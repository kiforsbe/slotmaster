import { renderSymbolLabel } from './TuningSymbolPresentation.js';

// The completed-tune counterpart to the live frequency gauge. It deliberately
// receives only data and returns HTML, so the controller owns run lifecycle and
// this module remains directly testable.
export function renderFrequencyComparisonTables({ reelFrequencyTables, tunedReelTables, paytable }) {
  let html = '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;">';
  reelFrequencyTables.forEach((baseReelTableWrapper, reelIdx) => {
    const baseReelTable = baseReelTableWrapper.symbols || baseReelTableWrapper;
    const tunedReelTable = tunedReelTables[reelIdx].symbols || tunedReelTables[reelIdx];
    html += `<div><h4 style="margin: 0 0 6px; font-size: 0.8em; color: #aaa; text-transform: uppercase;">Reel ${reelIdx + 1}</h4>`;
    html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.85em;">
      <thead><tr style="color: #888; font-size: 0.75em; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.15);">
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
    html += '</tbody></table></div>';
  });
  return `${html}</div>`;
}
