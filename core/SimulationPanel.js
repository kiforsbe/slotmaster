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
    const stats = symbolStats[symbol] || { counts: {}, expanding: { counts: {} } };
    const friendlyName = paytable[symbol]?.friendlyName || symbol;
    const isScatter = paytable[symbol]?.type === 'scatter';

    sectionHtml += `<div style="border: 1px solid rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; background: rgba(255,255,255,0.05); font-size: 0.85em;">`;
    sectionHtml += `<strong style="display: block; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">${friendlyName}</strong>`;

    sectionHtml += `<div style="margin-bottom: 8px;">`;
    sectionHtml += `<span style="font-size: 0.7em; color: #999; text-transform: uppercase;">${isScatter ? 'Scatter Wins' : 'Normal Wins'}</span>`;
    sectionHtml += renderWinTable(stats.counts, 'Hits', '#ccc', isScatter ? 'No scatter wins' : 'No standard line wins');
    sectionHtml += `</div>`;

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

      const symbolStats = {};
      results.detailedWins.forEach(win => {
        if (!symbolStats[win.symbol]) {
          symbolStats[win.symbol] = { counts: {}, expanding: { counts: {} } };
        }
        if (win.type === 'expanding') {
          if (!symbolStats[win.symbol].expanding.counts[win.count]) {
            symbolStats[win.symbol].expanding.counts[win.count] = { count: 0, totalAmount: 0 };
          }
          symbolStats[win.symbol].expanding.counts[win.count].count += 1;
          symbolStats[win.symbol].expanding.counts[win.count].totalAmount += win.winAmount;
        } else {
          if (!symbolStats[win.symbol].counts[win.count]) {
            symbolStats[win.symbol].counts[win.count] = { count: 0, totalAmount: 0 };
          }
          symbolStats[win.symbol].counts[win.count].count += 1;
          symbolStats[win.symbol].counts[win.count].totalAmount += win.winAmount;
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
 * Formats a paytable back out as a paste-ready `const PAYTABLE = { ... }` literal,
 * column-aligned. Field-agnostic: formats whichever scalar/array/boolean fields are
 * present (union across all symbols, first-seen order), so it works unchanged for
 * paytables with different field sets. `friendlyName` (if present) always renders last.
 */
export function formatPaytableForCopy(paytable) {
  const symbols = Object.keys(paytable);
  if (symbols.length === 0) return 'const PAYTABLE = {};';

  const keyWidth = Math.max(...symbols.map(s => s.length + 1));

  const fieldNames = [];
  symbols.forEach(s => {
    Object.keys(paytable[s]).forEach(field => {
      if (field !== 'payout' && field !== 'friendlyName' && !fieldNames.includes(field)) {
        fieldNames.push(field);
      }
    });
  });

  const payoutLen = paytable[symbols[0]].payout.length;
  const payoutColWidths = Array.from({ length: payoutLen }, (_, col) =>
    Math.max(...symbols.map(s => String(paytable[s].payout[col]).length))
  );
  const fmtPayout = (arr) =>
    '[' + arr.map((v, i) => String(v).padStart(payoutColWidths[i])).join(', ') + ']';

  const renderValue = (value) => {
    if (Array.isArray(value)) return `[${value.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ')}]`;
    if (typeof value === 'string') return `'${value}'`;
    return String(value);
  };

  const fmtField = (fieldName) => {
    const rendered = {};
    symbols.forEach(s => {
      rendered[s] = (fieldName in paytable[s]) ? `${fieldName}: ${renderValue(paytable[s][fieldName])},` : '';
    });
    const width = Math.max(...symbols.map(s => rendered[s].length));
    const padded = {};
    symbols.forEach(s => { padded[s] = rendered[s].padEnd(width); });
    return padded;
  };

  const fieldColumns = fieldNames.map(fmtField);

  const lines = symbols.map(symbol => {
    const data = paytable[symbol];
    const keyPart = `${symbol}:`.padEnd(keyWidth);
    const fieldsPart = fieldColumns.map(col => col[symbol]).filter(s => s.length > 0).join(' ');
    const namePart = data.friendlyName !== undefined ? ` friendlyName: '${data.friendlyName}'` : '';
    return `  ${keyPart} { payout: ${fmtPayout(data.payout)}, ${fieldsPart}${namePart} },`;
  });

  return `const PAYTABLE = {\n${lines.join('\n')}\n};`;
}

/**
 * Opens (or reuses) the frequency auto-balancer panel (SpinSimulator.js's tuneFrequencies)
 * with inputs for the tuning targets, showing live iteration-by-iteration progress. Only
 * ever reports a suggestion - never mutates the caller's live paytable/reels itself
 * (applying a result means regenerating reel strips, a deliberate source change).
 * @param {Object} args
 * @param {Object} args.paytable
 * @param {Object} args.tuneConfig - { reelsCount, rowsCount, paylines, reelSeeds, betPerLine, linesCount, reelLength, winEvaluator, wildSymbol, scatterSymbol }
 * @param {Object} args.domRefs - { simModal, simStats }
 */
export function openTuneFrequenciesPanel({ paytable, tuneConfig, domRefs }) {
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
        <label style="font-size: 0.8em; color: #ccc;">Max Iterations / Phase<br>
          <input id="tune-max-iterations" type="number" value="10" step="1" min="3" max="30" style="width: 100%; margin-top: 4px;">
        </label>
      </div>
      <button id="tune-start-btn" class="btn-close-sim">START TUNING</button>
      <div id="tune-progress-log" style="display: none; margin-top: 12px; max-height: 160px; overflow-y: auto; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;"></div>
      <div id="tune-results"></div>
    `;
    tuneContainer.querySelector('#tune-start-btn').addEventListener('click', () => startTuning({ paytable, tuneConfig, tuneContainer }));
  }

  if (simStats) simStats.style.display = 'none';

  simModal.style.display = 'block';
  simModal.style.maxWidth = '900px';
  simModal.style.width = '95%';
}

async function startTuning({ paytable, tuneConfig, tuneContainer }) {
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
  };

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
    maxIterations: parseInt(inputs.maxIterations.value, 10) || 10,
  };

  Object.values(inputs).forEach(el => { el.disabled = true; });
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
    const { paytable: tunedPaytable, rtp, triggerRatePct, diagnostics } = await tuneFrequencies(paytable, {
      ...options,
      onProgress: (phase, i, mult, r, best) => {
        const label = phase === 'scatter' ? 'Scatter frequency' : 'Premium/regular split';
        appendLog(`[${label} ${i + 1}] RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  (best so far: err=${best.error.toFixed(4)})`);
      }
    });

    appendLog(`Done. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%`);
    console.log('Frequency tuner diagnostics:', diagnostics);

    let html = `<p style="font-size: 0.85em; color: #ccc; margin: 12px 0 8px;">Achieved RTP: <strong>${rtp.toFixed(2)}%</strong> &nbsp;|&nbsp; Free spin trigger rate: <strong>${triggerRatePct.toFixed(3)}%</strong> (1 in ${(100 / triggerRatePct).toFixed(0)})</p>`;
    html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">`;
    html += `<thead><tr style="color: #888; font-size: 0.8em; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.15);">
                <th style="text-align: left; padding: 4px;">Symbol</th>
                <th style="text-align: left; padding: 4px;">Type</th>
                <th style="text-align: right; padding: 4px;">Current Freq</th>
                <th style="text-align: right; padding: 4px;">Suggested Freq</th>
                <th style="text-align: right; padding: 4px;">Δ</th>
              </tr></thead><tbody>`;
    Object.keys(paytable).forEach(symbol => {
      const current = paytable[symbol].frequency;
      const suggested = tunedPaytable[symbol].frequency;
      const delta = suggested - current;
      const deltaColor = Math.abs(delta) < 0.001 ? '#888' : (delta > 0 ? '#7fd97f' : '#e67f7f');
      html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                  <td style="padding: 4px;">${paytable[symbol].friendlyName || symbol}</td>
                  <td style="padding: 4px; color: #999;">${paytable[symbol].type}</td>
                  <td style="text-align: right; padding: 4px;">${current.toFixed(4)}</td>
                  <td style="text-align: right; padding: 4px; font-weight: bold;">${suggested.toFixed(4)}</td>
                  <td style="text-align: right; padding: 4px; color: ${deltaColor};">${delta >= 0 ? '+' : ''}${delta.toFixed(4)}</td>
                </tr>`;
    });
    html += `</tbody></table>`;
    html += `<p style="font-size: 0.75em; color: #888; margin-top: 10px;">This is a suggestion only - apply it by editing PAYTABLE's frequency values in game.js and reloading, so REEL_STRIPS regenerates from the new weights.</p>`;

    html += `<div style="margin-top: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">Copy-paste ready PAYTABLE</span>
                  <button id="tune-copy-btn" class="btn-icon btn-sim-btn" style="padding: 4px 10px; font-size: 0.75em;">COPY</button>
                </div>
                <textarea id="tune-paytable-output" readonly style="width: 100%; height: 200px; box-sizing: border-box; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.4); color: #ddd; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 8px; resize: vertical;"></textarea>
              </div>`;

    resultsEl.innerHTML = html;

    const paytableOutput = resultsEl.querySelector('#tune-paytable-output');
    paytableOutput.value = formatPaytableForCopy(tunedPaytable);

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
    startBtn.disabled = false;
    startBtn.textContent = 'START TUNING';
  }
}
