// Shared paytable presentation for line-pay and cluster-pay games. Game coordinators provide
// their rules data; this module owns the consistent, readable presentation.

const asMultiplier = (value) => `${Number(value).toFixed(2)}x`;

function symbolIconMarkup(symbol, assets, size = 28) {
  const animation = assets?.symbols?.tiles?.[symbol];
  const tile = animation?.frameAt?.() || animation?.frames?.[0]?.tile || animation?.frames?.[0] || animation;
  const sheetUrl = assets?.symbols?.sheetUrl;
  if (!tile || !sheetUrl) return `<span class="slot-paytable-fallback-symbol">◆</span>`;
  const scale = size / tile.w;
  return `<span class="slot-paytable-icon" style="width:${size}px;height:${Math.round(tile.h * scale)}px"><img src="${sheetUrl}" alt="" style="transform:scale(${scale}) translate(${-tile.x}px,${-tile.y}px)"></span>`;
}

function symbolMarkup(symbol, meta, renderSymbol) {
  const icon = renderSymbol?.(symbol, meta) || '';
  return `${icon}<span class="slot-paytable-symbol-name">${meta.friendlyName || symbol}</span>`;
}

function clusterHeaderMarkup(symbol, meta, renderSymbol) {
  const icon = renderSymbol?.(symbol, meta) || '';
  return `<div class="slot-paytable-header"><span class="slot-paytable-header-icon">${icon}</span><span class="slot-paytable-header-name">${meta.friendlyName || symbol}</span></div>`;
}

function makeLinePreview(container, paylines, rows = 3) {
  if (!container || !paylines?.length) return;
  container.innerHTML = '';
  container.className = 'slot-paytable-line-preview';
  paylines.forEach((path, index) => {
    const item = document.createElement('div');
    item.className = 'slot-payline-mini';
    item.title = `Payline ${index + 1}`;
    item.setAttribute('aria-label', `Payline ${index + 1}`);
    const grid = document.createElement('div');
    grid.className = 'slot-payline-mini-grid';
    path.forEach(row => {
      const column = document.createElement('div');
      column.className = 'slot-payline-mini-column';
      for (let cell = 0; cell < rows; cell++) {
        const dot = document.createElement('i');
        dot.className = cell === row ? 'active' : '';
        column.appendChild(dot);
      }
      grid.appendChild(column);
    });
    item.append(grid);
    const label = document.createElement('b');
    label.textContent = `L${index + 1}`;
    item.append(label);
    container.appendChild(item);
  });
}

export function renderLinePaytable({
  container,
  paytable,
  paylines = [],
  reelsCount = 5,
  assets,
  scatterTriggerCount,
  freeSpinsAward,
  renderSymbol,
  paylinePreviewContainer,
}) {
  if (!container) return;
  container.classList.add('slot-paytable-host');
  const symbols = Object.entries(paytable);
  const lineSymbols = symbols.filter(([, meta]) => meta.type !== 'scatter' && meta.paymode !== 'any');
  const scatterSymbols = symbols.filter(([, meta]) => meta.type === 'scatter' || meta.paymode === 'any');
  const hits = Array.from({ length: reelsCount }, (_, index) => index + 1)
    .filter(hit => {
      const payingSymbols = lineSymbols.filter(([, meta]) => Number(meta.payout?.[hit - 1]) > 0).length;
      return payingSymbols / Math.max(lineSymbols.length, 1) >= 0.2;
    });
  const table = document.createElement('table');
  table.className = 'slot-paytable-table slot-line-paytable';
  table.innerHTML = `<thead><tr><th>Symbol</th>${hits.map(hit => `<th>${hit} hits</th>`).join('')}</tr></thead>`;
  const body = document.createElement('tbody');

  for (const [symbol, meta] of lineSymbols) {
    const row = document.createElement('tr');
    const symbolCell = document.createElement('th');
    symbolCell.className = 'slot-paytable-symbol-cell';
    symbolCell.innerHTML = `${renderSymbol?.(symbol, meta) || symbolIconMarkup(symbol, assets)}<span class="slot-paytable-symbol-name">${meta.friendlyName || symbol}</span>`;
    row.appendChild(symbolCell);

    hits.forEach(hit => {
      const cell = document.createElement('td');
      const payout = meta.payout?.[hit - 1];
      cell.textContent = payout > 0 ? asMultiplier(payout) : '—';
      if (payout > 0) cell.className = 'has-payout';
      row.appendChild(cell);
    });

    const notes = [];
    if (meta.paymode === 'any' || meta.type === 'scatter') notes.push('pays anywhere');
    if (meta.wild) notes.push('Wild');
    if (meta.wildPenalty) notes.push(`Wild −${asMultiplier(meta.wildPenalty)}`);
    if (meta.aloneBonus) notes.push(`Reel bonus ${asMultiplier(meta.aloneBonus)}`);
    if (meta.triggerFreeSpins && scatterTriggerCount) {
      notes.push(`${scatterTriggerCount}+ triggers ${freeSpinsAward || ''} free spins`);
    }
    if (notes.length) row.dataset.rules = notes.join(' · ');
    body.appendChild(row);
  }
  table.appendChild(body);
  const defaultRule = document.createElement('p');
  defaultRule.className = 'slot-paytable-default-rule';
  defaultRule.textContent = 'Line wins pay left to right on active paylines. Values are multipliers of the line bet.';
  container.replaceChildren(defaultRule, table);

  const legend = lineSymbols.map(([symbol, meta]) => {
    const notes = [];
    if (meta.paymode === 'any' || meta.type === 'scatter') notes.push('pays anywhere');
    if (meta.wild) notes.push('wild');
    if (meta.wildPenalty) notes.push(`wild −${asMultiplier(meta.wildPenalty)}`);
    if (meta.aloneBonus) notes.push(`reel bonus ${asMultiplier(meta.aloneBonus)}`);
    if (meta.triggerFreeSpins && scatterTriggerCount) notes.push(`${scatterTriggerCount}+ triggers ${freeSpinsAward || ''} free spins`);
    return notes.length ? `<span class="slot-paytable-legend-item"><b>${meta.friendlyName || symbol}</b> · ${notes.join(' · ')}</span>` : '';
  }).filter(Boolean).join('');
  if (legend) container.insertAdjacentHTML('beforeend', `<div class="slot-paytable-legend">${legend}</div>`);

  if (scatterSymbols.length) {
    const scatterHits = Array.from({ length: reelsCount }, (_, index) => index + 1)
      .filter(hit => scatterSymbols.some(([, meta]) => Number(meta.payout?.[hit - 1]) > 0));
    const scatter = document.createElement('section');
    scatter.className = 'slot-paytable-scatter';
    scatter.innerHTML = `<h3>Scatter pays</h3><p class="slot-paytable-default-rule">Scatters pay anywhere on the reels and do not use paylines.</p>`;
    const scatterTable = document.createElement('table');
    scatterTable.className = 'slot-paytable-table';
    scatterTable.innerHTML = `<thead><tr><th>Symbol</th>${scatterHits.map(hit => `<th>${hit} scatters</th>`).join('')}</tr></thead>`;
    const scatterBody = document.createElement('tbody');
    scatterSymbols.forEach(([symbol, meta]) => {
      const row = document.createElement('tr');
      row.innerHTML = `<th class="slot-paytable-symbol-cell">${renderSymbol?.(symbol, meta) || symbolIconMarkup(symbol, assets)}<span class="slot-paytable-symbol-name">${meta.friendlyName || symbol}</span></th>${scatterHits.map(hit => {
        const payout = meta.payout?.[hit - 1];
        return `<td class="${payout > 0 ? 'has-payout' : ''}">${payout > 0 ? asMultiplier(payout) : '—'}</td>`;
      }).join('')}`;
      scatterBody.appendChild(row);
    });
    scatterTable.appendChild(scatterBody);
    scatter.appendChild(scatterTable);
    container.appendChild(scatter);
  }

  if (paylines.length) {
    const preview = paylinePreviewContainer || document.createElement('div');
    if (!paylinePreviewContainer) container.parentElement?.appendChild(preview);
    makeLinePreview(preview, paylines, 3);
  }
}

export function renderClusterPaytable({
  container,
  paytable,
  scatterTriggerCount,
  freeSpinsAward,
  renderSymbol,
}) {
  if (!container) return;
  container.classList.add('slot-paytable-host');
  const paying = Object.entries(paytable)
    .filter(([, meta]) => Array.isArray(meta.clusterPayout) && meta.clusterPayout.length)
    .sort(([, a], [, b]) => b.clusterPayout.at(-1).multiplier - a.clusterPayout.at(-1).multiplier);
  const sizes = [...new Set(paying.flatMap(([, meta]) => meta.clusterPayout.map(tier => tier.min)))].sort((a, b) => a - b);
  const largest = sizes.at(-1);
  const table = document.createElement('table');
  table.className = 'slot-paytable-table slot-cluster-paytable';
  const head = `<thead><tr><th class="slot-paytable-axis-header"><div class="slot-paytable-header"><span class="slot-paytable-header-icon" aria-hidden="true"></span><span class="slot-paytable-header-name">Cluster</span></div></th>${paying.map(([symbol, meta]) => `<th>${clusterHeaderMarkup(symbol, meta, renderSymbol)}</th>`).join('')}</tr></thead>`;
  const rows = [...sizes].reverse().map(size => {
    const cells = paying.map(([, meta]) => {
      const tier = meta.clusterPayout.filter(entry => entry.min <= size).at(-1);
      return `<td class="${tier ? 'has-payout' : ''}">${tier ? asMultiplier(tier.multiplier) : '—'}</td>`;
    }).join('');
    return `<tr class="${size === largest ? 'top-tier' : ''}"><th>${size}${size === largest ? '+' : ''}</th>${cells}</tr>`;
  }).join('');
  table.innerHTML = `${head}<tbody>${rows}</tbody>`;

  const notes = Object.entries(paytable)
    .filter(([, meta]) => !Array.isArray(meta.clusterPayout))
    .map(([symbol, meta]) => `<p class="slot-paytable-note">${symbolMarkup(symbol, meta, renderSymbol)} <span>pays anywhere${meta.triggerFreeSpins && scatterTriggerCount ? ` · ${scatterTriggerCount}+ triggers ${freeSpinsAward || ''} free spins` : ''}</span></p>`)
    .join('');
  const defaultRule = document.createElement('p');
  defaultRule.className = 'slot-paytable-default-rule';
  defaultRule.textContent = 'Clusters pay for orthogonally connected symbols anywhere on the grid. Values are multipliers of the total bet.';
  container.replaceChildren(defaultRule, table);
  if (notes) container.insertAdjacentHTML('beforeend', notes);
}
