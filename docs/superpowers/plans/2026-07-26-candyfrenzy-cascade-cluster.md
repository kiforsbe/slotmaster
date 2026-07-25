# Candy Frenzy Cascade/Cluster Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new game, Candy Frenzy — a 7×7 cluster-pays cascading slot (min. 5 orthogonally-connected symbols, cascading removal/refill within one spin, `bonus` scatter → 2× free spins) — plus the new generic cascade engine (`CascadeEngine`/`CascadeMath`) and cluster win evaluator (`ClusterMath`) it's built on.

**Architecture:** Pure math first (`CascadeMath.js`, `ClusterMath.js` — fully unit-testable under Node, no DOM), then three narrow rendering extractions out of the existing `SlotEngine.js` (`GridLayout.js`, `SpriteDrawer.js`, `ParticleSystem.js`) shared by both engines, then the new stateful `CascadeEngine.js` (built on top of a fully-precomputed-per-spin `resolveCascadeSequence` so animation is always just "catching up" to an already-known outcome, mirroring how `SlotEngine` precomputes `targetGrid`), then the game itself.

**Tech Stack:** Plain ES modules, HTML5 Canvas 2D, `node --test` for pure-math tests. No build step, no bundler, no new dependencies.

## Global Constraints

- 7 reels × 7 rows grid.
- Cluster wins: orthogonal (4-directional) adjacency only, minimum size 5, tiers 5-6/7-9/10-14/15-24/25+.
- No wild symbol in v1. `chest`, `clover`, `wild` art tiles are unused (excluded from `PAYTABLE` and every reel's frequency table).
- Symbols — Premium: `cottoncandy`, `gum`, `crystal`, `rocket`, `crown`, `cake`. Regular: `mint`, `gummy`, `bean`, `chocolate`, `chewy`, `cherry`. Scatter: `bonus`.
- Regular cluster payout tiers (multiplier of total bet): `[{min:5,multiplier:0.10}, {min:7,multiplier:0.20}, {min:10,multiplier:0.40}, {min:15,multiplier:1.0}, {min:25,multiplier:3.0}]`.
- Premium cluster payout tiers: `[{min:5,multiplier:0.25}, {min:7,multiplier:0.50}, {min:10,multiplier:1.0}, {min:15,multiplier:2.5}, {min:25,multiplier:7.5}]`.
- `bonus`: 3+ anywhere on the final settled grid → 10 free spins; 3+ again during free spins retriggers +10 (same rule). Free spins pay 2× per spin, no bet deducted, no direct cash payout for `bonus` itself.
- Reel strips are built with the existing, unmodified `generateReel` from `core/SlotMath.js` — one `FREQUENCY_REELn` per column, same authoring shape documented in the top-level README.
- No RUN SIMULATION / TUNE FREQUENCIES for this game (buttons omitted from `index.html` entirely). SPIN LOG is wired up.
- `core/SlotEngine.js`'s state machine/control flow (`spin()`, `update()`, `evaluateSpinResult()`, etc.) is not touched — only `resize()`, `drawSymbol()`, and the particle-handling code are rewritten to delegate to the new shared modules, with identical externally-visible behavior.
- No changes to `core/SlotMath.js`, `core/SpinSimulator.js`, `core/SimulationPanel.js`.

---

### Task 1: `core/CascadeMath.js` — pure cascade mechanics

**Files:**
- Create: `core/CascadeMath.js`
- Test: `tests/cascademath.test.mjs`

**Interfaces:**
- Consumes: `createSeededRng` from `core/SlotMath.js` (existing, unchanged).
- Produces (used by Task 2 and Task 7):
  - `nextStripSymbol(strip: string[], cursorState: {index: number}): string`
  - `applyCascade(grid: string[][], cursorStateByColumn: {index:number}[], strips: string[][], clearedPositions: [number,number][]): { grid: string[][], fallOffsets: number[][] }`
  - `checkScatterCount(grid: string[][], scatterSymbol: string, triggerCount: number): { count: number, positions: [number,number][], triggerFreeSpins: boolean }`
  - `resolveCascadeSequence(strips: string[][], rowsCount: number, seed: number, winEvaluator: (grid: string[][]) => { clusterWins: Array<{symbol,count,payout,winningPositions}>, totalPayoutMultiplier: number, scatterWin: object|null }, maxCascadeSteps?: number): { cascadeSteps: Array<{grid, fallOffsets, clusterWins, payout}>, totalPayoutMultiplier: number, finalGrid: string[][], scatterWin: object|null }`

Grid convention throughout: `grid[col][row]`, `row 0` = top, matching every existing game's `grid[col][row]` convention in `SlotMath.js`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cascademath.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStripSymbol, applyCascade, checkScatterCount, resolveCascadeSequence } from '../core/CascadeMath.js';

test('nextStripSymbol reads the current index then advances, wrapping circularly', () => {
  const strip = ['a', 'b', 'c'];
  const cursor = { index: 1 };
  assert.equal(nextStripSymbol(strip, cursor), 'b');
  assert.equal(cursor.index, 2);
  assert.equal(nextStripSymbol(strip, cursor), 'c');
  assert.equal(cursor.index, 0, 'wraps back to 0 after the last strip position');
  assert.equal(nextStripSymbol(strip, cursor), 'a');
  assert.equal(cursor.index, 1);
});

test('applyCascade on an empty grid performs the initial fill, reading each column forward from its cursor', () => {
  // 2 columns x 3 rows, tiny strips so the fill result is fully predictable.
  const strips = [
    ['x1', 'x2', 'x3', 'x4'],
    ['y1', 'y2', 'y3', 'y4'],
  ];
  const cursorStateByColumn = [{ index: 0 }, { index: 2 }];
  const emptyGrid = [[null, null, null], [null, null, null]];
  const allCleared = [];
  for (let col = 0; col < 2; col++) for (let row = 0; row < 3; row++) allCleared.push([col, row]);

  const { grid, fallOffsets } = applyCascade(emptyGrid, cursorStateByColumn, strips, allCleared);

  // Column 0 starts reading at index 0: x1, x2, x3 (top to bottom).
  assert.deepEqual(grid[0], ['x1', 'x2', 'x3']);
  // Column 1 starts reading at index 2: y3, y4, y1 (wraps).
  assert.deepEqual(grid[1], ['y3', 'y4', 'y1']);
  // Cursors advanced by 3 (one full column's worth of reads) each.
  assert.equal(cursorStateByColumn[0].index, 3);
  assert.equal(cursorStateByColumn[1].index, (2 + 3) % 4);

  // A full-column spawn: row 0 (top) has the largest offset, row 2 (bottom, closest to
  // its resting slot) has the smallest - the "stacked above the grid" pour effect.
  assert.deepEqual(fallOffsets[0], [3, 2, 1]);
  assert.deepEqual(fallOffsets[1], [3, 2, 1]);
});

test('applyCascade compacts survivors down and only refills the vacated top cells', () => {
  // 1 column x 4 rows: clear row 1 only. Row 0's survivor ('top') must shift down by 1 to
  // fill the gap; rows 2-3 ('mid','bottom') are untouched (no cleared cell was below them).
  const strips = [['new1', 'new2', 'new3', 'new4']];
  const cursorStateByColumn = [{ index: 0 }];
  const grid = [['top', 'cleared', 'mid', 'bottom']];
  const clearedPositions = [[0, 1]];

  const { grid: newGrid, fallOffsets } = applyCascade(grid, cursorStateByColumn, strips, clearedPositions);

  // 3 survivors ('top','mid','bottom') land in the bottom 3 rows in original relative order;
  // 1 new symbol spawns into the single vacated top row.
  assert.deepEqual(newGrid[0], ['new1', 'top', 'mid', 'bottom']);
  assert.deepEqual(fallOffsets[0], [1, 1, 0, 0], '"top" shifted down 1 row, "mid"/"bottom" did not move');
  assert.equal(cursorStateByColumn[0].index, 1, 'exactly one new symbol was drawn from the strip');
});

test('checkScatterCount finds every occurrence anywhere on the grid and flags the trigger boundary', () => {
  const grid = [['bonus', 'a'], ['b', 'bonus'], ['bonus', 'c']];
  const result = checkScatterCount(grid, 'bonus', 3);
  assert.equal(result.count, 3);
  assert.deepEqual(result.positions.sort(), [[0, 0], [1, 1], [2, 0]].sort());
  assert.equal(result.triggerFreeSpins, true);

  const belowThreshold = checkScatterCount(grid, 'bonus', 4);
  assert.equal(belowThreshold.triggerFreeSpins, false);
});

test('resolveCascadeSequence terminates, accumulates payout across steps, and stops once a step has no win', () => {
  // Fake winEvaluator: pays a fixed multiplier for exactly 2 cascades, then reports no win.
  let evalCount = 0;
  const winEvaluator = (grid) => {
    evalCount++;
    if (evalCount <= 2) {
      return {
        clusterWins: [{ symbol: 'x', count: 5, payout: 1.5, winningPositions: [[0, 0], [0, 1]] }],
        totalPayoutMultiplier: 1.5,
        scatterWin: null,
      };
    }
    return { clusterWins: [], totalPayoutMultiplier: 0, scatterWin: { symbol: 'bonus', count: 0, triggerFreeSpins: false } };
  };
  const strips = [['a', 'b'], ['c', 'd']];
  const result = resolveCascadeSequence(strips, 2, 12345, winEvaluator);

  assert.equal(result.totalPayoutMultiplier, 3, '1.5 + 1.5 across the two winning steps');
  assert.equal(result.cascadeSteps.length, 3, 'initial fill + 2 winning steps + 1 final no-win step = 4 evaluate calls but 3 grid states are recorded after the fill (fill counts as step 0)');
  assert.equal(evalCount, 3);
  assert.equal(result.cascadeSteps[result.cascadeSteps.length - 1].clusterWins.length, 0, 'the terminal step carries no wins');
  assert.deepEqual(result.finalGrid, result.cascadeSteps[result.cascadeSteps.length - 1].grid);
});

test('resolveCascadeSequence is deterministic for a given seed', () => {
  const winEvaluator = () => ({ clusterWins: [], totalPayoutMultiplier: 0, scatterWin: null });
  const strips = [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']];
  const a = resolveCascadeSequence(strips, 3, 999, winEvaluator);
  const b = resolveCascadeSequence(strips, 3, 999, winEvaluator);
  assert.deepEqual(a.finalGrid, b.finalGrid);
});

test('resolveCascadeSequence never loops forever even if the evaluator always reports a win', () => {
  const winEvaluator = () => ({
    clusterWins: [{ symbol: 'x', count: 5, payout: 0.1, winningPositions: [[0, 0]] }],
    totalPayoutMultiplier: 0.1,
    scatterWin: null,
  });
  const strips = [['a', 'a'], ['a', 'a']];
  const result = resolveCascadeSequence(strips, 2, 1, winEvaluator, 25);
  assert.equal(result.cascadeSteps.length, 26, 'stops at maxCascadeSteps + the initial fill step');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cascademath.test.mjs`
Expected: FAIL — `Cannot find module '../core/CascadeMath.js'`

- [ ] **Step 3: Implement `core/CascadeMath.js`**

```js
// Generic cascading-grid mechanics: reading a reel strip forward from a per-column cursor,
// gravity + refill after cells are cleared, and a grid-wide scatter-anywhere check. Nothing
// here knows about clusters or paylines - see core/ClusterMath.js for this game's win
// evaluator, and a future payline-cascade game's own evaluator, either of which plugs into
// resolveCascadeSequence below unchanged.
import { createSeededRng } from './SlotMath.js';

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
 * @param {string[][]} grid - grid[col][row], row 0 = top.
 * @param {{index: number}[]} cursorStateByColumn - one cursor per column, mutated in place.
 * @param {string[][]} strips - one reel strip per column.
 * @param {[number, number][]} clearedPositions - [col, row] pairs to remove.
 * @returns {{ grid: string[][], fallOffsets: number[][] }} the new grid, plus each cell's
 *   fall distance in rows (for animating the transition into this grid): a survivor's offset
 *   is how far it shifted down to close a gap; a freshly-spawned cell's offset places it
 *   stacked above the grid, closest-to-landing-first, so a whole cleared/refilled column
 *   animates as one continuous "pour."
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
      colOffsets[newRow] = spawnedCount - newRow;
    }

    newGrid.push(newColumn);
    fallOffsets.push(colOffsets);
  }

  return { grid: newGrid, fallOffsets };
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
    finalScatterWin = results.scatterWin;

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/cascademath.test.mjs`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add core/CascadeMath.js tests/cascademath.test.mjs
git commit -m "$(cat <<'EOF'
feat: add CascadeMath - generic cursor-based cascading grid mechanics

Pure functions for cascading grids: reading a reel strip forward from a
per-column cursor (never re-rolling), gravity + refill after cells clear,
a grid-wide scatter check, and resolveCascadeSequence which precomputes
one spin's entire cascade sequence deterministically from a seed. Knows
nothing about clusters or paylines - a pluggable winEvaluator closure
decides what counts as a win, so this is reusable by any future
cascading game, not just Candy Frenzy's cluster-pays evaluator.
EOF
)"
```

---

### Task 2: `core/ClusterMath.js` — cluster-pays win evaluator

**Files:**
- Create: `core/ClusterMath.js`
- Test: `tests/clustermath.test.mjs`

**Interfaces:**
- Consumes: `checkScatterCount` from `core/CascadeMath.js` (Task 1).
- Produces (used by Task 9's `game.js`, and exercised by Task 1's `resolveCascadeSequence` via the `winEvaluator` closure):
  - `findClusters(grid: string[][], paytable: object, minClusterSize: number): Array<{symbol, positions:[number,number][], size:number}>`
  - `checkClusterWins(grid, paytable, minClusterSize, scatterSymbol, scatterTriggerCount): { clusterWins: Array<{symbol,count,payout,winningPositions}>, totalPayoutMultiplier: number, scatterWin: object|null }`

- [ ] **Step 1: Write the failing tests**

```js
// tests/clustermath.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { findClusters, checkClusterWins } from '../core/ClusterMath.js';

const PAYTABLE = {
  cottoncandy: { clusterPayout: [{ min: 5, multiplier: 0.25 }, { min: 7, multiplier: 0.50 }, { min: 10, multiplier: 1.0 }, { min: 15, multiplier: 2.5 }, { min: 25, multiplier: 7.5 }] },
  mint:        { clusterPayout: [{ min: 5, multiplier: 0.10 }, { min: 7, multiplier: 0.20 }, { min: 10, multiplier: 0.40 }, { min: 15, multiplier: 1.0 }, { min: 25, multiplier: 3.0 }] },
  bonus:       { type: 'scatter', paymode: 'any', triggerFreeSpins: true },
};

function gridFromRows(rows) {
  // rows[row][col] input (easier to author by hand) -> grid[col][row] (this codebase's convention)
  const rowsCount = rows.length;
  const reelsCount = rows[0].length;
  const grid = Array.from({ length: reelsCount }, () => new Array(rowsCount));
  for (let row = 0; row < rowsCount; row++) {
    for (let col = 0; col < reelsCount; col++) {
      grid[col][row] = rows[row][col];
    }
  }
  return grid;
}

test('findClusters groups orthogonally-adjacent same symbols, not diagonal touches', () => {
  const grid = gridFromRows([
    ['mint', 'mint', 'x'],
    ['x',    'mint', 'x'],
    ['mint', 'x',    'x'], // bottom-left 'mint' only touches diagonally - separate cluster
  ]);
  const clusters = findClusters(grid, PAYTABLE, 5);
  const mintClusters = clusters.filter(c => c.symbol === 'mint');
  assert.equal(mintClusters.length, 2, 'the diagonally-touching mint must NOT merge into the L-shaped cluster');
  const sizes = mintClusters.map(c => c.size).sort();
  assert.deepEqual(sizes, [1, 3]);
});

test('findClusters ignores the scatter symbol and any symbol without a clusterPayout entry', () => {
  const grid = gridFromRows([
    ['bonus', 'bonus', 'bonus'],
    ['unknown', 'unknown', 'unknown'],
    ['mint', 'mint', 'mint'],
  ]);
  const clusters = findClusters(grid, PAYTABLE, 5);
  assert.equal(clusters.some(c => c.symbol === 'bonus'), false);
  assert.equal(clusters.some(c => c.symbol === 'unknown'), false);
  assert.equal(clusters.some(c => c.symbol === 'mint'), true);
});

test('checkClusterWins pays nothing below the minimum cluster size', () => {
  const grid = gridFromRows([
    ['mint', 'mint', 'x', 'x'],
    ['x',    'mint', 'x', 'x'],
    ['x',    'mint', 'x', 'x'], // exactly 4 connected - below min 5
  ]);
  const result = checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3);
  assert.deepEqual(result.clusterWins, []);
  assert.equal(result.totalPayoutMultiplier, 0);
});

test('checkClusterWins pays the correct tier at size boundaries and sums multiple clusters', () => {
  // A 7-cell mint cluster (tier 7-9 -> 0.20) and, separately, a 5-cell cottoncandy cluster
  // (tier 5-6 -> 0.25) in the same grid.
  const grid = gridFromRows([
    ['mint', 'mint', 'mint', 'x', 'cottoncandy', 'cottoncandy'],
    ['mint', 'mint', 'mint', 'x', 'cottoncandy', 'cottoncandy'],
    ['mint', 'x',    'x',    'x', 'cottoncandy', 'x'],
  ]);
  const result = checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3);
  const mintWin = result.clusterWins.find(w => w.symbol === 'mint');
  const candyWin = result.clusterWins.find(w => w.symbol === 'cottoncandy');
  assert.equal(mintWin.count, 7);
  assert.equal(mintWin.payout, 0.20);
  assert.equal(candyWin.count, 5);
  assert.equal(candyWin.payout, 0.25);
  assert.equal(result.totalPayoutMultiplier, 0.20 + 0.25);
});

test('checkClusterWins bundles the scatter check and reports triggerFreeSpins', () => {
  const grid = gridFromRows([
    ['bonus', 'x', 'bonus'],
    ['x',     'x', 'x'],
    ['bonus', 'x', 'x'],
  ]);
  const result = checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3);
  assert.equal(result.scatterWin.count, 3);
  assert.equal(result.scatterWin.triggerFreeSpins, true);
});

test('checkClusterWins reports scatterWin as null when the symbol does not appear at all', () => {
  const grid = gridFromRows([['mint', 'mint'], ['mint', 'mint']]);
  const result = checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3);
  assert.equal(result.scatterWin, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/clustermath.test.mjs`
Expected: FAIL — `Cannot find module '../core/ClusterMath.js'`

- [ ] **Step 3: Implement `core/ClusterMath.js`**

```js
// Cluster-pays win evaluation: orthogonal flood-fill clustering plus a cluster-size payout
// tier lookup. Sits alongside core/SlotMath.js's checkWins/checkWildLineWins as a sibling
// win-evaluation strategy, not a replacement - CascadeEngine (core/CascadeEngine.js) never
// imports this directly, a game's own winEvaluator closure does (see games/candyfrenzy/game.js).
import { checkScatterCount } from './CascadeMath.js';

/**
 * Orthogonal (4-directional, no diagonals) flood-fill over the grid, grouping
 * same-symbol connected components. Skips any cell whose symbol has no `clusterPayout`
 * entry in the paytable (the scatter symbol, or anything else not meant to cluster) -
 * every such cell is its own dead end, never merged into a neighboring cluster.
 * @param {string[][]} grid - grid[col][row], row 0 = top.
 * @param {Object} paytable - reads `paytable[symbol].clusterPayout` only to decide whether
 *   a symbol participates in clustering at all; the actual tier lookup is checkClusterWins's job.
 * @param {number} minClusterSize - NOT applied here; findClusters returns every connected
 *   component regardless of size, filtering is checkClusterWins's job (kept separate so a
 *   caller can inspect sub-minimum clusters too, e.g. for a future "near miss" UI highlight).
 * @returns {Array<{symbol: string, positions: [number, number][], size: number}>}
 */
export function findClusters(grid, paytable, minClusterSize) {
  const reelsCount = grid.length;
  const rowsCount = grid[0].length;
  const visited = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(false));
  const clusters = [];

  for (let col = 0; col < reelsCount; col++) {
    for (let row = 0; row < rowsCount; row++) {
      if (visited[col][row]) continue;
      const symbol = grid[col][row];
      const meta = paytable[symbol];
      if (!meta || !meta.clusterPayout) {
        visited[col][row] = true;
        continue;
      }

      const stack = [[col, row]];
      visited[col][row] = true;
      const positions = [];
      while (stack.length > 0) {
        const [c, r] = stack.pop();
        positions.push([c, r]);
        const neighbors = [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]];
        for (const [nc, nr] of neighbors) {
          if (nc < 0 || nc >= reelsCount || nr < 0 || nr >= rowsCount) continue;
          if (visited[nc][nr]) continue;
          if (grid[nc][nr] !== symbol) continue;
          visited[nc][nr] = true;
          stack.push([nc, nr]);
        }
      }
      clusters.push({ symbol, positions, size: positions.length });
    }
  }

  return clusters;
}

// Finds the highest tier whose min <= size (tiers must be ascending by min - see the
// PAYTABLE.clusterPayout shape documented in games/candyfrenzy/game.js).
function payoutForClusterSize(symbol, size, paytable) {
  const tiers = paytable[symbol] && paytable[symbol].clusterPayout;
  if (!tiers) return 0;
  let multiplier = 0;
  for (const tier of tiers) {
    if (size >= tier.min) multiplier = tier.multiplier;
  }
  return multiplier;
}

/**
 * The cluster-pays winEvaluator: qualifying clusters (>= minClusterSize) plus a bundled
 * scatter-anywhere check, combined into one result shape mirroring SlotMath.js's checkWins
 * convention. Meant to be wrapped in a single-argument closure for CascadeEngine/
 * resolveCascadeSequence's `winEvaluator` config, e.g.
 * `(grid) => checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3)`.
 * @returns {{ clusterWins: Array<{symbol,count,payout,winningPositions}>, totalPayoutMultiplier: number, scatterWin: object|null }}
 */
export function checkClusterWins(grid, paytable, minClusterSize, scatterSymbol, scatterTriggerCount) {
  const clusters = findClusters(grid, paytable, minClusterSize);
  const clusterWins = [];
  let totalPayoutMultiplier = 0;

  clusters.forEach(cluster => {
    if (cluster.size < minClusterSize) return;
    const payout = payoutForClusterSize(cluster.symbol, cluster.size, paytable);
    if (payout > 0) {
      clusterWins.push({ symbol: cluster.symbol, count: cluster.size, payout, winningPositions: cluster.positions });
      totalPayoutMultiplier += payout;
    }
  });

  const scatter = checkScatterCount(grid, scatterSymbol, scatterTriggerCount);
  const scatterWin = scatter.count > 0
    ? { symbol: scatterSymbol, count: scatter.count, positions: scatter.positions, triggerFreeSpins: scatter.triggerFreeSpins, payout: 0 }
    : null;

  return { clusterWins, totalPayoutMultiplier, scatterWin };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/clustermath.test.mjs`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add core/ClusterMath.js tests/clustermath.test.mjs
git commit -m "$(cat <<'EOF'
feat: add ClusterMath - cluster-pays win evaluator

Orthogonal flood-fill clustering plus a cluster-size payout tier lookup,
sitting alongside SlotMath.js's checkWins/checkWildLineWins as a sibling
win-evaluation strategy for cascading grids.
EOF
)"
```

---

### Task 3: Extract `core/GridLayout.js` from `SlotEngine.resize()`

**Files:**
- Create: `core/GridLayout.js`
- Modify: `core/SlotEngine.js:195-243` (the `resize()` method)
- Test: `tests/gridlayout.test.mjs`

**Interfaces:**
- Produces (used by `SlotEngine.js` now, `CascadeEngine.js` in Task 7):
  - `computeGridLayout(parentWidth: number, parentHeight: number, dpr: number, reelsCount: number, rowsCount: number, marginXFrac?: number, marginYFrac?: number): { cssWidth, cssHeight, canvasWidth, canvasHeight, cellSize, reelsWidth, reelsHeight, reelsX, reelsY }`

- [ ] **Step 1: Write the failing test**

```js
// tests/gridlayout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGridLayout } from '../core/GridLayout.js';

test('computeGridLayout fits the grid to the narrower dimension and centers it, matching a 5x3 grid at a wide parent', () => {
  const layout = computeGridLayout(1000, 400, 1, 5, 3);
  // Hand-computed from the original inline formula (marginXFrac=0.05, marginYFrac=0.08 defaults):
  // targetAspect = (5 * (1 - 0.16)) / (3 * (1 - 0.10)) = (5*0.84)/(3*0.90) = 4.2/2.7
  const targetAspect = (5 * (1 - 2 * 0.08)) / (3 * (1 - 2 * 0.05));
  let expectedW = 1000;
  let expectedH = 1000 / targetAspect;
  if (expectedH > 400) { expectedH = 400; expectedW = 400 * targetAspect; }
  assert.ok(Math.abs(layout.cssWidth - expectedW) < 1e-9);
  assert.ok(Math.abs(layout.cssHeight - expectedH) < 1e-9);
  assert.equal(layout.canvasWidth, layout.cssWidth * 1);
  assert.equal(layout.canvasHeight, layout.cssHeight * 1);
});

test('computeGridLayout scales canvas pixel dimensions by dpr but not css dimensions', () => {
  const layout = computeGridLayout(800, 800, 2, 7, 7);
  assert.equal(layout.canvasWidth, layout.cssWidth * 2);
  assert.equal(layout.canvasHeight, layout.cssHeight * 2);
});

test('computeGridLayout produces square cells that exactly tile reelsWidth/reelsHeight', () => {
  const layout = computeGridLayout(900, 900, 1, 7, 7);
  assert.ok(Math.abs(layout.reelsWidth - layout.cellSize * 7) < 1e-9);
  assert.ok(Math.abs(layout.reelsHeight - layout.cellSize * 7) < 1e-9);
  assert.ok(layout.reelsX > 0 && layout.reelsY > 0, 'grid is inset from the canvas edge by the margin');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gridlayout.test.mjs`
Expected: FAIL — `Cannot find module '../core/GridLayout.js'`

- [ ] **Step 3: Implement `core/GridLayout.js`**

```js
// Pure canvas/grid layout math, extracted from SlotEngine.resize() so CascadeEngine (a
// different grid shape/shape of animation entirely) can compute the same square-cell,
// centered-in-parent layout without duplicating the formula.

/**
 * Fits a reelsCount x rowsCount grid of square cells into a parent box, preserving aspect
 * ratio (never stretching/letterboxing), and centers it within a small margin.
 * @param {number} parentWidth - CSS pixels.
 * @param {number} parentHeight - CSS pixels.
 * @param {number} dpr - devicePixelRatio, for sizing the canvas's backing buffer.
 * @param {number} reelsCount
 * @param {number} rowsCount
 * @param {number} [marginXFrac=0.05] - horizontal margin as a fraction of the canvas box.
 * @param {number} [marginYFrac=0.08] - vertical margin as a fraction of the canvas box.
 * @returns {{ cssWidth: number, cssHeight: number, canvasWidth: number, canvasHeight: number,
 *   cellSize: number, reelsWidth: number, reelsHeight: number, reelsX: number, reelsY: number }}
 */
export function computeGridLayout(parentWidth, parentHeight, dpr, reelsCount, rowsCount, marginXFrac = 0.05, marginYFrac = 0.08) {
  const targetAspect =
    (reelsCount * (1 - 2 * marginYFrac)) /
    (rowsCount * (1 - 2 * marginXFrac));

  let cssWidth = parentWidth;
  let cssHeight = parentWidth / targetAspect;
  if (cssHeight > parentHeight) {
    cssHeight = parentHeight;
    cssWidth = parentHeight * targetAspect;
  }

  const marginX = cssWidth * marginXFrac;
  const marginY = cssHeight * marginYFrac;
  const availW = cssWidth - (2 * marginX);
  const availH = cssHeight - (2 * marginY);
  const cellSize = Math.min(availW / reelsCount, availH / rowsCount);
  const reelsWidth = cellSize * reelsCount;
  const reelsHeight = cellSize * rowsCount;

  return {
    cssWidth,
    cssHeight,
    canvasWidth: cssWidth * dpr,
    canvasHeight: cssHeight * dpr,
    cellSize,
    reelsWidth,
    reelsHeight,
    reelsX: marginX + (availW - reelsWidth) / 2,
    reelsY: marginY + (availH - reelsHeight) / 2,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/gridlayout.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Rewrite `SlotEngine.resize()` to delegate, same output**

In `core/SlotEngine.js`, add the import at the top (near the existing imports):

```js
import { computeGridLayout } from './GridLayout.js';
```

Replace the entire body of `resize()` (`core/SlotEngine.js:195-243`) with:

```js
  resize() {
    const parentRect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const layout = computeGridLayout(parentRect.width, parentRect.height, dpr, this.config.reelsCount, this.config.rowsCount);

    this.canvas.style.width = `${layout.cssWidth}px`;
    this.canvas.style.height = `${layout.cssHeight}px`;
    this.canvas.width = layout.canvasWidth;
    this.canvas.height = layout.canvasHeight;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);

    this.symbolWidth = layout.cellSize;
    this.symbolHeight = layout.cellSize;
    this.reelsWidth = layout.reelsWidth;
    this.reelsHeight = layout.reelsHeight;
    this.reelsX = layout.reelsX;
    this.reelsY = layout.reelsY;
  }
```

Every other field this method used to set (`this.symbolWidth`, `this.reelsX`, etc.) keeps the exact same name, so no other line in `SlotEngine.js` needs to change.

- [ ] **Step 6: Manually verify one existing game is unaffected**

Use the `run` skill to launch the dev server and open `games/fruitmachine/index.html`. Confirm: the grid renders at the correct size and aspect ratio, resizing the browser window keeps it centered and square-celled, and there are no console errors. This is a pure refactor — visual output must be pixel-identical to before.

- [ ] **Step 7: Commit**

```bash
git add core/GridLayout.js core/SlotEngine.js tests/gridlayout.test.mjs
git commit -m "$(cat <<'EOF'
refactor: extract computeGridLayout from SlotEngine.resize()

Pure layout math (fit a reelsCount x rowsCount grid of square cells into
a parent box, centered) pulled out into core/GridLayout.js so the new
CascadeEngine can reuse it for its own 7x7 grid instead of duplicating
the formula. SlotEngine.resize() now delegates to it; same field names,
same output, no behavior change.
EOF
)"
```

---

### Task 4: Extract `core/SpriteDrawer.js` from `SlotEngine.drawSymbol()`

**Files:**
- Create: `core/SpriteDrawer.js`
- Modify: `core/SlotEngine.js:985-1020` (the `drawSymbol()` method)

**Interfaces:**
- Produces (used by `SlotEngine.js` now, `CascadeEngine.js` in Task 7):
  - `drawSpriteSymbol(ctx: CanvasRenderingContext2D, spritesheet: HTMLImageElement, tile: {x,y,w,h}|undefined, x: number, y: number, width: number, height: number, blurSpeed?: number): void`

This one is a straight code extraction with no independently-testable pure-value output (it draws to a canvas context) — `node --test` has no canvas, so verification here is manual, matching how `SlotEngine.js`'s own rendering code has never had unit tests either.

- [ ] **Step 1: Implement `core/SpriteDrawer.js`**

```js
// Sprite-atlas blit with optional motion blur, extracted from SlotEngine.drawSymbol() so
// CascadeEngine can draw its own grid's symbols with identical visuals.

/**
 * Draws one sprite-atlas tile at a destination rect, optionally with a vertical
 * motion-blur stretch (used while a symbol is moving fast - reel spin, or a cascading fall).
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement} spritesheet
 * @param {{x:number,y:number,w:number,h:number}|undefined} tile - this symbol's atlas rect;
 *   a no-op if undefined (matches SlotEngine.drawSymbol's own defensive `if (!tile) return`).
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} [blurSpeed=0] - 0 draws crisp; > 0 draws a stretched, alpha-blended blur
 *   whose intensity scales with this value (SlotEngine passes reel speed here).
 */
export function drawSpriteSymbol(ctx, spritesheet, tile, x, y, width, height, blurSpeed = 0) {
  if (!tile) return;

  const destX = x;
  const destY = y;
  const destW = width;
  const destH = height;

  ctx.save();

  if (blurSpeed > 0) {
    const stretch = Math.min(2.0, 1 + (blurSpeed / 50));
    const blurCount = 3;

    ctx.globalAlpha = 0.35;
    for (let i = 0; i < blurCount; i++) {
      const offset = (i - (blurCount - 1) / 2) * (blurSpeed * 0.15);
      ctx.drawImage(
        spritesheet,
        tile.x, tile.y, tile.w, tile.h,
        destX, destY + offset - (destH * (stretch - 1) / 2), destW, destH * stretch
      );
    }
  } else {
    ctx.drawImage(
      spritesheet,
      tile.x, tile.y, tile.w, tile.h,
      destX, destY, destW, destH
    );
  }

  ctx.restore();
}
```

- [ ] **Step 2: Rewrite `SlotEngine.drawSymbol()` to delegate**

Add the import in `core/SlotEngine.js`:

```js
import { drawSpriteSymbol } from './SpriteDrawer.js';
```

Replace the entire body of `drawSymbol()` (`core/SlotEngine.js:985-1020`) with:

```js
  drawSymbol(name, x, y, width, height, blurSpeed = 0) {
    drawSpriteSymbol(this.ctx, this.spritesheet, this.symbolsConfig[name], x, y, width, height, blurSpeed);
  }
```

- [ ] **Step 3: Manually verify**

Use the `run` skill, open `games/fruitmachine/index.html`, spin a few times (including turbo mode, to exercise the motion-blur branch), confirm symbols render identically to before with no console errors.

- [ ] **Step 4: Commit**

```bash
git add core/SpriteDrawer.js core/SlotEngine.js
git commit -m "$(cat <<'EOF'
refactor: extract drawSpriteSymbol from SlotEngine.drawSymbol()

Pure sprite-atlas blit + motion-blur logic pulled into core/SpriteDrawer.js
so CascadeEngine can draw its own grid identically. SlotEngine.drawSymbol()
now a thin wrapper; same behavior, no visual change.
EOF
)"
```

---

### Task 5: Extract `core/ParticleSystem.js` from `SlotEngine`'s particle code

**Files:**
- Create: `core/ParticleSystem.js`
- Modify: `core/SlotEngine.js` (particle field init, the particle-update block in `update()`, `spawnWinParticles()`, `renderParticles()`)

**Interfaces:**
- Produces (used by `SlotEngine.js` now, `CascadeEngine.js` in Task 7):
  - `class ParticleSystem { spawn(points: {x:number,y:number}[]): void; update(): void; render(ctx: CanvasRenderingContext2D): void; clear(): void }`

- [ ] **Step 1: Implement `core/ParticleSystem.js`**

```js
// Win-celebration particle burst, extracted from SlotEngine's inline particle code so
// CascadeEngine can reuse the same effect for its own cluster-clear celebrations.

// Caps how many particles exist at once - spawn() clears any previous burst first, and each
// spot only gets particles up to this overall budget (matches SlotEngine's prior behavior).
const MAX_PARTICLES = 200;
const PARTICLES_PER_SPOT = 20;

export class ParticleSystem {
  constructor() {
    this.particles = [];
  }

  /** Advances every particle one frame and drops any that have fully faded. */
  update() {
    this.particles = this.particles.filter(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= p.decay;
      p.rotation += p.vRotation;
      return p.alpha > 0;
    });
  }

  /**
   * Replaces any current burst with a fresh one centered on each given world-space point.
   * @param {{x: number, y: number}[]} points
   */
  spawn(points) {
    this.particles = [];
    const maxSpots = Math.min(points.length, Math.floor(MAX_PARTICLES / PARTICLES_PER_SPOT));
    points.slice(0, maxSpots).forEach(({ x: cx, y: cy }) => {
      for (let i = 0; i < PARTICLES_PER_SPOT; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1 + Math.random() * 5;
        this.particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1.5,
          size: 2 + Math.random() * 6,
          alpha: 1.0,
          decay: 0.015 + Math.random() * 0.02,
          color: `hsl(${45 + Math.random() * 15}, 100%, ${50 + Math.random() * 30}%)`,
          rotation: Math.random() * Math.PI * 2,
          vRotation: -0.1 + Math.random() * 0.2,
        });
      }
    });
  }

  render(ctx) {
    this.particles.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  clear() {
    this.particles = [];
  }
}
```

- [ ] **Step 2: Rewrite `SlotEngine.js` to delegate**

Add the import:

```js
import { ParticleSystem } from './ParticleSystem.js';
```

In the constructor, replace `this.particles = [];` (around `core/SlotEngine.js:88`) with:

```js
    this.particleSystem = new ParticleSystem();
```

In `update()`, replace the particle-update block (`core/SlotEngine.js:273-280`, the `this.particles = this.particles.filter(...)` block) with:

```js
    this.particleSystem.update();
```

Replace `spawnWinParticles()` (`core/SlotEngine.js:1240-1278`) with:

```js
  spawnWinParticles() {
    const totalWins = (this.expandingWinData ? this.expandingWinData.wins : this.winData.lineWins) || [];
    let spots = [];
    totalWins.forEach(w => spots.push(...w.winningPositions));
    if (this.winData.scatterWin) {
      spots.push(...this.winData.scatterWin.winningPositions);
    }
    const points = spots.map(([col, row]) => ({
      x: this.reelsX + (col * this.symbolWidth) + (this.symbolWidth / 2),
      y: this.reelsY + (row * this.symbolHeight) + (this.symbolHeight / 2),
    }));
    this.particleSystem.spawn(points);
  }
```

Replace `renderParticles()` (`core/SlotEngine.js:1280-1293`) with:

```js
  renderParticles() {
    this.particleSystem.render(this.ctx);
  }
```

- [ ] **Step 3: Manually verify all three existing games**

Use the `run` skill to launch the dev server. For each of `games/bookbookbook`, `games/fruitmachine`, `games/barfruits`: spin until a win lands, confirm the gold particle burst appears at the winning positions exactly as before, with no console errors. This closes out the shared-rendering extraction (Tasks 3-5) — `SlotEngine.js`'s control flow was never touched, only these three delegated pieces, so this pass should show zero visual/behavioral difference in any of the three live games.

- [ ] **Step 4: Commit**

```bash
git add core/ParticleSystem.js core/SlotEngine.js
git commit -m "$(cat <<'EOF'
refactor: extract ParticleSystem from SlotEngine's inline particle code

Win-celebration particle burst pulled into core/ParticleSystem.js so
CascadeEngine can reuse it for cluster-clear celebrations. SlotEngine
delegates via this.particleSystem; same behavior, verified unchanged
across all three existing games.
EOF
)"
```

---

### Task 6: Cascade-aware spin log entries in `core/SpinLog.js`

**Files:**
- Modify: `core/SpinLog.js` (additive only — no existing export's behavior changes)
- Modify: `tests/spinlog.test.mjs` (add new tests; existing tests untouched)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by `CascadeEngine.js` in Task 7):
  - `createCascadeSpinLogEntry({ spinIndex, phase, betAmount, chargedBet, freeSpinsMultiplier, cascadeSteps, scatterSymbol, scatterWin, seed, timestamp }): object` — same top-level entry shape as `createSpinLogEntry` (so `SpinLogPanel.js`'s existing rendering/CSV export work unchanged), plus a `clusterWins` array and `cascadeStepCount`.
- `summarizeSpinWins` (existing export) gains cluster-win serialization, additive — its existing line/scatter/expanding output is byte-identical for any entry without a `clusterWins` field.

- [ ] **Step 1: Write the failing tests**

Add to the end of `tests/spinlog.test.mjs` (imports already include `summarizeSpinWins`; add `createCascadeSpinLogEntry` to the existing import line):

```js
import { createSpinLogEntry, applyExpandingWinToSpinLogEntry, summarizeSpinWins, createCascadeSpinLogEntry } from '../core/SpinLog.js';
```

```js
test('createCascadeSpinLogEntry scales cluster payouts by betAmount and freeSpinsMultiplier, folding them into totalWin', () => {
  const cascadeSteps = [
    { clusterWins: [] }, // the initial fill - no wins yet
    { clusterWins: [{ symbol: 'mint', count: 7, payout: 0.20 }] },
    { clusterWins: [{ symbol: 'cottoncandy', count: 5, payout: 0.25 }] },
    { clusterWins: [] }, // terminal step - no more wins
  ];
  const entry = createCascadeSpinLogEntry({
    spinIndex: 1,
    phase: 'free',
    betAmount: 2,
    chargedBet: 0, // free spins cost nothing to spin
    freeSpinsMultiplier: 2,
    cascadeSteps,
    scatterSymbol: 'bonus',
    scatterWin: null,
  });

  assert.equal(entry.totalBet, 0);
  assert.equal(entry.cascadeStepCount, 4);
  assert.equal(entry.clusterWins.length, 2);
  assert.equal(entry.clusterWins[0].cascadeStep, 1);
  assert.equal(entry.clusterWins[0].payout, 0.20 * 2 * 2, 'multiplier * betAmount * freeSpinsMultiplier');
  assert.equal(entry.clusterWins[1].cascadeStep, 2);
  assert.equal(entry.clusterWins[1].payout, 0.25 * 2 * 2);
  assert.equal(entry.totalWin, (0.20 * 2 * 2) + (0.25 * 2 * 2));
  assert.equal(entry.scatterCount, 0);
  assert.equal(entry.scatterSymbol, null, 'no scatter hit -> not recorded, even though one is configured');
});

test('createCascadeSpinLogEntry records a scatter hit without a cash payout', () => {
  const entry = createCascadeSpinLogEntry({
    spinIndex: 2,
    phase: 'base',
    betAmount: 1,
    chargedBet: 1,
    freeSpinsMultiplier: 1,
    cascadeSteps: [{ clusterWins: [] }],
    scatterSymbol: 'bonus',
    scatterWin: { count: 3, triggerFreeSpins: true },
  });
  assert.equal(entry.scatterSymbol, 'bonus');
  assert.equal(entry.scatterCount, 3);
  assert.equal(entry.totalWin, 0);
});

test('summarizeSpinWins serializes clusterWins additively, without disturbing line/scatter output', () => {
  const lineEntry = { scatterCount: 0, lineWins: [], expandingReels: 0 };
  assert.equal(summarizeSpinWins(lineEntry), '', 'an entry with no clusterWins field behaves exactly as before');

  const cascadeEntry = {
    scatterCount: 0,
    lineWins: [],
    expandingReels: 0,
    clusterWins: [{ cascadeStep: 1, symbol: 'mint', count: 7, payout: 0.8 }],
  };
  assert.equal(summarizeSpinWins(cascadeEntry), 'K1:mint:7:0.8');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/spinlog.test.mjs`
Expected: FAIL — `createCascadeSpinLogEntry is not a function` / assertion failures on the `clusterWins`-serialization test

- [ ] **Step 3: Implement the additions in `core/SpinLog.js`**

Add this new export anywhere after `applyExpandingWinToSpinLogEntry` (e.g. right after it):

```js
/**
 * Builds one spin-log entry for a cascading cluster-pays spin (Candy Frenzy) - same
 * top-level shape as createSpinLogEntry (spinIndex/timestamp/seed/phase/totalBet/totalWin/
 * scatter fields) so SpinLogPanel.js's existing table/CSV export work unchanged, plus a
 * clusterWins breakdown across every cascade step instead of lineWins.
 * @param {Object} args
 * @param {number} args.spinIndex
 * @param {'base'|'free'} args.phase
 * @param {number} args.betAmount - this game's single flat bet (no bet-per-line/lines concept).
 * @param {number} args.chargedBet - what this spin actually cost (0 during free spins).
 * @param {number} [args.freeSpinsMultiplier=1] - 2 during free spins per this game's rules.
 * @param {Array<{clusterWins: Array<{symbol,count,payout}>}>} args.cascadeSteps - from
 *   resolveCascadeSequence's own result shape (core/CascadeMath.js); a step's `payout` field
 *   there is a currency-scaled sum and isn't re-derived here, only its per-cluster multiplier
 *   entries are.
 * @param {string|null} [args.scatterSymbol=null]
 * @param {{count:number}|null} [args.scatterWin=null] - bonus has no direct cash payout in v1.
 * @param {number|null} [args.seed=null]
 * @param {number|null} [args.timestamp=null]
 */
export function createCascadeSpinLogEntry({
  spinIndex, phase, betAmount, chargedBet, freeSpinsMultiplier = 1,
  cascadeSteps, scatterSymbol = null, scatterWin = null, seed = null, timestamp = null
}) {
  const clusterWins = [];
  cascadeSteps.forEach((step, stepIndex) => {
    step.clusterWins.forEach(cw => {
      clusterWins.push({
        cascadeStep: stepIndex,
        symbol: cw.symbol,
        count: cw.count,
        payout: cw.payout * betAmount * freeSpinsMultiplier,
      });
    });
  });
  const cascadeWinTotal = clusterWins.reduce((sum, cw) => sum + cw.payout, 0);
  const scatterCount = scatterWin ? scatterWin.count : 0;

  return {
    spinIndex,
    timestamp,
    seed,
    phase,
    betPerLine: betAmount,
    linesCount: 1,
    totalBet: chargedBet,
    totalWin: cascadeWinTotal,
    scatterSymbol: scatterCount > 0 ? scatterSymbol : null,
    scatterCount,
    scatterWin: 0,
    lineWins: [],
    clusterWins,
    cascadeStepCount: cascadeSteps.length,
    expandingSymbol: null,
    expandingReels: 0,
    expandingWin: 0,
  };
}
```

Update `summarizeSpinWins` (find the existing function) to additively serialize `entry.clusterWins` — add this block right before the final `return parts.join('|');` line:

```js
  (entry.clusterWins || []).forEach(cw => {
    parts.push(`K${cw.cascadeStep}:${cw.symbol}:${cw.count}:${round2(cw.payout)}`);
  });
```

Also update the doc comment above `summarizeSpinWins` to mention the new `K<cascadeStep>` win-type prefix alongside the existing `S`/`X`/`L<lineIndex>` ones, and extend its documented parsing regex from `/(S|X|L\d+):.../ ` to `/(S|X|L\d+|K\d+):([^:|]+):(\d+):(-?[\d.]+)(?::([WA]+))?/g`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/spinlog.test.mjs`
Expected: PASS (all existing tests plus the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add core/SpinLog.js tests/spinlog.test.mjs
git commit -m "$(cat <<'EOF'
feat: add createCascadeSpinLogEntry for cluster-pays cascade spins

Additive to core/SpinLog.js - same entry shape as createSpinLogEntry so
SpinLogPanel.js's existing table/CSV export work unchanged, plus a
clusterWins breakdown across cascade steps instead of lineWins.
summarizeSpinWins gains a K<cascadeStep> win-type prefix, additive to
its existing S/X/L grammar.
EOF
)"
```

---

### Task 7: `core/CascadeEngine.js` — the stateful cascade engine

**Files:**
- Create: `core/CascadeEngine.js`

**Interfaces:**
- Consumes: `resolveCascadeSequence` (Task 1), `computeGridLayout` (Task 3), `drawSpriteSymbol` (Task 4), `ParticleSystem` (Task 5), `createCascadeSpinLogEntry` (Task 6), `audio` from `core/SlotAudio.js` (existing, unchanged), `createSeededRng` from `core/SlotMath.js` (existing, unchanged, used only for the debug force-scatter cheat's position choice — not for gameplay RNG, which lives entirely inside `resolveCascadeSequence`).
- Produces (used by `games/candyfrenzy/game.js` in Task 9):
  - `class CascadeEngine` — constructor `(canvas, config)` where `config` includes `{ reelsCount, rowsCount, paytable, reelStrips, winEvaluator, scatterSymbol, betAmount, symbolsConfig, spritesheetUrl, onStateChange, onScatterTrigger, onWin }`.
  - Public methods mirroring `SlotEngine`'s naming: `requestSpin()`, `spin(seed?)`, `enterFreeSpinsIntro()`, `enterFreeSpins(spinsCount)`, `retriggerFreeSpins(spinsCount)`, `exitFreeSpins()`, `returnToIdle()`, `loadAssets(spritesheetUrl?, symbolsConfig?)`, `forceScatterResult()` (debug cheat).
  - Public properties read by `game.js`: `state`, `balance`, `betAmount`, `lastWin`, `inFreeSpins`, `freeSpinsRemaining`, `freeSpinsTotal`, `freeSpinsAccumulatedWin`, `turboMode`, `autoPlay`, `spinLog`, `lastSpinSeed`, `audio`.

This class has no automated tests of its own (same precedent as `SlotEngine.js`, which has never had any — canvas/RAF/DOM don't run under `node --test`). Its correctness rests on the already-tested `resolveCascadeSequence`/`checkClusterWins` it calls; its own job is purely to animate a known-in-advance sequence. Verification is manual, via the `run` skill, once Task 9 wires it into a real page — this task is code-complete-and-reviewed, not runtime-verified, same as every other class in `core/`.

- [ ] **Step 1: Implement `core/CascadeEngine.js`**

```js
// Stateful cascade engine: canvas rendering + a state machine that animates playback of an
// already fully-resolved spin (see core/CascadeMath.js's resolveCascadeSequence) - mirroring
// how SlotEngine precomputes targetGrid and then animates reels catching up to it. Knows
// nothing about clusters or paylines: config.winEvaluator is a single-argument closure the
// game supplies (e.g. games/candyfrenzy/game.js wraps checkClusterWins), so this file is
// reusable by any future cascading-grid game, not just cluster-pays ones.
import { computeGridLayout } from './GridLayout.js';
import { drawSpriteSymbol } from './SpriteDrawer.js';
import { ParticleSystem } from './ParticleSystem.js';
import { resolveCascadeSequence } from './CascadeMath.js';
import { createCascadeSpinLogEntry } from './SpinLog.js';
import { audio } from './SlotAudio.js';

const SPIN_LOG_MAX_ENTRIES = 20000;

export class CascadeEngine {
  constructor(canvas, config = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.config = {
      reelsCount: 7,
      rowsCount: 7,
      paytable: {},
      reelStrips: [],
      winEvaluator: () => ({ clusterWins: [], totalPayoutMultiplier: 0, scatterWin: null }),
      scatterSymbol: null,
      onStateChange: () => {},
      onScatterTrigger: (scatterCount, isInFreeSpins) => {},
      onWin: () => {},
      ...config,
    };

    this.spritesheetUrl = config.spritesheetUrl || '';
    this.symbolsConfig = config.symbolsConfig || {};

    // idle -> dropping_in -> (clearing -> falling)* -> showing_wins -> idle, plus
    // free_spins_intro/game_over - same naming convention as SlotEngine.state.
    this.state = 'idle';
    this.balance = 1000;
    this.betAmount = config.betAmount ?? 1;
    this.lastWin = 0;

    this.inFreeSpins = false;
    this.freeSpinsRemaining = 0;
    this.freeSpinsTotal = 0;
    this.freeSpinsAccumulatedWin = 0;

    this.spritesheet = new Image();
    this.assetsLoaded = false;

    this.symbolWidth = 0;
    this.symbolHeight = 0;
    this.reelsX = 0;
    this.reelsY = 0;
    this.reelsWidth = 0;
    this.reelsHeight = 0;

    this.turboMode = false;
    this.autoPlay = false;
    this.pendingSpinRequest = false;
    this.autoPlayTimer = null;

    // This spin's fully precomputed outcome (set once per spin() call) and where playback
    // currently is within it.
    this.cascadeSequence = null;
    this.stepIndex = 0;
    this.grid = Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(null));
    this.cellOffsets = Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(0));
    this.clearStartTime = 0;
    this.currentClearPositions = [];
    this._forceScatterNextSpin = false;

    this.particleSystem = new ParticleSystem();
    this.audio = audio;

    this.spinLog = [];

    this.init();
  }

  init() {
    this.setupResize();
    this.loadAssets();
    this.animate();
  }

  loadAssets(spritesheetUrl = this.spritesheetUrl, symbolsConfig = this.symbolsConfig) {
    this.assetsLoaded = false;
    this.spritesheetUrl = spritesheetUrl;
    this.symbolsConfig = symbolsConfig;

    this.spritesheet.src = spritesheetUrl;
    this.spritesheet.onload = () => {
      this.assetsLoaded = true;
      this.resize();
    };
    this.spritesheet.onerror = () => {
      console.error('CascadeEngine: failed to load spritesheet from ' + spritesheetUrl);
    };
  }

  setupResize() {
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.resize(), 100);
    });
    this.resize();
  }

  resize() {
    const parentRect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const layout = computeGridLayout(parentRect.width, parentRect.height, dpr, this.config.reelsCount, this.config.rowsCount);

    this.canvas.style.width = `${layout.cssWidth}px`;
    this.canvas.style.height = `${layout.cssHeight}px`;
    this.canvas.width = layout.canvasWidth;
    this.canvas.height = layout.canvasHeight;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);

    this.symbolWidth = layout.cellSize;
    this.symbolHeight = layout.cellSize;
    this.reelsWidth = layout.reelsWidth;
    this.reelsHeight = layout.reelsHeight;
    this.reelsX = layout.reelsX;
    this.reelsY = layout.reelsY;
  }

  // --- Game loop ---
  animate() {
    this.update();
    this.render();
    requestAnimationFrame(() => this.animate());
  }

  update() {
    const now = Date.now();
    this.particleSystem.update();

    if (this.state === 'dropping_in' || this.state === 'falling') {
      const speed = this.turboMode ? 0.6 : 0.28; // rows per frame
      let allLanded = true;
      for (let col = 0; col < this.config.reelsCount; col++) {
        for (let row = 0; row < this.config.rowsCount; row++) {
          if (this.cellOffsets[col][row] > 0) {
            this.cellOffsets[col][row] = Math.max(0, this.cellOffsets[col][row] - speed);
            allLanded = false;
          }
        }
      }
      if (allLanded) this._onStepLanded();
    } else if (this.state === 'clearing') {
      const clearDuration = this.turboMode ? 150 : 380;
      if (now - this.clearStartTime >= clearDuration) this._advanceToNextStep();
    }

    if (this.pendingSpinRequest && (this.state === 'idle' || this.state === 'showing_wins')) {
      this.pendingSpinRequest = false;
      this.startNextSpin();
    }
  }

  _onStepLanded() {
    const step = this.cascadeSequence.cascadeSteps[this.stepIndex];
    if (step.clusterWins.length > 0) {
      this.state = 'clearing';
      this.clearStartTime = Date.now();
      this.currentClearPositions = step.clusterWins.flatMap(w => w.winningPositions);
      this._spawnClearParticles(this.currentClearPositions);
      audio.playWin(step.payout);
      this.config.onStateChange(this.state);
    } else {
      this._finishSpin();
    }
  }

  _advanceToNextStep() {
    this.stepIndex++;
    const step = this.cascadeSequence.cascadeSteps[this.stepIndex];
    this.grid = step.grid;
    this.cellOffsets = step.fallOffsets.map(col => col.slice());
    this.currentClearPositions = [];
    this.state = 'falling';
    this.config.onStateChange(this.state);
  }

  _spawnClearParticles(positions) {
    const points = positions.map(([col, row]) => ({
      x: this.reelsX + (col * this.symbolWidth) + (this.symbolWidth / 2),
      y: this.reelsY + (row * this.symbolHeight) + (this.symbolHeight / 2),
    }));
    this.particleSystem.spawn(points);
  }

  _finishSpin() {
    const freeSpinsMultiplier = this.inFreeSpins ? 2 : 1;
    const payoutAmount = this.cascadeSequence.totalPayoutMultiplier * this.betAmount * freeSpinsMultiplier;
    this.lastWin = payoutAmount;
    this.balance += payoutAmount;
    if (this.inFreeSpins) this.freeSpinsAccumulatedWin += payoutAmount;

    this._pushSpinLogEntry(freeSpinsMultiplier);

    if (payoutAmount > 0) {
      this.config.onWin({ amount: payoutAmount });
    }

    const scatterWin = this.cascadeSequence.scatterWin;
    if (scatterWin && scatterWin.triggerFreeSpins) {
      audio.playScatterTrigger();
      this.config.onScatterTrigger(scatterWin.count, this.inFreeSpins);
      return;
    }

    this.state = payoutAmount > 0 ? 'showing_wins' : 'idle';
    this.handleAutoPlay();
    this.config.onStateChange(this.state);
  }

  _pushSpinLogEntry(freeSpinsMultiplier) {
    const entry = createCascadeSpinLogEntry({
      spinIndex: this.spinLog.length + 1,
      phase: this.inFreeSpins ? 'free' : 'base',
      betAmount: this.betAmount,
      chargedBet: this.inFreeSpins ? 0 : this.betAmount,
      freeSpinsMultiplier,
      cascadeSteps: this.cascadeSequence.cascadeSteps,
      scatterSymbol: this.config.scatterSymbol,
      scatterWin: this.cascadeSequence.scatterWin,
      seed: this.lastSpinSeed,
      timestamp: Date.now(),
    });
    this.spinLog.push(entry);
    if (this.spinLog.length > SPIN_LOG_MAX_ENTRIES) this.spinLog.shift();
    return entry;
  }

  // --- Spin controllers ---

  requestSpin() {
    if (this.state === 'idle' || this.state === 'showing_wins') {
      this.startNextSpin();
      return;
    }
    this.pendingSpinRequest = true;
  }

  startNextSpin() {
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    if (this.inFreeSpins) {
      this.spinFreeSpins();
    } else {
      this.spin();
    }
  }

  spin(seed) {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;
    audio.stopBGM();

    if (!this.inFreeSpins) {
      if (this.balance < this.betAmount) {
        alert('Insufficient Balance!');
        this.autoPlay = false;
        return;
      }
      this.balance -= this.betAmount;
      this.lastWin = 0;
    }

    const spinSeed = seed !== undefined ? seed : ((Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0);
    this.lastSpinSeed = spinSeed;
    this.cascadeSequence = resolveCascadeSequence(
      this.config.reelStrips, this.config.rowsCount, spinSeed, this.config.winEvaluator
    );

    if (this._forceScatterNextSpin) {
      this._forceScatterNextSpin = false;
      const scatterSym = this.config.scatterSymbol;
      const lastStep = this.cascadeSequence.cascadeSteps[this.cascadeSequence.cascadeSteps.length - 1];
      const positions = [[0, 0], [Math.floor(this.config.reelsCount / 2), Math.floor(this.config.rowsCount / 2)], [this.config.reelsCount - 1, this.config.rowsCount - 1]];
      positions.forEach(([c, r]) => { lastStep.grid[c][r] = scatterSym; });
      this.cascadeSequence.finalGrid = lastStep.grid;
      this.cascadeSequence.scatterWin = { symbol: scatterSym, count: 3, positions, triggerFreeSpins: true, payout: 0 };
    }

    this.stepIndex = 0;
    const firstStep = this.cascadeSequence.cascadeSteps[0];
    this.grid = firstStep.grid;
    this.cellOffsets = firstStep.fallOffsets.map(col => col.slice());
    this.currentClearPositions = [];

    this.state = 'dropping_in';
    audio.playSpin();
    this.config.onStateChange(this.state);
  }

  // Debug/cheat helper (mirrors SlotEngine.forceWinResult('scatter')): forces this game's
  // next spin to land 3 bonus symbols on the final grid, for testing the free-spins trigger.
  forceScatterResult() {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;
    this._forceScatterNextSpin = true;
    this.spin();
  }

  handleAutoPlay() {
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }

    if (this.inFreeSpins) {
      this.autoPlayTimer = setTimeout(() => {
        this.spinFreeSpins();
      }, this.turboMode ? 800 : 1800);
    } else if (this.autoPlay) {
      this.autoPlayTimer = setTimeout(() => {
        if (this.autoPlay && (this.state === 'idle' || this.state === 'showing_wins')) {
          this.spin();
        }
      }, this.turboMode ? 300 : 1000);
    }
  }

  spinFreeSpins() {
    if (this.freeSpinsRemaining <= 0) {
      this.exitFreeSpins();
      return;
    }
    this.freeSpinsRemaining--;
    this.spin();
  }

  enterFreeSpins(spinsCount) {
    this.inFreeSpins = true;
    this.freeSpinsTotal = spinsCount;
    this.freeSpinsRemaining = spinsCount;
    this.freeSpinsAccumulatedWin = 0;

    audio.startBGM();

    this.state = 'idle';
    this.config.onStateChange(this.state);

    this.spinFreeSpins();
  }

  retriggerFreeSpins(spinsCount) {
    this.freeSpinsRemaining += spinsCount;
    this.freeSpinsTotal += spinsCount;
  }

  enterFreeSpinsIntro() {
    this.state = 'free_spins_intro';
    this.config.onStateChange(this.state);
  }

  returnToIdle() {
    this.state = 'idle';
    this.config.onStateChange(this.state);
  }

  exitFreeSpins() {
    this.inFreeSpins = false;
    audio.stopBGM();

    this.state = 'game_over';
    this.config.onStateChange(this.state);
  }

  // --- Rendering ---
  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.assetsLoaded) {
      this._renderLoading();
      return;
    }

    this._renderCabinet();

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(this.reelsX, this.reelsY, this.reelsWidth, this.reelsHeight);
    this.ctx.clip();

    this._renderGridSymbols();

    this.ctx.restore();

    this._renderGridBorders();
    this.renderParticles();
  }

  _renderLoading() {
    this.ctx.fillStyle = '#2a0e2e';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = '#ff6ec7';
    this.ctx.font = 'bold 24px Outfit, Inter, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText('LOADING CANDY...', this.canvas.width / (2 * (window.devicePixelRatio || 1)), this.canvas.height / (2 * (window.devicePixelRatio || 1)));
  }

  _renderCabinet() {
    const rx = this.reelsX, ry = this.reelsY, rw = this.reelsWidth, rh = this.reelsHeight;
    const gradient = this.ctx.createRadialGradient(rx + rw / 2, ry + rh / 2, rh * 0.2, rx + rw / 2, ry + rh / 2, rw * 0.7);
    gradient.addColorStop(0, '#3a1440');
    gradient.addColorStop(1, '#140518');
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, rx * 2 + rw, ry * 2 + rh);

    this.ctx.strokeStyle = '#ff6ec7';
    this.ctx.lineWidth = 4;
    this.ctx.shadowColor = '#ff6ec7';
    this.ctx.shadowBlur = 10;
    this.ctx.strokeRect(rx - 2, ry - 2, rw + 4, rh + 4);
    this.ctx.shadowBlur = 0;
  }

  _renderGridSymbols() {
    const isClearing = this.state === 'clearing';
    const clearDuration = this.turboMode ? 150 : 380;
    const clearProgress = isClearing ? Math.min((Date.now() - this.clearStartTime) / clearDuration, 1) : null;

    for (let col = 0; col < this.config.reelsCount; col++) {
      for (let row = 0; row < this.config.rowsCount; row++) {
        const symbol = this.grid[col][row];
        if (!symbol) continue;

        const offsetRows = this.cellOffsets[col][row] || 0;
        const cx = this.reelsX + col * this.symbolWidth;
        const cy = this.reelsY + (row - offsetRows) * this.symbolHeight;
        const tile = this.symbolsConfig[symbol];

        const isBeingCleared = isClearing && this.currentClearPositions.some(([c, r]) => c === col && r === row);

        this.ctx.save();
        if (isBeingCleared) {
          this.ctx.globalAlpha = 1 - clearProgress;
          const scale = 1 + clearProgress * 0.4;
          const centerX = cx + this.symbolWidth / 2;
          const centerY = cy + this.symbolHeight / 2;
          this.ctx.translate(centerX, centerY);
          this.ctx.scale(scale, scale);
          this.ctx.translate(-centerX, -centerY);
        }
        drawSpriteSymbol(this.ctx, this.spritesheet, tile, cx, cy, this.symbolWidth, this.symbolHeight, 0);
        this.ctx.restore();
      }
    }
  }

  _renderGridBorders() {
    const rx = this.reelsX, ry = this.reelsY, rw = this.reelsWidth, rh = this.reelsHeight;
    this.ctx.strokeStyle = '#2d1030';
    this.ctx.lineWidth = 6;
    this.ctx.strokeRect(rx, ry, rw, rh);

    this.ctx.strokeStyle = 'rgba(255, 110, 199, 0.25)';
    this.ctx.lineWidth = 1;
    for (let c = 1; c < this.config.reelsCount; c++) {
      const cx = rx + c * this.symbolWidth;
      this.ctx.beginPath();
      this.ctx.moveTo(cx, ry);
      this.ctx.lineTo(cx, ry + rh);
      this.ctx.stroke();
    }
    for (let r = 1; r < this.config.rowsCount; r++) {
      const cy = ry + r * this.symbolHeight;
      this.ctx.beginPath();
      this.ctx.moveTo(rx, cy);
      this.ctx.lineTo(rx + rw, cy);
      this.ctx.stroke();
    }
  }

  renderParticles() {
    this.particleSystem.render(this.ctx);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add core/CascadeEngine.js
git commit -m "$(cat <<'EOF'
feat: add CascadeEngine - stateful cascade grid engine

State machine (idle -> dropping_in -> (clearing -> falling)* ->
showing_wins -> idle, plus free_spins_intro/game_over) that animates
playback of a spin already fully resolved by resolveCascadeSequence -
same "precompute then animate" principle as SlotEngine's targetGrid.
Built on the shared GridLayout/SpriteDrawer/ParticleSystem modules;
config.winEvaluator is a pluggable single-argument closure so this
engine has no cluster/payline-specific logic of its own.
EOF
)"
```

---

### Task 8: Move Candy Frenzy assets into the standard `assets/<theme>/` layout

**Files:**
- Move: `games/candyfrenzy/candies_1/candies_1.png` → `games/candyfrenzy/assets/candies_1/candies_1.png`
- Move: `games/candyfrenzy/candies_1/candies_1.tiles.json` → `games/candyfrenzy/assets/candies_1/candies_1.tiles.json`

- [ ] **Step 1: Move the files**

```bash
mkdir -p games/candyfrenzy/assets
git mv games/candyfrenzy/candies_1 games/candyfrenzy/assets/candies_1
```

- [ ] **Step 2: Verify the move**

Run: `ls games/candyfrenzy/assets/candies_1/`
Expected: `candies_1.png` and `candies_1.tiles.json` listed; `games/candyfrenzy/candies_1/` no longer exists.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: move candyfrenzy art into assets/<theme>/ convention

Matches every other game's assets/<theme>/<theme>.{png,tiles.json}
layout (games/barfruits/assets/fruitmachine_1/, etc.) so game.js's
theme loader works the same way for every game.
EOF
)"
```

---

### Task 9: `games/candyfrenzy` — the game itself

**Files:**
- Create: `games/candyfrenzy/game.js`
- Create: `games/candyfrenzy/index.html`
- Create: `games/candyfrenzy/game.css`
- Create: `games/candyfrenzy/README.md`
- Modify: `index.html` (root — add a portal card)
- Modify: `README.md` (root — add a table row)

**Interfaces:**
- Consumes: `CascadeEngine` (Task 7), `checkClusterWins` (Task 2), `generateReel`/`createSeededRng` (existing, `core/SlotMath.js`, unchanged), `openSpinLogPanel` (existing, `core/SpinLogPanel.js`, unchanged).

- [ ] **Step 1: Write `games/candyfrenzy/game.js`**

```js
// Game coordinator for Candy Frenzy - a 7x7 cluster-pays cascading slot.
import { CascadeEngine } from '../../core/CascadeEngine.js';
import { generateReel } from '../../core/SlotMath.js';
import { checkClusterWins } from '../../core/ClusterMath.js';
import { openSpinLogPanel } from '../../core/SpinLogPanel.js';

export const REELS_COUNT = 7;
export const ROWS_COUNT = 7;
export const REEL_LENGTH = 500;
export const REEL_SEEDS = [101, 202, 303, 404, 505, 606, 707];
export const BET_AMOUNT = 1.00;
export const BET_STEP = 0.50;
export const BET_MAX = 50;
export const MIN_CLUSTER_SIZE = 5;
export const SCATTER_TRIGGER_COUNT = 3;
export const FREE_SPINS_AWARD = 10;

// 5 breakpoints since a cluster can run all the way up to 49 cells on this 7x7 grid - not a
// small fixed count like a payline game's payout[i] array.
const REGULAR_PAYOUT = [
  { min: 5, multiplier: 0.10 },
  { min: 7, multiplier: 0.20 },
  { min: 10, multiplier: 0.40 },
  { min: 15, multiplier: 1.0 },
  { min: 25, multiplier: 3.0 },
];
const PREMIUM_PAYOUT = [
  { min: 5, multiplier: 0.25 },
  { min: 7, multiplier: 0.50 },
  { min: 10, multiplier: 1.0 },
  { min: 15, multiplier: 2.5 },
  { min: 25, multiplier: 7.5 },
];

// chest, clover, and wild exist in the art but are unused in v1 - excluded here entirely,
// so they never appear on a reel or in the paytable.
export const PAYTABLE = {
  cottoncandy: { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Cotton Candy' },
  gum:         { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Bubble Gum' },
  crystal:     { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Sugar Crystal' },
  rocket:      { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Candy Rocket' },
  crown:       { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Candy Crown' },
  cake:        { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Cake Slice' },
  mint:        { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Mint' },
  gummy:       { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Gummy Bear' },
  bean:        { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Jelly Bean' },
  chocolate:   { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Chocolate' },
  chewy:       { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Chewy Candy' },
  cherry:      { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Cherry Candy' },
  bonus:       { type: 'scatter', paymode: 'any', triggerFreeSpins: true, friendlyName: 'Bonus' },
};

// All 7 reels start identical (same starting-point convention as barfruits/bookbookbook) -
// each its own object so a future per-reel hand-edit can't silently affect the others.
// bonus's triggerFreeSpins gets generateReel's automatic minGap-3 spacing for free.
const BASE_FREQUENCIES = {
  cottoncandy: 6.5, gum: 6.5, crystal: 5.0, rocket: 4.5, crown: 4.0, cake: 5.5,
  mint: 12.0, gummy: 12.0, bean: 11.0, chocolate: 11.0, chewy: 10.0, cherry: 10.0,
  bonus: 1.5,
};
function buildFrequencyReel() {
  return { symbols: { ...Object.fromEntries(Object.entries(BASE_FREQUENCIES).map(([sym, f]) => [sym, { frequency: f }])) } };
}
export const FREQUENCY_REEL1 = buildFrequencyReel();
export const FREQUENCY_REEL2 = buildFrequencyReel();
export const FREQUENCY_REEL3 = buildFrequencyReel();
export const FREQUENCY_REEL4 = buildFrequencyReel();
export const FREQUENCY_REEL5 = buildFrequencyReel();
export const FREQUENCY_REEL6 = buildFrequencyReel();
export const FREQUENCY_REEL7 = buildFrequencyReel();
const FREQUENCY_REELS = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3, FREQUENCY_REEL4, FREQUENCY_REEL5, FREQUENCY_REEL6, FREQUENCY_REEL7];

export const REEL_STRIPS = FREQUENCY_REELS.map((freqTable, i) => generateReel(freqTable, REEL_LENGTH, REEL_SEEDS[i], [], 3, PAYTABLE));

const winEvaluator = (grid) => checkClusterWins(grid, PAYTABLE, MIN_CLUSTER_SIZE, 'bonus', SCATTER_TRIGGER_COUNT);

let canvas, btnSpin, btnAuto, btnTurbo, btnMute, btnPaytable, btnPaytableOk;
let displayBalance, betValue, betMinus, betPlus, gameTicker;
let btnSpinLog, simModal, simStats;
let modalPaytable, modalFsTrigger, modalFsSummary, btnStartFs, btnCloseFsSummary, fsAwardAmount;
let fsPanel, fsCounter, fsTotalWin;
let cheatScatter;

const DEBUG_MODE = true;

let engine = null;
let pendingFreeSpinsAward = 0;
const THEME_NAME = 'candies_1';

async function loadThemeAssets(themeName) {
  try {
    const response = await fetch(`./assets/${themeName}/${themeName}.tiles.json`);
    const data = await response.json();
    const symbolsConfig = {};
    data.tiles.forEach(tile => {
      symbolsConfig[tile.name] = { x: tile.x, y: tile.y, w: tile.w, h: tile.h };
    });
    const spritesheetUrl = `./assets/${themeName}/${data.sheet}`;
    return { spritesheetUrl, symbolsConfig };
  } catch (error) {
    console.error(`Failed to fetch tile config for theme: ${themeName}`, error);
    return null;
  }
}

async function initGame() {
  canvas = document.getElementById('game-canvas');
  btnSpin = document.getElementById('btn-spin');
  btnAuto = document.getElementById('btn-auto');
  btnTurbo = document.getElementById('btn-turbo');
  btnMute = document.getElementById('btn-mute');
  btnPaytable = document.getElementById('btn-paytable');
  btnPaytableOk = document.getElementById('btn-paytable-ok');
  displayBalance = document.getElementById('display-balance');
  betValue = document.getElementById('bet-value');
  betMinus = document.getElementById('bet-minus');
  betPlus = document.getElementById('bet-plus');
  gameTicker = document.getElementById('game-ticker');

  btnSpinLog = document.getElementById('btn-spinlog');
  simModal = document.getElementById('sim-modal');
  simStats = document.getElementById('sim-stats');

  modalPaytable = document.getElementById('modal-paytable');
  modalFsTrigger = document.getElementById('modal-fs-trigger');
  modalFsSummary = document.getElementById('modal-fs-summary');
  btnStartFs = document.getElementById('btn-start-fs');
  btnCloseFsSummary = document.getElementById('btn-close-fs-summary');
  fsAwardAmount = document.getElementById('fs-award-amount');

  fsPanel = document.getElementById('fs-panel');
  fsCounter = document.getElementById('fs-counter');
  fsTotalWin = document.getElementById('fs-total-win');

  cheatScatter = document.getElementById('cheat-scatter');

  const debugShortcuts = document.querySelector('.debug-shortcuts');
  if (debugShortcuts && DEBUG_MODE) debugShortcuts.classList.add('debug-enabled');

  if (btnSpinLog) {
    btnSpinLog.addEventListener('click', () => {
      openSpinLogPanel({ engine, domRefs: { simModal, simStats } });
    });
  }

  const themeAssets = await loadThemeAssets(THEME_NAME);
  if (!themeAssets) {
    alert('Error loading assets!');
    return;
  }

  engine = new CascadeEngine(canvas, {
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    winEvaluator,
    scatterSymbol: 'bonus',
    symbolsConfig: themeAssets.symbolsConfig,
    spritesheetUrl: themeAssets.spritesheetUrl,
    betAmount: BET_AMOUNT,
    onStateChange: (state) => handleStateChange(state),
    onScatterTrigger: (scatterCount, isInFreeSpins) => handleScatterTrigger(scatterCount, isInFreeSpins),
    onWin: (winInfo) => handleWin(winInfo),
  });

  updateUI();
  setupUIHandlers();
  buildPaytableContent();
}

function updateUI() {
  if (!engine) return;
  displayBalance.textContent = `$${engine.balance.toFixed(2)}`;
  betValue.textContent = engine.betAmount.toFixed(2);

  if (engine.inFreeSpins) {
    fsPanel.classList.add('active');
    fsCounter.textContent = `FREE SPINS: ${engine.freeSpinsRemaining} / ${engine.freeSpinsTotal}`;
  } else {
    fsPanel.classList.remove('active');
  }
}

function handleStateChange(state) {
  updateUI();

  if (state === 'dropping_in' || state === 'falling') {
    btnSpin.textContent = 'STOP';
    btnSpin.className = 'btn-spin spinning';
    gameTicker.textContent = state === 'dropping_in' ? 'DROPPING IN...' : 'CASCADING...';
  } else if (state === 'clearing') {
    gameTicker.textContent = 'SWEET WIN!';
  } else {
    btnSpin.textContent = 'SPIN';
    btnSpin.className = 'btn-spin';

    if (state === 'showing_wins') {
      gameTicker.textContent = `WIN: $${engine.lastWin.toFixed(2)}!`;
    } else if (state === 'free_spins_intro') {
      gameTicker.textContent = 'BONUS TRIGGER!';
    } else if (state === 'game_over') {
      gameTicker.textContent = 'FREE SPINS COMPLETE!';
      handleFreeSpinsComplete();
    } else {
      gameTicker.textContent = 'IDLE';
    }
  }
}

function handleWin(winInfo) {
  updateUI();
}

function handleScatterTrigger(scatterCount, isInFreeSpins) {
  if (isInFreeSpins) {
    engine.retriggerFreeSpins(FREE_SPINS_AWARD);
    gameTicker.textContent = `+${FREE_SPINS_AWARD} EXTRA SPINS!`;
    engine.audio.playScatterTrigger();
    updateUI();
    return;
  }

  pendingFreeSpinsAward = FREE_SPINS_AWARD;
  engine.enterFreeSpinsIntro();
  fsAwardAmount.textContent = FREE_SPINS_AWARD;
  modalFsTrigger.classList.add('active');
  engine.audio.playScatterTrigger();
}

function startFreeSpins() {
  modalFsTrigger.classList.remove('active');
  engine.enterFreeSpins(pendingFreeSpinsAward);
}

function handleFreeSpinsComplete() {
  fsTotalWin.textContent = `$${engine.freeSpinsAccumulatedWin.toFixed(2)}`;
  modalFsSummary.classList.add('active');
  engine.audio.playScatterTrigger();
}

function closeFreeSpinsSummary() {
  modalFsSummary.classList.remove('active');
  engine.returnToIdle();
  updateUI();
  engine.handleAutoPlay();
}

function setupUIHandlers() {
  btnSpin.addEventListener('click', () => {
    engine.requestSpin();
  });

  betMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.betAmount > BET_STEP + 1e-9) {
      engine.betAmount = Math.round((engine.betAmount - BET_STEP) * 100) / 100;
      updateUI();
    }
  });

  betPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newBet = Math.round((engine.betAmount + BET_STEP) * 100) / 100;
    if (newBet <= BET_MAX + 1e-9 && engine.balance >= newBet) {
      engine.betAmount = newBet;
      updateUI();
    }
  });

  btnAuto.addEventListener('click', () => {
    engine.autoPlay = !engine.autoPlay;
    btnAuto.classList.toggle('active', engine.autoPlay);
    if (engine.autoPlay && engine.state === 'idle') {
      engine.spin();
    }
  });

  btnTurbo.addEventListener('click', () => {
    engine.turboMode = !engine.turboMode;
    btnTurbo.classList.toggle('active', engine.turboMode);
  });

  btnMute.addEventListener('click', () => {
    const isMuted = engine.audio.toggleMute();
    btnMute.textContent = isMuted ? '🔇 Sound OFF' : '🔊 Sound ON';
    btnMute.classList.toggle('active', isMuted);
  });

  btnPaytable.addEventListener('click', () => {
    modalPaytable.classList.add('active');
  });

  const closePaytable = () => modalPaytable.classList.remove('active');
  btnPaytableOk.addEventListener('click', closePaytable);
  document.querySelector('#modal-paytable .btn-modal-close').addEventListener('click', closePaytable);

  if (btnStartFs) btnStartFs.addEventListener('click', startFreeSpins);
  if (btnCloseFsSummary) btnCloseFsSummary.addEventListener('click', closeFreeSpinsSummary);

  if (DEBUG_MODE && cheatScatter) {
    cheatScatter.addEventListener('click', () => engine.forceScatterResult());
  }
}

function buildPaytableContent() {
  const container = document.getElementById('paytable-grid-content');
  container.innerHTML = '';

  for (const symbol of Object.keys(PAYTABLE)) {
    const meta = PAYTABLE[symbol];
    const item = document.createElement('div');
    item.className = 'paytable-item';

    const title = document.createElement('span');
    title.className = 'paytable-symbol-name';
    title.textContent = meta.friendlyName || symbol;
    item.appendChild(title);

    const payLines = document.createElement('div');
    payLines.className = 'paytable-payouts';

    let content = '';
    if (meta.clusterPayout) {
      meta.clusterPayout.forEach(tier => {
        const label = tier.min >= 25 ? `${tier.min}+` : (() => {
          const next = meta.clusterPayout.find(t => t.min > tier.min);
          return next ? `${tier.min}-${next.min - 1}` : `${tier.min}+`;
        })();
        content += `<strong>${label}:</strong> ${tier.multiplier}x<br>`;
      });
    } else {
      content += `<em style="color:#ff6ec7; font-size:10px;">Pays anywhere. 3+ triggers ${FREE_SPINS_AWARD} Free Spins (2x payout)</em>`;
    }

    payLines.innerHTML = content;
    item.appendChild(payLines);
    container.appendChild(item);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('load', initGame);
}
```

- [ ] **Step 2: Write `games/candyfrenzy/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Candy Frenzy - Cluster Pays Cascade Slot</title>
  <link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;700;800&family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style type="text/css">
    @import url('game.css');
  </style>
</head>
<body>

  <div class="cabinet-container">

    <header>
      <div class="title-logo">CANDY <span>FRENZY</span></div>
      <div class="top-controls">
        <button id="btn-paytable" class="btn-icon">📋 Paytable</button>
        <button id="btn-mute" class="btn-icon">🔊 Sound ON</button>
      </div>
    </header>

    <div class="game-viewport">
      <div id="game-ticker" class="game-ticker">IDLE</div>

      <div id="fs-panel" class="free-spins-panel">
        <div id="fs-counter" class="fs-counter">FREE SPINS: 10 / 10</div>
      </div>

      <canvas id="game-canvas"></canvas>

      <div class="debug-shortcuts">
        <span class="btn-debug" style="cursor:default; border:none; color:#777;">Cheats:</span>
        <button id="cheat-scatter" class="btn-debug">Bonus Trigger</button>
      </div>
    </div>

    <div class="dashboard">
      <div class="dashboard-panel">
        <div class="bet-container">
          <span class="dashboard-label">Balance</span>
          <span id="display-balance" class="dashboard-value">$1,000.00</span>
        </div>
      </div>

      <div class="dashboard-panel">
        <div class="bet-container">
          <span class="dashboard-label">Bet</span>
          <div class="bet-adjuster">
            <button id="bet-minus" class="btn-adjust">-</button>
            <span id="bet-value" class="bet-display-value">1.00</span>
            <button id="bet-plus" class="btn-adjust">+</button>
          </div>
        </div>
      </div>

      <div class="spin-section">
        <button id="btn-spin" class="btn-spin">SPIN</button>
      </div>

      <div class="auto-turbo-container">
        <button id="btn-turbo" class="btn-icon">⚡ Turbo</button>
        <button id="btn-auto" class="btn-icon">🔄 Auto</button>
      </div>
    </div>

    <div class="top-controls" style="position: fixed; bottom: 20px; right: 20px; z-index: 100; display: flex; gap: 10px;">
      <button id="btn-spinlog" class="btn-icon btn-sim-btn">SPIN LOG</button>
    </div>

  </div>

  <!-- MODALS -->

  <div id="modal-paytable" class="modal-overlay">
    <div class="modal-content" style="max-width: 600px;">
      <button class="btn-modal-close">×</button>
      <h2 style="font-family: 'Baloo 2', serif; color: var(--gold); margin-bottom: 10px;">CANDY FRENZY PAYTABLE</h2>
      <p style="font-size: 13px; color: #e0b0e8;">5+ orthogonally-connected symbols anywhere on the 7x7 grid pay as a cluster. No paylines. Winning clusters are removed and new candy cascades in - the spin only ends once a cascade produces no new cluster.</p>

      <div class="paytable-grid" id="paytable-grid-content">
        <!-- Rendered dynamically in game.js -->
      </div>
    </div>
  </div>

  <div id="modal-fs-trigger" class="modal-overlay">
    <div class="modal-content">
      <h2 style="font-family: 'Baloo 2', serif; color: var(--gold); font-size: 28px;">BONUS TRIGGERED!</h2>
      <p style="font-size: 14px; color: #fff; margin-top: 5px;">3+ BONUS SYMBOLS LANDED</p>
      <p style="font-size: 15px; color: #e0b0e8; margin: 15px 0;">
        You are awarded <strong id="fs-award-amount" style="color: var(--gold);">10</strong> FREE SPINS at 2x payout!
      </p>
      <button id="btn-start-fs" class="btn-primary">START FREE SPINS</button>
    </div>
  </div>

  <div id="modal-fs-summary" class="modal-overlay">
    <div class="modal-content">
      <h2 style="font-family: 'Baloo 2', serif; color: var(--gold); font-size: 32px;">FREE SPINS COMPLETE</h2>
      <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--gold); border-radius: 8px; padding: 20px; margin: 20px 0;">
        <span class="dashboard-label">Total Free Spins Win</span>
        <h3 id="fs-total-win" style="font-size: 36px; font-weight: 800; color: #fff; margin-top: 6px;">$0.00</h3>
      </div>
      <button id="btn-close-fs-summary" class="btn-primary">COLLECT PRIZE</button>
    </div>
  </div>

  <!-- Shared modal shell for SPIN LOG (reused from core/SpinLogPanel.js - no RUN SIMULATION/TUNE FREQUENCIES buttons/modals for this game) -->
  <div id="sim-modal" class="sim-modal" style="display: none;">
    <button class="btn-modal-close">×</button>
    <div id="sim-stats" class="sim-stats"></div>
  </div>

  <script type="module" src="./game.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `games/candyfrenzy/game.css`**

```css
:root {
  --gold: #ffe94a;
  --gold-glow: rgba(255, 233, 74, 0.4);
  --cabinet: #3a0e40;
  --cabinet-light: #5a1a63;
  --pink: #ff6ec7;
  --text: #ffe9fb;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  user-select: none;
}

body {
  background-color: #17061c;
  color: var(--text);
  font-family: 'Outfit', sans-serif;
  overflow: hidden;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at center, #2b0e33 0%, #0d0410 100%);
}

.cabinet-container {
  position: relative;
  width: 100%;
  max-width: 820px;
  height: 100%;
  max-height: 760px;
  display: flex;
  flex-direction: column;
  border: 4px solid var(--gold);
  border-radius: 16px;
  background: var(--cabinet);
  box-shadow: 0 0 40px rgba(0, 0, 0, 0.8), 0 0 20px var(--gold-glow);
  overflow: hidden;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 24px;
  background: linear-gradient(180deg, rgba(58, 14, 64, 0.9) 0%, rgba(23, 6, 28, 0.9) 100%);
  border-bottom: 2px solid rgba(255, 233, 74, 0.3);
  z-index: 10;
}

.title-logo {
  font-family: 'Baloo 2', sans-serif;
  font-size: 26px;
  font-weight: 800;
  color: #fff;
  text-shadow: 0 0 10px var(--pink), 0 0 20px var(--gold-glow);
}

.title-logo span {
  color: var(--gold);
}

.top-controls {
  display: flex;
  gap: 10px;
}

.btn-icon {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 233, 74, 0.3);
  color: var(--text);
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-icon:hover, .btn-icon.active {
  background: var(--gold);
  color: #201028;
}

.game-viewport {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  min-height: 0;
}

.game-ticker {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--gold);
  z-index: 5;
}

.free-spins-panel {
  position: absolute;
  top: 34px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(255, 110, 199, 0.15);
  border: 1px solid var(--pink);
  border-radius: 8px;
  padding: 4px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--pink);
  display: none;
  z-index: 5;
}

.free-spins-panel.active {
  display: block;
}

#game-canvas {
  max-width: 100%;
  max-height: 100%;
}

.debug-shortcuts {
  display: none;
  position: absolute;
  bottom: 4px;
  left: 4px;
  gap: 6px;
}

.debug-shortcuts.debug-enabled {
  display: flex;
}

.btn-debug {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #ccc;
  font-size: 10px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.dashboard {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 24px;
  background: linear-gradient(0deg, rgba(58, 14, 64, 0.9) 0%, rgba(23, 6, 28, 0.6) 100%);
  border-top: 2px solid rgba(255, 233, 74, 0.3);
}

.dashboard-panel {
  display: flex;
  flex-direction: column;
}

.bet-container {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dashboard-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: rgba(255, 233, 250, 0.5);
}

.dashboard-value {
  font-size: 16px;
  font-weight: 700;
  color: #fff;
}

.bet-adjuster {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-adjust {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px solid var(--gold);
  background: transparent;
  color: var(--gold);
  cursor: pointer;
  font-size: 14px;
}

.bet-display-value {
  font-size: 15px;
  font-weight: 700;
  min-width: 44px;
  text-align: center;
}

.spin-section {
  flex: 1;
  display: flex;
  justify-content: center;
}

.btn-spin {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  border: 4px solid var(--gold);
  background: radial-gradient(circle, var(--pink) 0%, #b6338f 100%);
  color: #fff;
  font-family: 'Baloo 2', sans-serif;
  font-weight: 800;
  font-size: 16px;
  cursor: pointer;
  box-shadow: 0 0 20px var(--gold-glow);
}

.btn-spin.spinning {
  opacity: 0.7;
}

.auto-turbo-container {
  display: flex;
  gap: 8px;
}

/* Modals - shared shell, same convention as every other game */
.modal-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal-overlay.active {
  display: flex;
}

.modal-content {
  position: relative;
  background: var(--cabinet-light);
  border: 2px solid var(--gold);
  border-radius: 16px;
  padding: 30px;
  max-width: 420px;
  width: 90%;
  text-align: center;
}

.btn-modal-close {
  position: absolute;
  top: 10px;
  right: 14px;
  background: none;
  border: none;
  color: #fff;
  font-size: 22px;
  cursor: pointer;
}

.btn-primary {
  margin-top: 10px;
  padding: 12px 28px;
  border-radius: 10px;
  border: none;
  background: var(--gold);
  color: #201028;
  font-weight: 800;
  font-size: 15px;
  cursor: pointer;
}

.paytable-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 16px 0;
  text-align: left;
}

.paytable-item {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 233, 74, 0.2);
  border-radius: 8px;
  padding: 10px;
}

.paytable-symbol-name {
  display: block;
  font-weight: 700;
  color: var(--gold);
  font-size: 13px;
  margin-bottom: 6px;
}

.paytable-payouts {
  font-size: 11px;
  color: #ddd;
  line-height: 1.5;
}

.sim-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: #1a0d1f;
  border: 2px solid var(--gold);
  border-radius: 16px;
  padding: 24px;
  max-width: 600px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
  z-index: 200;
}
```

- [ ] **Step 4: Write `games/candyfrenzy/README.md`**

```markdown
# Candy Frenzy

7×7 cluster-pays cascading slot, inspired by Sugar Rush-style games. Uses the shared
`core/` engine's cascade mechanic (`core/CascadeEngine.js` + `core/CascadeMath.js`) with
this game's own cluster win evaluator (`core/ClusterMath.js`).

## Rules

- **No paylines.** 5 or more of the same symbol, connected orthogonally (up/down/left/right,
  not diagonally), anywhere on the 7×7 grid pays as one cluster. A grid can have several
  clusters at once; each pays independently.
- **Cascading.** A winning cluster is removed; the symbols above it fall down to fill the
  gap, and new symbols drop in from the top to refill the grid. The grid is then
  re-evaluated — this can repeat several times within what is still one spin (same seed).
  The spin only ends, and payout is made, once a cascade step produces no new cluster.
- **Bonus / free spins.** 3+ `bonus` symbols anywhere on the final settled grid trigger
  10 free spins at 2× payout (no bet deducted). Landing 3+ again during free spins adds
  another 10 spins. `bonus` has no direct cash payout of its own.
- **Symbols** — Premium: Cotton Candy, Bubble Gum, Sugar Crystal, Candy Rocket, Candy Crown,
  Cake Slice. Regular: Mint, Gummy Bear, Jelly Bean, Chocolate, Chewy Candy, Cherry Candy.
  No wild in this version.

## Dev tooling

SPIN LOG is available (per-spin history + CSV export, same as every other game). RUN
SIMULATION / TUNE FREQUENCIES are **not** included — those tools are built around
line/scatter win evaluation and fixed-length reel-strip scrolling, neither of which this
game's cascading cluster mechanic uses; a cascade-aware equivalent is a separate future
project. The paytable multipliers here are a starting point, not a tuned RTP.

## Debug cheat

The **Bonus Trigger** button (visible when `DEBUG_MODE = true` in `game.js`) forces the
next spin's final grid to contain 3 `bonus` symbols, for testing the free-spins trigger and
retrigger without waiting for a natural hit.
```

- [ ] **Step 5: Wire the root portal page and README**

In `index.html` (root), add a new feature/link. Update the links block:

```html
    <div style="display: flex; gap: 16px; justify-content: center; flex-wrap: wrap;">
      <a href="games/bookbookbook/index.html" class="btn-play">ENTER THE TEMPLE</a>
      <a href="games/fruitmachine/index.html" class="btn-play">PLAY LUCKY FRUITS</a>
      <a href="games/barfruits/index.html" class="btn-play">PLAY BAR FRUITS</a>
      <a href="games/candyfrenzy/index.html" class="btn-play">PLAY CANDY FRENZY</a>
    </div>
```

In `README.md` (root), add a row to the games table:

```markdown
| Game | Grid | Bonus | README |
|---|---|---|---|
| Book of Book Book | 5x3, 10 lines | Book scatter → free spins with an expanding symbol | [games/bookbookbook](games/bookbookbook/README.md) |
| Lucky Fruits | 3x3, 1-5 lines | None — wilds only | [games/fruitmachine](games/fruitmachine/README.md) |
| Bar Fruits | 5x3, 10 lines | Star scatter → free spins, no expanding symbol | [games/barfruits](games/barfruits/README.md) |
| Candy Frenzy | 7x7, cluster pays (min. 5, no paylines) | Bonus scatter → free spins at 2x payout, cascading wins | [games/candyfrenzy](games/candyfrenzy/README.md) |
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS — every test file, including the new `cascademath.test.mjs`, `clustermath.test.mjs`, `gridlayout.test.mjs`, and the extended `spinlog.test.mjs`, plus all pre-existing tests unaffected.

- [ ] **Step 7: Manually verify the whole game end-to-end**

Use the `run` skill to launch the dev server and open `games/candyfrenzy/index.html`:
- Confirm the 7×7 grid loads with candy art (not broken image icons — this confirms the
  asset move in Task 8 and the tiles.json fetch path both work).
- Spin normally: confirm symbols drop in, any clusters found pop and cascade, new symbols
  fall in from the top, and this repeats until a step has no win — then the ticker shows
  the total win and balance updates once, for the whole spin.
- Click **Bonus Trigger** (debug cheat): confirm the free-spins trigger modal appears,
  starting free spins shows the free-spins panel/counter, spins during free spins don't
  deduct balance and pay double, and triggering again during free spins adds +10 to the
  counter instead of opening a second trigger modal.
- Open the paytable modal: confirm all 12 candy symbols and their cluster-size tiers render
  correctly, and `bonus`'s description shows.
- Open **SPIN LOG**: confirm spins appear with correct bet/win amounts and a
  cluster-win summary column.
- Confirm turbo mode speeds up the cascade animation, and autoplay keeps spinning between
  wins.

- [ ] **Step 8: Commit**

```bash
git add games/candyfrenzy/game.js games/candyfrenzy/index.html games/candyfrenzy/game.css games/candyfrenzy/README.md index.html README.md
git commit -m "$(cat <<'EOF'
feat: add Candy Frenzy - 7x7 cluster-pays cascading slot

New game built on CascadeEngine/CascadeMath/ClusterMath: no paylines,
5+ orthogonally-connected symbols cluster-pay anywhere on the grid,
winning clusters cascade (remove, fall, refill, re-evaluate) within one
spin, and 3+ bonus symbols on the final grid trigger free spins at 2x
payout. Wired into the root portal and README alongside the other three
games; SPIN LOG included, RUN SIMULATION/TUNE FREQUENCIES intentionally
omitted (no cascade-aware simulator yet).
EOF
)"
```

---

## Plan self-review

**Spec coverage:**
- 7×7 grid, no paylines, orthogonal min-5 clusters — Tasks 2, 9 (`REELS_COUNT`/`ROWS_COUNT`/`MIN_CLUSTER_SIZE`, `findClusters`).
- Cascading remove/fall/refill within one spin, same seed — Task 1 (`resolveCascadeSequence`, `applyCascade`), Task 7 (`CascadeEngine` playback).
- Cluster paytable, tiers, symbol split — Task 9 (`PAYTABLE`, `REGULAR_PAYOUT`/`PREMIUM_PAYOUT`).
- Bonus scatter → free spins, 2× payout, retrigger — Task 7 (`_finishSpin`, `enterFreeSpins`/`retriggerFreeSpins`), Task 9 (`handleScatterTrigger`).
- No wild in v1, `chest`/`clover` unused — Task 9 (`PAYTABLE`/`BASE_FREQUENCIES` omit them).
- Generic `CascadeEngine`/`CascadeMath` reusable by a future payline-cascade game (pluggable `winEvaluator` closure) — Tasks 1, 7.
- Shared `GridLayout`/`SpriteDrawer`/`ParticleSystem` extraction, `SlotEngine` control flow untouched — Tasks 3, 4, 5.
- Reel strips via unmodified `generateReel`, per-column cursor continuing forward (not re-rolled) — Task 1 (`nextStripSymbol`), Task 9 (`FREQUENCY_REELn`/`REEL_STRIPS`).
- SPIN LOG wired, RUN SIMULATION/TUNE FREQUENCIES omitted — Task 6, Task 9 (`index.html` has no sim/tune buttons).
- Asset relocation to `assets/<theme>/` convention — Task 8.
- Portal/README wiring — Task 9, Step 5.

No gaps found.

**Placeholder scan:** No TBD/TODO, no "add appropriate X," no bare prose steps without code. Confirmed clean.

**Type consistency:** `resolveCascadeSequence`'s return shape (`cascadeSteps[i] = {grid, fallOffsets, clusterWins, payout}`, `totalPayoutMultiplier`, `finalGrid`, `scatterWin`) is used identically in Task 1's own tests, Task 7's `CascadeEngine` (`this.cascadeSequence.cascadeSteps`, `.totalPayoutMultiplier`, `.scatterWin`), and Task 6's `createCascadeSpinLogEntry` (`cascadeSteps` param). `checkClusterWins`'s return shape (`clusterWins`, `totalPayoutMultiplier`, `scatterWin`) matches what `resolveCascadeSequence` expects from its `winEvaluator` parameter exactly. `computeGridLayout`'s return field names (`cssWidth`, `cssHeight`, `canvasWidth`, `canvasHeight`, `cellSize`, `reelsWidth`, `reelsHeight`, `reelsX`, `reelsY`) are used identically in Task 3's `SlotEngine.resize()` rewrite and Task 7's `CascadeEngine.resize()`. `drawSpriteSymbol`'s signature is identical at both call sites (Task 4's `SlotEngine.drawSymbol`, Task 7's `CascadeEngine._renderGridSymbols`). `ParticleSystem`'s `spawn`/`update`/`render` names match between Task 5's `SlotEngine` usage and Task 7's `CascadeEngine` usage.
