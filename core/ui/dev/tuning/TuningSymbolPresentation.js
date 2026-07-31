// Shared symbol presentation for tuning tables. Kept apart from reports because
// both the live gauge and final result table display the same symbol metadata.
export function symbolTypeColor(type) {
  switch (type) {
    case 'scatter': return '#ffd700';
    case 'wild': return '#c792ea';
    case 'premium': return '#7ec8ff';
    case 'regular': return '#eee';
    default: return '#888';
  }
}

export function renderSymbolLabel(symbol, paytable, displayText = symbol) {
  const meta = paytable?.[symbol];
  const type = meta?.type || 'other';
  const friendlyName = meta?.friendlyName || symbol;
  const color = symbolTypeColor(type);
  const title = `${friendlyName} (${type})`;
  return `<span title="${title}" style="color: ${color}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${displayText}</span>`;
}
