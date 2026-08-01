// Simulation-results developer panel. This module owns the simulation run and its detailed
// win breakdown; it never constructs or mutates the tuning UI.
import { exportSpinLogCsv } from '../../logging/SpinLog.js';
import { showDeveloperPanel } from '../DeveloperPanels.js';

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtInt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtPct = (n) => `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

const BUCKET_META = {
  counts: { label: 'Wins', hitLabel: 'Hits', color: '#4ade80' },
  wildAssisted: { label: 'Wild-Assisted', hitLabel: 'Natural Hits', color: '#60a5fa' },
  alone: { label: 'Alone Bonus', hitLabel: 'Landed', color: '#f97316' },
  expanding: { label: 'Expanding', hitLabel: 'Reels', color: '#eab308' },
};

function renderWinTable(counts, hitLabel, accentColor, emptyText) {
  const sortedKeys = Object.keys(counts).sort((a, b) => Number(a) - Number(b));
  if (sortedKeys.length === 0) {
    return `<div class="sim-win-empty">${emptyText}</div>`;
  }
  let html = '<table class="sim-win-table">';
  html += `<thead><tr>
    <th class="sim-win-hit" scope="col">${hitLabel}</th>
    <th class="sim-win-num" scope="col">Wins</th>
    <th class="sim-win-num" scope="col">Avg Win</th>
    <th class="sim-win-num" scope="col">Total Win</th>
  </tr></thead><tbody>`;
  sortedKeys.forEach(key => {
    const data = counts[key];
    const avg = data.totalAmount / data.count;
    html += `<tr>
      <td class="sim-win-hit" style="color: ${accentColor};">${key}</td>
      <td class="sim-win-num">${fmtInt(data.count)}</td>
      <td class="sim-win-num sim-win-muted">$${fmt(avg)}</td>
      <td class="sim-win-num sim-win-total">$${fmt(data.totalAmount)}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  return html;
}

function renderSymbolCard(symbol, stats, paytable, labels) {
  const friendlyName = paytable[symbol]?.friendlyName || symbol;
  const type = paytable[symbol]?.type || 'other';
  const isScatter = type === 'scatter';
  const primaryLabel = isScatter ? 'Scatter Wins' : labels.primaryHeader;
  const primaryEmpty = isScatter ? 'No scatter wins' : `No ${labels.primaryHeader.toLowerCase()}`;

  const buckets = [];
  buckets.push({ key: 'counts', header: primaryLabel });
  if (stats.wildAssisted && Object.keys(stats.wildAssisted.counts).length > 0) {
    buckets.push({ key: 'wildAssisted', header: 'Wild-Assisted Wins' });
  }
  if (stats.alone && Object.keys(stats.alone.counts).length > 0) {
    buckets.push({ key: 'alone', header: 'Alone Bonus' });
  }
  if (stats.expanding && Object.keys(stats.expanding.counts).length > 0) {
    buckets.push({ key: 'expanding', header: 'Expanding Wins' });
  }

  const typeBadge = type === 'other' ? '' : `<span class="sim-symbol-type">${type}</span>`;
  let html = `<article class="sim-symbol-card">`;
  html += `<header class="sim-symbol-header"><span class="sim-symbol-name">${friendlyName}</span>${typeBadge}</header>`;
  html += '<div class="sim-symbol-body">';
  buckets.forEach(({ key, header }, index) => {
    const meta = BUCKET_META[key];
    const bucketCounts = stats[key] || {};
    const isPrimary = index === 0;
    html += `<div class="sim-bucket${isPrimary ? '' : ' sim-bucket-extra'}">`;
    html += `<span class="sim-bucket-label">${header}</span>`;
    html += renderWinTable(bucketCounts, isPrimary ? labels.hitLabel : meta.hitLabel, meta.color, isPrimary ? primaryEmpty : '');
    html += '</div>';
  });
  html += '</div></article>';
  return html;
}

// `labels` overrides the primary (non-scatter, non-wild-assisted, non-alone, non-expanding)
// win bucket's header/column - defaults to the line-pay wording; a cascade mechanic's caller
// passes its own (see CascadeSpinMechanic.statsLabels: 'Cluster Wins'/'Cluster Size') so a
// cluster win doesn't get mislabeled as a payline hit.
function createSection(title, symbols, symbolStats, paytable, labels = { primaryHeader: 'Normal Wins', hitLabel: 'Hits' }) {
  if (symbols.length === 0) {
    return `<div class="sim-section-empty">No wins found for ${title}</div>`;
  }
  let html = `<section class="sim-section">`;
  html += `<h4 class="sim-section-title">${title}</h4>`;
  html += `<div class="sim-symbol-grid">`;
  symbols.forEach(symbol => {
    const stats = symbolStats[symbol] || { counts: {}, wildAssisted: { counts: {} }, alone: { counts: {} }, expanding: { counts: {} } };
    html += renderSymbolCard(symbol, stats, paytable, labels);
  });
  html += '</div></section>';
  return html;
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

function getOrCreateStatsGrid(host) {
  if (!host) return null;
  let grid = host.querySelector('#sim-stats');
  if (!grid) {
    grid = document.createElement('div');
    grid.id = 'sim-stats';
    grid.className = 'sim-stats';
    grid.setAttribute('aria-live', 'polite');
    host.appendChild(grid);
  } else {
    grid.innerHTML = '';
  }
  return grid;
}

function ensureStatCard(grid, id, label, { hero = false, wide = false } = {}) {
  if (!grid) return null;
  let box = grid.querySelector(`#${id}`)?.closest('.stat-box');
  if (!box) {
    box = document.createElement('div');
    box.className = 'stat-box';
    box.innerHTML = `<span class="stat-label">${label}</span><div id="${id}" class="stat-value">-</div>`;
    grid.appendChild(box);
  }
  if (hero) box.classList.add('stat-box-hero');
  if (wide) box.classList.add('stat-box-wide');
  return box.querySelector(`#${id}`);
}

function buildDetailsHtml({ paytable, symbolStats, labels }) {
  let html = `<header class="sim-details-header">
    <div>
      <h3 class="sim-details-title">Detailed Win Breakdown</h3>
      <p class="sim-details-subtitle">Winnings per symbol, grouped by symbol type</p>
    </div>
    <button id="sim-export-log-btn" class="btn-icon btn-sim-btn" type="button">Export Spin Log (CSV)</button>
  </header>`;
  groupSymbolsByType(paytable).forEach(({ type, symbols }) => {
    const title = type.charAt(0).toUpperCase() + type.slice(1) + ' Symbols';
    html += labels
      ? createSection(title, symbols, symbolStats, paytable, labels)
      : createSection(title, symbols, symbolStats, paytable);
  });
  return html;
}

const setStatTextOrError = (node, value, fallbackMessage) => {
  if (!node) return;
  const isValid = value !== null && value !== undefined && value !== '' && !(typeof value === 'number' && Number.isNaN(value));
  node.textContent = isValid ? value : fallbackMessage;
};

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
  const { btnSim, simModal, panel = simModal } = domRefs;
  const idleButtonMarkup = btnSim.innerHTML;
  // Always host the stats grid directly on the panel. Deliberately ignores any caller-supplied
  // simStats/simRtpDisplay/etc - those are dead params left over from a pre-stat-card-grid API
  // (DeveloperPanels.js's panels have no such static slot) - because at least one caller
  // (lemonpop) re-queries document.getElementById('sim-stats') fresh on every click. That id
  // doesn't exist before the first run, so it's null on run 1 (falls through harmlessly) but on
  // run 2+ it resolves to the very grid this function created last time, which getOrCreateStatsGrid
  // then can't recognize as itself (querySelector only searches descendants) - producing a second
  // nested #sim-stats grid instead of clearing the first.
  const statsGrid = getOrCreateStatsGrid(panel);

  const statNodes = {
    rtp: ensureStatCard(statsGrid, 'sim-rtp', 'Return to Player (RTP)'),
    totalSpins: ensureStatCard(statsGrid, 'sim-total-spins', 'Total Spins'),
    maxWin: ensureStatCard(statsGrid, 'sim-max-win', 'Max Win'),
    freeSpins: ensureStatCard(statsGrid, 'sim-free-spins', 'Free Spins Triggered'),
    seed: ensureStatCard(statsGrid, 'sim-seed', 'Overall Seed'),
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

      setStatTextOrError(statNodes.rtp, results.rtp, 'Error: RTP value unavailable');
      setStatTextOrError(statNodes.totalSpins, fmtInt(results.totalSpins), 'Error: Total Spins value unavailable');
      setStatTextOrError(statNodes.maxWin, `$${fmt(results.maxWin)}`, 'Error: Max Win value unavailable');
      const pct = results.totalSpins > 0 ? (results.freeSpinsTriggered / results.totalSpins) * 100 : 0;
      setStatTextOrError(
        statNodes.freeSpins,
        `${fmtInt(results.freeSpinsTriggered)} (${fmtPct(pct)})`,
        'Error: Free Spins value unavailable',
      );
      setStatTextOrError(statNodes.seed, seed, 'Error: Seed value unavailable');

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
        detailsContainer.className = 'sim-details';
        panel.appendChild(detailsContainer);
      }
      detailsContainer.innerHTML = buildDetailsHtml({ paytable, symbolStats, labels });

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
