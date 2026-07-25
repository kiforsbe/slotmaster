// Dev-tooling UI panel for viewing SlotEngine's live per-spin log in-game (see core/SpinLog.js
// for the shared entry shape/CSV export, and core/SimulationPanel.js for the sibling RUN
// SIMULATION/TUNE FREQUENCIES panels this one shares its modal DOM with).
import { summarizeSpinWins, exportSpinLogCsv } from './SpinLog.js';

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Caps how many rows the live viewer table renders at once - SlotEngine.spinLog itself can hold
// up to 20,000 entries (see its own SPIN_LOG_MAX_ENTRIES), far more than is sane to put in the
// DOM at once. Export still covers the whole (capped) log regardless of this limit.
const SPIN_LOG_VIEW_ROWS = 300;

function renderSpinLogPanelContents(container, engine) {
  const spinLog = engine.spinLog || [];
  const shown = spinLog.slice(-SPIN_LOG_VIEW_ROWS).reverse(); // most recent first

  let html = '<h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Live Spin Log</h3>';
  html += `<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; font-size: 0.85em; color: #aaa;">
              <span>${spinLog.length.toLocaleString()} spin${spinLog.length === 1 ? '' : 's'} logged this session${spinLog.length > SPIN_LOG_VIEW_ROWS ? ` (showing most recent ${SPIN_LOG_VIEW_ROWS})` : ''}</span>
              <button id="spinlog-refresh-btn" class="btn-icon btn-sim-btn" style="padding: 6px 14px; font-size: 0.9em;">REFRESH</button>
              <button id="spinlog-export-btn" class="btn-icon btn-sim-btn" style="padding: 6px 14px; font-size: 0.9em;">EXPORT CSV</button>
            </div>`;

  if (shown.length === 0) {
    html += '<div style="color: #666; font-style: italic;">No spins logged yet - spin a few times, then hit Refresh.</div>';
  } else {
    html += `<div style="max-height: 420px; overflow-y: auto;">
              <table style="width: 100%; border-collapse: collapse; font-size: 0.85em;">
                <thead><tr style="color: #888; text-transform: uppercase; position: sticky; top: 0; background: #1a1a1f;">
                  <th style="text-align: right; padding: 4px 8px;">#</th>
                  <th style="text-align: left; padding: 4px 8px;">Time</th>
                  <th style="text-align: left; padding: 4px 8px;">Phase</th>
                  <th style="text-align: right; padding: 4px 8px;">Seed</th>
                  <th style="text-align: right; padding: 4px 8px;">Bet</th>
                  <th style="text-align: right; padding: 4px 8px;">Win</th>
                  <th style="text-align: left; padding: 4px 8px;">Wins</th>
                </tr></thead><tbody>`;
    shown.forEach(entry => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const winColor = entry.totalWin > 0 ? '#7effa0' : '#888';
      html += `<tr>
                  <td style="text-align: right; padding: 3px 8px; color: #888;">${entry.spinIndex}</td>
                  <td style="padding: 3px 8px; color: #aaa;">${time}</td>
                  <td style="padding: 3px 8px; color: ${entry.phase === 'free' ? '#ffd700' : '#ccc'};">${entry.phase}</td>
                  <td style="text-align: right; padding: 3px 8px; color: #666;">${entry.seed}</td>
                  <td style="text-align: right; padding: 3px 8px;">$${fmt(entry.totalBet)}</td>
                  <td style="text-align: right; padding: 3px 8px; color: ${winColor}; font-weight: ${entry.totalWin > 0 ? 'bold' : 'normal'};">$${fmt(entry.totalWin)}</td>
                  <td style="padding: 3px 8px; color: #999;">${summarizeSpinWins(entry) || '—'}</td>
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

/**
 * Opens (or refreshes) a live view of SlotEngine's own per-spin log (SlotEngine.spinLog) -
 * every spin made during actual interactive play (not a simulated batch), each with its own
 * bet/win/seed/timestamp, plus a button to export the full (capped) log as CSV. Re-reads
 * engine.spinLog fresh every time it's (re)opened or its own Refresh button is clicked, so it
 * always reflects spins made since the panel was last shown.
 * @param {Object} args
 * @param {Object} args.engine - a SlotEngine instance (reads its live .spinLog)
 * @param {Object} args.domRefs - { simModal, simStats }
 */
export function openSpinLogPanel({ engine, domRefs }) {
  const { simModal, simStats } = domRefs;
  let container = simModal.querySelector('#spinlog-details');
  if (!container) {
    container = document.createElement('div');
    container.id = 'spinlog-details';
    container.style.marginTop = '20px';
    container.style.padding = '15px';
    container.style.background = 'rgba(255, 255, 255, 0.1)';
    container.style.borderRadius = '12px';
    container.style.fontSize = '0.9em';
    simModal.appendChild(container);
  }
  container.style.display = '';

  renderSpinLogPanelContents(container, engine);

  // Mirrors openTuneFrequenciesPanel's own hiding of simStats when it takes over the shared
  // modal - the other detail panels (#sim-details, #tune-details) aren't touched by either,
  // a pre-existing minor overlap quirk in this shared-modal setup, not something introduced here.
  if (simStats) simStats.style.display = 'none';

  simModal.style.display = 'block';
  simModal.style.maxWidth = '1100px';
  simModal.style.width = '95%';
}
