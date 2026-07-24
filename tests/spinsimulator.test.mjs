import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins } from '../core/SpinSimulator.js';
import { checkWildLineWins, generateReel } from '../core/SlotMath.js';

const PAYLINES3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 1, 2], [2, 1, 0]];
const PAYTABLE = {
  bar:    { payout: [0, 0, 10], frequency: 1 },
  clover: { payout: [0, 0, 4], frequency: 2, wildPenalty: 1 },
  star:   { payout: [0, 0, 0], frequency: 1, wild: true, wildExcludes: ['bar'] },
};

test('simulateSpins works with a custom winEvaluator (checkWildLineWins)', () => {
  const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));
  const config = {
    reelsCount: 3,
    rowsCount: 3,
    paytable: PAYTABLE,
    reelStrips,
    paylines: PAYLINES3,
    winEvaluator: checkWildLineWins,
  };

  const results = simulateSpins(config, 5000, 1, 5);
  assert.equal(results.totalSpins, 5000);
  assert.ok(typeof results.rtpRaw === 'number' && results.rtpRaw >= 0);
});

test('simulateSpins defaults to checkWins when winEvaluator is omitted', () => {
  const bookLikeConfig = {
    reelsCount: 3,
    rowsCount: 3,
    paytable: { x: { payout: [0, 0, 50], frequency: 1, paymode: 'line' } },
    reelStrips: [0, 1, 2].map((i) => generateReel({ x: { frequency: 1 } }, 50, 999 + i)),
    paylines: PAYLINES3,
  };
  const bookLikeResults = simulateSpins(bookLikeConfig, 2000, 1, 5);
  assert.equal(bookLikeResults.totalSpins, 2000);
});
