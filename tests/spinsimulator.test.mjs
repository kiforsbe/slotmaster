import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins } from '../core/SpinSimulator.js';
import { checkWildLineWins, generateReel, createSeededRng } from '../core/SlotMath.js';

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

test('simulateSpins is reproducible with a seeded rng, and varies without one', () => {
  const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));
  const config = {
    reelsCount: 3,
    rowsCount: 3,
    paytable: PAYTABLE,
    reelStrips,
    paylines: PAYLINES3,
    winEvaluator: checkWildLineWins,
  };

  const seededA = simulateSpins(config, 2000, 1, 5, createSeededRng(42));
  const seededB = simulateSpins(config, 2000, 1, 5, createSeededRng(42));
  assert.equal(seededA.totalWins, seededB.totalWins, 'same seed should reproduce identical totalWins');
  assert.equal(seededA.rtpRaw, seededB.rtpRaw, 'same seed should reproduce identical rtpRaw');

  const seededC = simulateSpins(config, 2000, 1, 5, createSeededRng(43));
  assert.notEqual(seededA.totalWins, seededC.totalWins, 'a different seed should (virtually certainly) differ');

  // Omitting rng entirely must still work exactly as before (default Math.random).
  const unseeded = simulateSpins(config, 2000, 1, 5);
  assert.ok(typeof unseeded.rtpRaw === 'number' && unseeded.rtpRaw >= 0);
});
