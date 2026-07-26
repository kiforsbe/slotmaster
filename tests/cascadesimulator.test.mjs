import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins, tuneFrequencies, computeValueRanks } from '../core/SpinSimulator.js';
import { LineMechanic } from '../core/LineMechanic.js';
import { CascadeSpinMechanic } from '../core/CascadeSpinMechanic.js';
import { createMultiplierTilesMode } from '../core/FreeSpinsModes.js';
import { checkWildLineWins, generateReel, createSeededRng } from '../core/SlotMath.js';

test('simulateSpins with mechanic: LineMechanic passed explicitly reproduces the default (omitted) behavior exactly', () => {
  const PAYLINES3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
  const PAYTABLE = { bar: { payout: [0, 0, 10], frequency: 1 } };
  const reelStrips = [0, 1, 2].map(i => generateReel(PAYTABLE, 50, 111 + i));
  const config = { reelsCount: 3, rowsCount: 3, paytable: PAYTABLE, reelStrips, paylines: PAYLINES3, winEvaluator: checkWildLineWins };

  const implicit = simulateSpins(config, 2000, 1, 5, createSeededRng(7));
  const explicit = simulateSpins({ ...config, mechanic: LineMechanic }, 2000, 1, 5, createSeededRng(7));
  assert.deepEqual(implicit, explicit, 'passing LineMechanic explicitly must be identical to the default');
});

// A synthetic single-cell "grid" (1 reel, 1 row) driven entirely by an evaluator that ignores
// grid content and instead alternates win/no-win by call count - this makes the cascade
// sequence (and, critically, exactly which spin a scatter trigger lands on) fully deterministic
// regardless of resolveCascadeSequence's own internal random cursor, unlike a real paytable/
// reel-strip-driven setup would be.
function makeAlternatingClusterEvaluator() {
  let callIndex = 0;
  return function evaluator() {
    const idx = callIndex++;
    const isWinStep = idx % 2 === 0;
    // The base spin's free-spins trigger fires on its TERMINAL (no-win) step, matching how a
    // real cascade game checks the scatter count on the final settled grid, not mid-cascade -
    // idx 1 is exactly that step (idx 0 = the base spin's one winning step).
    const scatterWin = idx === 1 ? { symbol: 'bonus', count: 3, triggerFreeSpins: true, payout: 0 } : null;
    if (!isWinStep) return { clusterWins: [], totalPayoutMultiplier: 0, scatterWin };
    return { clusterWins: [{ symbol: 'x', count: 5, payout: 1, winningPositions: [[0, 0]] }], totalPayoutMultiplier: 1, scatterWin };
  };
}

test('CascadeSpinMechanic carries a free-spins mode\'s persistent state (multiplier tiles) correctly across an entire free-spins round', () => {
  const config = {
    reelsCount: 1, rowsCount: 1,
    paytable: { x: { clusterPayout: [{ min: 1, multiplier: 1 }] }, bonus: {} },
    reelStrips: [['x']],
    winEvaluator: makeAlternatingClusterEvaluator(),
    mechanic: CascadeSpinMechanic,
    freeSpinsMode: createMultiplierTilesMode(),
    freeSpinsCount: 5,
  };

  const results = simulateSpins(config, 1, 1, 1);

  assert.equal(results.freeSpinsTriggered, 1);
  // 1 base spin + 5 awarded free spins.
  assert.equal(results.totalSpins, 6);
  // Base spin costs and wins 1 (unwrapped - the free-spins mode never touches a base spin).
  assert.equal(results.totalBets, 1, 'free spins cost nothing - only the base spin is charged');

  const freeClusterWins = results.detailedWins.filter(w => w.type === 'cluster' && w.isFreeSpin);
  assert.deepEqual(freeClusterWins.map(w => w.winAmount), [1, 2, 4, 8, 16],
    'each free spin\'s win at the same tile must reflect that tile\'s multiplier BEFORE this win, doubling after each hit - exactly what the live engine\'s per-cluster onClusterCleared replay produces');

  // Base spin (1) + free-spins total (1+2+4+8+16=31).
  assert.equal(results.totalWins, 32);
});

test('CascadeSpinMechanic.defaultPayoutOf ranks by the highest cluster-payout tier', () => {
  const paytable = {
    premium: { clusterPayout: [{ min: 5, multiplier: 0.5 }, { min: 10, multiplier: 5 }] },
    regular: { clusterPayout: [{ min: 5, multiplier: 0.1 }] },
    noPayout: {},
  };
  assert.equal(CascadeSpinMechanic.defaultPayoutOf(paytable, 'premium'), 5);
  assert.equal(CascadeSpinMechanic.defaultPayoutOf(paytable, 'regular'), 0.1);
  assert.equal(CascadeSpinMechanic.defaultPayoutOf(paytable, 'noPayout'), 0);
});

test('computeValueRanks uses a custom payoutOf (cluster tiers) instead of the line-pay default when given one', () => {
  const paytable = {
    premium: { clusterPayout: [{ min: 5, multiplier: 5 }] },
    regular: { clusterPayout: [{ min: 5, multiplier: 1 }] },
    alsoRegular: { clusterPayout: [{ min: 5, multiplier: 1 }] },
  };
  const ranks = computeValueRanks(paytable, ['premium', 'regular', 'alsoRegular'], CascadeSpinMechanic.defaultPayoutOf);
  assert.equal(ranks.premium, 0, 'highest-paying symbol gets rank 0');
  assert.equal(ranks.regular, ranks.alsoRegular, 'equally-paying symbols share a rank');
  assert.ok(ranks.regular > ranks.premium);
});

test('computeValueRanks defaults to the line-pay payout-array convention when payoutOf is omitted', () => {
  const paytable = { bar: { payout: [0, 5, 10] }, cherry: { payout: [0, 1, 2] } };
  const ranks = computeValueRanks(paytable, ['bar', 'cherry']);
  assert.equal(ranks.bar, 0);
  assert.equal(ranks.cherry, 1);
});

test('tuneFrequencies with mechanic: CascadeSpinMechanic runs against a cluster-payout paytable without throwing', async () => {
  // Tiny synthetic setup - just enough symbols/reels to exercise Phase 1 (scatter/trigger
  // scaling) and Phase 2 (joint frequency search) end to end. Not a statistical RTP assertion -
  // just confirms the cascade mechanic plugs into tuneFrequencies' existing search machinery
  // (gradientDescent1D/nelderMead/computeValueRanks) without any cascade-specific changes
  // needed there.
  //
  // The evaluator deliberately ignores grid content and alternates win/no-win by call count
  // (see makeAlternatingClusterEvaluator above) rather than doing real symbol-count-based
  // clustering - a content-driven evaluator here risks a self-sustaining win loop (clearing and
  // refilling favors whichever symbol is most frequent, which can keep "winning" almost every
  // cascade step) that pushes every simulated spin toward resolveCascadeSequence's 1000-step
  // safety valve, which is correct behavior for a real game but far too slow multiplied across
  // a tuning search's thousands of trial spins and dozens of candidates.
  const paytable = {
    premium: { clusterPayout: [{ min: 2, multiplier: 2 }] },
    regular: { clusterPayout: [{ min: 2, multiplier: 0.5 }] },
    bonus: { triggerFreeSpins: true },
  };
  const reelTables = [
    { symbols: { premium: { frequency: 3 }, regular: { frequency: 10 }, bonus: { frequency: 1 } } },
    { symbols: { premium: { frequency: 3 }, regular: { frequency: 10 }, bonus: { frequency: 1 } } },
  ];

  const result = await tuneFrequencies(paytable, reelTables, {
    reelsCount: 2, rowsCount: 2, reelLength: 50, reelSeeds: [1, 2],
    betPerLine: 1, linesCount: 1, winEvaluator: makeAlternatingClusterEvaluator(), mechanic: CascadeSpinMechanic,
    targetRtp: 90, trialSpins: 500, trialsPerPoint: 1, maxIterations: 5,
  });

  assert.ok(typeof result.rtp === 'number' && Number.isFinite(result.rtp));
  assert.equal(result.reelFrequencyTables.length, 2);
  assert.ok(result.reelFrequencyTables[0].symbols.bonus.frequency >= 0);
});
