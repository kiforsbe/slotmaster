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

// Single-element reel strips make every spin's grid identical regardless of the rng draw
// (Math.floor(rng() * 1) is always 0) - reelsCount=3, rowsCount=1, every reel entirely
// 'star', so every single spin (base or free) is a guaranteed 3-scatter hit. That isolates
// the free-spins award/retrigger bookkeeping from Monte Carlo noise entirely.
const ALL_STAR_PAYTABLE = { star: { payout: [0, 0, 0], type: 'scatter', paymode: 'any', triggerFreeSpins: true } };
const ALL_STAR_CONFIG = {
  reelsCount: 3,
  rowsCount: 1,
  paytable: ALL_STAR_PAYTABLE,
  reelStrips: [['star'], ['star'], ['star']],
  paylines: [[0, 0, 0]],
  scatterSymbol: 'star',
};

test('simulateSpins awards a flat freeSpinsCount with no retriggers when neither award table is configured (legacy behavior)', () => {
  const results = simulateSpins({ ...ALL_STAR_CONFIG }, 1, 1, 1);
  // 1 base spin (triggers) + flat freeSpinsCount default of 10, with no retrigger extension
  // even though every free spin is itself also a qualifying 3-scatter hit.
  assert.equal(results.totalSpins, 11);
});

test('simulateSpins looks up the awarded spin count from freeSpinsAwardTable by scatter count', () => {
  // retriggerFreeSpinsAwardTable: { 3: 0 } deliberately awards zero extra spins per retrigger -
  // every free spin here is itself a qualifying 3-scatter hit (all-star reels), so without an
  // explicit 0 the run would grow unbounded (see the dedicated retrigger test below); pinning
  // it to 0 isolates the *initial* award lookup from retrigger growth entirely.
  const results = simulateSpins({
    ...ALL_STAR_CONFIG,
    freeSpinsAwardTable: { 3: 7 },
    retriggerFreeSpinsAwardTable: { 3: 0 },
  }, 1, 1, 1);
  assert.equal(results.totalSpins, 8); // 1 base + 7 awarded via the table, not the flat default of 10
});

test('simulateSpins extends free spins on a retrigger, bounded by the global safety cap', () => {
  // Every free spin here is itself a qualifying retrigger (all-star reels) - without a cap
  // this would never terminate; the cap proves retriggering is actually being applied (total
  // spins run far exceeds the flat freeSpinsCount default) while still finishing in bounded time.
  // numBaseSpins=1 here, so FREE_SPINS_GLOBAL_CAP is its 50000 floor (max(1*20, 50000)).
  const results = simulateSpins({
    ...ALL_STAR_CONFIG,
    freeSpinsAwardTable: { 3: 1 },
    retriggerFreeSpinsAwardTable: { 3: 1 },
  }, 1, 1, 1);
  assert.equal(results.totalSpins, 1 + 50000, 'expected 1 base spin + the 50000-spin retrigger safety cap');
});

test('simulateSpins keeps simulating every base spin even after the global free-spins cap is exhausted', () => {
  // A per-triggering-chain-only cap would let numBaseSpins * cap total work happen in the
  // worst case (every base spin independently maxing out its own chain) - the cap here is
  // global across the whole call instead, so once it's hit, further triggers stop being
  // awarded any free spins at all, but the base-spin loop itself must still run to completion
  // (baseSpins/totalBets must reflect all 3 requested base spins, not fewer).
  const results = simulateSpins({
    ...ALL_STAR_CONFIG,
    freeSpinsAwardTable: { 3: 1 },
    retriggerFreeSpinsAwardTable: { 3: 1 },
  }, 3, 1, 1);
  assert.equal(results.baseSpins, 3);
  assert.equal(results.totalBets, 3, 'expected all 3 base spins to have been charged for, cap or no cap');
  assert.equal(results.totalSpins, 3 + 50000, 'only the first triggering base spin should consume the shared 50000 cap');
});

// A 4-reel, single-row setup where reels 1-3 are always 'star' (guaranteed 3-scatter trigger)
// and reel 4 is always 'other' (a plain, non-scatter symbol) - since 'other' is the ONLY
// non-scatter symbol in this paytable, it's the sole candidate checkExpandingWins' random pick
// could ever land on, making the outcome deterministic despite the randomization inside
// simulateSpins.
const EXPANDING_PAYTABLE = {
  star: { payout: [0, 0, 0], type: 'scatter', paymode: 'any', triggerFreeSpins: true },
  other: { payout: [5, 5, 5, 5] },
};
const EXPANDING_CONFIG = {
  reelsCount: 4,
  rowsCount: 1,
  paytable: EXPANDING_PAYTABLE,
  reelStrips: [['star'], ['star'], ['star'], ['other']],
  paylines: [[0, 0, 0, 0]],
  scatterSymbol: 'star',
  freeSpinsAwardTable: { 3: 1 }, // exactly one free spin per trigger, keeps this fast and exact
  // Every free spin is itself a qualifying 3-scatter hit (same all-star reels as the base
  // trigger) - without this, retriggerFreeSpinsAwardTable defaults to freeSpinsAwardTable (see
  // its own doc), so every free spin would also retrigger, running until the safety cap rather
  // than the single awarded spin this test is isolating.
  retriggerFreeSpinsAwardTable: { 3: 0 },
};

test('simulateSpins never simulates expanding wilds unless hasExpandingWild is set (legacy behavior)', () => {
  const results = simulateSpins({ ...EXPANDING_CONFIG }, 1, 1, 1);
  const expandingWins = results.detailedWins.filter(w => w.type === 'expanding');
  assert.equal(expandingWins.length, 0,
    'expected no expanding wins when hasExpandingWild is omitted, even though the free spin landed a real, winning symbol on reel 4');
});

test('simulateSpins simulates an expanding wild bonus when hasExpandingWild is set', () => {
  const results = simulateSpins({ ...EXPANDING_CONFIG, hasExpandingWild: true }, 1, 1, 1);
  const expandingWins = results.detailedWins.filter(w => w.type === 'expanding');
  assert.equal(expandingWins.length, 1, 'expected exactly one expanding win, from the one awarded free spin');
  assert.equal(expandingWins[0].symbol, 'other', "expected 'other' - the only non-scatter symbol in this paytable");
});
