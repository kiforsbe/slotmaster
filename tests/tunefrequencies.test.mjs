import test from 'node:test';
import assert from 'node:assert/strict';
import { gradientDescent1D, bisect1D, nelderMead, tuneFrequencies, simulateSpins, beatsIncumbent } from '../core/SpinSimulator.js';
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

// ---- bisect1D ----
// The staircase these tests model is the real shape of Phase 1's objective, and the reason
// gradientDescent1D was the wrong tool for it: generateReel rounds each symbol's share to a
// whole number of strip positions, so trigger rate moves in coarse jumps with wide dead
// plateaus in between. Every pre-existing gradientDescent1D test above uses a SMOOTH synthetic
// function, which is exactly why they all passed while the real search flailed.

// Mirrors games/bookbookbook at REEL_LENGTH 500: scatter count = round(share * 500), which over
// multiplier 0.70..1.36 yields only ~13 distinct reachable trigger rates on plateaus 5-10% wide.
const staircase = (param) => {
  const count = Math.max(1, Math.round(14.488 * param)); // 14.488 = book's real baseline share * 500
  return 0.6341 * Math.pow(count / 15, 3); // trigger rate scales ~cubically (needs 3 scatters)
};

test('bisect1D terminates early on an unreachable target instead of burning the whole budget oscillating', async () => {
  // This is the actual, reproducible failure - narrower than "slope search cannot do
  // staircases", which is NOT true: gradientDescent1D handles a REACHABLE staircase target
  // perfectly well, because its finite-difference probe usually does cross a step edge.
  //
  // What it has no concept of is a target that no parameter can reach. Trigger rate moves in
  // coarse jumps, so a target can fall in the gap between two adjacent achievable values - on
  // real bookbookbook data only 2 of the 13 reachable rates in the useful multiplier range land
  // inside the default tolerance band. With nothing to find, gradientDescent1D keeps stepping
  // toward the target from alternating sides forever and spends its entire iteration budget at
  // roughly 2.3 measurements per iteration. Each of those is trialsPerPoint * trialSpins spins
  // (2.4 million at the defaults), so this is the difference between a tune that ends in
  // seconds with an actionable answer and one that grinds through hundreds of millions of
  // simulated spins to report a bare "did not converge".
  const countAt = (param) => Math.max(1, Math.round(14.488 * param));
  const trueMetric = (param) => 0.6341 * Math.pow(countAt(param) / 15, 3);
  // 0.85 falls between count=16 (0.7696) and count=17 (0.9231). Nothing can reach it.
  const argsFor = (measure) => ({
    initialParam: 1, minParam: 0.05, maxParam: 8,
    target: 0.85, tolerance: 0.02,
    buildTrial: (param) => ({ param }),
    metricOf: (r) => r.value,
    measure,
    maxIterations: 150, seedBase: 1,
    yieldToEventLoop: () => Promise.resolve(),
  });

  const descentVisits = [];
  const descent = await gradientDescent1D({
    ...argsFor((t) => { descentVisits.push(t.param); return { value: trueMetric(t.param) }; }),
    onProgress: null,
  });
  const bisectVisits = [];
  const bisected = await bisect1D(argsFor((t) => { bisectVisits.push(t.param); return { value: trueMetric(t.param) }; }));

  assert.equal(descent.converged, false, 'sanity: the target really is unreachable');
  assert.equal(bisected.converged, false, 'bisection cannot reach it either - but it must say WHY');
  assert.equal(bisected.reason, 'lattice-gap');

  assert.ok(bisectVisits.length < descentVisits.length / 10,
    `expected bisection to give up an order of magnitude sooner; bisection took ${bisectVisits.length} measurements, gradient descent took ${descentVisits.length}`);
  // The oscillation itself: descent keeps re-measuring around the gap it can never close.
  assert.ok(descentVisits.length > 100,
    `expected the slope search to burn its whole budget oscillating, took only ${descentVisits.length} measurements`);
});

test('bisect1D reports reason "lattice-gap" when the target falls between two achievable values', async () => {
  // 0.58 sits in the dead gap between the count=14 (0.5154) and count=15 (0.6341) plateaus,
  // with a tolerance too tight to reach either. No multiplier can satisfy this - the correct
  // outcome is to say so, not to burn the budget and report a bare "did not converge".
  const result = await bisect1D({
    initialParam: 1, minParam: 0.05, maxParam: 8,
    target: 0.58, tolerance: 0.01,
    buildTrial: (param) => ({ param }),
    metricOf: (r) => r.value,
    measure: (trial) => ({ value: staircase(trial.param) }),
    maxIterations: 60, seedBase: 1,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(result.reason, 'lattice-gap');
  assert.equal(result.converged, false);
  // The bracket must report what IS reachable either side, so a caller can pick a real target.
  assert.ok(result.bracket.loMetric < 0.58 && result.bracket.hiMetric > 0.58,
    `expected the bracket to straddle the target, got ${result.bracket.loMetric}..${result.bracket.hiMetric}`);
});

test('bisect1D measures the starting point first and stops immediately when it is already in band', async () => {
  let measurements = 0;
  const result = await bisect1D({
    initialParam: 1, minParam: 0.05, maxParam: 8,
    // staircase(1) rounds to a count of 14, i.e. 0.5154 - the real baseline, already in band.
    target: 0.5154, tolerance: 0.05,
    buildTrial: (param) => ({ param }),
    metricOf: (r) => r.value,
    measure: (trial) => { measurements++; return { value: staircase(trial.param) }; },
    maxIterations: 30, seedBase: 1,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(measurements, 1, `expected exactly one measurement for an already-in-band baseline, took ${measurements}`);
  assert.equal(result.mult, 1, 'expected the multiplier to be left exactly at 1');
  assert.equal(result.reason, 'converged');
});

test('bisect1D reports unreachable-low / unreachable-high rather than pretending to converge', async () => {
  const base = {
    initialParam: 1, minParam: 1, maxParam: 10,
    tolerance: 0.5,
    buildTrial: (param) => ({ param }),
    metricOf: (r) => r.value,
    maxIterations: 20, seedBase: 1,
    yieldToEventLoop: () => Promise.resolve(),
  };
  const tooLow = await bisect1D({ ...base, target: 1000, measure: (t) => ({ value: 5 * t.param }) });
  assert.equal(tooLow.reason, 'unreachable-low', 'even maxParam only reaches 50, far below 1000');
  assert.ok(tooLow.mult <= 10.0001, `expected mult clamped to <= 10, got ${tooLow.mult}`);

  const tooHigh = await bisect1D({ ...base, target: 1, measure: (t) => ({ value: 5 * t.param }) });
  assert.equal(tooHigh.reason, 'unreachable-high', 'even minParam measures 5, above the 1 target band');
});

test('bisect1D stops cooperatively on signal.aborted with a usable best', async () => {
  const controller = new AbortController();
  let n = 0;
  const result = await bisect1D({
    initialParam: 1, minParam: 0.05, maxParam: 8,
    target: 0.42, tolerance: 1e-9, // unreachable tolerance, so only the abort can end it
    buildTrial: (param) => ({ param }),
    metricOf: (r) => r.value,
    measure: (trial) => { if (++n === 3) controller.abort(); return { value: staircase(trial.param) }; },
    maxIterations: 100, seedBase: 1,
    signal: controller.signal,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(result.reason, 'stopped');
  assert.equal(result.converged, false);
  assert.ok(Number.isFinite(result.mult) && Number.isFinite(result.error), 'expected a real, usable result');
});

test('bisect1D uses one fixed seed for every measurement so the bracket invariant cannot be broken by noise', async () => {
  const seeds = new Set();
  await bisect1D({
    initialParam: 1, minParam: 0.05, maxParam: 8,
    target: 0.42, tolerance: 0.02,
    buildTrial: (param) => ({ param }),
    metricOf: (r) => r.value,
    measure: (trial, rngSeed) => { seeds.add(rngSeed); return { value: staircase(trial.param) }; },
    maxIterations: 30, seedBase: 4242,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.deepEqual([...seeds], [4242],
    'every measurement must share one seed - a per-iteration seed would let noise flip a comparison and discard the half of the range containing the answer');
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

test('nelderMead stops cooperatively once signal.aborted is set, returning a usable best-so-far', async () => {
  const controller = new AbortController();
  let iterationsSeen = 0;
  const { iterations, point } = await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 100,
    convergenceTolerance: 1e-9,
    onProgress: () => { iterationsSeen++; if (iterationsSeen === 5) controller.abort(); },
    signal: controller.signal,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(iterations < 100, `expected far fewer than 100 iterations to have run, got ${iterations}`);
  assert.equal(iterations, iterationsSeen, 'expected to stop right after the iteration that requested the abort, not later');
  assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]));
});

test('nelderMead never checks signal before the initial simplex has a usable best', async () => {
  const controller = new AbortController();
  controller.abort();
  const { iterations, loss } = await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 100,
    convergenceTolerance: 1e-9,
    onProgress: null,
    signal: controller.signal,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(iterations, 0, 'expected zero iterations to have run - the initial simplex itself already gives a valid best');
  assert.ok(Number.isFinite(loss));
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

test('tuneFrequencies options.stdErrorPenaltyWeight adds stdErrorPenaltyWeight * trialRtpStdError directly into loss', async () => {
  // maxIterations: 0 + initialStepSize: 0 (same trick used elsewhere in this file) makes both
  // calls measure the exact same unperturbed starting candidate, under the same seed - so
  // trialRtpStdError is identical between them, and the only possible difference in `loss` is
  // this new term itself, isolated from every other source of variation.
  const sharedOpts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 3, maxIterations: 0, initialStepSize: 0, searchSeed: 21,
  };
  const withoutPenalty = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, stdErrorPenaltyWeight: 0 });
  const withPenalty = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, stdErrorPenaltyWeight: 2 });
  const stdError = withoutPenalty.diagnostics.rtpPhase.trialRtpStdError;
  assert.ok(stdError > 0, 'expected a nonzero std error (trialsPerPoint > 1) for this test to be meaningful');
  const expectedDelta = 2 * stdError;
  const actualDelta = withPenalty.diagnostics.rtpPhase.loss - withoutPenalty.diagnostics.rtpPhase.loss;
  assert.ok(
    Math.abs(actualDelta - expectedDelta) < 1e-9,
    `expected loss to differ by exactly stdErrorPenaltyWeight * stdError (${expectedDelta}), got ${actualDelta}`
  );
});

test('tuneFrequencies options.stdErrorPenaltyWeight defaults to 0 (off), matching pre-existing behavior exactly', async () => {
  const sharedOpts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 2, maxIterations: 8, searchSeed: 33,
  };
  const withDefault = await tuneFrequencies(PAYTABLE, REEL_TABLES, sharedOpts);
  const withExplicitZero = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, stdErrorPenaltyWeight: 0 });
  assert.deepEqual(withDefault.reelFrequencyTables, withExplicitZero.reelFrequencyTables);
  assert.equal(withDefault.diagnostics.rtpPhase.loss, withExplicitZero.diagnostics.rtpPhase.loss);
});

test('every onProgress phase emitting a null `best` is a known informational phase', async () => {
  // Contract between tuneFrequencies and any live view of it. Phases that carry a measured
  // candidate hand over a non-null `best`; purely informational ones ('headroom', 'feasibility',
  // 'initial', 'restart', 'busy', 'scatter-complete') deliberately pass null, and a consumer must
  // handle them before touching candidate fields.
  //
  // This exists because adding 'headroom' broke the tuning panel at runtime: it fell through to
  // generic candidate-rendering code that read `best.result`, and the TypeError aborted the whole
  // tune. A new phase emitting null `best` must be added here consciously - which is the prompt to
  // give core/SimulationPanel.js's progress handler a matching early return.
  const KNOWN_NULL_BEST_PHASES = new Set([
    'initial', 'headroom', 'feasibility', 'restart', 'busy', 'scatter-complete',
  ]);
  const offenders = new Set();
  await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 2000, trialsPerPoint: 1, maxIterations: 6, searchSeed: 11,
    onProgress: (phase, i, mult, r, best) => {
      if (best == null && !KNOWN_NULL_BEST_PHASES.has(phase)) offenders.add(phase);
    },
  });
  assert.deepEqual([...offenders], [],
    'these phases emitted a null `best` without being declared informational - add them here AND give SimulationPanel.js\'s progress handler an early return for them');
});

// ---- Phase 2: seed rotation and anchor gating ----

test('rotateSeedPerGeneration resamples the measurement seed each CMA-ES generation, but not within one', async () => {
  const seedsByGeneration = new Map();
  await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 800, trialsPerPoint: 1, maxIterations: 4, searchSeed: 3,
    searchAlgorithm: 'cmaes', measureHeadroom: false,
    runTrial: (config, numSpins, betPerLine, linesCount, seed) => {
      const gen = seedsByGeneration.size;
      if (!seedsByGeneration.has(seed)) seedsByGeneration.set(seed, 0);
      seedsByGeneration.set(seed, seedsByGeneration.get(seed) + 1);
      return Promise.resolve({ rtpRaw: 0.9, freeSpinsTriggered: 1, baseSpins: numSpins });
    },
  });
  // More than one distinct seed proves rotation happened at all; a single seed would mean the
  // whole search ran against one fixed noise realization, which is the bug being fixed.
  assert.ok(seedsByGeneration.size > 1,
    `expected several distinct measurement seeds across generations, saw ${seedsByGeneration.size}`);
  // Each distinct seed must be shared by a whole population, not used once - that is the
  // common-random-numbers property that keeps a generation's ranking fair.
  const counts = [...seedsByGeneration.values()];
  assert.ok(Math.max(...counts) > 1,
    `expected each generation's seed to be reused across its whole population, counts were ${counts}`);
});

test('rotateSeedPerGeneration: false keeps one fixed seed for the whole CMA-ES run', async () => {
  const seeds = new Set();
  await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 800, trialsPerPoint: 1, maxIterations: 4, searchSeed: 3,
    searchAlgorithm: 'cmaes', measureHeadroom: false, rotateSeedPerGeneration: false,
    runTrial: (config, numSpins, betPerLine, linesCount, seed) => {
      seeds.add(seed);
      return Promise.resolve({ rtpRaw: 0.9, freeSpinsTriggered: 1, baseSpins: numSpins });
    },
  });
  assert.equal(seeds.size, 1, `expected exactly one seed for the whole run when rotation is off, got ${[...seeds]}`);
});

test('tuneFrequencies stays deterministic for a given searchSeed with seed rotation on', async () => {
  const opts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 1, maxIterations: 6, searchSeed: 77,
    searchAlgorithm: 'cmaes', measureHeadroom: false,
  };
  const a = await tuneFrequencies(PAYTABLE, REEL_TABLES, opts);
  const b = await tuneFrequencies(PAYTABLE, REEL_TABLES, opts);
  assert.deepEqual(a.reelFrequencyTables, b.reelFrequencyTables,
    'rotating the seed per generation must stay a pure function of searchSeed');
  assert.equal(a.diagnostics.rtpPhase.loss, b.diagnostics.rtpPhase.loss);
});

// ---- Phase 0b: structural headroom, and the payout-value solve ----

test('diagnostics.structuralHeadroom reports what an EVEN symbol distribution pays', async () => {
  const { diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 4000, trialsPerPoint: 1, maxIterations: 0, initialStepSize: 0,
  });
  const h = diagnostics.structuralHeadroom;
  assert.ok(h, 'headroom must be reported by default - a dev who never asks is the one who needs it');
  assert.ok(h.uniformRtp > 0, `expected a real uniform-frequency RTP, got ${h.uniformRtp}`);
  assert.equal(h.targetRtp, 96);
  // shortfallFactor is how many times short of target an even distribution falls - i.e. how much
  // skew the frequency search is being asked to invent.
  assert.ok(Math.abs(h.shortfallFactor - 96 / h.uniformRtp) < 1e-9);
});

test('measureHeadroom: false skips the extra measurement entirely', async () => {
  const { diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 4000, trialsPerPoint: 1, maxIterations: 0, initialStepSize: 0,
    measureHeadroom: false,
  });
  assert.equal(diagnostics.structuralHeadroom, null);
});

test('solvePayoutScale returns a scaled paytable that lands on targetRtp, without mutating the input', async () => {
  const before = JSON.parse(JSON.stringify(PAYTABLE));
  const { scaledPaytable, diagnostics, rtp } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 0, initialStepSize: 0,
    solvePayoutScale: true,
  });
  assert.deepEqual(PAYTABLE, before, 'the caller\'s paytable must never be mutated');
  assert.ok(scaledPaytable, 'a scaled paytable must be returned when solvePayoutScale is on');

  const ps = diagnostics.payoutScale;
  assert.ok(Math.abs(ps.scale - 96 / ps.rtpBeforeScaling) < 1e-9, 'scale must be the closed-form targetRtp / measuredRtp');
  // Every payout entry must be scaled by exactly that factor.
  const sym = Object.keys(PAYTABLE).find(s => Array.isArray(PAYTABLE[s].payout) && PAYTABLE[s].payout.some(v => v > 0));
  const i = PAYTABLE[sym].payout.findIndex(v => v > 0);
  assert.ok(Math.abs(scaledPaytable[sym].payout[i] - PAYTABLE[sym].payout[i] * ps.scale) < 1e-9);
  // RTP is exactly linear in payout scale, so the verification run must land on target. A loose
  // band absorbs Monte Carlo noise only - a systematic miss here means linearity broke.
  assert.equal(ps.verified, true,
    `expected verification to succeed for a config-reading evaluator; note was: ${ps.verificationNote}`);
  assert.ok(Math.abs(ps.verifiedRtp - 96) < 8,
    `expected the scaled paytable to measure near 96%, got ${ps.verifiedRtp} (scale ${ps.scale}, from ${ps.rtpBeforeScaling})`);
  assert.ok(rtp > 0);
});

test('solvePayoutScale is off by default - no scaled paytable, no extra measurement', async () => {
  const { scaledPaytable, diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 4000, trialsPerPoint: 1, maxIterations: 0, initialStepSize: 0,
  });
  assert.equal(scaledPaytable, null);
  assert.equal(diagnostics.payoutScale, null);
});

// ---- Phase 0: reel-constraint feasibility ----

test('diagnostics.reelFeasibility flags a symbol whose minGap cannot be honored at this reel length', async () => {
  // 40 positions with minGap 8 allows at most 5 runs of a symbol. `hog` takes half the strip at
  // maxStack 1, so its ~20 occurrences are 20 SEPARATE runs - four times what the gap permits,
  // and generateReel can only handle that by silently abandoning the spacing. maxStack 1 matters:
  // without it those occurrences merge into one long run, which is a stacking problem rather than
  // a spacing one and correctly does not trip this check.
  const paytable = { hog: { payout: [0, 0, 5] }, a: { payout: [0, 0, 5] }, b: { payout: [0, 0, 5] } };
  const reelTables = [{
    defaults: { minGap: 8 },
    symbols: { hog: { frequency: 2, maxStack: 1 }, a: { frequency: 1 }, b: { frequency: 1 } },
  }];
  const { diagnostics } = await tuneFrequencies(paytable, reelTables, {
    reelsCount: 1, rowsCount: 3, paylines: [[0, 0, 0]], winEvaluator: checkWildLineWins,
    reelSeeds: [1], betPerLine: 1, linesCount: 1, reelLength: 40,
    targetRtp: 96, trialSpins: 500, trialsPerPoint: 1, maxIterations: 0, initialStepSize: 0,
  });
  const hog = diagnostics.reelFeasibility.find(v => v.symbol === 'hog');
  assert.ok(hog, `expected 'hog' to be reported infeasible, got ${JSON.stringify(diagnostics.reelFeasibility)}`);
  assert.equal(hog.ceiling, 5, 'ceiling must be floor(reelLength / minGap) = floor(40/8)');
  assert.ok(hog.runs > hog.ceiling, `expected runs (${hog.runs}) to exceed the ceiling (${hog.ceiling})`);
});

test('diagnostics.reelFeasibility is empty when every symbol\'s spacing genuinely fits', async () => {
  // Same shape, but a long strip and a small gap, so there is ample room for every symbol.
  const paytable = { a: { payout: [0, 0, 5] }, b: { payout: [0, 0, 5] }, c: { payout: [0, 0, 5] } };
  const reelTables = [{
    defaults: { minGap: 2 },
    symbols: { a: { frequency: 1 }, b: { frequency: 1 }, c: { frequency: 1 } },
  }];
  const { diagnostics } = await tuneFrequencies(paytable, reelTables, {
    reelsCount: 1, rowsCount: 3, paylines: [[0, 0, 0]], winEvaluator: checkWildLineWins,
    reelSeeds: [1], betPerLine: 1, linesCount: 1, reelLength: 300,
    targetRtp: 96, trialSpins: 500, trialsPerPoint: 1, maxIterations: 0, initialStepSize: 0,
  });
  assert.deepEqual(diagnostics.reelFeasibility, []);
});

// ---- Phase 1b: per-reel trigger-count refinement ----

// A synthetic game whose trigger rate is deliberately coarse under a shared multiplier: the
// scatter lands only a handful of times per strip, so every reel crosses its rounding threshold
// at the same multiplier and the achievable rates jump in big lockstep steps. This is the shape
// Candy Frenzy really has (bonus lands 2-6 times on a 500-position strip); the point of the
// test is that the target is reachable by an UNEVEN per-reel distribution even though no shared
// multiplier can reach it.
const COARSE_PAYTABLE = {
  scat: { payout: [0, 0, 2, 20, 200], type: 'scatter', paymode: 'any', triggerFreeSpins: true },
  a:    { payout: [0, 0, 5, 40, 150] },
  b:    { payout: [0, 0, 5, 30, 100] },
};
const coarseReels = () => Array.from({ length: 5 }, () => ({
  symbols: { scat: { frequency: 0.075, maxStack: 1 }, a: { frequency: 0.5 }, b: { frequency: 0.5 } },
}));

test('Phase 1b refines per-reel trigger counts when a shared multiplier cannot reach the target band', async () => {
  const perReelCountsSeen = [];
  const { diagnostics } = await tuneFrequencies(COARSE_PAYTABLE, coarseReels(), {
    // NO winEvaluator: checkWildLineWins takes no scatterSymbol and cannot produce a scatter
    // win at all, so a fixture using it has a trigger rate of exactly 0 and Phase 1 has nothing
    // to tune. The default evaluator (checkWins) is the one that detects scatters.
    reelsCount: 5, rowsCount: 3, paylines: PAYLINES,
    reelSeeds: [11, 22, 33, 44, 55], betPerLine: 1, linesCount: 5, reelLength: 200,
    scatterSymbol: 'scat', targetRtp: 96,
    // Deliberately tight, sitting between two whole-symbol steps.
    targetTriggerRatePct: 0.9, triggerRateTolerancePct: 0.25,
    trialSpins: 40000, trialsPerPoint: 1, maxIterations: 3, searchSeed: 5,
    onProgress: (phase, i, mult, r) => { if (phase === 'scatter-refine') perReelCountsSeen.push(r.counts); },
  });
  assert.ok(perReelCountsSeen.length > 0,
    'expected Phase 1b to run at all - if the shared multiplier happened to land in band, this fixture no longer reproduces the coarse-lattice case it exists to test');
  // The whole point: at least one step must produce an UNEVEN distribution. A refinement that
  // only ever moved every reel together would be no better than the shared multiplier.
  assert.ok(perReelCountsSeen.some(c => new Set(c).size > 1),
    `expected at least one per-reel count vector to be uneven, got ${JSON.stringify(perReelCountsSeen)}`);
  assert.equal(diagnostics.scatterPhase.refinedPerReelCounts?.length ?? 0, 5,
    'the winning per-reel counts must be reported, one entry per reel');
});

test('Phase 1b is skipped entirely when maxTriggerRefineSteps is 0', async () => {
  let refineSteps = 0;
  const { diagnostics } = await tuneFrequencies(COARSE_PAYTABLE, coarseReels(), {
    // NO winEvaluator: checkWildLineWins takes no scatterSymbol and cannot produce a scatter
    // win at all, so a fixture using it has a trigger rate of exactly 0 and Phase 1 has nothing
    // to tune. The default evaluator (checkWins) is the one that detects scatters.
    reelsCount: 5, rowsCount: 3, paylines: PAYLINES,
    reelSeeds: [11, 22, 33, 44, 55], betPerLine: 1, linesCount: 5, reelLength: 200,
    scatterSymbol: 'scat', targetRtp: 96,
    targetTriggerRatePct: 0.9, triggerRateTolerancePct: 0.25,
    trialSpins: 40000, trialsPerPoint: 1, maxIterations: 3, searchSeed: 5,
    maxTriggerRefineSteps: 0,
    onProgress: (phase) => { if (phase === 'scatter-refine') refineSteps++; },
  });
  assert.equal(refineSteps, 0, 'no refinement steps may run when the budget is 0');
  assert.equal(diagnostics.scatterPhase.refinedPerReelCounts, null,
    'refinedPerReelCounts must be null when Phase 1b never ran');
});

test('Phase 1b never runs when the shared multiplier already reached the target band', async () => {
  let refineSteps = 0;
  await tuneFrequencies(COARSE_PAYTABLE, coarseReels(), {
    // NO winEvaluator: checkWildLineWins takes no scatterSymbol and cannot produce a scatter
    // win at all, so a fixture using it has a trigger rate of exactly 0 and Phase 1 has nothing
    // to tune. The default evaluator (checkWins) is the one that detects scatters.
    reelsCount: 5, rowsCount: 3, paylines: PAYLINES,
    reelSeeds: [11, 22, 33, 44, 55], betPerLine: 1, linesCount: 5, reelLength: 200,
    scatterSymbol: 'scat', targetRtp: 96,
    // A tolerance wide enough that Phase 1a cannot fail - so the expensive refinement must not fire.
    targetTriggerRatePct: 0.9, triggerRateTolerancePct: 100,
    trialSpins: 20000, trialsPerPoint: 1, maxIterations: 2, searchSeed: 5,
    onProgress: (phase) => { if (phase === 'scatter-refine') refineSteps++; },
  });
  assert.equal(refineSteps, 0, 'refinement must not run when the shared multiplier already converged');
});

// ---- triggerRatePenaltyWeight ----
// fruitmachine has no triggerFreeSpins symbol, so its trigger rate is a flat 0 and the penalty
// is a pure function of the target/tolerance - which is exactly what makes it a clean way to
// verify the arithmetic in isolation, with no Phase 1 and no cascade coupling in the way.

test('tuneFrequencies options.triggerRatePenaltyWeight adds weight * distance OUTSIDE the tolerance band into loss', async () => {
  const sharedOpts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 1, maxIterations: 0, initialStepSize: 0, searchSeed: 21,
    targetTriggerRatePct: 2, triggerRateTolerancePct: 0.5,
  };
  const withoutPenalty = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, triggerRatePenaltyWeight: 0 });
  const withPenalty = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, triggerRatePenaltyWeight: 3 });
  const triggerRate = withoutPenalty.diagnostics.rtpPhase.triggerRate;
  // Distance outside the band, not distance from the target - the band is the whole point.
  const expectedDelta = 3 * Math.max(0, Math.abs(triggerRate - 2) - 0.5);
  assert.ok(expectedDelta > 0, 'expected this candidate to sit outside the band for the test to be meaningful');
  const actualDelta = withPenalty.diagnostics.rtpPhase.loss - withoutPenalty.diagnostics.rtpPhase.loss;
  assert.ok(Math.abs(actualDelta - expectedDelta) < 1e-9,
    `expected loss to differ by exactly weight * outside-band distance (${expectedDelta}), got ${actualDelta}`);
});

test('tuneFrequencies triggerRatePenaltyWeight costs nothing while the trigger rate is INSIDE the band', async () => {
  // A tolerance wide enough to swallow the measured rate must make the term exactly zero, so
  // raising the weight cannot perturb a search whose trigger rate was already acceptable.
  const sharedOpts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 1, maxIterations: 0, initialStepSize: 0, searchSeed: 21,
    targetTriggerRatePct: 0, triggerRateTolerancePct: 100,
  };
  const off = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, triggerRatePenaltyWeight: 0 });
  const on = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, triggerRatePenaltyWeight: 50 });
  assert.equal(on.diagnostics.rtpPhase.loss, off.diagnostics.rtpPhase.loss,
    'a candidate inside the tolerance band must score identically at any weight');
});

test('tuneFrequencies options.triggerRatePenaltyWeight defaults to 0 (off), matching pre-existing behavior exactly', async () => {
  const sharedOpts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 2, maxIterations: 8, searchSeed: 33,
  };
  const withDefault = await tuneFrequencies(PAYTABLE, REEL_TABLES, sharedOpts);
  const withExplicitZero = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, triggerRatePenaltyWeight: 0 });
  assert.deepEqual(withDefault.reelFrequencyTables, withExplicitZero.reelFrequencyTables);
  assert.equal(withDefault.diagnostics.rtpPhase.loss, withExplicitZero.diagnostics.rtpPhase.loss);
  assert.equal(withDefault.diagnostics.inputParameters.triggerRatePenaltyWeight, 0);
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

// ---- Pluggable search algorithm (options.searchAlgorithm) and noise-aware best tracking ----

test('beatsIncumbent always accepts when there is no incumbent yet', () => {
  assert.equal(beatsIncumbent({ loss: 5, trialRtpStdError: 0 }, null, 1), true);
});

test('beatsIncumbent rejects a "better" candidate whose margin is within combined measurement noise', () => {
  // Candidate's loss is only slightly lower than incumbent's, but both carry std error large
  // enough that the difference isn't statistically meaningful.
  const incumbent = { loss: 10, trialRtpStdError: 3 };
  const candidate = { loss: 9, trialRtpStdError: 3 };
  assert.equal(beatsIncumbent(candidate, incumbent, 1), false);
});

test('beatsIncumbent accepts a candidate that beats the incumbent by more than the combined noise margin', () => {
  const incumbent = { loss: 10, trialRtpStdError: 0.1 };
  const candidate = { loss: 2, trialRtpStdError: 0.1 };
  assert.equal(beatsIncumbent(candidate, incumbent, 1), true);
});

test('beatsIncumbent treats missing trialRtpStdError as zero, matching a raw comparison when noise-free', () => {
  // Both sides omit trialRtpStdError entirely -> margin collapses to z*sqrt(0+0) = 0, so any
  // strictly-lower loss is accepted, same as today's raw `<` comparison for deterministic
  // candidates (trialsPerPoint: 1, or a synthetic non-noisy evaluate like this one).
  const incumbent = { loss: 10 };
  const candidate = { loss: 9.999 };
  assert.equal(beatsIncumbent(candidate, incumbent, 1), true);
});

test('tuneFrequencies with searchAlgorithm: "nelderMead" (explicit) matches the default (omitted) exactly', async () => {
  const opts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 10, searchSeed: 42,
  };
  const withDefault = await tuneFrequencies(PAYTABLE, REEL_TABLES, opts);
  const withExplicit = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...opts, searchAlgorithm: 'nelderMead' });
  assert.deepEqual(withDefault.reelFrequencyTables, withExplicit.reelFrequencyTables);
  assert.equal(withDefault.rtp, withExplicit.rtp);
});

test('tuneFrequencies with searchAlgorithm: "cmaes" converges to a sane RTP on a real fixture', async () => {
  const { rtp, diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 4000, trialsPerPoint: 1, maxIterations: 30,
    searchAlgorithm: 'cmaes', searchSeed: 42,
  });
  assert.ok(Math.abs(rtp - 96) < 10, `expected cmaes to get reasonably close to target RTP 96, got ${rtp}`);
  assert.ok(diagnostics.rtpPhase.iterationsRun > 0, 'expected the cmaes path to actually run iterations');
});

test('tuneFrequencies diagnostics.inputParameters reflects both explicit options and resolved defaults', async () => {
  const { diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 97, trialSpins: 3000, trialsPerPoint: 1, maxIterations: 5, searchAlgorithm: 'cmaes', searchSeed: 7,
  });
  const params = diagnostics.inputParameters;
  // Explicitly passed - should reflect exactly what was passed, not some other value.
  assert.equal(params.targetRtp, 97);
  assert.equal(params.trialSpins, 3000);
  assert.equal(params.trialsPerPoint, 1);
  assert.equal(params.maxIterations, 5);
  assert.equal(params.searchAlgorithm, 'cmaes');
  assert.equal(params.searchSeed, 7);
  // Left at their default - should reflect the RESOLVED default value, not be missing/undefined,
  // since the whole point is a caller shouldn't have to separately know what the defaults were.
  assert.equal(params.rtpTolerancePct, 1.5);
  assert.equal(params.orderingPenaltyWeight, 0.5);
  assert.equal(params.limitPenaltyWeight, 0.5);
  assert.equal(params.uniformityPenaltyWeight, 0);
  assert.equal(params.stdErrorPenaltyWeight, 0);
  assert.equal(params.bestAcceptanceZ, 1.0);
  assert.equal(params.initialWeightStrategy, 'provided');
  // Not JSON-safe / not a tuning knob - must not leak function values or game-layout data onto
  // a section meant to be serialized wholesale.
  assert.equal(params.winEvaluator, undefined);
  assert.equal(params.mechanic, undefined);
  assert.equal(params.paylines, undefined);
  // Survives JSON.stringify/parse round-trip cleanly (the actual point of this whole field).
  const roundTripped = JSON.parse(JSON.stringify(diagnostics)).inputParameters;
  assert.equal(roundTripped.targetRtp, 97);
});

test('tuneFrequencies with searchAlgorithm: "cmaes" never returns a result with worse loss than the point it started from', async () => {
  // Nelder-Mead's own initial simplex always includes the exact starting point as a real,
  // competing vertex (vertex 0) - CMA-ES has no equivalent (it only samples random
  // perturbations around its mean, never the literal mean itself), so without an explicit fix
  // it has no guarantee of ever being at least as good as wherever it started - exactly the
  // property "CONTINUE TUNING FROM THIS RESULT" depends on. `initialStepSize: 0` collapses
  // nelderMead's initial simplex to a single point (every "perturbed" vertex becomes identical
  // to the start), isolating a clean, unperturbed measurement of the starting reel tables'
  // own loss under the same seed cmaes's own first round uses - not "the best of a fanned-out
  // simplex", which a nonzero initialStepSize would conflate this baseline with.
  //
  // Compared on `loss`, not `error` - `loss` (error + weighted ordering/limit/uniformity
  // penalties) is what beatsIncumbent and every vertex comparison actually decide on. A
  // candidate can legitimately have WORSE raw RTP error than another yet still have LOWER loss
  // (and correctly win) if it resolved a violation the other one didn't - asserting on `error`
  // would flag that correct outcome as a regression.
  const sharedOpts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 1, searchSeed: 55,
  };
  const baseline = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, maxIterations: 0, initialStepSize: 0 });
  const cmaesResult = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, maxIterations: 10, searchAlgorithm: 'cmaes' });
  assert.ok(
    cmaesResult.diagnostics.rtpPhase.loss <= baseline.diagnostics.rtpPhase.loss + 1e-9,
    `expected cmaes's result (loss=${cmaesResult.diagnostics.rtpPhase.loss}) to be no worse than the untouched starting point (loss=${baseline.diagnostics.rtpPhase.loss})`
  );
});

test('tuneFrequencies with searchAlgorithm: "cmaes" never regresses (by loss) when continuing from a previous result', async () => {
  // Simulates the panel's CONTINUE TUNING FROM THIS RESULT button: feed one run's own output
  // back in as the next run's starting reelFrequencyTables. The second run's loss must never
  // be worse than the first run's own final loss - continuing should only ever hold steady or
  // improve, never silently regress. Compared on `loss`, not `error` - see the previous test's
  // own comment for why.
  const sharedOpts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 1, searchAlgorithm: 'cmaes', searchSeed: 55,
  };
  const first = await tuneFrequencies(PAYTABLE, REEL_TABLES, { ...sharedOpts, maxIterations: 10 });
  const continued = await tuneFrequencies(PAYTABLE, first.reelFrequencyTables, { ...sharedOpts, maxIterations: 10 });
  assert.ok(
    continued.diagnostics.rtpPhase.loss <= first.diagnostics.rtpPhase.loss + 1e-9,
    `expected continuing (loss=${continued.diagnostics.rtpPhase.loss}) to be no worse than the first run's own result (loss=${first.diagnostics.rtpPhase.loss})`
  );
});

test('tuneFrequencies stops early via options.signal, reporting reason "stopped" and converged: false', async () => {
  const controller = new AbortController();
  let shapeStepsSeen = 0;
  const result = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 1, searchAlgorithm: 'cmaes', searchSeed: 55,
    maxIterations: 100,
    signal: controller.signal,
    onProgress: (phase) => { if (phase === 'shape') { shapeStepsSeen++; if (shapeStepsSeen === 3) controller.abort(); } },
  });
  assert.equal(result.diagnostics.rtpPhase.reason, 'stopped');
  assert.equal(result.diagnostics.rtpPhase.converged, false, 'expected converged: false even if the stopped-at result happened to be within tolerance');
  assert.ok(result.diagnostics.rtpPhase.iterationsRun < 100, `expected far fewer than 100 iterations to have run, got ${result.diagnostics.rtpPhase.iterationsRun}`);
  assert.ok(Number.isFinite(result.rtp), 'expected a real, usable RTP even though the search was cut short');
  assert.ok(Array.isArray(result.reelFrequencyTables) && result.reelFrequencyTables.length === REEL_TABLES.length);
});

test('tuneFrequencies with searchAlgorithm: "nelderMead" also stops early via options.signal', async () => {
  const controller = new AbortController();
  let shapeStepsSeen = 0;
  const result = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 3000, trialsPerPoint: 1, searchSeed: 55,
    maxIterations: 100,
    signal: controller.signal,
    onProgress: (phase) => { if (phase === 'shape') { shapeStepsSeen++; if (shapeStepsSeen === 3) controller.abort(); } },
  });
  assert.equal(result.diagnostics.rtpPhase.reason, 'stopped');
  assert.ok(result.diagnostics.rtpPhase.iterationsRun < 100, `expected far fewer than 100 iterations to have run, got ${result.diagnostics.rtpPhase.iterationsRun}`);
});

// ---- Package 0: reel coupling ----
// Shared fixture for the coupling tests below. A line-pay shape is used deliberately even though
// coupling exists for CLUSTER games: it keeps the test fast and mechanic-independent, and what is
// under test is how `dims` and `projectPoint` treat the reel axis, which is identical either way.
const couplingPaytable = {
  hi:   { payout: [0, 0, 10, 40, 200], type: 'regular' },
  lo:   { payout: [0, 0,  5, 20, 100], type: 'regular' },
  scat: { payout: [0, 0,  2,  5,  20], type: 'scatter', triggerFreeSpins: true },
};
const couplingTable = () => ({ defaults: {}, symbols: { hi: { frequency: 3 }, lo: { frequency: 6 }, scat: { frequency: 1 } } });
const couplingOptions = {
  reelsCount: 3, rowsCount: 3, reelLength: 100, reelSeeds: [11, 22, 33],
  paylines: [[0, 0, 0]], linesCount: 1, betPerLine: 1,
  trialSpins: 2000, trialsPerPoint: 1, maxIterations: 6, searchSeed: 7,
};

test('reelCoupling "linked" gives every reel identical tuned frequencies', async () => {
  // On a cluster game reel index means nothing - a cluster forms from grid-adjacent cells, not
  // from a payline position. Independent per-reel dims let the search invent a large spread
  // between reels for the same symbol, which is the "over-abundance" complaint: it is search
  // noise given one scalar objective and (on Candy Frenzy) 84 degrees of freedom, not a design
  // decision. Linking makes that spread unrepresentable rather than merely penalized.
  const result = await tuneFrequencies(couplingPaytable, [couplingTable(), couplingTable(), couplingTable()], {
    ...couplingOptions, reelCoupling: 'linked',
  });

  const out = result.reelFrequencyTables;
  for (const symbol of ['hi', 'lo']) {
    const values = out.map(rt => rt.symbols[symbol].frequency);
    values.forEach(v => assert.ok(Math.abs(v - values[0]) < 1e-9,
      `${symbol} must be identical across reels under 'linked', got ${values.join(', ')}`));
  }
  assert.equal(result.diagnostics.rtpPhase.coupling.mode, 'linked');
  assert.equal(result.diagnostics.rtpPhase.coupling.dimsLinked, 2,
    'one dim per tunable symbol, not per (symbol, reel)');
});

test('reelCoupling defaults to independent and leaves existing results untouched', async () => {
  // The regression guard every new option in this plan needs: absent, behavior is identical.
  const a = await tuneFrequencies(couplingPaytable, [couplingTable(), couplingTable(), couplingTable()], couplingOptions);
  const b = await tuneFrequencies(couplingPaytable, [couplingTable(), couplingTable(), couplingTable()],
    { ...couplingOptions, reelCoupling: 'independent' });
  assert.deepEqual(b.reelFrequencyTables, a.reelFrequencyTables);
  assert.equal(a.rtp, b.rtp);
});

test('reelCoupling rejects reels that do not carry the same symbols', async () => {
  // Linking writes ONE weight per symbol to every reel, so the reels must agree on what symbols
  // exist. A best-effort merge would write a frequency onto a reel that never had that symbol,
  // producing a strip nobody configured - so this is a hard error naming the offender.
  const mismatched = [couplingTable(), couplingTable(), { defaults: {}, symbols: { hi: { frequency: 3 }, scat: { frequency: 1 } } }];
  await assert.rejects(
    () => tuneFrequencies(couplingPaytable, mismatched, { ...couplingOptions, reelCoupling: 'linked' }),
    /reel 2.*missing.*lo/s);
});

test('reelCoupling "linked-then-refine" bounds per-reel deviation from the linked result', async () => {
  // Phase 2b exists so a reel CAN differ - "reel 4 runs a little heavier on cake" is a real design
  // choice. What it must not do is re-invent the spread linking just removed, so every refined
  // weight stays within maxReelDeviation of the linked value it started from.
  //
  // The tolerance below is deliberately loose relative to maxReelDeviation: the bound clamps each
  // dimension's PRE-renormalization raw weight, and projectPoint then renormalizes each reel
  // against its own budget, which shifts the realized frequency somewhat. This asserts the bound
  // is doing real work, not an exact arithmetic identity.
  const result = await tuneFrequencies(couplingPaytable, [couplingTable(), couplingTable(), couplingTable()], {
    ...couplingOptions, reelCoupling: 'linked-then-refine', maxReelDeviation: 0.25, maxIterations: 12,
  });

  const c = result.diagnostics.rtpPhase.coupling;
  assert.equal(c.mode, 'linked-then-refine');
  assert.equal(c.dimsLinked, 2, 'stage A searches one dim per symbol');
  assert.equal(c.dimsRefined, 6, 'stage B reopens one dim per (symbol, reel)');
  assert.ok(Number.isFinite(c.linkedRtp), 'the linked stage always runs and always reports its RTP');

  for (const symbol of ['hi', 'lo']) {
    const values = result.reelFrequencyTables.map(rt => rt.symbols[symbol].frequency);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    values.forEach(v => assert.ok(Math.abs(v - mean) / mean <= 0.6,
      `${symbol} spread [${values.join(', ')}] exceeds what maxReelDeviation 0.25 should allow`));
  }
});

test('reelCoupling "linked-then-refine" keeps the linked answer when refinement does not beat it', async () => {
  // 2b replacing 2a unconditionally would let a noisier refinement quietly undo a better linked
  // answer - the same failure 7ba9259 fixed for stall restarts. maxReelDeviation 0 pins stage B
  // to exactly stage A's point, so refinement can only ever match, never beat, and the linked
  // result must survive.
  const result = await tuneFrequencies(couplingPaytable, [couplingTable(), couplingTable(), couplingTable()], {
    ...couplingOptions, reelCoupling: 'linked-then-refine', maxReelDeviation: 0, maxIterations: 10,
  });
  assert.equal(result.diagnostics.rtpPhase.coupling.refinementAccepted, false);
  for (const symbol of ['hi', 'lo']) {
    const values = result.reelFrequencyTables.map(rt => rt.symbols[symbol].frequency);
    values.forEach(v => assert.ok(Math.abs(v - values[0]) < 1e-9,
      `${symbol} must still be identical across reels, got ${values.join(', ')}`));
  }
});

test('the two coupling stages number their progress events continuously', async () => {
  // Without an iteration offset, stage B restarts its 'shape' numbering at 0 and the live log
  // reads as two searches rather than one - a caller cannot tell a refinement from a crash-restart.
  const shapeIterations = [];
  await tuneFrequencies(couplingPaytable, [couplingTable(), couplingTable(), couplingTable()], {
    ...couplingOptions, reelCoupling: 'linked-then-refine', maxIterations: 12,
    onProgress: (phase, i) => { if (phase === 'shape') shapeIterations.push(i); },
  });
  assert.ok(shapeIterations.length > 1);
  for (let i = 1; i < shapeIterations.length; i++) {
    assert.ok(shapeIterations[i] >= shapeIterations[i - 1],
      `iteration numbering went backwards at ${i}: ${shapeIterations.join(', ')}`);
  }
});
