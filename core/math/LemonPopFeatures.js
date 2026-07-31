// Deterministic Lemon Pop board effects. Charge effects happen inside a base no-refill cascade;
// full Pop Rush variants prepare the one bonus respin after all three charges have been filled.
import { applyNoRefillCascade } from './CascadeMath.js';

const keyOf = ([col, row]) => `${col},${row}`;

export const POP_RUSH_VARIANTS = ['pop-rush', 'citrus-cross', 'flavor-remix', 'soda-storm'];
export const POP_FEATURES = ['wild-splash', 'flavor-shift', 'bubble-burst'];

function cloneState(grid, wildMultipliers) {
  return {
    grid: grid.map(column => column.slice()),
    wildMultipliers: wildMultipliers?.map(column => column.slice())
      || grid.map(column => new Array(column.length).fill(1)),
  };
}

function allWindows(grid, length = 3) {
  const windows = [];
  const rows = grid[0].length;
  for (let row = 0; row < rows; row++) {
    for (let start = 0; start <= grid.length - length; start++) {
      windows.push(Array.from({ length }, (_, offset) => [start + offset, row]));
    }
  }
  for (let col = 0; col < grid.length; col++) {
    for (let start = 0; start <= rows - length; start++) {
      windows.push(Array.from({ length }, (_, offset) => [col, start + offset]));
    }
  }
  return windows;
}

function valueOf(paytable, symbol) {
  return Number(paytable[symbol]?.linePayout?.[0] ?? 0);
}

function bestNearLineCandidates(grid, paytable, wildSymbol) {
  return allWindows(grid).map(positions => {
    const symbols = positions.map(([col, row]) => grid[col][row]);
    const natural = symbols.filter(symbol => symbol !== wildSymbol);
    const premiums = natural.filter(symbol => paytable[symbol]?.type === 'premium');
    const regularCounts = natural.reduce((counts, symbol) => {
      if (paytable[symbol]?.type === 'regular') counts.set(symbol, (counts.get(symbol) || 0) + 1);
      return counts;
    }, new Map());
    const regular = [...regularCounts.entries()].sort((a, b) => b[1] - a[1] || valueOf(paytable, b[0]) - valueOf(paytable, a[0]))[0];
    const premiumTarget = premiums.sort((a, b) => valueOf(paytable, b) - valueOf(paytable, a))[0];
    const target = premiumTarget || regular?.[0] || null;
    const compatibleCount = premiumTarget
      ? premiums.length + symbols.filter(symbol => symbol === wildSymbol).length
      : (regular?.[1] || 0) + symbols.filter(symbol => symbol === wildSymbol).length;
    const missing = positions.filter(([col, row]) => {
      const symbol = grid[col][row];
      return premiumTarget
        ? symbol !== wildSymbol && paytable[symbol]?.type !== 'premium'
        : symbol !== target && symbol !== wildSymbol;
    });
    return { positions, target, premiumTarget: !!premiumTarget, compatibleCount, missing, value: target ? valueOf(paytable, target) : 0 };
  }).filter(candidate => candidate.target && candidate.compatibleCount >= 2 && candidate.missing.length > 0)
    .sort((a, b) => b.value - a.value || a.missing.length - b.missing.length);
}

function setWild(state, [col, row], wildSymbol, multiplier = 1) {
  state.grid[col][row] = wildSymbol;
  state.wildMultipliers[col][row] = Math.max(state.wildMultipliers[col][row] ?? 1, multiplier);
}

function shuffled(items, rng) {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function everyPosition(grid) {
  return grid.flatMap((column, col) => column.map((_, row) => [col, row]));
}

function naturalSymbols(paytable, wildSymbol) {
  return Object.keys(paytable).filter(symbol => symbol !== wildSymbol && paytable[symbol]?.linePayout);
}

function applyWildSplash(state, wildSymbol, rng) {
  const count = 1 + Math.floor(rng() * 2);
  const positions = shuffled(everyPosition(state.grid), rng).slice(0, count);
  const next = applyNoRefillCascade(state.grid, [], positions.map(position => ({ position, symbol: wildSymbol })), state.wildMultipliers);
  return { ...next, feature: 'wild-splash', affectedPositions: positions };
}

function pickCandidates(candidates, count, rng) {
  const picked = [];
  const usedCells = new Set();
  while (picked.length < count) {
    const available = candidates.filter(candidate => candidate.missing.some(position => !usedCells.has(keyOf(position))));
    if (!available.length) break;
    const best = available[0];
    // Preserve the value ordering; the spin seed breaks genuinely equal choices.
    const tied = available.filter(candidate => candidate.value === best.value && candidate.missing.length === best.missing.length);
    const chosen = tied.length > 1 ? tied[Math.floor(rng() * tied.length)] : best;
    const position = chosen.missing.find(item => !usedCells.has(keyOf(item)));
    picked.push({ ...chosen, position });
    usedCells.add(keyOf(position));
  }
  return picked;
}

function fallbackPositions(grid, count, occupied = new Set()) {
  const centreCol = (grid.length - 1) / 2;
  const centreRow = (grid[0].length - 1) / 2;
  return Array.from({ length: grid.length }, (_, col) => Array.from({ length: grid[0].length }, (_, row) => [col, row]))
    .flat()
    .filter(position => !occupied.has(keyOf(position)))
    .sort((a, b) => (Math.abs(a[0] - centreCol) + Math.abs(a[1] - centreRow)) - (Math.abs(b[0] - centreCol) + Math.abs(b[1] - centreRow))
      || a[1] - b[1] || a[0] - b[0])
    .slice(0, count);
}

function sodaStormPositions(grid, paytable, wildSymbol) {
  const candidates = bestNearLineCandidates(grid, paytable, wildSymbol);
  const selected = [];
  const covered = new Set();
  while (selected.length < 5) {
    const occupied = new Set(selected.map(keyOf));
    const choices = new Map();
    candidates.forEach((candidate, index) => candidate.missing.forEach(position => {
      if (occupied.has(keyOf(position))) return;
      const item = choices.get(keyOf(position)) || { position, score: 0 };
      // Favor a cell that completes a previously uncovered horizontal/vertical opportunity;
      // a shared crossing cell therefore beats five cells aimed at one same-direction run.
      item.score += candidate.value * (covered.has(index) ? 0.3 : 1);
      choices.set(keyOf(position), item);
    }));
    const best = [...choices.values()].sort((a, b) => b.score - a.score || keyOf(a.position).localeCompare(keyOf(b.position)))[0];
    if (!best) break;
    selected.push(best.position);
    candidates.forEach((candidate, index) => {
      if (candidate.missing.some(position => keyOf(position) === keyOf(best.position))) covered.add(index);
    });
  }
  return [...selected, ...fallbackPositions(grid, 5 - selected.length, new Set(selected.map(keyOf)))];
}

/**
 * Apply a small effect when one Pop charge fills. Effects use the spin RNG, so a replay,
 * simulation worker, and live spin always make the same board changes. A wild placed into an
 * empty cell is passed through gravity immediately; all effects can therefore create another
 * ordinary straight-line cascade without ever refilling the board.
 */
export function applyPopFeature({ grid, wildMultipliers, paytable, wildSymbol, feature, rng }) {
  const state = cloneState(grid, wildMultipliers);
  const allPositions = everyPosition(state.grid);

  if (feature === 'wild-splash') {
    return applyWildSplash(state, wildSymbol, rng);
  }

  if (feature === 'flavor-shift') {
    const candidates = allPositions.filter(([col, row]) => {
      const symbol = state.grid[col][row];
      return symbol != null && symbol !== wildSymbol;
    });
    const position = shuffled(candidates, rng)[0];
    // A nearly empty board can contain only persistent wilds. Keep the Pop meaningful by
    // substituting the always-applicable splash effect instead of displaying a no-op.
    if (!position) return applyWildSplash(state, wildSymbol, rng);
    const [col, row] = position;
    const currentSymbol = state.grid[col][row];
    const target = shuffled(naturalSymbols(paytable, wildSymbol).filter(symbol => symbol !== currentSymbol), rng)[0];
    state.grid[col][row] = target || currentSymbol;
    state.wildMultipliers[col][row] = 1;
    return { ...state, feature, affectedPositions: [position], transformedSymbol: target || currentSymbol };
  }

  // Bubble Burst removes two matching pairs when possible. Removing a small, predictable
  // amount is intentionally gentler than clearing a whole symbol family on a sparse board.
  const bySymbol = new Map();
  allPositions.forEach(position => {
    const symbol = state.grid[position[0]][position[1]];
    if (symbol != null && symbol !== wildSymbol) {
      const positions = bySymbol.get(symbol) || [];
      positions.push(position);
      bySymbol.set(symbol, positions);
    }
  });
  const selectedSymbols = shuffled([...bySymbol.keys()], rng).slice(0, 2);
  const positions = selectedSymbols.flatMap(symbol => shuffled(bySymbol.get(symbol), rng).slice(0, 2));
  if (!positions.length) return applyWildSplash(state, wildSymbol, rng);
  const next = applyNoRefillCascade(state.grid, positions, [], state.wildMultipliers);
  return { ...next, feature: 'bubble-burst', affectedPositions: positions, removedSymbols: selectedSymbols };
}

/** Apply one of the four Pop Rush variants to an initial 5x5 board. */
export function applyPopRushVariant({ grid, wildMultipliers, paytable, wildSymbol, variant, rng }) {
  const state = cloneState(grid, wildMultipliers);
  const candidates = bestNearLineCandidates(state.grid, paytable, wildSymbol);

  if (variant === 'pop-rush') {
    const selected = pickCandidates(candidates, 3, rng).map(({ position }) => position);
    const fallbacks = fallbackPositions(state.grid, 3 - selected.length, new Set(selected.map(keyOf)));
    [...selected, ...fallbacks].forEach(position => setWild(state, position, wildSymbol, 2));
  } else if (variant === 'citrus-cross') {
    const col = Math.floor(state.grid.length / 2);
    const row = Math.floor(state.grid[0].length / 2);
    [[col, row], [col - 1, row], [col + 1, row], [col, row - 1], [col, row + 1]]
      .forEach(position => setWild(state, position, wildSymbol, position[0] === col && position[1] === row ? 2 : 1));
  } else if (variant === 'flavor-remix') {
    const used = new Set();
    candidates.filter(candidate => candidate.premiumTarget).forEach(candidate => {
      if (used.size >= 2 || candidate.positions.some(position => used.has(keyOf(position)))) return;
      candidate.positions.forEach(([col, row]) => {
        if (state.grid[col][row] !== wildSymbol) state.grid[col][row] = candidate.target;
      });
      candidate.positions.forEach(position => used.add(keyOf(position)));
    });
  } else if (variant === 'soda-storm') {
    sodaStormPositions(state.grid, paytable, wildSymbol).forEach(position => setWild(state, position, wildSymbol, 1));
  }

  return state;
}
