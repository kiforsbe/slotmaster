import test from 'node:test';
import assert from 'node:assert/strict';
import { gradientDescent1D, nelderMead, tuneFrequencies } from '../core/SpinSimulator.js';
import { checkWildLineWins } from '../core/SlotMath.js';
import {
  PAYTABLE, REELS_COUNT, ROWS_COUNT, PAYLINES, REEL_SEEDS, BET_PER_LINE, LINES_COUNT, REEL_LENGTH,
  FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3,
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

test('nelderMead minimizes a simple 2D quadratic bowl', async () => {
  // loss(x, y) = (x-3)^2 + (y+2)^2 - deterministic, minimum at (3, -2), loss 0 there.
  const { point, loss, converged } = await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 100,
    convergenceTolerance: 1e-6,
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(converged, `expected convergence, got loss=${loss}`);
  assert.ok(Math.abs(point[0] - 3) < 0.01, `expected x near 3, got ${point[0]}`);
  assert.ok(Math.abs(point[1] - (-2)) < 0.01, `expected y near -2, got ${point[1]}`);
});

test('nelderMead respects maxIterations and still returns the best point found', async () => {
  const { loss, iterations } = await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 3,
    convergenceTolerance: 1e-9, // unreachable in 3 iterations, forces the cap
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(iterations <= 3, `expected iterations capped at 3, got ${iterations}`);
  assert.ok(loss < 13, `expected some improvement over the initial loss (9+4=13), got ${loss}`);
});

test('nelderMead carries extra evaluate() fields through onto the returned result', async () => {
  const { result } = await nelderMead({
    initialPoint: [0],
    initialStepSize: 1,
    evaluate: ([x]) => ({ loss: (x - 5) ** 2, tag: 'custom-field' }),
    maxIterations: 20,
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(result.tag, 'custom-field');
});

test('nelderMead reports per-iteration progress via onProgress', async () => {
  const iterationsSeen = [];
  await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 10,
    convergenceTolerance: 1e-9, // unreachable, so all 10 iterations run
    onProgress: (i, point, result, best) => { iterationsSeen.push(i); },
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.deepEqual(iterationsSeen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

const REEL_TABLES = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3];

function assertNeverInvertsPayoutOrderPerReel(paytable, reelFrequencyTables) {
  reelFrequencyTables.forEach((reelTable, reelIdx) => {
    const present = Object.keys(reelTable).filter(s => paytable[s].type !== 'wild' && reelTable[s].frequency > 0);
    for (const a of present) {
      for (const b of present) {
        const payoutA = paytable[a].payout.at(-1);
        const payoutB = paytable[b].payout.at(-1);
        if (payoutA > payoutB) {
          assert.ok(
            reelTable[a].frequency <= reelTable[b].frequency,
            `reel ${reelIdx + 1}: ${a} (payout ${payoutA}, freq ${reelTable[a].frequency}) should not be more ` +
            `frequent than ${b} (payout ${payoutB}, freq ${reelTable[b].frequency})`
          );
        }
      }
    }
  });
}

test('tuneFrequencies never inverts payout order within any single reel', async () => {
  // Fruit machine's real historical per-reel weights are NOT monotonic by payout to start
  // with (e.g. reel 1's clover, paying 20, starts 4x more frequent than grapes, paying 10) -
  // the ordering guarantee only holds once the tilt search actually reaches the crossover
  // point for the worst-case pair, so this needs enough iterations to get there, not just
  // enough to satisfy the (unrelated) RTP tolerance.
  const { reelFrequencyTables } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 8000, trialsPerPoint: 1, maxIterations: 20, rounds: 2,
  });
  assertNeverInvertsPayoutOrderPerReel(PAYTABLE, reelFrequencyTables);
});

test('tuneFrequencies never gives a reel-absent symbol (frequency 0) a nonzero frequency', async () => {
  const { reelFrequencyTables } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 8000, trialsPerPoint: 1, maxIterations: 4, rounds: 2,
  });
  // FREQUENCY_REEL1 and FREQUENCY_REEL2 both define star/strawberry at frequency: 0 (only
  // reel 3 carries them) - tuning must never turn those into nonzero frequencies.
  assert.equal(reelFrequencyTables[0].star.frequency, 0);
  assert.equal(reelFrequencyTables[0].strawberry.frequency, 0);
  assert.equal(reelFrequencyTables[1].star.frequency, 0);
  assert.equal(reelFrequencyTables[1].strawberry.frequency, 0);
});

test('tuneFrequencies diagnostics expose a per-step error and reel/round context via onProgress', async () => {
  const stepsSeen = [];
  await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 3, rounds: 2,
    onProgress: (phase, i, mult, result, best, context) => {
      if (phase === 'shape') stepsSeen.push({ error: result.error, context });
    },
  });
  const distinct = new Set(stepsSeen.map(s => s.error.toFixed(6)));
  assert.ok(distinct.size > 1, `expected per-step error to vary across iterations, got ${stepsSeen.map(s => s.error)}`);
  assert.ok(stepsSeen.every(s => s.context && typeof s.context.reelIndex === 'number' && typeof s.context.round === 'number'),
    'every "shape" phase progress callback must include { reelIndex, round }');
});

test('tuneFrequencies diagnostics.rtpPhase includes numeric error and boolean converged fields', async () => {
  const { diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 3, rounds: 1,
  });
  assert.ok(typeof diagnostics.rtpPhase.error === 'number');
  assert.ok(typeof diagnostics.rtpPhase.converged === 'boolean');
  // Fruit machine's paytable has no scatter-typed symbol, so this phase should be a no-op.
  assert.equal(diagnostics.scatterPhase, null);
});

test('tuneFrequencies throws if reelFrequencyTables.length does not match reelsCount', async () => {
  await assert.rejects(
    () => tuneFrequencies(PAYTABLE, [FREQUENCY_REEL1, FREQUENCY_REEL2], {
      reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
      reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
      trialSpins: 1000, maxIterations: 1, rounds: 1,
    }),
    /reelFrequencyTables/
  );
});
