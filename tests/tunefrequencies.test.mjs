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

test('tuneFrequencies converges RTP close to target even when baseline data has a large ordering violation', async () => {
  // Old design: FREQUENCY_REEL1's melon (pays 15x) at freq 20 vs grapes (pays 10x) at
  // freq 4 forced a hard floor to t=5.0, overriding an RTP search that had already
  // converged - and that override, compounding across reels, made RTP unreachable (ended
  // near 131% against a 96% target). The new design should actually reach the target.
  const { rtp, diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 80,
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
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, max: cap } } },
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
  const result = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
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
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, min: FREQUENCY_REEL1.symbols.cherries.frequency * 5 } } },
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
