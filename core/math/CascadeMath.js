// Generic cascading-grid mechanics: reading a reel strip forward from a per-column cursor,
// gravity + refill after cells are cleared, and a grid-wide scatter-anywhere check. Nothing
// here knows about clusters or paylines - see core/ClusterMath.js for this game's win
// evaluator, and a future payline-cascade game's own evaluator, either of which plugs into
// resolveCascadeSequence below unchanged.
import { createSeededRng } from './SlotMath.js';

const wildMultiplierAt = (wildMultipliers, col, row) => Number(wildMultipliers?.[col]?.[row] ?? 1);

/**
 * Reads the symbol at cursorState.index, then advances the cursor by 1, wrapping circularly.
 * Centralizes the "keep reading forward, never re-roll" rule used by every cell that drops
 * into the grid, whether that's the very first fill or a later cascade refill.
 * @param {string[]} strip - one column's full reel strip (from generateReel).
 * @param {{index: number}} cursorState - mutated in place.
 * @returns {string} the symbol at the cursor's current position, before advancing.
 */
export function nextStripSymbol(strip, cursorState) {
  const symbol = strip[cursorState.index];
  cursorState.index = (cursorState.index + 1) % strip.length;
  return symbol;
}

/**
 * Removes the given positions from the grid, compacts each affected column's remaining
 * symbols downward (gravity, order-preserving), and refills the vacated top cells by reading
 * forward from that column's own cursor. Pure - doesn't know or care why positions were
 * cleared (a matched cluster, or - for a future payline-cascade game - a matched line).
 *
 * Also used for the very first fill of a spin: call it with an all-null grid and every
 * position listed as cleared.
 *
 * Always removes every given position in one combined pass - clusterWins' winningPositions
 * are coordinates into the grid as it existed BEFORE any clearing, so removing them across
 * multiple sequential passes (with gravity compacting survivors between passes) would shift
 * row indices and corrupt later positions. When several clusters win on the same step, the
 * caller collects every cluster's winningPositions first and calls this once with the union
 * (see resolveCascadeSequence below) - any one-cluster-at-a-time *visual* poof sequencing
 * belongs in the animator, which can hide cells progressively without touching this math.
 *
 * @param {string[][]} grid - grid[col][row], row 0 = top.
 * @param {{index: number}[]} cursorStateByColumn - one cursor per column, mutated in place.
 * @param {string[][]} strips - one reel strip per column.
 * @param {[number, number][]} clearedPositions - [col, row] pairs to remove.
 * @returns {{ grid: string[][], fallOffsets: number[][] }} the new grid, plus each cell's
 *   fall distance in rows (for animating the transition into this grid): a survivor's offset
 *   is how far it shifted down to close a gap; every freshly-spawned cell in a column shares
 *   the same offset (= how many cells were spawned in that column), so the whole spawned group
 *   forms one contiguous block sitting immediately above the grid - its bottom-most (closest
 *   to landing) cell starts exactly one row above the grid's top edge, never already inside
 *   it, however many rows are being refilled at once.
 */
export function applyCascade(grid, cursorStateByColumn, strips, clearedPositions) {
  const reelsCount = grid.length;
  const rowsCount = grid[0].length;

  const clearedByColumn = Array.from({ length: reelsCount }, () => new Set());
  clearedPositions.forEach(([col, row]) => clearedByColumn[col].add(row));

  const newGrid = [];
  const fallOffsets = [];

  for (let col = 0; col < reelsCount; col++) {
    const survivors = [];
    for (let row = 0; row < rowsCount; row++) {
      if (!clearedByColumn[col].has(row)) survivors.push({ symbol: grid[col][row], originalRow: row });
    }
    const spawnedCount = rowsCount - survivors.length;

    const newColumn = new Array(rowsCount);
    const colOffsets = new Array(rowsCount);

    for (let i = 0; i < survivors.length; i++) {
      const newRow = spawnedCount + i;
      newColumn[newRow] = survivors[i].symbol;
      colOffsets[newRow] = newRow - survivors[i].originalRow;
    }
    for (let newRow = 0; newRow < spawnedCount; newRow++) {
      newColumn[newRow] = nextStripSymbol(strips[col], cursorStateByColumn[col]);
      colOffsets[newRow] = spawnedCount;
    }

    newGrid.push(newColumn);
    fallOffsets.push(colOffsets);
  }

  return { grid: newGrid, fallOffsets };
}

/**
 * Clear cells, optionally replace some of those cells with persistent symbols, and apply gravity
 * without dealing new symbols into the vacated top cells. `wildMultipliers` is a parallel grid:
 * 1 is a normal wild/no multiplier and 2 marks a Pop Rush wild. It travels with its symbol.
 */
export function applyNoRefillCascade(grid, clearedPositions, spawnedSymbols = [], wildMultipliers = null) {
  const reelsCount = grid.length;
  const rowsCount = grid[0].length;
  const cleared = new Set(clearedPositions.map(([col, row]) => `${col},${row}`));
  const spawns = new Map(spawnedSymbols.map(({ position, symbol, multiplier = 1 }) => [
    `${position[0]},${position[1]}`, { symbol, multiplier },
  ]));
  const nextGrid = [];
  const nextMultipliers = [];
  const fallOffsets = [];

  for (let col = 0; col < reelsCount; col++) {
    const survivors = [];
    for (let row = 0; row < rowsCount; row++) {
      const key = `${col},${row}`;
      const spawn = spawns.get(key);
      if (spawn) {
        survivors.push({ symbol: spawn.symbol, multiplier: spawn.multiplier, originalRow: row });
      } else if (!cleared.has(key) && grid[col][row] != null) {
        survivors.push({ symbol: grid[col][row], multiplier: wildMultiplierAt(wildMultipliers, col, row), originalRow: row });
      }
    }

    const emptyCount = rowsCount - survivors.length;
    const column = new Array(rowsCount).fill(null);
    const multiplierColumn = new Array(rowsCount).fill(1);
    const offsets = new Array(rowsCount).fill(0);
    survivors.forEach((cell, index) => {
      const row = emptyCount + index;
      column[row] = cell.symbol;
      multiplierColumn[row] = cell.multiplier;
      offsets[row] = row - cell.originalRow;
    });
    nextGrid.push(column);
    nextMultipliers.push(multiplierColumn);
    fallOffsets.push(offsets);
  }
  return { grid: nextGrid, wildMultipliers: nextMultipliers, fallOffsets };
}

/** Resolve a deterministic cascade sequence with one initial reel fill and gravity-only steps. */
export function resolveNoRefillCascadeSequence(strips, rowsCount, seed, winEvaluator, {
  maxCascadeSteps = 25,
  initialTransform = null,
} = {}) {
  const rng = createSeededRng(seed);
  const reelsCount = strips.length;
  const cursorStateByColumn = strips.map(strip => ({ index: Math.floor(rng() * strip.length) }));
  const emptyGrid = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(null));
  const allPositions = [];
  for (let col = 0; col < reelsCount; col++) for (let row = 0; row < rowsCount; row++) allPositions.push([col, row]);
  let { grid: currentGrid, fallOffsets: currentFallOffsets } = applyCascade(emptyGrid, cursorStateByColumn, strips, allPositions);
  let currentWildMultipliers = createWildMultipliers(reelsCount, rowsCount);
  if (initialTransform) {
    const transformed = initialTransform({ grid: currentGrid, wildMultipliers: currentWildMultipliers, rng });
    currentGrid = transformed.grid;
    currentWildMultipliers = transformed.wildMultipliers;
  }

  const cascadeSteps = [];
  let totalPayoutMultiplier = 0;
  for (let stepIndex = 0; stepIndex <= maxCascadeSteps; stepIndex++) {
    const result = winEvaluator(currentGrid, currentWildMultipliers);
    const hasWin = result.totalPayoutMultiplier > 0;
    cascadeSteps.push({
      grid: currentGrid,
      wildMultipliers: currentWildMultipliers,
      fallOffsets: currentFallOffsets,
      clusterWins: hasWin ? result.clusterWins : [],
      payout: hasWin ? result.totalPayoutMultiplier : 0,
    });
    if (!hasWin) break;
    totalPayoutMultiplier += result.totalPayoutMultiplier;
    const clearedPositions = result.clusterWins.flatMap(win => win.winningPositions);
    const spawnedSymbols = result.clusterWins.map(win => ({
      position: win.wildSpawnPosition,
      symbol: result.wildSymbol || 'lemonpop',
      multiplier: 1,
    }));
    const next = applyNoRefillCascade(currentGrid, clearedPositions, spawnedSymbols, currentWildMultipliers);
    currentGrid = next.grid;
    currentWildMultipliers = next.wildMultipliers;
    currentFallOffsets = next.fallOffsets;
  }
  return { cascadeSteps, totalPayoutMultiplier, finalGrid: currentGrid, wildMultipliers: currentWildMultipliers, scatterWin: null };
}

function createWildMultipliers(reelsCount, rowsCount) {
  return Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(1));
}

/**
 * Counts a symbol anywhere on the grid, independent of win type - a scatter check needs to
 * run the same way whether the game underneath is cluster-pays or (a future) line-pays.
 * @returns {{ count: number, positions: [number, number][], triggerFreeSpins: boolean }}
 */
export function checkScatterCount(grid, scatterSymbol, triggerCount) {
  const positions = [];
  for (let col = 0; col < grid.length; col++) {
    for (let row = 0; row < grid[col].length; row++) {
      if (grid[col][row] === scatterSymbol) positions.push([col, row]);
    }
  }
  return { count: positions.length, positions, triggerFreeSpins: positions.length >= triggerCount };
}

/**
 * Resolves one entire spin's cascade sequence synchronously and deterministically: the
 * initial fill, then every cascade step, until a step produces no win. This is the "what
 * happens" half of a spin (pure, replayable from a seed) - CascadeEngine's job is only to
 * animate playback of an already-known sequence, the same way SlotEngine precomputes
 * targetGrid and then animates reels catching up to it.
 *
 * @param {string[][]} strips - one reel strip per column.
 * @param {number} rowsCount
 * @param {number} seed
 * @param {(grid: string[][]) => { clusterWins: object[], totalPayoutMultiplier: number, scatterWin: object|null }} winEvaluator -
 *   a single-argument closure the game builds (e.g. `(grid) => checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3)`).
 * @param {number} [maxCascadeSteps=1000] - safety valve against a pathological paytable/strip
 *   combination that could otherwise cascade forever; never expected to bind in practice.
 * @returns {{ cascadeSteps: Array<{grid: string[][], fallOffsets: number[][], clusterWins: object[], payout: number}>,
 *   totalPayoutMultiplier: number, finalGrid: string[][], scatterWin: object|null }}
 *   cascadeSteps[i].clusterWins/payout describe the wins found ON that step's grid (empty/0
 *   for the terminal step, which is simply the final settled grid).
 */
export function resolveCascadeSequence(strips, rowsCount, seed, winEvaluator, maxCascadeSteps = 1000) {
  const rng = createSeededRng(seed);
  const reelsCount = strips.length;
  const cursorStateByColumn = strips.map(strip => ({ index: Math.floor(rng() * strip.length) }));

  const emptyGrid = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(null));
  const allCleared = [];
  for (let col = 0; col < reelsCount; col++) for (let row = 0; row < rowsCount; row++) allCleared.push([col, row]);

  let { grid: currentGrid, fallOffsets: currentFallOffsets } = applyCascade(emptyGrid, cursorStateByColumn, strips, allCleared);

  const cascadeSteps = [];
  let totalPayoutMultiplier = 0;
  let finalScatterWin = null;
  let stepCount = 0;

  while (true) {
    const results = winEvaluator(currentGrid);
    const hasWin = results.totalPayoutMultiplier > 0;

    cascadeSteps.push({
      grid: currentGrid,
      fallOffsets: currentFallOffsets,
      clusterWins: hasWin ? results.clusterWins : [],
      payout: hasWin ? results.totalPayoutMultiplier : 0,
    });
    if (results.scatterWin) {
      finalScatterWin = results.scatterWin;
    }

    if (!hasWin || stepCount >= maxCascadeSteps) break;

    totalPayoutMultiplier += results.totalPayoutMultiplier;
    const clearedPositions = [];
    results.clusterWins.forEach(w => clearedPositions.push(...w.winningPositions));

    const next = applyCascade(currentGrid, cursorStateByColumn, strips, clearedPositions);
    currentGrid = next.grid;
    currentFallOffsets = next.fallOffsets;
    stepCount++;
  }

  return { cascadeSteps, totalPayoutMultiplier, finalGrid: currentGrid, scatterWin: finalScatterWin };
}
