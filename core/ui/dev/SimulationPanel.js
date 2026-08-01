// Simulation-results developer panel. This module owns the simulation run and its detailed
// win breakdown; it never constructs or mutates the tuning UI.
import { exportSpinLogCsv } from '../../logging/SpinLog.js';
import { showDeveloperPanel } from '../DeveloperPanels.js';

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtInt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

function renderWinTable(counts, hitLabel, accentColor, emptyText) {
  const sortedKeys = Object.keys(counts).sort((a, b) => a - b);
  if (sortedKeys.length === 0) {
    return `<div style="color: #666; font-style: italic; font-size: 0.8em; padding: 4px 0;">${emptyText}</div>`;
  }
  let html = `<table style="width: 100%; border-collapse: collapse; font-size: 0.9em; margin-top: 4px;">`;
  html += `<thead><tr style="color: #888; font-size: 0.75em; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.1);">
              <th style="text-align: left; font-weight: 600; padding: 4px 4px 6px 0;">${hitLabel}</th>
              <th style="text-align: right; font-weight: 600; padding: 4px 4px 6px;">Wins</th>
              <th style="text-align: right; font-weight: 600; padding: 4px 4px 6px;">Avg Win</th>
              <th style="text-align: right; font-weight: 600; padding: 4px 0 6px;">Total Win</th>
            </tr></thead><tbody>`;
  sortedKeys.forEach(key => {
    const data = counts[key];
    const avg = data.totalAmount / data.count;
    html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
                <td style="padding: 4px 4px 4px 0; color: ${accentColor}; font-weight: 600;">${key}</td>
                <td style="text-align: right; padding: 4px;">${fmtInt(data.count)}</td>
                <td style="text-align: right; padding: 4px; color: #ddd;">$${fmt(avg)}</td>
                <td style="text-align: right; padding: 4px 0; font-weight: 700; color: #fff;">$${fmt(data.totalAmount)}</td>
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
  if (symbols.length === 0) return `<div style="color: #666; font-style: italic; font-size: 0.85em; margin-bottom: 12px;">No wins found for ${title}</div>`;
  let sectionHtml = `<h4 style="margin: 20px 0 10px 0; color: #888; text-transform: uppercase; font-size: 0.75em; letter-spacing: 1.5px; font-weight: 700;">${title}</h4>`;
  sectionHtml += `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px;">`;

  symbols.forEach(symbol => {
    const stats = symbolStats[symbol] || { counts: {}, wildAssisted: { counts: {} }, alone: { counts: {} }, expanding: { counts: {} } };
    const friendlyName = paytable[symbol]?.friendlyName || symbol;
    const isScatter = paytable[symbol]?.type === 'scatter';

    sectionHtml += `<div style="border: 1px solid rgba(255,255,255,0.12); padding: 14px; border-radius: 10px; background: rgba(0, 0, 0, 0.25); box-shadow: 0 4px 12px rgba(0,0,0,0.15);">`;
    sectionHtml += `<strong style="display: block; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; color: #fff; font-size: 0.95em;">${friendlyName}</strong>`;

    sectionHtml += `<div style="margin-bottom: 8px;">`;
    sectionHtml += `<span style="font-size: 0.7em; color: #aaa; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px;">${isScatter ? 'Scatter Wins' : labels.primaryHeader}</span>`;
    sectionHtml += renderWinTable(stats.counts, labels.hitLabel, '#4ade80', isScatter ? 'No scatter wins' : `No ${labels.primaryHeader.toLowerCase()}`);
    sectionHtml += `</div>`;

    if (stats.wildAssisted && Object.keys(stats.wildAssisted.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 10px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #60a5fa; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px;">Wild-Assisted Wins</span>`;
      sectionHtml += renderWinTable(stats.wildAssisted.counts, 'Natural Hits', '#60a5fa', '');
      sectionHtml += `</div>`;
    }

    if (stats.alone && Object.keys(stats.alone.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 10px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #f97316; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px;">Alone Bonus</span>`;
      sectionHtml += renderWinTable(stats.alone.counts, 'Landed', '#f97316', '');
      sectionHtml += `</div>`;
    }

    if (stats.expanding && Object.keys(stats.expanding.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 10px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #eab308; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px;">Expanding Wins</span>`;
      sectionHtml += renderWinTable(stats.expanding.counts, 'Reels', '#eab308', '');
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
  const statScope = panel || simModal;
  const resolvedSimStats = simStats || statScope?.querySelector('#sim-stats');
  const resolvedSimRtpDisplay = simRtpDisplay || statScope?.querySelector('#sim-rtp');
  const resolvedSimTotalSpinsDisplay = simTotalSpinsDisplay || statScope?.querySelector('#sim-total-spins');
  const resolvedSimMaxWinDisplay = simMaxWinDisplay || statScope?.querySelector('#sim-max-win');
  const resolvedSimFreeSpinsDisplay = simFreeSpinsDisplay || statScope?.querySelector('#sim-free-spins');
  const statHost = resolvedSimStats || statScope;

  const ensureStatNode = (existingNode, id, label) => {
    if (existingNode) return existingNode;
    if (!statHost) return null;
    let box = statHost.querySelector(`#${id}`)?.closest('.stat-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'stat-box';
      box.innerHTML = `<span class="stat-label">${label}</span><div id="${id}" class="stat-value">-</div>`;
      statHost.appendChild(box);
    }
    return box.querySelector(`#${id}`);
  };

  const statNodes = {
    stats: statHost,
    rtp: ensureStatNode(resolvedSimRtpDisplay, 'sim-rtp', 'Return to Player (RTP)'),
    totalSpins: ensureStatNode(resolvedSimTotalSpinsDisplay, 'sim-total-spins', 'Total Spins'),
    maxWin: ensureStatNode(resolvedSimMaxWinDisplay, 'sim-max-win', 'Max Win'),
    freeSpins: ensureStatNode(resolvedSimFreeSpinsDisplay, 'sim-free-spins', 'Free Spins Triggered'),
  };
  const setStatTextOrError = (node, value, fallbackMessage) => {
    if (!node) return;
    const isValid = value !== null && value !== undefined && value !== '' && !(typeof value === 'number' && Number.isNaN(value));
    node.textContent = isValid ? value : fallbackMessage;
  };

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

      if (statNodes.stats) statNodes.stats.style.display = '';
      setStatTextOrError(statNodes.rtp, results.rtp, 'Error: RTP value unavailable');
      setStatTextOrError(statNodes.totalSpins, results.totalSpins, 'Error: Total Spins value unavailable');
      setStatTextOrError(statNodes.maxWin, `$${fmt(results.maxWin)}`, 'Error: Max Win value unavailable');
      const pct = results.totalSpins > 0 ? (results.freeSpinsTriggered / results.totalSpins) * 100 : 0;
      setStatTextOrError(
        statNodes.freeSpins,
        `${results.freeSpinsTriggered} (${pct.toFixed(2)}%)`,
        'Error: Free Spins value unavailable',
      );

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
        detailsContainer.style.marginTop = '24px';
        detailsContainer.style.padding = '20px';
        detailsContainer.style.background = 'rgba(0, 0, 0, 0.2)';
        detailsContainer.style.border = '1px solid rgba(255, 255, 255, 0.08)';
        detailsContainer.style.borderRadius = '14px';
        detailsContainer.style.fontSize = '0.9em';
        panel.appendChild(detailsContainer);
      } else {
        detailsContainer.innerHTML = '';
      }

      let detailsHtml = '<h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 10px; font-size: 1.1em; letter-spacing: 0.5px;">Detailed Win Breakdown</h3>';
      detailsHtml += `<div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; font-size: 0.85em; color: #888;">
                        <span title="Pass this to engine.runSimulation(..., { seed }) to reproduce this exact run">Seed: <strong style="color: #4ade80; font-family: monospace; font-size: 1.05em;">${seed}</strong></span>
                        <button id="sim-export-log-btn" class="btn-icon btn-sim-btn" style="padding: 6px 14px; font-size: 0.85em; border-radius: 6px;">EXPORT SPIN LOG (CSV)</button>
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
