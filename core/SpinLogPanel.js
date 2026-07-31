// Dev-tooling UI panel for viewing SlotEngine's live per-spin log in-game (see core/SpinLog.js
// for the shared entry shape/CSV export, and core/SimulationPanel.js/core/TuningPanel.js for the
// sibling developer panels).
import { summarizeSpinWins, exportSpinLogCsv } from './SpinLog.js';
import { showDeveloperPanel } from './ui/DeveloperPanels.js';

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Caps how many rows the live viewer table renders at once - SlotEngine.spinLog itself can hold
// up to 20,000 entries (see its own SPIN_LOG_MAX_ENTRIES), far more than is sane to put in the
// DOM at once. Export still covers the whole (capped) log regardless of this limit.
const SPIN_LOG_VIEW_ROWS = 300;

function renderSpinLogPanelContents(container, engine) {
  const spinLog = engine.spinLog || [];
  const shown = spinLog.slice(-SPIN_LOG_VIEW_ROWS).reverse(); // most recent first

  let html = `<div class="spinlog-toolbar">
              <span>${spinLog.length.toLocaleString()} spin${spinLog.length === 1 ? '' : 's'} logged this session${spinLog.length > SPIN_LOG_VIEW_ROWS ? ` (showing most recent ${SPIN_LOG_VIEW_ROWS})` : ''}</span>
              <div class="spinlog-actions">
                <button id="spinlog-refresh-btn" class="btn-icon btn-sim-btn">REFRESH</button>
                <button id="spinlog-export-btn" class="btn-icon btn-sim-btn">EXPORT CSV</button>
              </div>
            </div>`;

  if (shown.length === 0) {
    html += '<div class="spinlog-empty">No spins logged yet - spin a few times, then hit Refresh.</div>';
  } else {
    html += `<div class="spinlog-table-scroll">
              <table class="spinlog-table">
                <thead><tr>
                  <th class="is-number">#</th>
                  <th>Time</th>
                  <th>Phase</th>
                  <th class="is-number">Seed</th>
                  <th class="is-number">Bet</th>
                  <th class="is-number">Win</th>
                  <th>Wins</th>
                </tr></thead><tbody>`;
    shown.forEach(entry => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const winColor = entry.totalWin > 0 ? '#7effa0' : '#888';
      html += `<tr>
                  <td class="is-number is-muted">${entry.spinIndex}</td>
                  <td class="is-muted">${time}</td>
                  <td class="${entry.phase === 'free' ? 'is-free' : ''}">${entry.phase}</td>
                  <td class="is-number is-dim">${entry.seed}</td>
                  <td class="is-number">$${fmt(entry.totalBet)}</td>
                  <td class="is-number ${entry.totalWin > 0 ? 'is-win' : 'is-muted'}">$${fmt(entry.totalWin)}</td>
                  <td class="is-wins">${summarizeSpinWins(entry) || '—'}</td>
                </tr>`;
    });
    html += '</tbody></table></div>';
  }

  container.innerHTML = html;
  container.querySelector('#spinlog-refresh-btn').addEventListener('click', () => renderSpinLogPanelContents(container, engine));
  container.querySelector('#spinlog-export-btn').addEventListener('click', () => {
    if (spinLog.length === 0) { alert('No spins logged yet.'); return; }
    exportSpinLogCsv(spinLog, { filenamePrefix: 'live_spinlog' });
  });
}

function stopSpinLogAutoUpdate(panel) {
  panel.__spinLogAutoUpdate?.();
  panel.__spinLogAutoUpdate = null;
}

function startSpinLogAutoUpdate(panel, container, engine) {
  stopSpinLogAutoUpdate(panel);

  const recorder = engine.spinLogRecorder;
  let stopped = false;
  const refresh = () => {
    if (!stopped && panel.style.display !== 'none' && container.isConnected) {
      renderSpinLogPanelContents(container, engine);
    }
  };
  const unsubscribe = recorder?.subscribe?.(refresh);

  // Core games use SpinLogRecorder's event hook. Keep a small fallback for compatible engines
  // that expose only a mutable `spinLog` array, so the panel remains genuinely live there too.
  const fallbackTimer = typeof recorder?.subscribe === 'function' ? null : setInterval(refresh, 500);
  panel.__spinLogAutoUpdate = () => {
    stopped = true;
    unsubscribe?.();
    if (fallbackTimer) clearInterval(fallbackTimer);
  };
}

/**
 * Opens (or refreshes) a live view of SlotEngine's own per-spin log (SlotEngine.spinLog) -
 * every spin made during actual interactive play (not a simulated batch), each with its own
 * bet/win/seed/timestamp, plus a button to export the full (capped) log as CSV. Re-reads
 * engine.spinLog fresh every time it's (re)opened or its own Refresh button is clicked, so it
 * always reflects spins made since the panel was last shown.
 * @param {Object} args
 * @param {Object} args.engine - a SlotEngine instance (reads its live .spinLog)
 * @param {Object} args.domRefs - { panel }
 */
export function openSpinLogPanel({ engine, domRefs }) {
  const { simModal, panel = simModal } = domRefs;
  if (!panel) return;
  let container = panel.querySelector('#spinlog-details');
  if (!container) {
    container = document.createElement('div');
    container.id = 'spinlog-details';
    panel.appendChild(container);
  }
  container.className = 'spinlog-body';
  container.style.display = '';

  renderSpinLogPanelContents(container, engine);

  showDeveloperPanel(panel);
  startSpinLogAutoUpdate(panel, container, engine);
}
