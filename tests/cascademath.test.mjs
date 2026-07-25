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
