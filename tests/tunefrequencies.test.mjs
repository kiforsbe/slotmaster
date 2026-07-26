import test from 'node:test';
import assert from 'node:assert/strict';
import { gradientDescent1D, nelderMead, tuneFrequencies, simulateSpins } from '../core/SpinSimulator.js';
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

test('nelderMead fires onBusy with operation: "shrink" when reflection/expansion/contraction all fail to improve', async () => {
  // A flat plateau (loss 1000) everywhere except the exact origin (loss 0, which is also
  // initialPoint) - reflection/expansion/contraction essentially never land exactly on the
  // origin, so every iteration falls through to a shrink.
  const busyEvents = [];
  await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: (point) => ({ loss: point.every(v => Math.abs(v) < 1e-9) ? 0 : 1000 }),
    maxIterations: 5,
    convergenceTolerance: 1e-9,
    onProgress: null,
    onBusy: (info) => { busyEvents.push(info); },
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(busyEvents.length > 0, 'expected at least one shrink notification on a flat plateau');
  busyEvents.forEach(e => {
    assert.equal(e.operation, 'shrink');
    assert.equal(e.verticesToEvaluate, 3, 'a 2D search has a 3-vertex simplex (n+1)');
  });
});

test('nelderMead reports per-vertex shrink progress when busyReportIntervalMs is lowered', async () => {
  // Same flat-plateau setup as above, but with busyReportIntervalMs: 0 so every non-last
  // vertex's completion fires its own progress update (real usage throttles this to avoid
  // exactly this - see the default-interval test above, which asserts the opposite).
  const busyEvents = [];
  await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: (point) => ({ loss: point.every(v => Math.abs(v) < 1e-9) ? 0 : 1000 }),
    maxIterations: 1,
    convergenceTolerance: 1e-9,
    onProgress: null,
    onBusy: (info) => { busyEvents.push(info); },
    busyReportIntervalMs: 0,
    yieldToEventLoop: () => Promise.resolve(),
  });
  // 1 "starting" call (no verticesEvaluated) + one per non-last vertex of the 3-vertex simplex.
  assert.equal(busyEvents.length, 3);
  assert.equal(busyEvents[0].verticesEvaluated, undefined, 'the first call announces the shrink is starting, before any vertex is done');
  assert.deepEqual(busyEvents.slice(1).map(e => e.verticesEvaluated), [1, 2]);
});

test('nelderMead never fires onBusy on a smooth loss surface where reflection alone keeps improving', async () => {
  const busyEvents = [];
  await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 20,
    onProgress: null,
    onBusy: (info) => { busyEvents.push(info); },
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(busyEvents.length, 0, 'a well-behaved quadratic bowl should never need to shrink');
});

test('gradientDescent1D fires onBusy with operation: "widen-probe" exactly once, only when the initial probe is flat', async () => {
  // metric is a step function: flat (5) for param < 14, then 10 - initialParam=10 with the
  // default epsilon(0.05) only crosses that threshold once the probe widens several times
  // (widen=8), so this deterministically exercises the widen loop without needing maxIterations
  // to reach the point where the loop would otherwise stop before probing at all.
  const busyEvents = [];
  await gradientDescent1D({
    initialParam: 10, minParam: 1, maxParam: 100, target: 8, tolerance: 0.01,
    buildTrial: (param) => ({ param }),
    metricOf: (result) => result.value,
    measure: (trial) => ({ value: trial.param < 14 ? 5 : 10 }),
    maxIterations: 2,
    seedBase: 1,
    onProgress: null,
    onBusy: (info) => { busyEvents.push(info); },
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(busyEvents.length, 1, 'expected exactly one widen-probe notification, not one per widen attempt');
  assert.equal(busyEvents[0].operation, 'widen-probe');
  assert.equal(busyEvents[0].iteration, 0);
});

test('gradientDescent1D reports per-probe widen progress when busyReportIntervalMs is lowered', async () => {
  // Same step-function setup as above (flat below 14, resolves at widen=8), but with
  // busyReportIntervalMs: 0 so every probe attempt from the 2nd onward fires its own update.
  const busyEvents = [];
  await gradientDescent1D({
    initialParam: 10, minParam: 1, maxParam: 100, target: 8, tolerance: 0.01,
    buildTrial: (param) => ({ param }),
    metricOf: (result) => result.value,
    measure: (trial) => ({ value: trial.param < 14 ? 5 : 10 }),
    maxIterations: 2,
    seedBase: 1,
    onProgress: null,
    onBusy: (info) => { busyEvents.push(info); },
    busyReportIntervalMs: 0,
    yieldToEventLoop: () => Promise.resolve(),
  });
  // Resolves at probe attempt 4 (sign=+1, widen=8 - see the setup comment above) - attempts
  // 2, 3, 4 each fire (attempt 1's flat result is what triggers the very first onBusy call).
  assert.deepEqual(busyEvents.map(e => e.probeAttempt), [2, 3, 4]);
  busyEvents.forEach(e => assert.equal(e.operation, 'widen-probe'));
});

test('gradientDescent1D never fires onBusy when the first slope probe already succeeds', async () => {
  const busyEvents = [];
  await gradientDescent1D({
    initialParam: 1, minParam: 0.01, maxParam: 100, target: 70, tolerance: 0.5,
    buildTrial: (param) => ({ param }),
    metricOf: (result) => result.value,
    measure: (trial) => ({ value: 20 * Math.log(trial.param) + 50 }),
    maxIterations: 5,
    seedBase: 1,
    onProgress: null,
    onBusy: (info) => { busyEvents.push(info); },
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(busyEvents.length, 0, 'a smooth, always-measurable slope should never need to widen');
});

const REEL_TABLES = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3];

test('tuneFrequencies converges RTP close to target even when baseline data has a large ordering violation', async () => {
  // Old design: FREQUENCY_REEL1's melon (pays 15x) at freq 20 vs grapes (pays 10x) at
  // freq 4 forced a hard floor to t=5.0, overriding an RTP search that had already
  // converged - and that override, compounding across reels, made RTP unreachable (ended
  // near 131% against a 96% target). The new design should actually reach the target.
  // maxIterations: 100, not 80 - buildReelStrips now seeds identically to production
  // (reelSeeds[i], no extra offset - see tuneFrequencies' own comment), which changes the
  // exact concrete reel arrangement explored and thus the search's trajectory; verified via a
  // throwaway script that 80 iterations lands at 'exhausted' with error ~10.3 (just outside
  // this test's tolerance) while 100+ reliably reaches 'converged-with-violations' well inside it.
  const { rtp, diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 100,
  });
  assert.ok(Math.abs(rtp - 96) < 10, `expected RTP within 10 points of target, got ${rtp}`);
  assert.ok(typeof diagnostics.rtpPhase.orderingViolations === 'object', 'orderingViolations must be reported (possibly empty), never omitted');
});

test('tuneFrequencies honors a per-reel reversed ordering preference (orderingBiasByReel)', async () => {
  // bias +1 on reel index 1 reverses that reel's preference: a higher-paying symbol should
  // end up no *less* frequent than a lower-paying one there - the opposite of the default -1
  // behavior, useful for a "near-miss" design (premium symbols show up often on some reels,
  // rarely on another, so lines look close but rarely land).
  const { reelFrequencyTables, diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 80,
    orderingPenaltyWeight: 5, orderingBiasByReel: [-1, 1, -1],
  });
  const reversedReel = reelFrequencyTables[1].symbols;
  assert.ok(reversedReel.bar.frequency >= reversedReel.cherries.frequency,
    `expected bar (highest pay) >= cherries (lowest tier) on the bias-reversed reel, got bar=${reversedReel.bar.frequency} cherries=${reversedReel.cherries.frequency}`);
  assert.ok(diagnostics.rtpPhase.orderingViolations.every(v => v.reel !== 1 || v.bias === 1),
    'any violation reported on the bias-reversed reel must itself carry bias: 1');
});

test('tuneFrequencies diagnostics.rtpPhase reports fixedSymbols and a sane rtpRange', async () => {
  const reelTablesWithFixedBar = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, fixed: true } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
  const { rtp, diagnostics } = await tuneFrequencies(PAYTABLE, reelTablesWithFixedBar, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 10,
  });
  assert.deepEqual(diagnostics.rtpPhase.fixedSymbols, [{ reel: 0, symbol: 'bar' }]);
  const { min, max } = diagnostics.rtpPhase.rtpRange;
  assert.ok(min <= max, `expected rtpRange.min (${min}) <= rtpRange.max (${max})`);
  assert.ok(min <= rtp && rtp <= max, `expected achieved RTP ${rtp} within explored range [${min}, ${max}]`);
});

test('tuneFrequencies diagnostics.rtpPhase.trialRtpMin/Max collapse to a single value when trialsPerPoint is 1', async () => {
  // No repeat measurement is ever taken with trialsPerPoint: 1, so there's no variance
  // information to report - min/max both equal the one trial's own RTP, which itself equals
  // the (only) measured rtp for the final candidate.
  const { rtp, diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 10,
  });
  const { trialRtpMin, trialRtpMax } = diagnostics.rtpPhase;
  assert.equal(trialRtpMin, trialRtpMax, 'expected no spread whatsoever with only one trial per point');
  assert.equal(trialRtpMin, rtp, "expected the lone trial's RTP to equal the reported rtp exactly");
});

test('tuneFrequencies diagnostics.rtpPhase.trialRtpMin/Max report the final candidate\'s own trial-to-trial spread when trialsPerPoint > 1', async () => {
  // A synthetic high-variance runTrial (alternates between a very low and very high RTP every
  // other call) stands in for a real high-variance mechanic (e.g. a cascade bonus whose
  // multiplier can stack) - this isolates the reporting plumbing from real Monte Carlo noise,
  // which could randomly happen to produce a near-zero spread and make the assertion flaky.
  let callCount = 0;
  const runTrial = async () => {
    callCount++;
    const rtpRaw = (callCount % 2 === 0) ? 1.90 : 0.10; // alternates ~10% and ~190% RTP
    return { rtpRaw, freeSpinsTriggered: 1, baseSpins: 1000 };
  };
  const { diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 1000, trialsPerPoint: 4, maxIterations: 3, runTrial,
  });
  const { trialRtpMin, trialRtpMax, rtp } = diagnostics.rtpPhase;
  assert.ok(trialRtpMin < rtp && rtp < trialRtpMax,
    `expected the averaged rtp (${rtp}) to sit strictly between trialRtpMin (${trialRtpMin}) and trialRtpMax (${trialRtpMax})`);
  assert.ok(Math.abs(trialRtpMin - 10) < 0.01, `expected trialRtpMin near 10%, got ${trialRtpMin}`);
  assert.ok(Math.abs(trialRtpMax - 190) < 0.01, `expected trialRtpMax near 190%, got ${trialRtpMax}`);
});

test('tuneFrequencies diagnostics.rtpPhase.trialRtpStdDev/trialRtpStdError are computed correctly and 0 when trialsPerPoint is 1', async () => {
  // A synthetic runTrial with a KNOWN, exact per-trial RTP sequence (0%, 20%, 40%, 60% - not
  // alternating, so the sample std dev has a hand-checkable closed form) isolates the actual
  // arithmetic from real Monte Carlo noise entirely.
  let callCount = 0;
  const fixedRtps = [0, 0.20, 0.40, 0.60];
  const runTrial = async () => {
    const rtpRaw = fixedRtps[callCount % fixedRtps.length];
    callCount++;
    return { rtpRaw, freeSpinsTriggered: 1, baseSpins: 1000 };
  };
  const { diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 1000, trialsPerPoint: 4, maxIterations: 1, runTrial,
  });
  // Mean = 30, sample variance (n-1) = ((30)^2+(10)^2+(10)^2+(30)^2)/3 = 2000/3, stdDev = sqrt(2000/3).
  const expectedStdDev = Math.sqrt(2000 / 3);
  const expectedStdError = expectedStdDev / Math.sqrt(4);
  assert.ok(Math.abs(diagnostics.rtpPhase.trialRtpStdDev - expectedStdDev) < 0.01,
    `expected trialRtpStdDev ~${expectedStdDev.toFixed(4)}, got ${diagnostics.rtpPhase.trialRtpStdDev}`);
  assert.ok(Math.abs(diagnostics.rtpPhase.trialRtpStdError - expectedStdError) < 0.01,
    `expected trialRtpStdError ~${expectedStdError.toFixed(4)}, got ${diagnostics.rtpPhase.trialRtpStdError}`);

  const single = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 10,
  });
  assert.equal(single.diagnostics.rtpPhase.trialRtpStdDev, 0, 'expected 0 (not NaN) std dev with only one trial per point');
  assert.equal(single.diagnostics.rtpPhase.trialRtpStdError, 0, 'expected 0 (not NaN) std error with only one trial per point');
});

test('tuneFrequencies options.maxRtpStdError refuses to call an unreliable candidate "converged" even though its average RTP hit target', async () => {
  // A synthetic runTrial that alternates between two very different RTPs whose AVERAGE lands
  // almost exactly on target (96%) - without a std-error gate, this would report 'converged' on
  // a measurement that's really just noise (a real high-variance mechanic's exact failure mode -
  // see the design doc/session that motivated this option). trialSpins/maxIterations are tiny
  // for test speed - this only needs to prove the gate fires, not perform a real search.
  let callCount = 0;
  const runTrial = async () => {
    callCount++;
    const rtpRaw = (callCount % 2 === 0) ? 1.90 : 0.02; // average ~96%, wildly disagreeing trials
    return { rtpRaw, freeSpinsTriggered: 1, baseSpins: 1000 };
  };
  const commonOptions = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 1000, trialsPerPoint: 4, maxIterations: 3, runTrial,
  };

  const gated = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...commonOptions, maxRtpStdError: 1 });
  assert.ok(Math.abs(gated.diagnostics.rtpPhase.error) < 3, 'sanity check: the average RTP really is within rtpTolerancePct of target');
  assert.notEqual(gated.diagnostics.rtpPhase.reason, 'converged',
    'expected a high-std-error "hit" to NOT be classified as converged when maxRtpStdError gates it');
  assert.equal(gated.diagnostics.rtpPhase.converged, false, 'expected the top-level converged flag to also reflect the gate');

  // Same exact noisy measurements, but the gate left at its Infinity default - the old
  // behavior (a lucky-looking average is accepted at face value) must still be reachable for
  // every caller that never opts into maxRtpStdError. Reason may land on either
  // 'converged' or 'converged-with-violations' depending on whether this fixture's baseline
  // reel tables already satisfy the ordering/limit penalties too - either way, rtpOk itself
  // (the thing maxRtpStdError actually gates) must have been satisfied, unlike the gated run above.
  const ungated = await tuneFrequencies(PAYTABLE, REEL_TABLES, commonOptions);
  assert.ok(['converged', 'converged-with-violations'].includes(ungated.diagnostics.rtpPhase.reason),
    `expected the exact same measurements to still count as an accepted RTP hit when maxRtpStdError is left at its default (off), got ${ungated.diagnostics.rtpPhase.reason}`);
});

test('tuneFrequencies leaves a symbol untouched on a reel where its own entry sets fixed: true, even if not wild-typed', async () => {
  // `fixed` lives on the reel data itself (per symbol, per reel), independent of the
  // paytable's `type` - a perfectly ordinary value symbol (bar) can be pinned on one specific
  // reel while staying freely tunable everywhere else.
  const reelTablesWithFixedBar = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, fixed: true } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
  const { reelFrequencyTables } = await tuneFrequencies(PAYTABLE, reelTablesWithFixedBar, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 8000, trialsPerPoint: 1, maxIterations: 20,
  });
  assert.equal(reelFrequencyTables[0].symbols.bar.frequency, FREQUENCY_REEL1.symbols.bar.frequency,
    `expected bar's frequency on reel 1 to stay exactly at its baseline (fixed: true), got ${reelFrequencyTables[0].symbols.bar.frequency}`);
  // bar is only fixed on reel 1 - reel 3 (which also carries bar, not fixed there) should
  // remain freely tunable, i.e. is not expected to equal its own baseline.
});

test('tuneFrequencies respects a soft max frequency limit on a reel symbol (limitPenaltyWeight)', async () => {
  const cap = FREQUENCY_REEL1.symbols.bar.frequency / 2;
  const cappedTables = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, maxFrequency: cap } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
  const { reelFrequencyTables, diagnostics } = await tuneFrequencies(PAYTABLE, cappedTables, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 80,
    limitPenaltyWeight: 10,
  });
  assert.ok(reelFrequencyTables[0].symbols.bar.frequency <= cap + 2,
    `expected bar's frequency to stay close to its soft cap of ${cap}, got ${reelFrequencyTables[0].symbols.bar.frequency}`);
  assert.ok(Array.isArray(diagnostics.rtpPhase.limitViolations), 'limitViolations must be reported (possibly empty), never omitted');
});

test('tuneFrequencies applies a reel-level default maxFrequency to a symbol without its own override', async () => {
  const cap = FREQUENCY_REEL1.symbols.bar.frequency / 2;
  const cappedByDefault = [
    { ...FREQUENCY_REEL1, defaults: { ...FREQUENCY_REEL1.defaults, maxFrequency: cap } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
  const { reelFrequencyTables, diagnostics } = await tuneFrequencies(PAYTABLE, cappedByDefault, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 80,
    limitPenaltyWeight: 10,
  });
  // bar has no per-symbol maxFrequency of its own here - only the reel-level default should
  // constrain it, exactly as if it had been set directly on bar (mirrors the existing
  // per-symbol-override test's own tolerance).
  assert.ok(reelFrequencyTables[0].symbols.bar.frequency <= cap + 2,
    `expected bar's frequency to stay close to the reel-default cap of ${cap} (no per-symbol override), got ${reelFrequencyTables[0].symbols.bar.frequency}`);
  assert.ok(Array.isArray(diagnostics.rtpPhase.limitViolations), 'limitViolations must be reported (possibly empty), never omitted');
});

test('tuneFrequencies never gives a reel-absent symbol (frequency 0) a nonzero frequency', async () => {
  const { reelFrequencyTables } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 8000, trialsPerPoint: 1, maxIterations: 4,
  });
  // FREQUENCY_REEL1 and FREQUENCY_REEL2 both define star/strawberry at frequency: 0 (only
  // reel 3 carries them) - tuning must never turn those into nonzero frequencies.
  assert.equal(reelFrequencyTables[0].symbols.star.frequency, 0);
  assert.equal(reelFrequencyTables[0].symbols.strawberry.frequency, 0);
  assert.equal(reelFrequencyTables[1].symbols.star.frequency, 0);
  assert.equal(reelFrequencyTables[1].symbols.strawberry.frequency, 0);
});

test('tuneFrequencies\' scatter phase keys off triggerFreeSpins, not type', async () => {
  // A type: 'scatter' symbol with triggerFreeSpins: false must NOT be scaled by Phase 1;
  // conversely (not tested here, since fruitmachine/bookbookbook always agree on the two),
  // this only proves the filter reads triggerFreeSpins rather than type.
  const paytableWithMismatch = {
    ...PAYTABLE,
    bar: { ...PAYTABLE.bar, type: 'scatter', triggerFreeSpins: false },
  };
  const { diagnostics } = await tuneFrequencies(paytableWithMismatch, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 3,
  });
  // No symbol in this paytable actually has triggerFreeSpins: true, so Phase 1 must be a
  // no-op (scatterPhase null) even though `bar` is type: 'scatter'.
  assert.equal(diagnostics.scatterPhase, null);
});

test('tuneFrequencies diagnostics expose a per-step error via onProgress, without a reel/round context', async () => {
  const stepsSeen = [];
  await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    // The committed FREQUENCY_REEL1/2/3 are already close to targetRtp (someone adopted a
    // tuned result), so a short run can genuinely find no improvement for a few iterations
    // before noise/search finally moves the best - needs more than a handful of iterations
    // to reliably show variation, unlike when the baseline was still far from optimal.
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 20,
    onProgress: (phase, i, mult, result, best) => {
      if (phase === 'shape') stepsSeen.push({ error: result.error, mult });
    },
  });
  const distinct = new Set(stepsSeen.map(s => s.error.toFixed(6)));
  assert.ok(distinct.size > 1, `expected per-step error to vary across iterations, got ${stepsSeen.map(s => s.error)}`);
  assert.ok(stepsSeen.every(s => s.mult === null), 'phase "shape" no longer has one scalar per step - mult must always be null');
});

test('tuneFrequencies diagnostics.rtpPhase includes numeric error and boolean converged fields', async () => {
  const { diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 3,
  });
  assert.ok(typeof diagnostics.rtpPhase.error === 'number');
  assert.ok(typeof diagnostics.rtpPhase.converged === 'boolean');
  assert.ok(typeof diagnostics.rtpPhase.iterationsRun === 'number');
  assert.ok(Array.isArray(diagnostics.rtpPhase.orderingViolations));
  // Fruit machine's paytable has no scatter-typed symbol, so this phase should be a no-op.
  assert.equal(diagnostics.scatterPhase, null);
});

test('tuneFrequencies gives up early and stays deterministic on a genuinely infeasible target', async () => {
  const opts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    // 100000% RTP is unreachable for this paytable no matter how frequencies are shuffled -
    // renormalization conserves each reel's total weight budget and every symbol needs at
    // least 1 occurrence, so there's a hard ceiling far below this. orderingBiasByReel: [0,0,0]
    // disables the ordering preference for this test specifically - ordering-violation totals
    // are computed deterministically from the exact reel weights (not sampled, unlike RTP), so
    // they keep ratcheting down for a long time as the simplex moves even once RTP itself has
    // hit its structural ceiling; that's correct per-component behavior (an RTP plateau alone
    // shouldn't restart the search while another front is still genuinely improving - see
    // 'exhausted' in the design doc), but it means a *reliable* 'stalled' test needs RTP
    // isolated as the only active front. Mirrors the barfruits case that motivated this (a
    // scatter payout that made 96% unreachable at a 1% trigger rate).
    targetRtp: 100000, trialSpins: 4000, trialsPerPoint: 1, maxIterations: 100,
    stallWindowIterations: 8, maxStallRestarts: 3, orderingBiasByReel: [0, 0, 0],
  };
  const result = await tuneFrequencies(PAYTABLE, REEL_TABLES, opts);
  const rp = result.diagnostics.rtpPhase;
  assert.equal(rp.reason, 'stalled', `expected 'stalled', got '${rp.reason}' (error=${rp.error})`);
  assert.ok(rp.restarts > 0, `expected at least one restart, got ${rp.restarts}`);
  assert.ok(rp.iterationsRun < rp.iterationsBudget,
    `expected to give up before exhausting the ${rp.iterationsBudget}-iteration budget, used ${rp.iterationsRun}`);

  // Determinism: an identical second call reproduces exactly, including restart count -
  // the seed-shifting on restart must still be a pure function of the original searchSeed.
  const result2 = await tuneFrequencies(PAYTABLE, REEL_TABLES, opts);
  assert.deepEqual(result.reelFrequencyTables, result2.reelFrequencyTables);
  assert.equal(result.diagnostics.rtpPhase.restarts, result2.diagnostics.rtpPhase.restarts);
});

test('tuneFrequencies stops early once already essentially resolved (reason: converged)', async () => {
  // REEL_TABLES is fruitmachine's own live, hand-edited game data (its reel-level `defaults`
  // can carry a minFrequency/maxFrequency someone is actively tuning against in-game, e.g. a
  // maxFrequency far below bar's real baseline frequency there) - this test only cares about
  // the "already essentially resolved" early-exit reason logic, not about satisfying whatever
  // per-reel limit someone happens to have configured at the moment the suite runs, so it
  // strips `defaults` on its own copy the same way orderingBiasByReel: [0,0,0] below strips
  // the ordering preference - both isolate this test from fronts it isn't testing.
  const reelTablesNoDefaults = REEL_TABLES.map(rt => ({ ...rt, defaults: {} }));
  const result = await tuneFrequencies(PAYTABLE, reelTablesNoDefaults, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 30000, trialsPerPoint: 2, maxIterations: 150,
    // Loose on purpose - REEL_TABLES is already close to 96%, but not necessarily within
    // 0.01 points of it. If this doesn't produce 'converged', check the actual measured RTP
    // via a throwaway script and either loosen this further or tighten trialSpins' noise.
    // orderingBiasByReel: [0,0,0] disables the ordering preference - "fully resolved" requires
    // both ordering and limit penalty totals to hit exactly 0, and REEL_TABLES' real baseline
    // (verified via a throwaway script) has small persistent ordering violations under the
    // default preference that a soft-penalty search doesn't fully eliminate, which would keep
    // this stuck at 'converged-with-violations' instead - not what this test is checking.
    earlyAcceptErrorPct: 3, orderingBiasByReel: [0, 0, 0],
  });
  const rp = result.diagnostics.rtpPhase;
  assert.equal(rp.reason, 'converged', `expected 'converged', got '${rp.reason}' (error=${rp.error})`);
  assert.ok(rp.iterationsRun < rp.iterationsBudget,
    `expected to stop early, used ${rp.iterationsRun} of ${rp.iterationsBudget}`);
});

test('tuneFrequencies reports converged-with-violations when RTP is reachable but an ordering conflict is not', async () => {
  const conflictedTables = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, minFrequency: FREQUENCY_REEL1.symbols.cherries.frequency * 5 } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
  const result = await tuneFrequencies(PAYTABLE, conflictedTables, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    // maxIterations: 120, not 60 - the forced conflict needs more than a single 60-iteration
    // budget for the ordering front to actually plateau (verified via a throwaway script); at
    // 60 it's still gradually improving, which is correctly NOT what 'stillImproving.ordering
    // === false' should assert against.
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 8000, trialsPerPoint: 1, maxIterations: 120,
    limitPenaltyWeight: 20, orderingPenaltyWeight: 0.5, stallWindowIterations: 8, maxStallRestarts: 3,
  });
  const rp = result.diagnostics.rtpPhase;
  assert.equal(rp.reason, 'converged-with-violations', `expected 'converged-with-violations', got '${rp.reason}' (error=${rp.error}, orderingPenaltyRemaining=${rp.orderingPenaltyRemaining})`);
  assert.ok(rp.orderingPenaltyRemaining > 0,
    `expected a remaining ordering violation forced by bar's artificially high min, got ${rp.orderingPenaltyRemaining}`);
  assert.equal(rp.stillImproving.ordering, false, 'expected ordering to be reported as no longer improving once genuinely stuck');
});

test('tuneFrequencies throws if reelFrequencyTables.length does not match reelsCount', async () => {
  await assert.rejects(
    () => tuneFrequencies(PAYTABLE, [FREQUENCY_REEL1, FREQUENCY_REEL2], {
      reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
      reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
      trialSpins: 1000, maxIterations: 1,
    }),
    /reelFrequencyTables/
  );
});

// Fully synthetic (not fruitmachine's live/hand-tuned data) so these stay stable regardless of
// anyone's in-progress edits elsewhere - a single reel, single payline, four value symbols that
// all pay identically. Since every spin always lands exactly one symbol and every symbol pays
// the same, RTP is structurally constant (500%) no matter how the frequency budget is split
// between them - this isolates uniformityPenaltyWeight's effect on the loss entirely from RTP
// pressure, so any reshaping toward an equal split is unambiguously the uniformity term at work.
const UNIFORMITY_PAYTABLE = {
  a: { payout: [5] }, b: { payout: [5] }, c: { payout: [5] }, d: { payout: [5] },
};
const UNIFORMITY_REEL_TABLES = [
  { defaults: {}, symbols: { a: { frequency: 20 }, b: { frequency: 1 }, c: { frequency: 1 }, d: { frequency: 1 } } },
];
const UNIFORMITY_COMMON_OPTIONS = {
  reelsCount: 1, rowsCount: 1, paylines: [[0]],
  reelSeeds: [42], betPerLine: 1, linesCount: 1, reelLength: 200,
  targetRtp: 500, rtpTolerancePct: 5, trialSpins: 4000, trialsPerPoint: 1, maxIterations: 40,
  orderingBiasByReel: [0], // isolates uniformity from the (unrelated) ordering preference entirely
};

test('tuneFrequencies pulls tunable frequencies toward an equal per-reel split when uniformityPenaltyWeight is set', async () => {
  const withoutUniformity = await tuneFrequencies(UNIFORMITY_PAYTABLE, UNIFORMITY_REEL_TABLES, {
    ...UNIFORMITY_COMMON_OPTIONS, uniformityPenaltyWeight: 0,
  });
  const withUniformity = await tuneFrequencies(UNIFORMITY_PAYTABLE, UNIFORMITY_REEL_TABLES, {
    ...UNIFORMITY_COMMON_OPTIONS, uniformityPenaltyWeight: 5,
  });

  assert.ok(
    withUniformity.diagnostics.rtpPhase.uniformityPenaltyRemaining < withoutUniformity.diagnostics.rtpPhase.uniformityPenaltyRemaining,
    `expected uniformity weighting to reduce the spread - without=${withoutUniformity.diagnostics.rtpPhase.uniformityPenaltyRemaining}, with=${withUniformity.diagnostics.rtpPhase.uniformityPenaltyRemaining}`
  );

  const values = Object.values(withUniformity.reelFrequencyTables[0].symbols).map(s => s.frequency);
  const spread = Math.max(...values) - Math.min(...values);
  assert.ok(spread < 5, `expected the uniformity-weighted run's frequencies to land much closer together (equal share is 5.75 each), got spread=${spread} (values: ${values})`);
});

test('tuneFrequencies uniformityPenaltyWeight defaults to off and never blocks a converged reason', async () => {
  const result = await tuneFrequencies(UNIFORMITY_PAYTABLE, UNIFORMITY_REEL_TABLES, UNIFORMITY_COMMON_OPTIONS);
  assert.equal(result.diagnostics.rtpPhase.reason, 'converged');
  assert.ok(typeof result.diagnostics.rtpPhase.uniformityPenaltyRemaining === 'number');
});

test('tuneFrequencies excludes a fixed: true symbol from uniformity\'s equal-share target entirely', async () => {
  // fixedSym's frequency (100) is wildly larger than a/b/c's own budget (1+19+10=30) - if it
  // leaked into uniformity's "equal share" computation at all, a/b/c would get pulled toward
  // (30+100)/4=32.5 each instead of their own 30/3=10. Same "everyone pays the same" trick as
  // UNIFORMITY_PAYTABLE isolates RTP pressure from this entirely.
  const paytable = { a: { payout: [5] }, b: { payout: [5] }, c: { payout: [5] }, fixedSym: { payout: [5] } };
  const reelTables = [{ symbols: {
    a: { frequency: 1 }, b: { frequency: 19 }, c: { frequency: 10 },
    fixedSym: { frequency: 100, fixed: true },
  } }];
  const result = await tuneFrequencies(paytable, reelTables, {
    reelsCount: 1, rowsCount: 1, paylines: [[0]],
    reelSeeds: [42], betPerLine: 1, linesCount: 1, reelLength: 200,
    targetRtp: 500, rtpTolerancePct: 5, trialSpins: 4000, trialsPerPoint: 1, maxIterations: 40,
    orderingBiasByReel: [0], uniformityPenaltyWeight: 5,
  });
  const symbols = result.reelFrequencyTables[0].symbols;
  assert.equal(symbols.fixedSym.frequency, 100, 'fixed: true must leave the symbol\'s own frequency untouched');
  ['a', 'b', 'c'].forEach(s => {
    assert.ok(Math.abs(symbols[s].frequency - 10) < 2,
      `expected ${s} pulled toward a/b/c's OWN equal share (10), not one inflated by fixedSym's 100 (got ${symbols[s].frequency})`);
  });
});

// d and e deliberately have no minFrequency/maxFrequency at all - initialWeightStrategy only
// has a defined [min, max] range to sample from once both bounds are configured, so neither is
// ever resampled regardless of strategy. Their post-renormalization frequencies still shift
// alongside a/b/c's though (renormalizeWeights rescales every tunable symbol on a reel by the
// same factor to fit the reel's fixed budget) - so "was d resampled" isn't observable from d's
// own absolute value. What IS invariant if - and only if - neither is being resampled is their
// *ratio* to each other (7:3), since a uniform rescale preserves ratios between the untouched
// symbols even while it moves their absolute values. initialStepSize is tiny so every vertex in
// the very first simplex - whichever one onProgress's first call (i===0) reports post-sort -
// is within a hair of its unperturbed values, keeping the assertions robust regardless of which
// vertex happens to sort first under Monte Carlo noise.
const INITIAL_WEIGHT_PAYTABLE = {
  a: { payout: [3] }, b: { payout: [3] }, c: { payout: [3] }, d: { payout: [3] }, e: { payout: [3] },
};
const INITIAL_WEIGHT_REEL_TABLES = [
  { defaults: {}, symbols: {
    a: { frequency: 5, minFrequency: 1, maxFrequency: 20 },
    b: { frequency: 5, minFrequency: 1, maxFrequency: 20 },
    c: { frequency: 5, minFrequency: 1, maxFrequency: 20 },
    d: { frequency: 7 },
    e: { frequency: 3 },
  } },
];
const INITIAL_WEIGHT_COMMON_OPTIONS = {
  reelsCount: 1, rowsCount: 1, paylines: [[0]],
  reelSeeds: [11], betPerLine: 1, linesCount: 1, reelLength: 200,
  targetRtp: 50, rtpTolerancePct: 40, trialSpins: 500, trialsPerPoint: 1,
  maxIterations: 1, orderingBiasByReel: [0], initialStepSize: 0.0001,
};

async function captureFirstCandidate(strategy, searchSeed) {
  let captured = null;
  await tuneFrequencies(INITIAL_WEIGHT_PAYTABLE, INITIAL_WEIGHT_REEL_TABLES, {
    ...INITIAL_WEIGHT_COMMON_OPTIONS,
    initialWeightStrategy: strategy,
    searchSeed,
    onProgress: (phase, i, mult, r) => {
      if (phase === 'shape' && i === 0 && !captured) captured = { ...r.trial[0].symbols };
    },
  });
  return captured;
}

test('tuneFrequencies initialWeightStrategy defaults to "provided" (unchanged baseline start)', async () => {
  const candidate = await captureFirstCandidate('provided', 7);
  assert.ok(Math.abs(candidate.a.frequency - 5) < 0.01, `expected a to start at its baseline 5, got ${candidate.a.frequency}`);
  assert.ok(Math.abs(candidate.d.frequency - 7) < 0.01, `expected d to start at its baseline 7, got ${candidate.d.frequency}`);
  assert.ok(Math.abs(candidate.e.frequency - 3) < 0.01, `expected e to start at its baseline 3, got ${candidate.e.frequency}`);
});

test('tuneFrequencies initialWeightStrategy never resamples a symbol missing either bound', async () => {
  for (const strategy of ['provided', 'uniform', 'normal']) {
    const candidate = await captureFirstCandidate(strategy, 7);
    const ratio = candidate.d.frequency / candidate.e.frequency;
    assert.ok(Math.abs(ratio - 7 / 3) < 0.01,
      `expected unbounded d:e to keep their baseline 7:3 ratio under strategy '${strategy}' (only a uniform rescale from a/b/c's resampling should move them), got ${ratio}`);
  }
});

test('tuneFrequencies initialWeightStrategy "uniform"/"normal" sample a meaningfully different starting point than "provided"', async () => {
  const provided = await captureFirstCandidate('provided', 7);
  const uniform = await captureFirstCandidate('uniform', 7);
  const normal = await captureFirstCandidate('normal', 7);

  assert.ok(['a', 'b', 'c'].some(s => Math.abs(uniform[s].frequency - provided[s].frequency) > 0.1),
    'expected "uniform" to sample a meaningfully different starting point than "provided"');
  assert.ok(['a', 'b', 'c'].some(s => Math.abs(normal[s].frequency - provided[s].frequency) > 0.1),
    'expected "normal" to sample a meaningfully different starting point than "provided"');
});

test('tuneFrequencies initialWeightStrategy sampling stays deterministic for a given searchSeed', async () => {
  const first = await captureFirstCandidate('uniform', 12345);
  const second = await captureFirstCandidate('uniform', 12345);
  assert.deepEqual(first, second, 'expected identical searchSeed to reproduce an identical sampled starting point');
});

test('tuneFrequencies fires an "initial" onProgress event before Phase 1, with the real Phase 2 starting point', async () => {
  const phasesSeen = [];
  let initialTrialSymbols = null;
  await tuneFrequencies(INITIAL_WEIGHT_PAYTABLE, INITIAL_WEIGHT_REEL_TABLES, {
    ...INITIAL_WEIGHT_COMMON_OPTIONS,
    initialWeightStrategy: 'uniform',
    searchSeed: 7,
    onProgress: (phase, i, mult, r) => {
      phasesSeen.push(phase);
      if (phase === 'initial') initialTrialSymbols = { ...r.trial[0].symbols };
    },
  });
  assert.equal(phasesSeen[0], 'initial', `expected 'initial' to be the very first onProgress event, got order: ${phasesSeen.slice(0, 3)}`);
  assert.ok(initialTrialSymbols, "expected the 'initial' event to carry r.trial");

  // The preview must match the real search's own starting point exactly - both use the same
  // seed formula and dims iteration order, so they should never disagree.
  const realStart = await captureFirstCandidate('uniform', 7);
  for (const symbol of ['a', 'b', 'c', 'd', 'e']) {
    assert.ok(Math.abs(initialTrialSymbols[symbol].frequency - realStart[symbol].frequency) < 0.01,
      `expected the 'initial' preview's ${symbol} to match the real search's own starting value, got preview=${initialTrialSymbols[symbol].frequency} real=${realStart[symbol].frequency}`);
  }
});

test('tuneFrequencies fires a "restart" onProgress event when a round stalls, before giving up', async () => {
  const restartEvents = [];
  const opts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    // Mirrors the existing "genuinely infeasible target" test below - reliably stalls and
    // restarts rather than converging, which is exactly the scenario this event exists for.
    targetRtp: 100000, trialSpins: 4000, trialsPerPoint: 1, maxIterations: 100,
    stallWindowIterations: 8, maxStallRestarts: 3, orderingBiasByReel: [0, 0, 0],
    onProgress: (phase, i, mult, r, best) => {
      if (phase === 'restart') restartEvents.push(r);
    },
  };
  const result = await tuneFrequencies(PAYTABLE, REEL_TABLES, opts);
  assert.equal(result.diagnostics.rtpPhase.reason, 'stalled');
  assert.ok(restartEvents.length > 0, 'expected at least one "restart" event to fire');
  assert.equal(restartEvents.length, result.diagnostics.rtpPhase.restarts,
    'expected one "restart" event per restart actually recorded in diagnostics');
  // stepSize should be strictly growing across successive restarts (stallWidenFactor > 1).
  for (let i = 1; i < restartEvents.length; i++) {
    assert.ok(restartEvents[i].stepSize > restartEvents[i - 1].stepSize,
      `expected stepSize to grow with each restart, got ${restartEvents.map(e => e.stepSize)}`);
  }
  assert.equal(restartEvents.at(-1).willStopNow, true, 'expected the final restart event to flag that the search is giving up');
});

// ---- Parallel dispatch (Worker-pool-friendly evaluate/measure/runTrial) ----
// These prove the actual point of accepting an async evaluate/measure/runTrial - real
// concurrency, not just "doesn't crash when given a Promise" - by using delayed fake work
// (setTimeout) as a stand-in for a Worker pool's postMessage round trip, and asserting wall
// time looks like everything ran together rather than one after another.

test('nelderMead evaluates the initial simplex concurrently when evaluate is async', async () => {
  const delayMs = 40;
  const delayedEvaluate = (point) => new Promise(resolve => {
    setTimeout(() => resolve({ loss: (point[0] - 3) ** 2 + (point[1] + 2) ** 2 }), delayMs);
  });
  const startedAt = Date.now();
  await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: delayedEvaluate,
    maxIterations: 0, // only the initial 3-vertex simplex gets built - no iterations run
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  const elapsed = Date.now() - startedAt;
  // Sequential would take ~3 * delayMs (120ms); concurrent should land close to 1 * delayMs.
  // Generous upper bound (2 * delayMs) to absorb scheduler jitter without weakening the
  // assertion into meaninglessness.
  assert.ok(elapsed < delayMs * 2, `expected the 3-vertex initial simplex to evaluate concurrently (~${delayMs}ms), took ${elapsed}ms`);
});

test('nelderMead evaluates a simplex shrink concurrently when evaluate is async', async () => {
  const delayMs = 40;
  // Same flat-plateau setup used by the onBusy shrink tests above - forces every iteration to
  // fall through to a shrink (reflection/expansion/contraction never land exactly on the origin).
  const delayedEvaluate = (point) => new Promise(resolve => {
    setTimeout(() => resolve({ loss: point.every(v => Math.abs(v) < 1e-9) ? 0 : 1000 }), delayMs);
  });
  const startedAt = Date.now();
  await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: delayedEvaluate,
    maxIterations: 1,
    convergenceTolerance: 1e-9,
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  const elapsed = Date.now() - startedAt;
  // One iteration touches: initial simplex (3 concurrent) -> reflect (1) -> contract (1) ->
  // shrink (3 concurrent) = 4 sequential delayed steps if none of the concurrent batches were
  // actually parallel, but only ~4 * delayMs even so; the point is each *batch* is well under
  // its own count * delayMs. Bound generously on the total to avoid coupling this test to the
  // algorithm's exact step count while still catching a regression back to serial shrink
  // evaluation (which would cost 3 extra delayMs on top, i.e. ~7 * delayMs total). Bound at 6x
  // rather than 5x - under system load a handful of extra ms of scheduler jitter shouldn't flip
  // this test, since the case it actually needs to catch (fully serial, ~7x) is well beyond it.
  assert.ok(elapsed < delayMs * 6, `expected concurrent vertex evaluation to keep total wall time well under the fully-serial case, took ${elapsed}ms`);
});

test('tuneFrequencies dispatches a candidate\'s trialsPerPoint trials concurrently via options.runTrial', async () => {
  const delayMs = 30;
  let concurrent = 0, maxConcurrent = 0;
  const runTrial = async (config, numSpins, betPerLine, linesCount, rngSeed) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    concurrent--;
    // A trivial deterministic stand-in for a real simulateSpins() trial - this test only cares
    // about dispatch/aggregation, not simulation accuracy.
    return { rtpRaw: 0.96, freeSpinsTriggered: 1, baseSpins: 1000 };
  };
  await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 1000, trialsPerPoint: 4, maxIterations: 1, runTrial,
  });
  // At least the 4 trials of a single candidate should overlap - in practice this is usually
  // far higher, since nelderMead's initial simplex evaluates every one of its (many, for a
  // real reel table) vertices concurrently too, each contributing its own 4 concurrent trials -
  // this only asserts the floor tuneFrequencies' own doc promises, not the exact ceiling,
  // since the latter is an implementation detail of how many dimensions this fixture happens
  // to have.
  assert.ok(maxConcurrent >= 4, `expected at least trialsPerPoint (4) trials in flight at once, saw max ${maxConcurrent}`);
});

test('tuneFrequencies with options.runTrial produces identical results to its in-process default', async () => {
  // runTrial here does exactly what measure()'s own in-process fallback does (call
  // simulateSpins with a seeded rng), just wrapped as an async hop - proving the dispatch
  // machinery (Promise.all batching, trial-index-ordered summation) doesn't change the answer,
  // only how it gets computed.
  const runTrial = async (config, numSpins, betPerLine, linesCount, rngSeed) => {
    const { createSeededRng } = await import('../core/SlotMath.js');
    const rng = rngSeed != null ? createSeededRng(rngSeed) : Math.random;
    const results = simulateSpins(config, numSpins, betPerLine, linesCount, rng);
    return { rtpRaw: results.rtpRaw, freeSpinsTriggered: results.freeSpinsTriggered, baseSpins: results.baseSpins };
  };
  const sharedOptions = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 2, maxIterations: 6, searchSeed: 999,
  };
  const withoutPool = await tuneFrequencies(PAYTABLE, REEL_TABLES, sharedOptions);
  const withPool = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOptions, runTrial });
  assert.equal(withPool.rtp, withoutPool.rtp, 'expected identical achieved RTP with and without the runTrial pool hook');
  assert.equal(withPool.triggerRatePct, withoutPool.triggerRatePct);
  assert.deepEqual(withPool.reelFrequencyTables, withoutPool.reelFrequencyTables);
});
