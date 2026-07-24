import test from 'node:test';
import assert from 'node:assert/strict';
import { gradientDescent1D, tuneFrequencies } from '../core/SpinSimulator.js';
import { checkWildLineWins } from '../core/SlotMath.js';
import {
  PAYTABLE, REELS_COUNT, ROWS_COUNT, PAYLINES, REEL_SEEDS, BET_PER_LINE, LINES_COUNT, REEL_LENGTH,
} from '../games/fruitmachine/game.js';

test('gradientDescent1D converges to a target metric on a synthetic deterministic function', async () => {
  // metric(param) = 20 * ln(param) + 50 - a plain deterministic function standing in for
  // measure(), so this isolates the optimizer's own convergence behavior from Monte Carlo
  // simulation noise entirely.
  const best = await gradientDescent1D({
    initialParam: 1,
    minParam: 0.01,
    maxParam: 100,
    target: 70,
    tolerance: 0.5,
    buildTrial: (param) => ({ param }),
    metricOf: (result) => result.value,
    measure: (trial) => ({ value: 20 * Math.log(trial.param) + 50, triggerRate: 0 }),
    maxIterations: 20,
    seedBase: 1,
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });

  assert.ok(best.error <= 0.5, `expected error <= 0.5, got ${best.error}`);
  // target 70 = 20*ln(param)+50 => ln(param) = 1 => param = e
  assert.ok(Math.abs(best.mult - Math.E) < 0.1, `expected mult near e (${Math.E}), got ${best.mult}`);
});

test('gradientDescent1D clamps to maxParam when the target is unreachable within bounds', async () => {
  // metric grows without bound as param grows, but param is capped at 10 - target 1000
  // needs param far beyond 10, so the search must land at (not beyond) the boundary.
  const best = await gradientDescent1D({
    initialParam: 1,
    minParam: 1,
    maxParam: 10,
    target: 1000,
    tolerance: 0.5,
    buildTrial: (param) => ({ param }),
    metricOf: (result) => result.value,
    measure: (trial) => ({ value: 5 * trial.param, triggerRate: 0 }),
    maxIterations: 15,
    seedBase: 1,
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(best.mult <= 10.0001, `expected mult clamped to <= 10, got ${best.mult}`);
});

test('gradientDescent1D reports a distinct error per step, not a single frozen value', async () => {
  const errors = [];
  await gradientDescent1D({
    initialParam: 1,
    minParam: 0.01,
    maxParam: 100,
    target: 70,
    tolerance: 0.001, // tight enough that it won't converge in 6 steps, so all 6 report
    buildTrial: (param) => ({ param }),
    metricOf: (result) => result.value,
    measure: (trial) => ({ value: 20 * Math.log(trial.param) + 50, triggerRate: 0 }),
    maxIterations: 6,
    seedBase: 1,
    onProgress: (i, param, result) => { errors.push(result.error); },
    yieldToEventLoop: () => Promise.resolve(),
  });
  const distinct = new Set(errors.map(e => e.toFixed(8)));
  assert.ok(distinct.size > 1, `expected per-step error to vary, got ${errors}`);
});

function assertNeverInvertsPayoutOrder(paytable) {
  const nonWild = Object.keys(paytable).filter(s => paytable[s].type !== 'wild');
  for (const a of nonWild) {
    for (const b of nonWild) {
      const payoutA = paytable[a].payout.at(-1);
      const payoutB = paytable[b].payout.at(-1);
      if (payoutA > payoutB) {
        assert.ok(
          paytable[a].frequency <= paytable[b].frequency,
          `${a} (payout ${payoutA}, freq ${paytable[a].frequency}) should not be more ` +
          `frequent than ${b} (payout ${payoutB}, freq ${paytable[b].frequency})`
        );
      }
    }
  }
}

test('tuneFrequencies defaults to rankTilt and never inverts payout order', async () => {
  const tuned = await tuneFrequencies(PAYTABLE, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 40000, trialsPerPoint: 1, maxIterations: 12,
  });
  assertNeverInvertsPayoutOrder(tuned.paytable);
});

test('tuneFrequencies premiumSplit also never inverts payout order', async () => {
  const tuned = await tuneFrequencies(PAYTABLE, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 40000, trialsPerPoint: 1, maxIterations: 12,
    frequencyMode: 'premiumSplit',
  });
  assertNeverInvertsPayoutOrder(tuned.paytable);
});

test('tuneFrequencies diagnostics expose a per-step error via onProgress, not a single frozen value', async () => {
  const errorsSeen = [];
  await tuneFrequencies(PAYTABLE, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 10,
    onProgress: (phase, i, mult, result) => { if (phase === 'shape') errorsSeen.push(result.error); },
  });
  const distinct = new Set(errorsSeen.map(e => e.toFixed(6)));
  assert.ok(distinct.size > 1, `expected per-step error to vary across iterations, got ${errorsSeen}`);
});

test('tuneFrequencies diagnostics.rtpPhase includes a numeric error field', async () => {
  const { diagnostics } = await tuneFrequencies(PAYTABLE, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 8,
  });
  assert.ok(typeof diagnostics.rtpPhase.error === 'number');
});
