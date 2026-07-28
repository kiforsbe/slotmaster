import test from 'node:test';
import assert from 'node:assert/strict';
import { findClusters, checkClusterWins } from '../core/math/ClusterMath.js';

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
