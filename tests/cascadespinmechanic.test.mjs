import test from 'node:test';
import assert from 'node:assert/strict';
import { CascadeSpinMechanic } from '../core/engine/mechanics/CascadeSpinMechanic.js';

test('resolveLiveSpin returns the cascade sequence steps plus the sequence-level scatterWin', () => {
  const reelStrips = [
    ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a'],
  ];
  const noWinEvaluator = () => ({ clusterWins: [], totalPayoutMultiplier: 0, scatterWin: null });

  const result = CascadeSpinMechanic.resolveLiveSpin({
    reelStrips, rowsCount: 3, seed: 1, winEvaluator: noWinEvaluator, maxCascadeSteps: 10,
  });

  assert.ok(Array.isArray(result.steps));
  assert.ok(result.steps.length >= 1);
  assert.ok('grid' in result.steps[0]);
  assert.ok('fallOffsets' in result.steps[0]);
  assert.ok('clusterWins' in result.steps[0]);
  assert.ok('payout' in result.steps[0]);
  assert.equal(result.scatterWin, null);
});
