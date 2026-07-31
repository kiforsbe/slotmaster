// Simulation-results developer panel. This module owns the simulation run and its detailed
// win breakdown; it never constructs or mutates the tuning UI.
import { exportSpinLogCsv } from './SpinLog.js';
import { showDeveloperPanel } from './ui/DeveloperPanels.js';

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

// `labels` overrides the primary (non-scatter, non-wild-assisted, non-alone, non-expanding)
// win bucket's header/column - defaults to the line-pay wording; a cascade mechanic's caller
// passes its own (see CascadeSpinMechanic.statsLabels: 'Cluster Wins'/'Cluster Size') so a
// cluster win doesn't get mislabeled as a payline hit.
function createSection(title, symbols, symbolStats, paytable, labels = { primaryHeader: 'Normal Wins', hitLabel: 'Hits' }) {
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
    sectionHtml += `<span style="font-size: 0.7em; color: #999; text-transform: uppercase;">${isScatter ? 'Scatter Wins' : labels.primaryHeader}</span>`;
    sectionHtml += renderWinTable(stats.counts, labels.hitLabel, '#ccc', isScatter ? 'No scatter wins' : `No ${labels.primaryHeader.toLowerCase()}`);
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
 * @param {Object} [args.labels] - Primary win-bucket header/column override for a non-line-pay
 *   mechanic (see createSection's own doc) - e.g. CascadeSpinMechanic.statsLabels for Candy
 *   Frenzy's RUN SIMULATION button. Defaults to the line-pay wording.
 * @param {Object} args.domRefs
 */
export function runSimulationAndRender({ engine, paytable, betPerLine, linesCount, numSpins = 1000000, labels, domRefs }) {
  const { btnSim, simModal, panel = simModal, simStats, simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay } = domRefs;
  const idleButtonMarkup = btnSim.innerHTML;

  btnSim.textContent = '⏳';
  btnSim.setAttribute('aria-busy', 'true');
  btnSim.disabled = true;

  setTimeout(() => {
    try {
      // Every run is seeded (even though no UI exposes the value to type back in yet) so the
      // exported spin log's "Seed" column is always meaningful provenance, not a placeholder -
      // note it down and pass it to engine.runSimulation(..., { seed }) to reproduce this run.
      const seed = Math.floor(Math.random() * 2 ** 31);
      const startedAt = new Date().toISOString();
      const results = engine.runSimulation(numSpins, betPerLine, linesCount, { seed, logSpins: true });

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

      let detailsContainer = panel.querySelector('#sim-details');
      if (!detailsContainer) {
        detailsContainer = document.createElement('div');
        detailsContainer.id = 'sim-details';
        detailsContainer.style.marginTop = '20px';
        detailsContainer.style.padding = '15px';
        detailsContainer.style.background = 'rgba(255, 255, 255, 0.1)';
        detailsContainer.style.borderRadius = '12px';
        detailsContainer.style.fontSize = '0.9em';
        panel.appendChild(detailsContainer);
      } else {
        detailsContainer.innerHTML = '';
      }

      let detailsHtml = '<h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Detailed Win Breakdown</h3>';
      detailsHtml += `<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 15px; font-size: 0.85em; color: #aaa;">
                        <span title="Pass this to engine.runSimulation(..., { seed }) to reproduce this exact run">Seed: <strong style="color: #ccc;">${seed}</strong></span>
                        <button id="sim-export-log-btn" class="btn-icon btn-sim-btn" style="padding: 6px 14px; font-size: 0.9em;">EXPORT SPIN LOG (CSV)</button>
                      </div>`;
      groupSymbolsByType(paytable).forEach(({ type, symbols }) => {
        const title = type.charAt(0).toUpperCase() + type.slice(1) + ' Symbols';
        detailsHtml += labels ? createSection(title, symbols, symbolStats, paytable, labels) : createSection(title, symbols, symbolStats, paytable);
      });
      detailsContainer.innerHTML = detailsHtml;

      detailsContainer.querySelector('#sim-export-log-btn').addEventListener('click', () => {
        exportSpinLogCsv(results.spinLog, { seed, startedAt, filenamePrefix: 'spinlog' });
      });

      showDeveloperPanel(panel);
      panel.style.maxWidth = '1200px';
      panel.style.width = '95%';
    } catch (error) {
      console.error('Simulation failed:', error);
      alert('Error running simulation');
    } finally {
      btnSim.innerHTML = idleButtonMarkup;
      btnSim.removeAttribute('aria-busy');
      btnSim.disabled = false;
    }
  }, 50);
}
