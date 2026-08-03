import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLandedSymbols } from '../core/engine/animators/ReelScrollAnimator.js';

test('buildLandedSymbols wraps a 3-row target column with one leading and two trailing filler symbols', () => {
  const calls = [];
  const pickRandom = (strip) => { calls.push(strip); return 'FILLER'; };
  const result = buildLandedSymbols(['a', 'b'], ['x', 'y', 'z'], pickRandom);
  assert.deepEqual(result, ['FILLER', 'x', 'y', 'z', 'FILLER', 'FILLER']);
  assert.equal(calls.length, 3, 'pickRandom is called once per filler slot');
});

test('buildLandedSymbols generalizes to a 5-row target column (Beach Party grid shape)', () => {
  const pickRandom = () => 'FILLER';
  const result = buildLandedSymbols(['a'], ['r1', 'r2', 'r3', 'r4', 'r5'], pickRandom);
  assert.deepEqual(result, ['FILLER', 'r1', 'r2', 'r3', 'r4', 'r5', 'FILLER', 'FILLER']);
  assert.equal(result.length, 5 + 3, 'matches the rowsCount + 3 buffer size _ensureReels allocates');
});
