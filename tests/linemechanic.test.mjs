import test from 'node:test';
import assert from 'node:assert/strict';
import { LineMechanic } from '../core/engine/mechanics/LineMechanic.js';

test('resolveLiveSpin returns a single-step sequence with the resolved grid and payout', () => {
  const reelStrips = [['a', 'b'], ['a', 'b'], ['a', 'b']];
  const config = {
    paytable: { a: { payout: [0, 0, 5], type: 'normal' } },
    paylines: [[0, 0, 0]],
  };

  const result = LineMechanic.resolveLiveSpin({
    reelStrips, rowsCount: 1, seed: 1, config, linesCount: 1,
  });

  assert.equal(result.steps.length, 1);
  assert.ok(Array.isArray(result.steps[0].grid));
  assert.equal(typeof result.steps[0].payout, 'number');
  assert.ok('lineWins' in result.steps[0]);
  assert.ok('scatterWin' in result.steps[0]);
  assert.ok('scatterWin' in result);
});

test('resolveLiveSpin is deterministic for a given seed', () => {
  const reelStrips = [['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c']];
  const config = { paytable: { a: { payout: [0, 0, 5] } }, paylines: [[0, 0, 0]] };

  const first = LineMechanic.resolveLiveSpin({ reelStrips, rowsCount: 1, seed: 7, config, linesCount: 1 });
  const second = LineMechanic.resolveLiveSpin({ reelStrips, rowsCount: 1, seed: 7, config, linesCount: 1 });

  assert.deepEqual(first.steps[0].grid, second.steps[0].grid);
});
