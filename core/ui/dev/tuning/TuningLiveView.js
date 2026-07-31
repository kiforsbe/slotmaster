import { symbolTypeColor, renderSymbolLabel } from './TuningSymbolPresentation.js';
// One symbol's gauge: a single horizontal track, scaled 0 -> reelMax (the highest frequency
// value seen anywhere on this symbol's own reel - configured bounds, tested range, current, or
// best value, across every symbol on that reel, not just this one) so every symbol's bar on a
// given reel is directly comparable at a glance - a symbol at 26 fills most of the track while
// one at 1.6 is a sliver, instead of each bar independently stretching to fill its own box
// regardless of magnitude. A light blue band for the configured minFrequency/maxFrequency
// range, a brighter band for the tested min/max range (the actual low/high frequency this
// symbol has been assigned to across every candidate evaluated so far this run), a gold tick
// for the candidate this step just tried (`current` - may not be an improvement), and a green
// tick for this symbol's value in the overall best-ever candidate found so far (`best` - same
// distinction as the progress log's "current"/"best" split, see startTuning's own onProgress
// handler doc for why the two can differ for many iterations in a row). reelMax <= 0 can't
// derive a span (e.g. every symbol on the reel is 0) - ticks render centered with no bands
// rather than dividing by zero.
function renderFrequencyGauge(current, best, configuredMin, configuredMax, testedMin, testedMax, reelMax) {
  const pct = (v) => reelMax > 0 ? (v / reelMax) * 100 : 50;

  const configuredBand = (configuredMin != null && configuredMax != null)
    ? `<div style="position: absolute; left: ${pct(configuredMin)}%; width: ${Math.max(pct(configuredMax) - pct(configuredMin), 1)}%; top: 0; height: 100%; background: rgba(126,200,255,0.18); border-left: 1px solid rgba(126,200,255,0.5); border-right: 1px solid rgba(126,200,255,0.5);"></div>`
    : '';
  const testedBand = (testedMin != null && testedMax != null)
    ? `<div style="position: absolute; left: ${pct(testedMin)}%; width: ${Math.max(pct(testedMax) - pct(testedMin), 1)}%; top: 30%; height: 40%; background: rgba(255,255,255,0.4); border-radius: 2px;"></div>`
    : '';
  // Drawn before the current tick so current wins visually if the two ever land on the exact
  // same pixel (common once the search has actually converged onto the best candidate).
  const bestTick = best != null
    ? `<div style="position: absolute; left: calc(${pct(best)}% - 1px); top: -2px; width: 2px; height: calc(100% + 4px); background: #4ade80;"></div>`
    : '';
  const currentTick = current != null
    ? `<div style="position: absolute; left: calc(${pct(current)}% - 1px); top: -2px; width: 2px; height: calc(100% + 4px); background: #e6b800;"></div>`
    : '';

  const title = [
    current != null ? `current: ${current.toFixed(3)}` : null,
    best != null ? `best: ${best.toFixed(3)}` : null,
    testedMin != null ? `tested: ${testedMin.toFixed(3)} – ${testedMax.toFixed(3)}` : null,
    configuredMin != null || configuredMax != null
      ? `configured: ${configuredMin != null ? configuredMin.toFixed(3) : '–'} – ${configuredMax != null ? configuredMax.toFixed(3) : '–'}`
      : null,
  ].filter(Boolean).join(' | ');

  return `<div title="${title}" style="position: relative; height: 14px; background: rgba(255,255,255,0.06); border-radius: 3px;">${configuredBand}${testedBand}${bestTick}${currentTick}</div>`;
}

// Renders the TUNE FREQUENCIES panel's live per-reel view: one gauge row per value symbol,
// showing both the candidate this step just tried (`liveTrial` - "current", may not be an
// improvement) and this symbol's value in the overall best-ever candidate found so far
// (`bestTrial` - "best") against both its configured soft minFrequency/maxFrequency bounds
// (resolved once up front - static for the whole run) and the min/max it's actually been tested
// at so far this run (`testedRangeByReel`, updated by the caller on every Phase 2 iteration -
// grows monotonically, never shrinks, until the next run resets it). Before Phase 2 has run at
// all (or during Phase 1, which never touches value symbols), both `liveTrial`/`bestTrial` are
// null and every symbol just shows its untouched baseline frequency with no best marker - see
// startTuning's onProgress handler for exactly when each is populated, and why "current" and
// "best" can disagree for many steps in a row (same reasoning as the progress log's own
// current/best split). Every symbol's gauge on a given reel shares that reel's own scale (0 ->
// the highest value seen anywhere on that reel), not its own - see renderFrequencyGauge's doc.
export function renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, testedRangeByReel, liveTrial, bestTrial, paytable, bestOrderingViolations = [], bestLimitViolations = []) {
  let html = `<div style="font-size: 0.7em; color: #888; margin-bottom: 6px;">
                 <span style="color: #7ec8ff;">▮</span> configured range &nbsp;
                 <span style="color: #ddd;">▮</span> tested range &nbsp;
                 <span style="color: #e6b800;">|</span> current &nbsp;
                 <span style="color: #4ade80;">|</span> best &nbsp; &nbsp;
                 <span style="color: ${symbolTypeColor('scatter')};">●</span> scatter &nbsp;
                 <span style="color: ${symbolTypeColor('wild')};">●</span> wild &nbsp;
                 <span style="color: ${symbolTypeColor('premium')};">●</span> premium &nbsp;
                 <span style="color: ${symbolTypeColor('regular')};">●</span> regular &nbsp; &nbsp;
                 <span style="color: #ff8080;">▮</span> ordering/limit violation (best)
               </div>`;
  html += `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px;">`;
  reelFrequencyTables.forEach((baseReelTableWrapper, reelIdx) => {
    const baseReelTable = baseReelTableWrapper.symbols || baseReelTableWrapper;
    const liveReelTable = liveTrial ? (liveTrial[reelIdx].symbols || liveTrial[reelIdx]) : null;
    const bestReelTable = bestTrial ? (bestTrial[reelIdx].symbols || bestTrial[reelIdx]) : null;
    const testedRange = testedRangeByReel[reelIdx];
    // Reel-wide scale ceiling: the highest of every symbol's current/best/configured-max/
    // tested-max on this reel - computed once per reel, then shared by every symbol's gauge
    // below so bars are comparable to each other, not just internally consistent with their own
    // min/max.
    let reelMax = 0;
    Object.keys(baseReelTable).forEach(symbol => {
      const current = liveReelTable ? liveReelTable[symbol].frequency : baseReelTable[symbol].frequency;
      const best = bestReelTable ? bestReelTable[symbol].frequency : null;
      const { maxFrequency } = boundsByReel[reelIdx][symbol];
      const tested = testedRange[symbol];
      [current, best, maxFrequency, tested ? tested.max : null].forEach(v => { if (v != null && v > reelMax) reelMax = v; });
    });
    html += `<div><h4 style="margin: 0 0 4px; font-size: 0.75em; color: #aaa; text-transform: uppercase;">Reel ${reelIdx + 1}</h4>`;
    Object.keys(baseReelTable).forEach(symbol => {
      const current = liveReelTable ? liveReelTable[symbol].frequency : baseReelTable[symbol].frequency;
      const best = bestReelTable ? bestReelTable[symbol].frequency : null;
      const { minFrequency, maxFrequency } = boundsByReel[reelIdx][symbol];
      const tested = testedRange[symbol];
      const gauge = renderFrequencyGauge(current, best, minFrequency, maxFrequency, tested ? tested.min : null, tested ? tested.max : null, reelMax);
      // Marks a symbol currently involved in one of the BEST candidate's own ordering/limit
      // violations (the same arrays the final results' "N ordering/limit violations remain"
      // paragraphs list, surfaced live and per-symbol here instead of only after the run ends) -
      // a row can carry both if a symbol happens to violate on two fronts at once.
      const orderingHits = bestOrderingViolations.filter(v => v.reel === reelIdx && (v.higherPaySymbol === symbol || v.lowerPaySymbol === symbol));
      const limitHits = bestLimitViolations.filter(v => v.reel === reelIdx && v.symbol === symbol);
      const violationTitle = [...orderingHits.map(v => `ordering: ${v.amount.toFixed(3)} past preference`), ...limitHits.map(v => `${v.bound} limit: ${v.amount.toFixed(3)} past ${v.limit}`)].join(' | ');
      const rowStyle = (orderingHits.length > 0 || limitHits.length > 0)
        ? 'background: rgba(255,90,90,0.12); border-left: 2px solid #ff8080; padding-left: 4px;'
        : 'border-left: 2px solid transparent; padding-left: 4px;';
      html += `<div title="${violationTitle}" style="display: grid; grid-template-columns: 66px 46px 46px 1fr; align-items: center; gap: 6px; padding: 2px 0; font-size: 0.78em; ${rowStyle}">
                  ${renderSymbolLabel(symbol, paytable)}
                  <span style="text-align: right; color: #ddd;">${current.toFixed(3)}</span>
                  <span style="text-align: right; color: #4ade80;">${best != null ? best.toFixed(3) : '–'}</span>
                  ${gauge}
                </div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  return html;
}
