// Shared RUN SIMULATION / TUNE FREQUENCIES dev-tooling UI, built on top of
// core/SpinSimulator.js's pure simulateSpins/tuneFrequencies functions.
// Every game's game.js calls into this instead of maintaining its own copy.
import { resolveFrequencyBounds } from './SlotMath.js';

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Shared symbol-type -> color mapping, used anywhere a symbol name is listed next to others of
// mixed type (the TUNE FREQUENCIES live/results tables) so type is visible at a glance without
// needing a separate column or section per type. Deliberately distinct from the gauge's own
// palette (configured/tested bands, current tick) so the two don't read as related.
function symbolTypeColor(type) {
  switch (type) {
    case 'scatter': return '#ffd700';
    case 'wild': return '#c792ea';
    case 'premium': return '#7ec8ff';
    case 'regular': return '#eee';
    default: return '#888';
  }
}

// A symbol name span colored by its paytable type, with a title (hover) attribute spelling out
// the friendly name and type explicitly for anyone who can't rely on color alone. `displayText`
// defaults to the raw symbol key (compact, for the space-constrained live gauge table) but can
// be overridden (e.g. to the friendly name) where there's room for it.
function renderSymbolLabel(symbol, paytable, displayText = symbol) {
  const meta = paytable?.[symbol];
  const type = meta?.type || 'other';
  const friendlyName = meta?.friendlyName || symbol;
  const color = symbolTypeColor(type);
  const title = `${friendlyName} (${type})`;
  return `<span title="${title}" style="color: ${color}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${displayText}</span>`;
}

/**
 * Runs tuneFrequencies() in a dedicated Worker (core/tuneFrequenciesWorker.js) instead of on
 * this thread, so the potentially long Monte Carlo search never blocks page rendering/input -
 * see that worker file's own comment for why. `paytable`/`reelFrequencyTables`/`options` are
 * postMessage'd across, so they must be structured-cloneable (no functions - `onProgress` is
 * kept on this side and invoked locally as messages arrive).
 * @returns {Promise<{ reelFrequencyTables: Object[], rtp: number, triggerRatePct: number, diagnostics: Object }>}
 */
function runTuneFrequenciesInWorker(paytable, reelFrequencyTables, options, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./tuneFrequenciesWorker.js', import.meta.url), { type: 'module' });
    // winEvaluator (a function, e.g. checkWildLineWins) can't cross postMessage - send its
    // name instead, resolved back to the real function inside the worker (see its own
    // WIN_EVALUATORS table). Everything else in `options` is already plain data.
    const { onProgress: _ignored, winEvaluator, ...cloneableOptions } = options;
    cloneableOptions.winEvaluatorName = winEvaluator ? winEvaluator.name : null;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        onProgress(msg.phase, msg.i, msg.mult, msg.result, msg.best);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.result);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'tuneFrequencies worker failed'));
    };
    worker.postMessage({ paytable, reelFrequencyTables, options: cloneableOptions });
  });
}

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
// A fixed decimal-place count (the previous `.toFixed(1)`) is fine for frequencies in the
// tens (fruitmachine's bar: 25.3) but is catastrophically lossy for frequencies under 1
// (bookbookbook's book: 0.051 and explorer: 0.079 both rounded to "0.1" - two symbols with
// nearly 2x different rarity reading back as identical). Significant figures scale with
// magnitude instead, so both ranges keep enough precision to survive a copy/paste
// round-trip without silently corrupting the tuned result.
function formatFrequencyForCopy(freq) {
  if (freq === 0) return '0';
  return Number(freq.toPrecision(4)).toString();
}

export function formatReelFrequencyTablesForCopy(reelFrequencyTables) {
  return reelFrequencyTables.map((table, i) => {
    const defaults = table.defaults || {};
    const symbolsTable = table.symbols || table;
    const symbols = Object.keys(symbolsTable);
    if (symbols.length === 0) return `export const FREQUENCY_REEL${i + 1} = {\n  defaults: {},\n  symbols: {},\n};`;

    const defaultsParts = [];
    if (defaults.minGap != null) defaultsParts.push(`minGap: ${defaults.minGap}`);
    if (defaults.maxStack != null) defaultsParts.push(`maxStack: ${defaults.maxStack}`);
    if (defaults.minStack != null) defaultsParts.push(`minStack: ${defaults.minStack}`);
    if (defaults.minFrequency != null) defaultsParts.push(`minFrequency: ${defaults.minFrequency}`);
    if (defaults.maxFrequency != null) defaultsParts.push(`maxFrequency: ${defaults.maxFrequency}`);
    const defaultsLine = `  defaults: { ${defaultsParts.join(', ')} },`;

    const keyWidth = Math.max(...symbols.map(s => s.length + 1));
    const lines = symbols.map(symbol => {
      const entry = symbolsTable[symbol];
      const keyPart = `${symbol}:`.padEnd(keyWidth);
      const minGapPart = entry.minGap != null ? `, minGap: ${entry.minGap}` : '';
      const maxStackPart = entry.maxStack != null ? `, maxStack: ${entry.maxStack}` : '';
      const minStackPart = entry.minStack != null ? `, minStack: ${entry.minStack}` : '';
      const fixedPart = entry.fixed ? ', fixed: true' : '';
      const minPart = entry.minFrequency != null ? `, minFrequency: ${entry.minFrequency}` : '';
      const maxPart = entry.maxFrequency != null ? `, maxFrequency: ${entry.maxFrequency}` : '';
      return `    ${keyPart} { frequency: ${formatFrequencyForCopy(entry.frequency)}${minGapPart}${maxStackPart}${minStackPart}${fixedPart}${minPart}${maxPart} },`;
    });
    return `export const FREQUENCY_REEL${i + 1} = {\n${defaultsLine}\n  symbols: {\n${lines.join('\n')}\n  },\n};`;
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
        <div style="display: flex; gap: 6px; align-items: flex-end;">
          <label title="Which direction (if any) this reel's ordering preference pushes higher-paying vs lower-paying symbols - see the explanation below." style="font-size: 0.8em; color: #ccc; flex: 1;">Reel ${r + 1} preference<br>
            <select id="tune-bias-${r}" style="width: 100%; margin-top: 4px;">
              ${opt(1, 'High pay more frequent')}
              ${opt(-1, 'High pay rarer')}
              ${opt(0, 'No preference')}
            </select>
          </label>
          <label title="How strongly this reel's preference is enforced relative to Ordering Penalty Weight - 1 is normal, 0 mutes it without changing the direction dropdown, above 1 pushes harder." style="font-size: 0.8em; color: #ccc; width: 64px;">Strength<br>
            <input id="tune-bias-strength-${r}" type="number" value="1" step="0.1" min="0" max="5" style="width: 100%; margin-top: 4px;">
          </label>
        </div>`;
    }).join('');

    tuneContainer.innerHTML = `
      <h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Frequency Tuner</h3>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px;">
        <label title="The RTP percent the search tries to hit (e.g. 96 for 96%). Phase 2 stops adjusting once within its tolerance band, balanced against the Ordering/Limit/Uniformity penalties below." style="font-size: 0.8em; color: #ccc;">Target RTP (%)<br>
          <input id="tune-target-rtp" type="number" value="96" step="0.5" min="1" style="width: 100%; margin-top: 4px;">
        </label>
        <label title="The percent of spins that should trigger free spins - only matters if this paytable has a triggerFreeSpins: true symbol. Phase 1 scales that symbol's frequency (identically on every reel) until the measured rate lands within tolerance of this, before Phase 2 touches anything else." style="font-size: 0.8em; color: #ccc;">Target Trigger Rate (%)<br>
          <input id="tune-target-trigger" type="number" value="0.6" step="0.05" min="0.01" style="width: 100%; margin-top: 4px;">
        </label>
        <label title="Virtual reel strip length used to build each candidate's reel strips - defaults to this game's own REEL_LENGTH. Longer reels let low frequencies round to more distinct symbol counts, at the cost of a slower simulation per candidate." style="font-size: 0.8em; color: #ccc;">Reel Length<br>
          <input id="tune-reel-length" type="number" value="${tuneConfig.reelLength}" step="10" min="30" style="width: 100%; margin-top: 4px;">
        </label>
        <label title="How many spins are simulated to measure each candidate's RTP/trigger rate. Higher reduces Monte Carlo noise but makes every iteration slower - see also Trials Averaged." style="font-size: 0.8em; color: #ccc;">Trial Spins / Candidate<br>
          <input id="tune-trial-spins" type="number" value="300000" step="50000" min="10000" style="width: 100%; margin-top: 4px;">
        </label>
        <label title="How many independent Trial Spins runs are averaged per candidate measurement. Higher further reduces noise in the RTP/trigger estimate, at a proportional cost in time (2 trials ≈ 2x the work per iteration)." style="font-size: 0.8em; color: #ccc;">Trials Averaged / Candidate<br>
          <input id="tune-trials-per-point" type="number" value="2" step="1" min="1" max="10" style="width: 100%; margin-top: 4px;">
        </label>
        <label title="Upper bound on Nelder-Mead iterations for the joint frequency search (Phase 2). The search may stop earlier if it converges, stalls out after repeated restarts, or is already essentially resolved - see the reason reported after a run." style="font-size: 0.8em; color: #ccc;">Max Iterations<br>
          <input id="tune-max-iterations" type="number" value="150" step="10" min="10" max="1000" style="width: 100%; margin-top: 4px;">
        </label>
        <label title="How strongly each reel's ordering preference (below) is enforced as a soft penalty on the search's loss, relative to hitting Target RTP. Higher makes the search work harder to satisfy every reel's preference even at some cost to RTP accuracy." style="font-size: 0.8em; color: #ccc;">Ordering Penalty Weight<br>
          <input id="tune-ordering-weight" type="number" value="0.5" step="0.1" min="0" style="width: 100%; margin-top: 4px;">
        </label>
        <label title="How strongly a symbol's own soft minFrequency/maxFrequency bounds (set directly in its FREQUENCY_REELn entry in game.js, not from this panel) are enforced as a penalty on the search's loss. Higher discourages the search from letting a bounded symbol drift outside its configured range." style="font-size: 0.8em; color: #ccc;">Frequency Limit Penalty Weight<br>
          <input id="tune-limit-weight" type="number" value="0.5" step="0.1" min="0" style="width: 100%; margin-top: 4px;">
        </label>
        <label title="Discourages any one tunable symbol's frequency on a reel from sitting drastically far from what an equal split of that reel's budget would give it - 0 (default) is off; raise it if the search keeps producing one or two outlier symbols next to a pack of much smaller ones." style="font-size: 0.8em; color: #ccc;">Uniformity Penalty Weight<br>
          <input id="tune-uniformity-weight" type="number" value="0" step="0.1" min="0" style="width: 100%; margin-top: 4px;">
        </label>
        <label title="How each tunable symbol's STARTING frequency is chosen before the search begins. 'Use configured baseline' starts every symbol exactly where FREQUENCY_REELn already had it (default - unchanged behavior). The two random options instead pick a starting value between that symbol's own minFrequency and maxFrequency - only symbols with BOTH bounds set are affected, everything else always starts at its baseline regardless of this setting. Useful for checking whether the search reliably reaches the same answer from a meaningfully different starting shape, or gets stuck depending on where it started." style="font-size: 0.8em; color: #ccc;">Initial Frequency Strategy<br>
          <select id="tune-initial-weight-strategy" style="width: 100%; margin-top: 4px;">
            <option value="provided" selected>Use configured baseline (default)</option>
            <option value="uniform">Random (uniform) within min/max</option>
            <option value="normal">Random (normal) within min/max</option>
          </select>
        </label>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 12px;">
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
        than push RTP far off target. Each reel's own <strong>Strength</strong> multiplies how hard
        that specific reel's preference is enforced (1 = normal, 0 = same as "no preference" without
        losing the direction dropdown's selection, above 1 = enforced harder) - useful when one
        reel's preference is visibly dominating the tune at the shared Ordering Penalty Weight
        below. A symbol can also carry its own soft <code>min</code>/
        <code>max</code> frequency bounds directly in its FREQUENCY_REELn entry (edit that in
        game.js - there's no input for it here); Frequency Limit Penalty Weight controls how
        strongly those are enforced, same soft-preference semantics. Uniformity Penalty Weight
        (off by default) is a separate, reel-wide soft preference: it discourages any one
        tunable symbol from landing drastically far from an equal split of its reel's budget,
        independently of ordering or of any per-symbol min/max - raise it if the search keeps
        producing one or two outlier symbols (e.g. 1.45 next to a pack sitting at 0.02-0.065)
        rather than a comparatively gradual spread. Any violation still present at the end is
        listed below.
      </p>
      <button id="tune-start-btn" class="btn-close-sim">START TUNING</button>
      <div id="tune-live-table" style="display: none; margin-top: 12px;"></div>
      <div id="tune-progress-log" style="display: none; margin-top: 12px; max-height: 160px; overflow-y: auto; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;"></div>
      <div id="tune-results"></div>
    `;
    tuneContainer.querySelector('#tune-start-btn').addEventListener('click', () => startTuning({
      paytable, reelFrequencyTables, tuneConfig, tuneContainer,
      originalReelFrequencyTables: reelFrequencyTables,
    }));
  }

  if (simStats) simStats.style.display = 'none';

  simModal.style.display = 'block';
  simModal.style.maxWidth = '900px';
  simModal.style.width = '95%';
}

// One symbol's gauge: a single horizontal track, scaled 0 -> reelMax (the highest frequency
// value seen anywhere on this symbol's own reel - configured bounds, tested range, or current
// value, across every symbol on that reel, not just this one) so every symbol's bar on a given
// reel is directly comparable at a glance - a symbol at 26 fills most of the track while one at
// 1.6 is a sliver, instead of each bar independently stretching to fill its own box regardless
// of magnitude. A light blue band for the configured minFrequency/maxFrequency range, a
// brighter band for the tested min/max range (the actual low/high frequency this symbol has
// been assigned to across every candidate evaluated so far this run), and a gold tick for the
// current value. reelMax <= 0 can't derive a span (e.g. every symbol on the reel is 0) - the
// tick renders centered with no bands rather than dividing by zero.
function renderFrequencyGauge(current, configuredMin, configuredMax, testedMin, testedMax, reelMax) {
  const pct = (v) => reelMax > 0 ? (v / reelMax) * 100 : 50;

  const configuredBand = (configuredMin != null && configuredMax != null)
    ? `<div style="position: absolute; left: ${pct(configuredMin)}%; width: ${Math.max(pct(configuredMax) - pct(configuredMin), 1)}%; top: 0; height: 100%; background: rgba(126,200,255,0.18); border-left: 1px solid rgba(126,200,255,0.5); border-right: 1px solid rgba(126,200,255,0.5);"></div>`
    : '';
  const testedBand = (testedMin != null && testedMax != null)
    ? `<div style="position: absolute; left: ${pct(testedMin)}%; width: ${Math.max(pct(testedMax) - pct(testedMin), 1)}%; top: 30%; height: 40%; background: rgba(255,255,255,0.4); border-radius: 2px;"></div>`
    : '';
  const currentTick = current != null
    ? `<div style="position: absolute; left: calc(${pct(current)}% - 1px); top: -2px; width: 2px; height: calc(100% + 4px); background: #e6b800;"></div>`
    : '';

  const title = [
    current != null ? `current: ${current.toFixed(3)}` : null,
    testedMin != null ? `tested: ${testedMin.toFixed(3)} – ${testedMax.toFixed(3)}` : null,
    configuredMin != null || configuredMax != null
      ? `configured: ${configuredMin != null ? configuredMin.toFixed(3) : '–'} – ${configuredMax != null ? configuredMax.toFixed(3) : '–'}`
      : null,
  ].filter(Boolean).join(' | ');

  return `<div title="${title}" style="position: relative; height: 14px; background: rgba(255,255,255,0.06); border-radius: 3px;">${configuredBand}${testedBand}${currentTick}</div>`;
}

// Renders the TUNE FREQUENCIES panel's live per-reel view: one gauge row per value symbol,
// showing its current frequency (from the live candidate being evaluated, or the untouched
// baseline before Phase 2 starts moving anything) against both its configured soft
// minFrequency/maxFrequency bounds (resolved once up front - static for the whole run) and the
// min/max it's actually been tested at so far this run (`testedRangeByReel`, updated by the
// caller on every Phase 2 iteration - grows monotonically, never shrinks, until the next run
// resets it). Every symbol's gauge on a given reel shares that reel's own scale (0 -> the
// highest value seen anywhere on that reel), not its own - see renderFrequencyGauge's doc.
function renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, testedRangeByReel, liveTrial, paytable) {
  let html = `<div style="font-size: 0.7em; color: #888; margin-bottom: 6px;">
                 <span style="color: #7ec8ff;">▮</span> configured range &nbsp;
                 <span style="color: #ddd;">▮</span> tested range &nbsp;
                 <span style="color: #e6b800;">|</span> current &nbsp; &nbsp;
                 <span style="color: ${symbolTypeColor('scatter')};">●</span> scatter &nbsp;
                 <span style="color: ${symbolTypeColor('wild')};">●</span> wild &nbsp;
                 <span style="color: ${symbolTypeColor('premium')};">●</span> premium &nbsp;
                 <span style="color: ${symbolTypeColor('regular')};">●</span> regular
               </div>`;
  html += `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px;">`;
  reelFrequencyTables.forEach((baseReelTableWrapper, reelIdx) => {
    const baseReelTable = baseReelTableWrapper.symbols || baseReelTableWrapper;
    const liveReelTable = liveTrial ? (liveTrial[reelIdx].symbols || liveTrial[reelIdx]) : null;
    const testedRange = testedRangeByReel[reelIdx];
    // Reel-wide scale ceiling: the highest of every symbol's current/configured-max/tested-max
    // on this reel - computed once per reel, then shared by every symbol's gauge below so bars
    // are comparable to each other, not just internally consistent with their own min/max.
    let reelMax = 0;
    Object.keys(baseReelTable).forEach(symbol => {
      const current = liveReelTable ? liveReelTable[symbol].frequency : baseReelTable[symbol].frequency;
      const { maxFrequency } = boundsByReel[reelIdx][symbol];
      const tested = testedRange[symbol];
      [current, maxFrequency, tested ? tested.max : null].forEach(v => { if (v != null && v > reelMax) reelMax = v; });
    });
    html += `<div><h4 style="margin: 0 0 4px; font-size: 0.75em; color: #aaa; text-transform: uppercase;">Reel ${reelIdx + 1}</h4>`;
    Object.keys(baseReelTable).forEach(symbol => {
      const current = liveReelTable ? liveReelTable[symbol].frequency : baseReelTable[symbol].frequency;
      const { minFrequency, maxFrequency } = boundsByReel[reelIdx][symbol];
      const tested = testedRange[symbol];
      const gauge = renderFrequencyGauge(current, minFrequency, maxFrequency, tested ? tested.min : null, tested ? tested.max : null, reelMax);
      html += `<div style="display: grid; grid-template-columns: 66px 46px 1fr; align-items: center; gap: 6px; padding: 2px 0; font-size: 0.78em;">
                  ${renderSymbolLabel(symbol, paytable)}
                  <span style="text-align: right; color: #ddd;">${current.toFixed(3)}</span>
                  ${gauge}
                </div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  return html;
}

async function startTuning({ paytable, reelFrequencyTables, tuneConfig, tuneContainer, originalReelFrequencyTables = reelFrequencyTables }) {
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
    uniformityPenaltyWeight: tuneContainer.querySelector('#tune-uniformity-weight'),
    initialWeightStrategy: tuneContainer.querySelector('#tune-initial-weight-strategy'),
  };
  const biasSelects = Array.from({ length: tuneConfig.reelsCount }, (_, r) => tuneContainer.querySelector(`#tune-bias-${r}`));
  const biasStrengthInputs = Array.from({ length: tuneConfig.reelsCount }, (_, r) => tuneContainer.querySelector(`#tune-bias-strength-${r}`));

  // Resolved once, up front - these bounds don't change during the run, only frequency does.
  const boundsByReel = reelFrequencyTables.map(reelTableWrapper => {
    const symbolsTable = reelTableWrapper.symbols || reelTableWrapper;
    const bounds = {};
    Object.keys(symbolsTable).forEach(symbol => { bounds[symbol] = resolveFrequencyBounds(reelTableWrapper, symbol); });
    return bounds;
  });
  const liveTableEl = tuneContainer.querySelector('#tune-live-table');
  // reelIdx -> symbol -> { min, max } actually assigned during the search so far this run -
  // grows as Phase 2 explores, reset fresh on every START TUNING click.
  const testedRangeByReel = reelFrequencyTables.map(() => ({}));

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
    freeSpinsCount: tuneConfig.freeSpinsCount,
    freeSpinsAwardTable: tuneConfig.freeSpinsAwardTable,
    retriggerFreeSpinsAwardTable: tuneConfig.retriggerFreeSpinsAwardTable,
    hasExpandingWild: tuneConfig.hasExpandingWild,
    reelLength: parseInt(inputs.reelLength.value, 10) || tuneConfig.reelLength,
    targetRtp: parseFloat(inputs.targetRtp.value) || 96,
    targetTriggerRatePct: parseFloat(inputs.targetTriggerRatePct.value) || 0.6,
    trialSpins: parseInt(inputs.trialSpins.value, 10) || 300000,
    trialsPerPoint: parseInt(inputs.trialsPerPoint.value, 10) || 2,
    maxIterations: parseInt(inputs.maxIterations.value, 10) || 150,
    orderingPenaltyWeight: parseFloat(inputs.orderingPenaltyWeight.value) || 0.5,
    limitPenaltyWeight: parseFloat(inputs.limitPenaltyWeight.value) || 0.5,
    uniformityPenaltyWeight: parseFloat(inputs.uniformityPenaltyWeight.value) || 0,
    initialWeightStrategy: inputs.initialWeightStrategy.value,
    // Direction (dropdown, -1/1/0) times this reel's own Strength input (default 1) - a
    // strength of 0 mutes the preference the same way "No preference" does, without losing
    // the dropdown's own selection; above 1 enforces it harder than the shared Ordering
    // Penalty Weight alone would. tuneFrequencies already supports any magnitude here, not
    // just -1/0/1 (see its own orderingBiasByReel doc) - this just exposes that per reel.
    orderingBiasByReel: biasSelects.map((el, r) => {
      const rawStrength = parseFloat(biasStrengthInputs[r].value);
      return parseInt(el.value, 10) * (Number.isFinite(rawStrength) ? rawStrength : 1);
    }),
  };

  Object.values(inputs).forEach(el => { el.disabled = true; });
  biasSelects.forEach(el => { el.disabled = true; });
  biasStrengthInputs.forEach(el => { el.disabled = true; });
  startBtn.disabled = true;
  startBtn.textContent = 'TUNING...';
  resultsEl.innerHTML = '';
  logEl.style.display = 'block';
  logEl.innerHTML = '';
  liveTableEl.style.display = 'block';
  liveTableEl.innerHTML = renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, testedRangeByReel, null, paytable);

  const appendLog = (line) => {
    const row = document.createElement('div');
    row.textContent = line;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  };

  try {
    const initialWeightStrategyLabels = {
      provided: 'configured baseline', uniform: 'random, uniform', normal: 'random, normal',
    };
    // Shared by the 'initial' preview event and every 'shape' iteration - folds a candidate's
    // trial reel tables into the running tested-range tracker and re-renders the live gauges.
    const updateLiveTable = (trial) => {
      trial.forEach((reelTableWrapper, reelIdx) => {
        const symbolsTable = reelTableWrapper.symbols || reelTableWrapper;
        const range = testedRangeByReel[reelIdx];
        Object.keys(symbolsTable).forEach(symbol => {
          const freq = symbolsTable[symbol].frequency;
          const prev = range[symbol];
          range[symbol] = prev ? { min: Math.min(prev.min, freq), max: Math.max(prev.max, freq) } : { min: freq, max: freq };
        });
      });
      liveTableEl.innerHTML = renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, testedRangeByReel, trial, paytable);
    };

    const { reelFrequencyTables: tunedReelTables, rtp, triggerRatePct, diagnostics } = await runTuneFrequenciesInWorker(paytable, reelFrequencyTables, options,
      (phase, i, mult, r, best) => {
        // Fired once, before Phase 1 even runs, with Phase 2's actual starting point (reflecting
        // Initial Frequency Strategy) - without this the live table stayed frozen on the raw
        // baseline all through Phase 1's scatter rounds, making the strategy look like it
        // hadn't taken effect until well after the fact.
        if (phase === 'initial') {
          appendLog(`Starting point selected (${initialWeightStrategyLabels[options.initialWeightStrategy] || options.initialWeightStrategy})`);
          if (r.trial) updateLiveTable(r.trial);
          return;
        }
        // A stalled round restarting with a wider step is otherwise invisible here - the next
        // 'shape' log line looks identical whether or not a restart just happened underneath it.
        if (phase === 'restart') {
          appendLog(`⚠ Round stalled - restarting with a wider step (stepSize=${r.stepSize.toFixed(4)}, stall ${r.stallStreak}/${r.maxStallRestarts} in a row, ${r.restarts} restart${r.restarts === 1 ? '' : 's'} total${r.willStopNow ? ' - giving up after this' : ''})`);
          return;
        }
        const label = phase === 'scatter' ? `Scatter frequency ${i + 1}` : `Step ${i + 1}`;
        const multLabel = mult == null ? '' : `  mult=${mult.toFixed(3)}`;
        appendLog(`[${label}]${multLabel}  RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  err=${r.error.toFixed(4)}  (best err=${best.error.toFixed(4)})`);
        // Only Phase 2 ('shape') carries a full live candidate reel table (r.trial) - Phase 1
        // ('scatter') only ever scales trigger symbols, which are excluded from Phase 2's
        // search entirely, so every value symbol's frequency is still exactly its baseline
        // value during Phase 1 anyway; nothing to update yet.
        if (phase === 'shape' && r.trial) {
          updateLiveTable(r.trial);
        }
      }
    );

    const rtpConverged = !!diagnostics.rtpPhase?.converged;
    const scatterConverged = diagnostics.scatterPhase == null || !!diagnostics.scatterPhase.converged;
    appendLog(
      rtpConverged && scatterConverged
        ? `Done. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%`
        : `⚠ Did NOT converge. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%  (this is the closest attempt found, not a successful tune)`
    );
    console.log('Frequency tuner diagnostics:', diagnostics);

    let html = `<p style="font-size: 0.85em; color: #ccc; margin: 12px 0 8px;">Achieved RTP: <strong>${rtp.toFixed(2)}%</strong> &nbsp;|&nbsp; Free spin trigger rate: <strong>${triggerRatePct.toFixed(3)}%</strong> (1 in ${(100 / triggerRatePct).toFixed(0)})</p>`;

    // Only shown when the user actually asked for uniformity to be enforced - it's a soft
    // steer, never a pass/fail state, so this is informational only (see uniformityPenaltyWeight's
    // own doc for why it never gates the reason banner above/below).
    if (options.uniformityPenaltyWeight > 0 && diagnostics.rtpPhase) {
      html += `<p style="font-size: 0.78em; color: #999; margin: 0 0 10px;">Uniformity penalty remaining: <strong>${diagnostics.rtpPhase.uniformityPenaltyRemaining.toFixed(3)}</strong> (lower means the tunable symbols on each reel ended up closer to an equal split of that reel's budget).</p>`;
    }

    const targetRtp = options.targetRtp;
    const reason = diagnostics.rtpPhase?.reason;
    if (reason && reason !== 'converged') {
      const rp = diagnostics.rtpPhase;
      const rangeNote = rp.rtpRange
        ? ` RTP ranged from ${rp.rtpRange.min.toFixed(2)}% to ${rp.rtpRange.max.toFixed(2)}% during the search.`
        : '';
      let message;
      if (reason === 'converged-with-violations') {
        const totalViolations = rp.orderingViolations.length + rp.limitViolations.length;
        message = `<strong>⚠ Target RTP (${targetRtp}%) was reached, but ${rp.orderingViolations.length} ordering / ` +
          `${rp.limitViolations.length} limit violation${totalViolations === 1 ? '' : 's'} remain</strong> ` +
          `(totaling ${rp.orderingPenaltyRemaining.toFixed(3)} / ${rp.limitPenaltyRemaining.toFixed(3)}) - the search stopped trying to ` +
          `resolve them further after ${rp.restarts} restart${rp.restarts === 1 ? '' : 's'}.`;
      } else if (reason === 'stalled') {
        message = `<strong>⚠ Target RTP (${targetRtp}%) was NOT reached</strong> - the search gave up after ${rp.restarts} restart${rp.restarts === 1 ? '' : 's'} ` +
          `with no further improvement on RTP, ordering, or limits (used ${rp.iterationsRun} of ${rp.iterationsBudget} iterations). ` +
          `The closest attempt found is off by ${rp.error.toFixed(2)} percentage points. Raising Max Iterations alone is unlikely to help - ` +
          `check whether the current frequencies/payouts allow ${targetRtp}% RTP at all.`;
      } else { // 'exhausted'
        message = `<strong>⚠ Target RTP (${targetRtp}%) was NOT reached</strong> - the closest attempt found is off by ${rp.error.toFixed(2)} ` +
          `percentage points, and the search was still improving when it ran out of iterations (used all ${rp.iterationsBudget}). ` +
          `Try raising Max Iterations.`;
      }
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 ${message}${rangeNote}
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
    reelFrequencyTables.forEach((baseReelTableWrapper, reelIdx) => {
      const baseReelTable = baseReelTableWrapper.symbols || baseReelTableWrapper;
      const tunedReelTable = (tunedReelTables[reelIdx].symbols || tunedReelTables[reelIdx]);
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
                    <td style="padding: 3px;">${renderSymbolLabel(symbol, paytable, paytable[symbol]?.friendlyName || symbol)}</td>
                    <td style="text-align: right; padding: 3px;">${current.toFixed(4)}</td>
                    <td style="text-align: right; padding: 3px; font-weight: bold;">${suggested.toFixed(4)}</td>
                    <td style="text-align: right; padding: 3px; color: ${deltaColor};">${delta >= 0 ? '+' : ''}${delta.toFixed(4)}</td>
                  </tr>`;
      });
      html += `</tbody></table></div>`;
    });
    html += `</div>`;
    html += `<p style="font-size: 0.75em; color: #888; margin-top: 10px;">This is a suggestion only - apply it by replacing FREQUENCY_REEL1/2/3 in game.js and reloading, so REEL_STRIPS regenerates from the new weights. Or keep refining it right here without leaving the panel:</p>`;

    html += `<div style="margin: 8px 0 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                <button id="tune-continue-btn" class="btn-icon btn-sim-btn" style="padding: 6px 14px; font-size: 0.8em;">CONTINUE TUNING FROM THIS RESULT</button>
                ${reelFrequencyTables !== originalReelFrequencyTables
                  ? `<button id="tune-reset-btn" class="btn-icon btn-sim-btn" style="padding: 6px 14px; font-size: 0.8em; opacity: 0.75;">RESET TO ORIGINAL BASELINE</button>`
                  : ''}
              </div>`;

    html += `<div style="margin-top: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">Copy-paste ready FREQUENCY_REEL tables</span>
                  <button id="tune-copy-btn" class="btn-icon btn-sim-btn" style="padding: 4px 10px; font-size: 0.75em;">COPY</button>
                </div>
                <textarea id="tune-paytable-output" readonly style="width: 100%; height: 200px; box-sizing: border-box; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.4); color: #ddd; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 8px; resize: vertical;"></textarea>
              </div>`;

    resultsEl.innerHTML = html;

    // Re-runs startTuning with this result as the new baseline (whatever's currently in the
    // form - Target RTP, Trial Spins, etc. - carries over untouched, since none of that is
    // rebuilt here) - lets the user iteratively refine across multiple runs without leaving
    // the panel to copy-paste back into game.js and reload each time.
    resultsEl.querySelector('#tune-continue-btn').addEventListener('click', () => {
      startTuning({ paytable, reelFrequencyTables: tunedReelTables, tuneConfig, tuneContainer, originalReelFrequencyTables });
    });
    // Only rendered once a run has actually diverged from the original baseline (see the html
    // build above) - lets the user back out of a chain of continued runs without reloading.
    const resetBtn = resultsEl.querySelector('#tune-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        startTuning({ paytable, reelFrequencyTables: originalReelFrequencyTables, tuneConfig, tuneContainer, originalReelFrequencyTables });
      });
    }

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
    biasStrengthInputs.forEach(el => { el.disabled = false; });
    startBtn.disabled = false;
    startBtn.textContent = 'START TUNING';
  }
}
