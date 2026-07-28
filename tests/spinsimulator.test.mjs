import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins, mergeRoundStats } from '../core/SpinSimulator.js';
import { checkWildLineWins, generateReel, createSeededRng } from '../core/math/SlotMath.js';

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

test('simulateSpins leaves spinLog empty unless logSpins is set (opt-in, per its own doc)', () => {
  const results = simulateSpins({ ...EXPANDING_CONFIG, hasExpandingWild: true }, 1, 1, 1);
  assert.deepEqual(results.spinLog, [], 'expected no per-spin log entries without an explicit opt-in');
});

test('simulateSpins records one spinLog entry per simulated spin when logSpins is set', () => {
  const results = simulateSpins({ ...EXPANDING_CONFIG, hasExpandingWild: true, logSpins: true }, 1, 1, 1);
  // 1 base spin (the trigger) + 1 free spin (the single awarded spin) = 2 total.
  assert.equal(results.spinLog.length, 2, 'expected one log entry per base+free spin');
  assert.equal(results.totalSpins, 2);

  const [baseEntry, freeEntry] = results.spinLog;
  assert.equal(baseEntry.phase, 'base');
  assert.equal(baseEntry.totalBet, 1, 'base spin bet = betPerLine(1) * linesCount(1)');
  assert.equal(baseEntry.scatterCount, 3, 'the guaranteed 3-scatter trigger on reels 1-3');

  assert.equal(freeEntry.phase, 'free');
  assert.equal(freeEntry.totalBet, 0, 'free spins cost nothing to spin');
  assert.equal(freeEntry.expandingSymbol, 'other');
  assert.equal(freeEntry.expandingReels, 1, 'only reel 4 ever lands the non-scatter symbol here');
  assert.ok(freeEntry.expandingWin > 0);

  const loggedTotalWin = results.spinLog.reduce((sum, e) => sum + e.totalWin, 0);
  assert.equal(loggedTotalWin, results.totalWins, 'per-spin log totals must reconcile with the aggregate totalWins');
  const loggedTotalBet = results.spinLog.reduce((sum, e) => sum + e.totalBet, 0);
  assert.equal(loggedTotalBet, results.totalBets, 'per-spin log totals must reconcile with the aggregate totalBets');
});

// ---- Package 3.1: round-level win shape ----------------------------------------------------
// measure() returns RTP, trigger rate and trial spread, and throws away everything about the SHAPE
// of the wins. So "rough payout per win, and no massive variance" - a real design requirement -
// has had no metric, no target, no penalty and no display.

// A paying symbol on every line plus a guaranteed trigger, so rounds are deterministic and a
// round's total is unambiguously larger than any single spin inside it.
const ROUND_PAYTABLE = {
  star: { payout: [0, 0, 0], type: 'scatter', paymode: 'any', triggerFreeSpins: true },
};
const ROUND_CONFIG = {
  reelsCount: 3, rowsCount: 1, paytable: ROUND_PAYTABLE,
  reelStrips: [['star'], ['star'], ['star']],
  paylines: [[0, 0, 0]], scatterSymbol: 'star',
  freeSpinsAwardTable: { 3: 5 }, retriggerFreeSpinsAwardTable: { 3: 0 },
};

test('roundStats counts exactly one round per PAID spin, not per simulated spin', () => {
  // winDistribution keys individual SPINS, base and free alike, and free spins are charged 0 bet -
  // so they inflate the hit rate and deflate the mean. What a player experiences is a ROUND: one
  // paid spin plus every free spin it bought.
  const results = simulateSpins({ ...ROUND_CONFIG }, 20, 1, 1);
  assert.ok(results.roundStats, 'roundStats must always be produced');
  assert.equal(results.roundStats.rounds, 20);
  assert.equal(results.totalSpins, 120, '20 base + 20x5 free - the round count must not follow this');
});

test('a round is at least as large as the biggest single spin inside it', () => {
  // Units differ, deliberately and permanently: `results.maxWin` is an absolute amount in whatever
  // currency the bet was in, while every roundStats figure is a MULTIPLE OF THE BET, so the shape
  // is comparable across games and bet sizes. Comparing them raw is meaningless - the first draft
  // of this test did exactly that and read 6 against 30 on a bet of 5.
  const betPerLine = 1, linesCount = 5;
  const totalBet = betPerLine * linesCount;
  const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));
  const results = simulateSpins({
    reelsCount: 3, rowsCount: 3, paytable: PAYTABLE, reelStrips,
    paylines: PAYLINES3, winEvaluator: checkWildLineWins,
  }, 4000, betPerLine, linesCount);
  assert.ok(results.roundStats.maxWin >= results.maxWin / totalBet,
    `round max ${results.roundStats.maxWin}x must be >= biggest single spin ${results.maxWin / totalBet}x`);
});

test('roundStats needs no logSpins and holds no per-spin objects', () => {
  // logSpins holds one object per spin, which is why it is off by default at 1,000,000 spins.
  // roundStats must stay cheap enough to be on always - a few counters and a fixed histogram.
  const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));
  const results = simulateSpins({
    reelsCount: 3, rowsCount: 3, paytable: PAYTABLE, reelStrips,
    paylines: PAYLINES3, winEvaluator: checkWildLineWins, logSpins: false,
  }, 5000, 1, 5);
  assert.ok(results.roundStats);
  assert.equal(results.spinLog.length, 0);
  assert.ok(results.roundStats.histogram.length < 200, 'a fixed, small histogram - never one bucket per round');
});

test('roundStats percentiles are ordered and bracketed by mean and max', () => {
  const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));
  const results = simulateSpins({
    reelsCount: 3, rowsCount: 3, paytable: PAYTABLE, reelStrips,
    paylines: PAYLINES3, winEvaluator: checkWildLineWins,
  }, 20000, 1, 5);
  const rs = results.roundStats;
  assert.ok(rs.medianWin <= rs.p90 && rs.p90 <= rs.p99 && rs.p99 <= rs.p999,
    `percentiles must be monotone: ${rs.medianWin}, ${rs.p90}, ${rs.p99}, ${rs.p999}`);
  assert.ok(rs.p999 <= rs.maxWin * 1.5, 'p99.9 cannot exceed the largest round by more than a bucket width');
  assert.ok(rs.hitRate >= 0 && rs.hitRate <= 1);
  assert.ok(rs.volatilityIndex > 0, 'a game with varying wins has non-zero volatility');
});

test('roundStats mean win per round reconciles with RTP', () => {
  // meanWin is per unit bet, so mean x rounds / (rounds x bet) is exactly rtpRaw. If these two
  // ever disagree, one of them is measuring something other than what it claims.
  const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));
  const results = simulateSpins({
    reelsCount: 3, rowsCount: 3, paytable: PAYTABLE, reelStrips,
    paylines: PAYLINES3, winEvaluator: checkWildLineWins,
  }, 10000, 1, 5);
  assert.ok(Math.abs(results.roundStats.meanWin - results.rtpRaw) < 1e-9,
    `mean round return ${results.roundStats.meanWin} must equal rtpRaw ${results.rtpRaw}`);
});

test('top1PctShare says how much of the payout the rarest 1% of rounds carries', () => {
  // The single most useful number for "will this feel flat or spiky": a game paying 96% where the
  // top 1% of rounds carries 60% of it is a different game from one where they carry 10%.
  const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));
  const results = simulateSpins({
    reelsCount: 3, rowsCount: 3, paytable: PAYTABLE, reelStrips,
    paylines: PAYLINES3, winEvaluator: checkWildLineWins,
  }, 20000, 1, 5);
  const share = results.roundStats.top1PctShare;
  assert.ok(share >= 0 && share <= 1, `a share must be a fraction, got ${share}`);
});

test('mergeRoundStats reproduces exactly what one long run would have measured', () => {
  // A candidate is measured over several trials, and averaging their percentiles is wrong - the
  // mean of two medians is not the median of the union. Every quantity is instead recovered to its
  // underlying counter, added, and re-derived.
  const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));
  const config = {
    reelsCount: 3, rowsCount: 3, paytable: PAYTABLE, reelStrips,
    paylines: PAYLINES3, winEvaluator: checkWildLineWins,
  };
  // Two halves of one deterministic stream against the whole of it: the SAME rounds either way,
  // so a correct merge is exact rather than merely close.
  const rng = createSeededRng(4242);
  const a = simulateSpins(config, 3000, 1, 5, rng);
  const b = simulateSpins(config, 3000, 1, 5, rng);
  const merged = mergeRoundStats([a.roundStats, b.roundStats]);

  const whole = createSeededRng(4242);
  const together = simulateSpins(config, 6000, 1, 5, whole);

  assert.equal(merged.rounds, together.roundStats.rounds);
  assert.ok(Math.abs(merged.meanWin - together.roundStats.meanWin) < 1e-9,
    `merged mean ${merged.meanWin} vs single-run ${together.roundStats.meanWin}`);
  assert.ok(Math.abs(merged.volatilityIndex - together.roundStats.volatilityIndex) < 1e-9);
  assert.equal(merged.maxWin, together.roundStats.maxWin);
  assert.equal(merged.medianWin, together.roundStats.medianWin);
  assert.equal(merged.p99, together.roundStats.p99);
});

test('mergeRoundStats handles the empty and single-trial cases without inventing rounds', () => {
  assert.equal(mergeRoundStats([]).rounds, 0);
  assert.equal(mergeRoundStats([null, undefined]).rounds, 0);
  const one = { rounds: 5, hitRate: 0.4, meanWin: 1, volatilityIndex: 0.5, maxWin: 3, medianWin: 0, p90: 2, p99: 3, p999: 3, top1PctShare: 0.5, histogram: [] };
  assert.equal(mergeRoundStats([one]), one, 'a single trial is passed through untouched, not round-tripped');
});
