/**
 * Deterministic Lemon Pop board effects.
 *
 * The mini Pop features run inside the base no-refill cascade sequence after a charge is spent.
 * The Pop Rush variants shape the bonus respin board once three charges have been banked and the
 * mechanic has promoted the player into the major feature.
 *
 * Every helper in this module is pure relative to its inputs and only uses the supplied RNG, so
 * live play, replay logs, and simulations resolve the same board transitions.
 */
import { applyNoRefillCascade } from '../../core/math/CascadeMath.js';

/** @typedef {[number, number]} Position */

/** @typedef {Array<Array<string | null>>} SymbolGrid */

/** @typedef {Array<Array<number>>} WildMultiplierGrid */

/**
 * Minimal paytable shape used by Lemon Pop board-effect selection.
 *
 * `type` is used to distinguish premium versus regular symbol targeting, and `linePayout[0]`
 * acts as the relative value score when ranking candidate upgrades.
 *
 * @typedef {Object.<string, { linePayout?: number[], type?: string }>} PopFeaturePaytable
 */

/**
 * Result shape returned by a mini Pop feature.
 *
 * Some variants add extra metadata such as `transformedSymbol` or `removedSymbols` so the game
 * can surface a more descriptive debug payload without re-deriving the effect outcome.
 *
 * @typedef {{
 *   grid: SymbolGrid,
 *   wildMultipliers: WildMultiplierGrid,
 *   feature: string,
 *   affectedPositions: Position[],
 *   transformedSymbol?: string,
 *   removedSymbols?: string[]
 * }} PopFeatureResult
 */

/** @typedef {{ grid: SymbolGrid, wildMultipliers: WildMultiplierGrid }} GridState */

const keyOf = ([col, row]) => `${col},${row}`;

/** Pop Rush bonus board variants in the order exposed to the mechanic/UI. */
export const POP_RUSH_VARIANTS = ['pop-rush', 'citrus-cross', 'flavor-remix', 'soda-storm'];

/** Single-charge mini features in the order consumed by the mechanic/UI. */
export const POP_FEATURES = ['wild-splash', 'flavor-shift', 'bubble-burst'];

/**
 * Clone a board state so effect helpers can stay pure and mutate only the local working copy.
 *
 * @param {SymbolGrid} grid
 * @param {WildMultiplierGrid | undefined} wildMultipliers
 * @returns {GridState}
 */
function cloneState(grid, wildMultipliers) {
  return {
    grid: grid.map(column => column.slice()),
    wildMultipliers: wildMultipliers?.map(column => column.slice())
      || grid.map(column => new Array(column.length).fill(1)),
  };
}

/**
 * Enumerate every horizontal and vertical window of a given length on the board.
 *
 * The major-feature placement logic uses these windows to look for cells that are one step away
 * from completing a strong line hit.
 *
 * @param {SymbolGrid} grid
 * @param {number} [length=3]
 * @returns {Position[][]}
 */
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

/**
 * Read a comparable payout score for a symbol.
 *
 * @param {PopFeaturePaytable} paytable
 * @param {string} symbol
 * @returns {number}
 */
function valueOf(paytable, symbol) {
  return Number(paytable[symbol]?.linePayout?.[0] ?? 0);
}

/**
 * Find windows that are close to becoming a paying line and rank them by value.
 *
 * Premium windows can be completed by turning the remaining cells into any premium symbol,
 * whereas regular windows look for the highest-count regular match already present.
 *
 * @param {SymbolGrid} grid
 * @param {PopFeaturePaytable} paytable
 * @param {string} wildSymbol
 * @returns {Array<{
 *   positions: Position[],
 *   target: string,
 *   premiumTarget: boolean,
 *   compatibleCount: number,
 *   missing: Position[],
 *   value: number
 * }>}
 */
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

/**
 * Write a wild into the working state while preserving the strongest multiplier already present.
 *
 * @param {GridState} state
 * @param {Position} position
 * @param {string} wildSymbol
 * @param {number} [multiplier=1]
 */
function setWild(state, [col, row], wildSymbol, multiplier = 1) {
  state.grid[col][row] = wildSymbol;
  state.wildMultipliers[col][row] = Math.max(state.wildMultipliers[col][row] ?? 1, multiplier);
}

/**
 * Deterministically shuffle an array with the supplied RNG.
 *
 * @template T
 * @param {T[]} items
 * @param {() => number} rng
 * @returns {T[]}
 */
function shuffled(items, rng) {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/**
 * Enumerate every coordinate in column-major order.
 *
 * @param {SymbolGrid} grid
 * @returns {Position[]}
 */
function everyPosition(grid) {
  return grid.flatMap((column, col) => column.map((_, row) => [col, row]));
}

/**
 * Return all natural symbols that can be used for a flavor-shift transformation.
 *
 * @param {PopFeaturePaytable} paytable
 * @param {string} wildSymbol
 * @returns {string[]}
 */
function naturalSymbols(paytable, wildSymbol) {
  return Object.keys(paytable).filter(symbol => symbol !== wildSymbol && paytable[symbol]?.linePayout);
}

/**
 * Add one or two wilds and immediately resolve gravity on the no-refill board.
 *
 * @param {GridState} state
 * @param {string} wildSymbol
 * @param {() => number} rng
 * @param {Position[]} [forcedPositions]
 * @returns {PopFeatureResult}
 */
function applyWildSplash(state, wildSymbol, rng, forcedPositions = null) {
  const count = forcedPositions?.length || (1 + Math.floor(rng() * 2));
  const positions = forcedPositions?.slice(0, count) || shuffled(everyPosition(state.grid), rng).slice(0, count);
  const next = applyNoRefillCascade(state.grid, [], positions.map(position => ({ position, symbol: wildSymbol })), state.wildMultipliers);
  return { ...next, feature: 'wild-splash', affectedPositions: positions };
}

/**
 * Pick distinct candidate cells from the highest-value near-line opportunities.
 *
 * @param {ReturnType<typeof bestNearLineCandidates>} candidates
 * @param {number} count
 * @param {() => number} rng
 * @returns {Array<ReturnType<typeof bestNearLineCandidates>[number] & { position: Position }>}
 */
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

/**
 * Choose central fallback cells when heuristic placement cannot fill the requested quota.
 *
 * This keeps bonus boards legible and avoids bunching replacements at arbitrary corners.
 *
 * @param {SymbolGrid} grid
 * @param {number} count
 * @param {Set<string>} [occupied=new Set()]
 * @returns {Position[]}
 */
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

/**
 * Spread five soda-storm wilds across the board to cover as many promising line completions as
 * possible, preferring crossing cells that improve multiple windows at once.
 *
 * @param {SymbolGrid} grid
 * @param {PopFeaturePaytable} paytable
 * @param {string} wildSymbol
 * @returns {Position[]}
 */
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
 * Apply one mini Pop feature after a charge is consumed.
 *
 * Effects use the spin RNG, so a replay, simulation worker, and live spin always make the same
 * board changes. A wild placed into an empty cell is passed through gravity immediately; all
 * effects can therefore create another ordinary straight-line cascade without ever refilling the
 * board.
 *
 * `wild-splash` injects one or two wilds, `flavor-shift` retargets every instance of one chosen
 * non-wild symbol, and `bubble-burst` removes up to two matching pairs.
 *
 * @param {{
 *   grid: SymbolGrid,
 *   wildMultipliers: WildMultiplierGrid | undefined,
 *   paytable: PopFeaturePaytable,
 *   wildSymbol: string,
 *   feature: string,
 *   rng: () => number,
 *   forcedAffectedPositions?: Position[]
 * }} params
 * @returns {PopFeatureResult}
 */
export function applyPopFeature({ grid, wildMultipliers, paytable, wildSymbol, feature, rng, forcedAffectedPositions }) {
  const state = cloneState(grid, wildMultipliers);
  const allPositions = everyPosition(state.grid);

  if (feature === 'wild-splash') {
    return applyWildSplash(state, wildSymbol, rng, forcedAffectedPositions);
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
    const transformedSymbol = target || currentSymbol;
    const affectedPositions = candidates.filter(([candidateCol, candidateRow]) => state.grid[candidateCol][candidateRow] === currentSymbol);
    affectedPositions.forEach(([candidateCol, candidateRow]) => {
      state.grid[candidateCol][candidateRow] = transformedSymbol;
      state.wildMultipliers[candidateCol][candidateRow] = 1;
    });
    return { ...state, feature, affectedPositions, transformedSymbol };
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

/**
 * Apply one Pop Rush major-feature variant to the initial bonus board.
 *
 * Variants intentionally bias toward different player-facing patterns:
 * `pop-rush` completes high-value near-lines, `citrus-cross` builds a central plus shape,
 * `flavor-remix` upgrades premium windows in place, and `soda-storm` scatters five wilds across
 * the strongest uncovered opportunities.
 *
 * @param {{
 *   grid: SymbolGrid,
 *   wildMultipliers: WildMultiplierGrid | undefined,
 *   paytable: PopFeaturePaytable,
 *   wildSymbol: string,
 *   variant: string,
 *   rng: () => number
 * }} params
 * @returns {GridState}
 */
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