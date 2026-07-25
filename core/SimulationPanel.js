// Shared RUN SIMULATION / TUNE FREQUENCIES dev-tooling UI, built on top of
// core/SpinSimulator.js's pure simulateSpins/tuneFrequencies functions.
// Every game's game.js calls into this instead of maintaining its own copy.
import { tuneFrequencies } from './SpinSimulator.js';

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function renderWinTable(counts, hitLabel, accentColor, emptyText) {
  const sortedKeys = Object.keys(counts).sort((a, b) => a - b);
  if (sortedKeys.length === 0) {
    return `<div style="color: #666; font-style: italic; font-size: 0.8em;">${emptyText}</div>`;
  }
  let html = `<table style="width: 100%; border-collapse: collapse; font-size: 0.95em;">`;
  html += `<thead><tr style="color: #888; font-size: 0.8em; text-transform: uppercase;">
              <th style="text-align: left; font-weight: normal; padding: 2px 4px 4px 0;">${hitLabel}</th>
              <th style="text-align: right; font-weight: normal; padding: 2px 4px 4px;">Wins</th>
              <th style="text-align: right; font-weight: normal; padding: 2px 4px 4px;">Avg Win</th>
              <th style="text-align: right; font-weight: normal; padding: 2px 0 4px;">Total Win</th>
            </tr></thead><tbody>`;
  sortedKeys.forEach(key => {
    const data = counts[key];
    const avg = data.totalAmount / data.count;
    html += `<tr>
                <td style="padding: 2px 4px 2px 0; color: ${accentColor};">${key}</td>
                <td style="text-align: right; padding: 2px 4px;">${data.count}</td>
                <td style="text-align: right; padding: 2px 4px;">$${fmt(avg)}</td>
                <td style="text-align: right; padding: 2px 0; font-weight: bold;">$${fmt(data.totalAmount)}</td>
              </tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

function createSection(title, symbols, symbolStats, paytable) {
  if (symbols.length === 0) return `<div style="color: #666; font-style: italic; font-size: 0.8em;">No wins found for ${title}</div>`;
  let sectionHtml = `<h4 style="margin: 15px 0 10px 0; color: #aaa; text-transform: uppercase; font-size: 0.75em; letter-spacing: 1px;">${title}</h4>`;
  sectionHtml += `<div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px;">`;

  symbols.forEach(symbol => {
    const stats = symbolStats[symbol] || { counts: {}, wildAssisted: { counts: {} }, alone: { counts: {} }, expanding: { counts: {} } };
    const friendlyName = paytable[symbol]?.friendlyName || symbol;
    const isScatter = paytable[symbol]?.type === 'scatter';

    sectionHtml += `<div style="border: 1px solid rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; background: rgba(255,255,255,0.05); font-size: 0.85em;">`;
    sectionHtml += `<strong style="display: block; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">${friendlyName}</strong>`;

    sectionHtml += `<div style="margin-bottom: 8px;">`;
    sectionHtml += `<span style="font-size: 0.7em; color: #999; text-transform: uppercase;">${isScatter ? 'Scatter Wins' : 'Normal Wins'}</span>`;
    sectionHtml += renderWinTable(stats.counts, 'Hits', '#ccc', isScatter ? 'No scatter wins' : 'No standard line wins');
    sectionHtml += `</div>`;

    // Wild-assisted matches (natural run one short of a full line, completed by a wild) are
    // reported apart from natural hits above - otherwise a full-payout wild-completed win
    // reads like a partial pay for symbols that don't actually have one.
    if (stats.wildAssisted && Object.keys(stats.wildAssisted.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 8px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #7ec8ff; text-transform: uppercase;">Wild-Assisted Wins</span>`;
      sectionHtml += renderWinTable(stats.wildAssisted.counts, 'Natural Hits', '#7ec8ff', '');
      sectionHtml += `</div>`;
    }

    // A wild's standalone "alone bonus" pays out regardless of what's elsewhere on the
    // line, so it's tallied under the wild symbol itself rather than whatever unrelated
    // symbol happened to land in reel 1.
    if (stats.alone && Object.keys(stats.alone.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 8px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #ffb27e; text-transform: uppercase;">Alone Bonus</span>`;
      sectionHtml += renderWinTable(stats.alone.counts, 'Landed', '#ffb27e', '');
      sectionHtml += `</div>`;
    }

    if (stats.expanding && Object.keys(stats.expanding.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 8px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #ffd700; text-transform: uppercase;">Expanding Wins</span>`;
      sectionHtml += renderWinTable(stats.expanding.counts, 'Reels', '#ffd700', '');
      sectionHtml += `</div>`;
    }

    sectionHtml += `</div>`;
  });

  sectionHtml += `</div>`;
  return sectionHtml;
}

/**
 * Groups a paytable's symbols by their `type` field (in first-seen order, 'other' for
 * symbols with no type), for rendering one section per type in the win breakdown. This
 * is purely data-driven - it reflects whatever `type` values the caller's paytable uses,
 * with no hardcoded symbol or type name.
 */
function groupSymbolsByType(paytable) {
  const order = [];
  const groups = {};
  Object.keys(paytable).forEach(symbol => {
    const type = paytable[symbol].type || 'other';
    if (!groups[type]) {
      groups[type] = [];
      order.push(type);
    }
    groups[type].push(symbol);
  });
  return order.map(type => ({ type, symbols: groups[type] }));
}

/**
 * Runs engine.runSimulation() and renders the results (stats + detailed win breakdown)
 * into the given DOM refs.
 * @param {Object} args
 * @param {Object} args.engine - a SlotEngine instance (has .runSimulation())
 * @param {Object} args.paytable
 * @param {number} args.betPerLine
 * @param {number} args.linesCount
 * @param {number} [args.numSpins=1000000]
 * @param {Object} args.domRefs
 */
export function runSimulationAndRender({ engine, paytable, betPerLine, linesCount, numSpins = 1000000, domRefs }) {
  const { btnSim, simModal, simStats, simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay } = domRefs;

  btnSim.textContent = 'RUNNING...';
  btnSim.disabled = true;

  setTimeout(() => {
    try {
      const results = engine.runSimulation(numSpins, betPerLine, linesCount);

      if (simStats) simStats.style.display = '';
      simRtpDisplay.textContent = results.rtp;
      simTotalSpinsDisplay.textContent = results.totalSpins;
      simMaxWinDisplay.textContent = `$${results.maxWin}`;
      const pct = results.totalSpins > 0 ? (results.freeSpinsTriggered / results.totalSpins) * 100 : 0;
      simFreeSpinsDisplay.textContent = `${results.freeSpinsTriggered} (${pct.toFixed(2)}%)`;

      function bump(bucket, key, amount) {
        if (!bucket[key]) bucket[key] = { count: 0, totalAmount: 0 };
        bucket[key].count += 1;
        bucket[key].totalAmount += amount;
      }

      const symbolStats = {};
      results.detailedWins.forEach(win => {
        if (!symbolStats[win.symbol]) {
          symbolStats[win.symbol] = { counts: {}, wildAssisted: { counts: {} }, alone: { counts: {} }, expanding: { counts: {} } };
        }
        const stats = symbolStats[win.symbol];
        if (win.type === 'expanding') {
          bump(stats.expanding.counts, win.count, win.winAmount);
        } else if (win.type === 'alone') {
          bump(stats.alone.counts, win.count, win.winAmount);
        } else if (win.wildUsed) {
          bump(stats.wildAssisted.counts, win.count, win.winAmount);
        } else {
          bump(stats.counts, win.count, win.winAmount);
        }
      });

      let detailsContainer = simModal.querySelector('#sim-details');
      if (!detailsContainer) {
        detailsContainer = document.createElement('div');
        detailsContainer.id = 'sim-details';
        detailsContainer.style.marginTop = '20px';
        detailsContainer.style.padding = '15px';
        detailsContainer.style.background = 'rgba(255, 255, 255, 0.1)';
        detailsContainer.style.borderRadius = '12px';
        detailsContainer.style.fontSize = '0.9em';
        simModal.appendChild(detailsContainer);
      } else {
        detailsContainer.innerHTML = '';
      }

      let detailsHtml = '<h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Detailed Win Breakdown</h3>';
      groupSymbolsByType(paytable).forEach(({ type, symbols }) => {
        const title = type.charAt(0).toUpperCase() + type.slice(1) + ' Symbols';
        detailsHtml += createSection(title, symbols, symbolStats, paytable);
      });
      detailsContainer.innerHTML = detailsHtml;

      simModal.style.display = 'block';
      simModal.style.maxWidth = '1200px';
      simModal.style.width = '95%';
    } catch (error) {
      console.error('Simulation failed:', error);
      alert('Error running simulation');
    } finally {
      btnSim.textContent = 'RUN SIMULATION';
      btnSim.disabled = false;
    }
  }, 50);
}

/**
 * Formats an array of per-reel frequency tables back out as paste-ready
 * `export const FREQUENCY_REELn = { ... }` literals, column-aligned - matching the exact
 * style already used in games/fruitmachine/game.js.
 */
export function formatReelFrequencyTablesForCopy(reelFrequencyTables) {
  return reelFrequencyTables.map((table, i) => {
    const symbols = Object.keys(table);
    if (symbols.length === 0) return `export const FREQUENCY_REEL${i + 1} = {};`;

    const keyWidth = Math.max(...symbols.map(s => s.length + 1));
    const lines = symbols.map(symbol => {
      const keyPart = `${symbol}:`.padEnd(keyWidth);
      const fixedPart = table[symbol].fixed ? ', fixed: true' : '';
      const minPart = table[symbol].min != null ? `, min: ${table[symbol].min}` : '';
      const maxPart = table[symbol].max != null ? `, max: ${table[symbol].max}` : '';
      return `  ${keyPart} { frequency: ${table[symbol].frequency.toFixed(1)}${fixedPart}${minPart}${maxPart} },`;
    });
    return `export const FREQUENCY_REEL${i + 1} = {\n${lines.join('\n')}\n};`;
  }).join('\n\n');
}

/**
 * Opens (or reuses) the frequency auto-balancer panel (SpinSimulator.js's tuneFrequencies)
 * with inputs for the tuning targets, showing live iteration-by-iteration progress. Only
 * ever reports a suggestion - never mutates the caller's live paytable/reels itself
 * (applying a result means regenerating reel strips, a deliberate source change).
 * @param {Object} args
 * @param {Object} args.paytable
 * @param {Object[]} args.reelFrequencyTables - One table per reel, each `{ symbol: { frequency } }`.
 * @param {Object} args.tuneConfig - { reelsCount, rowsCount, paylines, reelSeeds, betPerLine, linesCount, reelLength, winEvaluator, wildSymbol, scatterSymbol }
 * @param {Object} args.domRefs - { simModal, simStats }
 */
export function openTuneFrequenciesPanel({ paytable, reelFrequencyTables, tuneConfig, domRefs }) {
  const { simModal, simStats } = domRefs;
  let tuneContainer = simModal.querySelector('#tune-details');
  if (!tuneContainer) {
    tuneContainer = document.createElement('div');
    tuneContainer.id = 'tune-details';
    tuneContainer.style.marginTop = '20px';
    tuneContainer.style.padding = '15px';
    tuneContainer.style.background = 'rgba(255, 255, 255, 0.1)';
    tuneContainer.style.borderRadius = '12px';
    tuneContainer.style.fontSize = '0.9em';
    simModal.appendChild(tuneContainer);

    // Pre-selected default per reel, not a change to tuneFrequencies' own default (which
    // stays -1/"high pay rarer" everywhere unless orderingBiasByReel is passed): splits the
    // reels into thirds by position for a near-miss-shaped starting point - early reels
    // default to favoring high pay more frequent (builds a "you can see it's close" feel),
    // middle reels to the traditional high-pay-rarer direction, late reels to no preference.
    // Still just a default selection - each dropdown can be changed before starting a tune.
    function defaultBiasForReel(r, count) {
      if (count <= 1) return 1;
      const bucket = Math.floor(r * 3 / count);
      return bucket === 0 ? 1 : bucket === 1 ? -1 : 0;
    }

    const biasSelectorsHtml = Array.from({ length: tuneConfig.reelsCount }, (_, r) => {
      const def = defaultBiasForReel(r, tuneConfig.reelsCount);
      const opt = (value, label) => `<option value="${value}"${def === value ? ' selected' : ''}>${label}</option>`;
      return `
        <label style="font-size: 0.8em; color: #ccc;">Reel ${r + 1} preference<br>
          <select id="tune-bias-${r}" style="width: 100%; margin-top: 4px;">
            ${opt(1, 'High pay more frequent')}
            ${opt(-1, 'High pay rarer')}
            ${opt(0, 'No preference')}
          </select>
        </label>`;
    }).join('');

    tuneContainer.innerHTML = `
      <h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Frequency Tuner</h3>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px;">
        <label style="font-size: 0.8em; color: #ccc;">Target RTP (%)<br>
          <input id="tune-target-rtp" type="number" value="96" step="0.5" min="1" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Target Trigger Rate (%)<br>
          <input id="tune-target-trigger" type="number" value="0.6" step="0.05" min="0.01" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Reel Length<br>
          <input id="tune-reel-length" type="number" value="${tuneConfig.reelLength}" step="10" min="30" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Trial Spins / Candidate<br>
          <input id="tune-trial-spins" type="number" value="300000" step="50000" min="10000" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Trials Averaged / Candidate<br>
          <input id="tune-trials-per-point" type="number" value="2" step="1" min="1" max="10" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Max Iterations<br>
          <input id="tune-max-iterations" type="number" value="150" step="10" min="10" max="1000" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Ordering Penalty Weight<br>
          <input id="tune-ordering-weight" type="number" value="0.5" step="0.1" min="0" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Frequency Limit Penalty Weight<br>
          <input id="tune-limit-weight" type="number" value="0.5" step="0.1" min="0" style="width: 100%; margin-top: 4px;">
        </label>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px;">
        ${biasSelectorsHtml}
      </div>
      <p style="font-size: 0.75em; color: #888; margin: -4px 0 12px;">
        Every value symbol on every reel is tuned jointly (one search, not per-reel) via a
        Nelder-Mead simplex search. Each reel has its own ordering preference (above,
        pre-selected in a near-miss shape - early reels favor high pay more frequent, middle
        reels favor it rarer, late reels no preference - adjust any of them freely): "more
        frequent" discourages a higher-paying symbol from being less frequent than a
        lower-paying one on that reel (premium symbols show up often, so lines look close);
        "rarer" is the traditional direction; "no preference" disables it for that reel. It's
        always a soft preference, not an absolute rule - the search will accept a small violation rather
        than push RTP far off target. A symbol can also carry its own soft <code>min</code>/
        <code>max</code> frequency bounds directly in its FREQUENCY_REELn entry (edit that in
        game.js - there's no input for it here); Frequency Limit Penalty Weight controls how
        strongly those are enforced, same soft-preference semantics. Any violation still
        present at the end is listed below.
      </p>
      <button id="tune-start-btn" class="btn-close-sim">START TUNING</button>
      <div id="tune-progress-log" style="display: none; margin-top: 12px; max-height: 160px; overflow-y: auto; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;"></div>
      <div id="tune-results"></div>
    `;
    tuneContainer.querySelector('#tune-start-btn').addEventListener('click', () => startTuning({ paytable, reelFrequencyTables, tuneConfig, tuneContainer }));
  }

  if (simStats) simStats.style.display = 'none';

  simModal.style.display = 'block';
  simModal.style.maxWidth = '900px';
  simModal.style.width = '95%';
}

async function startTuning({ paytable, reelFrequencyTables, tuneConfig, tuneContainer }) {
  const startBtn = tuneContainer.querySelector('#tune-start-btn');
  const logEl = tuneContainer.querySelector('#tune-progress-log');
  const resultsEl = tuneContainer.querySelector('#tune-results');
  const inputs = {
    targetRtp: tuneContainer.querySelector('#tune-target-rtp'),
    targetTriggerRatePct: tuneContainer.querySelector('#tune-target-trigger'),
    reelLength: tuneContainer.querySelector('#tune-reel-length'),
    trialSpins: tuneContainer.querySelector('#tune-trial-spins'),
    trialsPerPoint: tuneContainer.querySelector('#tune-trials-per-point'),
    maxIterations: tuneContainer.querySelector('#tune-max-iterations'),
    orderingPenaltyWeight: tuneContainer.querySelector('#tune-ordering-weight'),
    limitPenaltyWeight: tuneContainer.querySelector('#tune-limit-weight'),
  };
  const biasSelects = Array.from({ length: tuneConfig.reelsCount }, (_, r) => tuneContainer.querySelector(`#tune-bias-${r}`));

  const options = {
    reelsCount: tuneConfig.reelsCount,
    rowsCount: tuneConfig.rowsCount,
    paylines: tuneConfig.paylines,
    reelSeeds: tuneConfig.reelSeeds,
    betPerLine: tuneConfig.betPerLine,
    linesCount: tuneConfig.linesCount,
    winEvaluator: tuneConfig.winEvaluator,
    wildSymbol: tuneConfig.wildSymbol,
    scatterSymbol: tuneConfig.scatterSymbol,
    reelLength: parseInt(inputs.reelLength.value, 10) || tuneConfig.reelLength,
    targetRtp: parseFloat(inputs.targetRtp.value) || 96,
    targetTriggerRatePct: parseFloat(inputs.targetTriggerRatePct.value) || 0.6,
    trialSpins: parseInt(inputs.trialSpins.value, 10) || 300000,
    trialsPerPoint: parseInt(inputs.trialsPerPoint.value, 10) || 2,
    maxIterations: parseInt(inputs.maxIterations.value, 10) || 150,
    orderingPenaltyWeight: parseFloat(inputs.orderingPenaltyWeight.value) || 0.5,
    limitPenaltyWeight: parseFloat(inputs.limitPenaltyWeight.value) || 0.5,
    orderingBiasByReel: biasSelects.map(el => parseInt(el.value, 10)),
  };

  Object.values(inputs).forEach(el => { el.disabled = true; });
  biasSelects.forEach(el => { el.disabled = true; });
  startBtn.disabled = true;
  startBtn.textContent = 'TUNING...';
  resultsEl.innerHTML = '';
  logEl.style.display = 'block';
  logEl.innerHTML = '';

  const appendLog = (line) => {
    const row = document.createElement('div');
    row.textContent = line;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  };

  try {
    const { reelFrequencyTables: tunedReelTables, rtp, triggerRatePct, diagnostics } = await tuneFrequencies(paytable, reelFrequencyTables, {
      ...options,
      onProgress: (phase, i, mult, r, best) => {
        const label = phase === 'scatter' ? `Scatter frequency ${i + 1}` : `Step ${i + 1}`;
        const multLabel = mult == null ? '' : `  mult=${mult.toFixed(3)}`;
        appendLog(`[${label}]${multLabel}  RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  err=${r.error.toFixed(4)}  (best err=${best.error.toFixed(4)})`);
      }
    });

    const rtpConverged = !!diagnostics.rtpPhase?.converged;
    const scatterConverged = diagnostics.scatterPhase == null || !!diagnostics.scatterPhase.converged;
    appendLog(
      rtpConverged && scatterConverged
        ? `Done. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%`
        : `⚠ Did NOT converge. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%  (this is the closest attempt found, not a successful tune)`
    );
    console.log('Frequency tuner diagnostics:', diagnostics);

    let html = `<p style="font-size: 0.85em; color: #ccc; margin: 12px 0 8px;">Achieved RTP: <strong>${rtp.toFixed(2)}%</strong> &nbsp;|&nbsp; Free spin trigger rate: <strong>${triggerRatePct.toFixed(3)}%</strong> (1 in ${(100 / triggerRatePct).toFixed(0)})</p>`;

    const targetRtp = options.targetRtp;
    if (!rtpConverged) {
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 <strong>⚠ Target RTP (${targetRtp}%) was NOT reached</strong> -
                 the closest attempt found is off by ${diagnostics.rtpPhase.error.toFixed(2)} percentage points.
                 Try raising Max Iterations, or check whether the current frequencies/payouts allow
                 ${targetRtp}% RTP at all - don't treat the RTP shown above as final without checking this.
               </p>`;
    }

    const violations = diagnostics.rtpPhase?.orderingViolations ?? [];
    if (violations.length > 0) {
      const rows = violations.map(v => {
        const higher = paytable[v.higherPaySymbol]?.friendlyName || v.higherPaySymbol;
        const lower = paytable[v.lowerPaySymbol]?.friendlyName || v.lowerPaySymbol;
        // bias -1 (default) wants higher rarer than lower, so a violation means higher ended
        // up more frequent; bias +1 wants higher no less frequent than lower, so a violation
        // means lower ended up more frequent instead - phrase whichever one actually happened.
        return v.bias < 0
          ? `Reel ${v.reel + 1}: ${higher} is ${v.amount.toFixed(3)} more frequent than ${lower}`
          : `Reel ${v.reel + 1}: ${lower} is ${v.amount.toFixed(3)} more frequent than ${higher} (reel prefers ${higher} more frequent)`;
      });
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 <strong>⚠ ${violations.length} ordering violation${violations.length > 1 ? 's' : ''} remain</strong> (accepted to keep RTP close to target):<br>
                 ${rows.join('<br>')}
               </p>`;
    }

    const limitViolations = diagnostics.rtpPhase?.limitViolations ?? [];
    if (limitViolations.length > 0) {
      const rows = limitViolations.map(v => {
        const name = paytable[v.symbol]?.friendlyName || v.symbol;
        return `Reel ${v.reel + 1}: ${name} is ${v.amount.toFixed(3)} past its ${v.bound} limit (${v.limit})`;
      });
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 <strong>⚠ ${limitViolations.length} frequency limit violation${limitViolations.length > 1 ? 's' : ''} remain</strong> (accepted to keep RTP close to target):<br>
                 ${rows.join('<br>')}
               </p>`;
    }

    html += `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;">`;
    reelFrequencyTables.forEach((baseReelTable, reelIdx) => {
      const tunedReelTable = tunedReelTables[reelIdx];
      html += `<div><h4 style="margin: 0 0 6px; font-size: 0.8em; color: #aaa; text-transform: uppercase;">Reel ${reelIdx + 1}</h4>`;
      html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.85em;">`;
      html += `<thead><tr style="color: #888; font-size: 0.75em; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.15);">
                  <th style="text-align: left; padding: 3px;">Symbol</th>
                  <th style="text-align: right; padding: 3px;">Current</th>
                  <th style="text-align: right; padding: 3px;">Suggested</th>
                  <th style="text-align: right; padding: 3px;">Δ</th>
                </tr></thead><tbody>`;
      Object.keys(baseReelTable).forEach(symbol => {
        const current = baseReelTable[symbol].frequency;
        const suggested = tunedReelTable[symbol].frequency;
        const delta = suggested - current;
        const deltaColor = Math.abs(delta) < 0.001 ? '#888' : (delta > 0 ? '#7fd97f' : '#e67f7f');
        html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 3px;">${paytable[symbol]?.friendlyName || symbol}</td>
                    <td style="text-align: right; padding: 3px;">${current.toFixed(4)}</td>
                    <td style="text-align: right; padding: 3px; font-weight: bold;">${suggested.toFixed(4)}</td>
                    <td style="text-align: right; padding: 3px; color: ${deltaColor};">${delta >= 0 ? '+' : ''}${delta.toFixed(4)}</td>
                  </tr>`;
      });
      html += `</tbody></table></div>`;
    });
    html += `</div>`;
    html += `<p style="font-size: 0.75em; color: #888; margin-top: 10px;">This is a suggestion only - apply it by replacing FREQUENCY_REEL1/2/3 in game.js and reloading, so REEL_STRIPS regenerates from the new weights.</p>`;

    html += `<div style="margin-top: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">Copy-paste ready FREQUENCY_REEL tables</span>
                  <button id="tune-copy-btn" class="btn-icon btn-sim-btn" style="padding: 4px 10px; font-size: 0.75em;">COPY</button>
                </div>
                <textarea id="tune-paytable-output" readonly style="width: 100%; height: 200px; box-sizing: border-box; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.4); color: #ddd; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 8px; resize: vertical;"></textarea>
              </div>`;

    resultsEl.innerHTML = html;

    const paytableOutput = resultsEl.querySelector('#tune-paytable-output');
    paytableOutput.value = formatReelFrequencyTablesForCopy(tunedReelTables);

    const copyBtn = resultsEl.querySelector('#tune-copy-btn');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(paytableOutput.value);
      } catch (err) {
        paytableOutput.select();
      }
      const original = copyBtn.textContent;
      copyBtn.textContent = 'COPIED!';
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    });
  } catch (error) {
    console.error('Frequency tuning failed:', error);
    appendLog(`Error: ${error.message}`);
  } finally {
    Object.values(inputs).forEach(el => { el.disabled = false; });
    biasSelects.forEach(el => { el.disabled = false; });
    startBtn.disabled = false;
    startBtn.textContent = 'START TUNING';
  }
}
