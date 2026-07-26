/**
 * A pure functional simulator for the SlotMachine game logic.
 * It models spins without any visual or audio side effects.
 */
import { generateReel, createSeededRng, resolveFrequencyBounds } from './SlotMath.js';
import { LineMechanic } from './LineMechanic.js';

/**
 * Simulates multiple spins and returns statistical analysis. Mechanic-agnostic: how one spin
 * actually resolves (draw a target grid and evaluate paylines vs. resolve a full cascade
 * sequence) is delegated to `config.mechanic` (core/LineMechanic.js's default, or
 * core/CascadeSpinMechanic.js for cluster-pays games) - this function only owns what's common
 * to both: the base-spin loop, free-spins triggering/retriggering/award-table lookups, the
 * global free-spins safety cap, and result aggregation (RTP, win distribution, spin log).
 * @param {Object} config - Game configuration with reelStrips, paytable, etc.
 * @param {Object} [config.mechanic] - A spin-resolution mechanic (see core/LineMechanic.js's
 *   `LineMechanic` export for the contract: `createFreeSpinsState(simConfig, rng)` and
 *   `resolveSpin({ simConfig, betPerLine, linesCount, rng, isFreeSpin, freeSpinsState,
 *   spinIndex, chargedBet, logSpins }) -> { spinWin, scatterWin, detailedWins, logEntry }`).
 *   Defaults to `LineMechanic` - every existing line-pay caller keeps working unchanged without
 *   ever passing this. Candy Frenzy (and any future cascade game) passes
 *   `CascadeSpinMechanic` from core/CascadeSpinMechanic.js instead.
 * @param {Object} [config.freeSpinsMode] - Cascade-mechanic-only: the pluggable free-spins
 *   payout mode (core/FreeSpinsModes.js) to simulate, passed straight through to
 *   `mechanic.createFreeSpinsState`. Ignored by LineMechanic.
 * @param {number} [config.freeSpinsCount=10] - Flat number of free spins awarded per trigger,
 *   used whenever the triggering scatter count isn't found in `freeSpinsAwardTable` (or that
 *   table is omitted entirely).
 * @param {Object} [config.freeSpinsAwardTable] - Optional `{ scatterCount: awardedSpins }` map
 *   for the free-spins award granted by a BASE-game trigger, mirroring a real game's own award
 *   schedule (e.g. `{ 3: 10, 4: 15, 5: 20 }`). Falls back to `freeSpinsCount` for any count not
 *   listed.
 * @param {Object} [config.retriggerFreeSpinsAwardTable] - Same shape, for a qualifying scatter
 *   hit landing DURING an active free-spins round (a retrigger). Defaults to
 *   `freeSpinsAwardTable` when omitted. Its mere presence (directly or via that default) is
 *   what enables retrigger simulation at all - if neither table is set, free spins run for
 *   exactly `freeSpinsCount` spins with no retriggers, matching this function's original
 *   behavior exactly.
 * @param {boolean} [config.logSpins=false] - When true, records one entry per simulated spin
 *   (base and free alike) in the returned `spinLog` array - spin index, phase, bet, total win,
 *   and a breakdown of every scatter/line/expanding/cluster win that spin produced. Off by
 *   default since it holds one object per spin in memory for the whole run (relevant at the
 *   default 1,000,000+ spin counts); turn it on for a dev-tooling export (see
 *   SimulationPanel.js's "EXPORT SPIN LOG" button), not for routine RTP measurement.
 * @param {boolean} [config.hasExpandingWild=false] - LineMechanic-only: whether free spins here
 *   include a Book-of-Dead-style expanding-wild bonus (a random non-scatter symbol picked fresh
 *   each free-spins session, expanding to fill any reel it lands on - see checkExpandingWins).
 *   Off by default - without this, free spins pay out exactly like the base game, just at no
 *   cost. Omitting it for a game that doesn't actually have this mechanic isn't just "leaving
 *   a feature off": this used to run unconditionally for ANY game with free spins regardless
 *   of whether its real engine flow ever calls enterFreeSpins with an expanding symbol,
 *   fabricating extra "expanding win" payouts (against a real, randomly-chosen paytable
 *   symbol, so not even a harmless no-op) that inflated RTP for any such game.
 * @param {number} numBaseSpins - Number of base spins to simulate (default 100000)
 * @param {number} betPerLine - Bet per line (default 1). Cascade games (no per-line concept)
 *   pass their flat bet amount here alongside `linesCount: 1`.
 * @param {number} linesCount - Number of active paylines (default 10). Cascade games pass 1.
 * @param {() => number} [rng=Math.random] - Random source for spin outcomes. Pass a seeded
 *   rng (e.g. createSeededRng(seed) from SlotMath.js) for a reproducible run; defaults to
 *   Math.random for today's non-deterministic behavior.
 * @returns {Object} Simulation results including RTP, win distribution, etc.
 */
export function simulateSpins(config, numBaseSpins = 100000, betPerLine = 1, linesCount = 10, rng = Math.random) {
  // Input validation
  if (!config || !config.reelStrips || !config.paytable) {
    throw new Error('Invalid config: reelStrips and paytable required');
  }
  if (numBaseSpins <= 0 || betPerLine <= 0 || linesCount <= 0) {
    throw new Error('All numeric parameters must be positive');
  }

  const results = {
    totalBets: 0,
    totalWins: 0,
    winDistribution: {}, // winAmount -> count
    detailedWins: [],     // New: Detailed breakdown of every win
    spinLog: [],           // Populated only when config.logSpins is true (see its own doc)
    scatterCounts: 0,
    maxWin: 0,
    minWin: Infinity,
    freeSpinsTriggered: 0,
    totalSimulatedSpins: 0
  };

  const simConfig = { ...config };
  simConfig.linesCount = linesCount;
  simConfig.betPerLine = betPerLine;
  simConfig.totalBet = betPerLine * linesCount;

  const mechanic = simConfig.mechanic || LineMechanic;

  // Get configuration values with defaults
  const freeSpinsCount = simConfig.freeSpinsCount || 10;
  // Optional { scatterCount: awardedSpins } lookups mirroring a real game's own award
  // schedule (e.g. barfruits' FREQUENCY_REEL-adjacent FREE_SPINS_AWARD = {3:10, 4:15, 5:20}).
  // Absent -> awardFor() falls back to the flat freeSpinsCount above, unchanged from before
  // these existed. retriggerFreeSpinsAwardTable additionally defaults to freeSpinsAwardTable
  // when only one is given, since most games use the same schedule for both; its mere
  // presence is what turns retrigger simulation on at all (see supportsRetrigger below) - a
  // config that sets neither table keeps the exact old behavior (flat freeSpinsCount spins,
  // no retriggers), so this is purely additive for any existing caller.
  const freeSpinsAwardTable = simConfig.freeSpinsAwardTable || null;
  const retriggerFreeSpinsAwardTable = simConfig.retriggerFreeSpinsAwardTable || freeSpinsAwardTable;
  const supportsRetrigger = retriggerFreeSpinsAwardTable != null;
  const awardFor = (table, count) => (table && table[count] != null) ? table[count] : freeSpinsCount;
  // Bounds the TOTAL free spins run across the whole call, not just one chain - a per-chain-only
  // cap still allows worst-case total work of numBaseSpins * cap, which for a candidate/baseline
  // with an extremely high trigger+retrigger rate (very plausible mid-search, before Phase 1 has
  // scaled anything down yet, or simply while a game's frequencies are still being hand-tuned)
  // could take impractically long even though each individual chain is itself bounded. Scaling
  // with numBaseSpins keeps a larger requested simulation proportionally better sampled while
  // still keeping worst-case runtime roughly O(numBaseSpins) regardless of how pathological the
  // configured frequencies are.
  const FREE_SPINS_GLOBAL_CAP = Math.max(numBaseSpins * 20, 50000);
  let totalFreeSpinsRun = 0;
  const logSpins = !!simConfig.logSpins;

  // Runs one spin (base or free) via the active mechanic, then folds its result into `results` -
  // the one piece of bookkeeping every mechanic shares, regardless of how it resolved the grid.
  function runOneSpin(isFreeSpin, freeSpinsState) {
    const chargedBet = isFreeSpin ? 0 : simConfig.totalBet;
    if (!isFreeSpin) results.totalBets += chargedBet;
    results.totalSimulatedSpins++;

    const { spinWin, scatterWin, detailedWins, logEntry } = mechanic.resolveSpin({
      simConfig, betPerLine, linesCount, rng, isFreeSpin, freeSpinsState,
      spinIndex: results.totalSimulatedSpins, chargedBet, logSpins,
    });

    if (scatterWin) {
      results.scatterCounts += scatterWin.count;
      if (scatterWin.triggerFreeSpins) results.freeSpinsTriggered++;
    }

    results.totalWins += spinWin;
    if (spinWin > results.maxWin) results.maxWin = spinWin;
    if (spinWin < results.minWin) results.minWin = spinWin;
    results.winDistribution[spinWin] = (results.winDistribution[spinWin] || 0) + 1;
    detailedWins.forEach(w => results.detailedWins.push(w));
    if (logSpins && logEntry) results.spinLog.push(logEntry);

    return { scatterWin };
  }

  // Main simulation loop for base spins
  for (let i = 0; i < numBaseSpins; i++) {
    const result = runOneSpin(false, null);

    // If free spins were triggered by this base spin, simulate them (unless the global free
    // spins budget is already exhausted - base spins keep running either way, so the base-game
    // RTP/trigger-rate signal stays representative even once free-spin payouts are truncated).
    if (result.scatterWin && result.scatterWin.triggerFreeSpins && totalFreeSpinsRun < FREE_SPINS_GLOBAL_CAP) {
      // Built once per round (e.g. LineMechanic randomizes an expanding symbol,
      // CascadeSpinMechanic inits a free-spins-mode's persistent state) - never rebuilt by a
      // retrigger extending this same round.
      const freeSpinsState = mechanic.createFreeSpinsState(simConfig, rng);

      // A real free-spins round can retrigger itself (another qualifying scatter hit during
      // the bonus adds more spins on top, same as the live engine's retriggerFreeSpins) - the
      // remaining-spins count grows as the loop runs rather than being fixed up front.
      let freeSpinsRemaining = awardFor(freeSpinsAwardTable, result.scatterWin.count);
      let freeSpinsRun = 0;
      while (freeSpinsRun < freeSpinsRemaining && totalFreeSpinsRun < FREE_SPINS_GLOBAL_CAP) {
        const fsResult = runOneSpin(true, freeSpinsState);
        freeSpinsRun++;
        totalFreeSpinsRun++;
        if (supportsRetrigger && fsResult.scatterWin && fsResult.scatterWin.triggerFreeSpins) {
          freeSpinsRemaining += awardFor(retriggerFreeSpinsAwardTable, fsResult.scatterWin.count);
        }
      }
    }
  }

  const rtp = results.totalBets > 0 ? (results.totalWins / results.totalBets) * 100 : 0;

  return {
    rtp: rtp.toFixed(2) + '%',
    rtpRaw: results.totalBets > 0 ? (results.totalWins / results.totalBets) : 0,
    totalSpins: results.totalSimulatedSpins,
    baseSpins: numBaseSpins,
    totalBets: results.totalBets,
    totalWins: results.totalWins,
    maxWin: results.maxWin,
    minWin: results.minWin === Infinity ? 0 : results.minWin,
    scatterCounts: results.scatterCounts,
    freeSpinsTriggered: results.freeSpinsTriggered,
    winDistribution: results.winDistribution,
    detailedWins: results.detailedWins,
    spinLog: results.spinLog
  };
}

// Ranks symbols by descending payout (highest single-line payout = rank 0), tying symbols
// with equal payout to the same rank so their relative weight is preserved as a group.
// `payoutOf(paytable, symbol) -> number` is mechanic-specific (line-pay ranks by the highest
// N-of-a-kind payout, cascade ranks by the highest cluster-payout tier - see LineMechanic.js/
// CascadeSpinMechanic.js's own `defaultPayoutOf`) - defaults to the line-pay convention so
// existing callers that don't pass one keep working unchanged.
export function computeValueRanks(paytable, symbols, payoutOf = LineMechanic.defaultPayoutOf) {
  const sorted = [...symbols].sort((a, b) => payoutOf(paytable, b) - payoutOf(paytable, a));
  const rankOf = {};
  let rank = -1, lastPayout = null;
  for (const s of sorted) {
    const p = payoutOf(paytable, s);
    if (p !== lastPayout) { rank++; lastPayout = p; }
    rankOf[s] = rank;
  }
  return rankOf;
}

// Scales any positive per-symbol raw-weight map so it sums to valueBudget - used both to
// project Phase 2's Nelder-Mead candidates back onto each reel's fixed budget, and (via
// Phase 1) to keep the scatter-symbol scaling on the same footing.
export function renormalizeWeights(raw, valueBudget) {
  const rawTotal = Object.values(raw).reduce((a, b) => a + b, 0);
  const scale = valueBudget / rawTotal;
  const out = {};
  Object.keys(raw).forEach(s => { out[s] = raw[s] * scale; });
  return out;
}

/**
 * Generic 1D root-finder for tuning a single parameter against a target scalar metric,
 * replacing bisection with a gradient-informed step: at each iteration, the local
 * derivative of the metric with respect to the (log-space) parameter is estimated via a
 * finite difference, then the parameter is moved directly toward the target by an amount
 * proportional to (targetGap / estimatedSlope) - equivalent to a gradient descent step on
 * the squared-error loss (metric - target)^2, with the step size self-normalized by the
 * local slope instead of a fixed learning rate. That self-normalization is what keeps it
 * numerically stable across metrics with very different natural scales (a trigger rate
 * near 1% vs an RTP near 100%) without per-phase learning-rate tuning.
 *
 * Parameterized in log-space (x = ln(param)) since every tuned parameter here is a
 * positive multiplicative scale factor - a fixed step in x is a fixed *relative* change
 * in param regardless of its current magnitude.
 *
 * Uses common random numbers for the finite difference: both probe points in a step share
 * the same seed, so the estimated slope reflects the parameter change, not two independent
 * noisy Monte Carlo draws (measure() is stochastic unless given a fixed seed).
 *
 * Costs up to 2 simulated measurements per iteration (vs 1 for plain bisection) - the
 * probe measurement is skipped once tolerance is met or on the final iteration.
 *
 * @param {Object} args
 * @param {number} args.initialParam - Starting parameter value (> 0).
 * @param {number} args.minParam - Lower clamp (> 0).
 * @param {number} args.maxParam - Upper clamp (>= minParam).
 * @param {number} args.target - Target value for the metric.
 * @param {number} args.tolerance - Stop early once |metric - target| <= tolerance.
 * @param {(param: number) => Object} args.buildTrial - Builds a trial from a parameter value.
 * @param {(measureResult: Object) => number} args.metricOf - Extracts the scalar metric from a measure() result.
 * @param {(trial: Object, rngSeed: number) => Object} args.measure - Measures a trial (seeded, for CRN).
 * @param {number} args.maxIterations - Number of gradient steps.
 * @param {number} args.seedBase - Base seed for this phase's steps (offset per phase/mode to avoid correlated noise between phases).
 * @param {(i: number, param: number, result: Object & {error: number}, best: Object) => (void|Promise<void>)} [args.onProgress]
 * @param {(info: { iteration: number, operation: 'widen-probe', probeAttempt: number }) => (void|Promise<void>)} [args.onBusy] -
 *   Fired once the first slope probe comes back exactly flat and this iteration is about to
 *   spend several more (up to 7 further) measurements widening/flipping direction to find one -
 *   without this, that extra work is invisible between one onProgress call and the next. Never
 *   fired for the common case (a measurable slope on the first try). If widening drags on, it
 *   fires again with an updated `probeAttempt`, throttled to at most once every
 *   `busyReportIntervalMs` of real time - a plateau that resolves within a probe or two only
 *   ever fires once.
 * @param {number} [args.busyReportIntervalMs=300] - Minimum real time between successive
 *   `onBusy` calls within the same widen-probe search (see above).
 * @param {() => Promise<void>} args.yieldToEventLoop
 * @param {number} [args.trustFactor=0.8] - Fraction of the suggested step actually taken each
 *   iteration (damping against noisy slope estimates); decays each step.
 * @param {number} [args.trustFactorDecay=0.9]
 * @param {number} [args.epsilon=0.05] - Finite-difference probe distance in log-space.
 * @returns {Promise<{ mult: number, error: number, result: Object, trial: Object, converged: boolean }>} -
 *   `converged` is true iff the best candidate found landed within `tolerance` of `target`;
 *   false means the search exhausted its iterations (or every direction was a flat
 *   plateau) without reaching the target - callers should surface this rather than
 *   silently treating `best` as a successful tune.
 */
export async function gradientDescent1D({
  initialParam, minParam, maxParam, target, tolerance,
  buildTrial, metricOf, measure, maxIterations, seedBase,
  onProgress, onBusy, yieldToEventLoop,
  trustFactor = 0.8, trustFactorDecay = 0.9, epsilon = 0.05,
  busyReportIntervalMs = 300,
}) {
  const minX = Math.log(minParam);
  const maxX = Math.log(maxParam);
  let x = Math.min(maxX, Math.max(minX, Math.log(initialParam)));
  let trust = trustFactor;
  let best = null;

  for (let i = 0; i < maxIterations; i++) {
    const stepSeed = seedBase + i * 7919;
    const param = Math.exp(x);
    const trial = buildTrial(param);
    const result = measure(trial, stepSeed);
    const metric = metricOf(result);
    const error = Math.abs(metric - target);
    const resultWithError = { ...result, error };
    if (!best || error < best.error) best = { mult: param, error, result, trial };
    if (onProgress) await onProgress(i, param, resultWithError, best);
    await yieldToEventLoop();
    if (error <= tolerance || i === maxIterations - 1) break;

    // Probe for a measurable slope, widening the probe distance (and, failing that,
    // trying the opposite direction) when the first probe lands on a flat plateau -
    // generateReel() rounds symbol counts to whole numbers per reel, so a small parameter
    // change can measure as an *exactly* zero slope even though the metric does move at a
    // larger step. Without this, the search stalls permanently at the first such plateau
    // (trust decays every iteration regardless, but x itself never moves).
    let slope = 0, usedDx = epsilon;
    let probeAttempt = 0;
    let reportedBusy = false;
    let lastBusyReportTime = 0;
    outer: for (const sign of [1, -1]) {
      for (let widen = 1; widen <= 8; widen *= 2) {
        probeAttempt++;
        // First fired once the FIRST probe has already come back flat and this iteration is
        // about to spend several more measurements widening/flipping to escape the plateau -
        // not per probe attempt (up to 8 total). After that, fired again at most once every
        // `busyReportIntervalMs` of real time (not once per remaining probe) - a plateau that
        // resolves within a couple of probes reports once; one that grinds through several
        // gets an occasional "still on it" heartbeat with an updated attempt count, without a
        // log line per measurement.
        if (onBusy && probeAttempt >= 2) {
          const now = Date.now();
          if (!reportedBusy || now - lastBusyReportTime >= busyReportIntervalMs) {
            reportedBusy = true;
            lastBusyReportTime = now;
            await onBusy({ iteration: i, operation: 'widen-probe', probeAttempt });
          }
        }
        const xProbe = Math.min(maxX, Math.max(minX, x + sign * epsilon * widen));
        const dx = xProbe - x;
        if (dx === 0) continue;
        const probeResult = measure(buildTrial(Math.exp(xProbe)), stepSeed);
        slope = (metricOf(probeResult) - metric) / dx;
        if (slope !== 0) { usedDx = dx; break outer; }
      }
    }
    if (slope !== 0) {
      // Cap the step to a small multiple of the distance actually probed - a shallow slope
      // measured only because the probe had to widen to escape a flat plateau is a coarse,
      // low-confidence estimate; extrapolating it at full strength is what previously sent
      // the search flying from one end of the parameter range to the other in a single step.
      const rawStep = ((target - metric) / slope) * trust;
      const maxStep = Math.abs(usedDx) * 4;
      const step = Math.max(-maxStep, Math.min(maxStep, rawStep));
      x = Math.min(maxX, Math.max(minX, x + step));
    }
    trust *= trustFactorDecay;
  }

  return { ...best, converged: best.error <= tolerance };
}

/**
 * Generic Nelder-Mead simplex minimizer over an n-dimensional parameter vector.
 * Derivative-free - compares function values across n+1 simplex vertices (reflect, expand,
 * contract, shrink) rather than estimating a gradient - the standard choice (same algorithm
 * behind scipy.optimize.minimize(method='Nelder-Mead') / MATLAB's fminsearch) for objectives
 * that are noisy or expensive to differentiate, both true here: `evaluate` wraps a Monte
 * Carlo RTP measurement, not a closed-form function, and a numerical gradient across many
 * dimensions would need one extra evaluation per dimension per iteration, where Nelder-Mead
 * typically needs only one or two.
 *
 * Callers are responsible for their own CRN (common random numbers) discipline if
 * `evaluate` wraps something stochastic - e.g. closing over one fixed RNG seed for the
 * whole call, so every point (old or new) is evaluated under directly comparable
 * conditions and vertices never need re-evaluating just because time passed.
 *
 * @param {Object} args
 * @param {number[]} args.initialPoint - Starting parameter vector.
 * @param {number} args.initialStepSize - Perturbation used to build the initial simplex
 *   (vertex i = initialPoint with dimension i-1 offset by this amount).
 * @param {(point: number[]) => ({ loss: number, [key: string]: any })} args.evaluate -
 *   Evaluates one point; must return at least `{ loss }` (lower is better). Any extra
 *   fields are carried through onto the vertex object returned via onProgress/result.
 * @param {number} args.maxIterations
 * @param {number} [args.convergenceTolerance=1e-4] - Stop early once the spread between the
 *   simplex's best and worst loss is at or below this.
 * @param {(iteration: number, point: number[], result: Object, best: Object) => (void|Promise<void>)} [args.onProgress]
 * @param {(info: { iteration: number, operation: 'shrink', verticesToEvaluate: number, verticesEvaluated?: number }) => (void|Promise<void>)} [args.onBusy] -
 *   Fired once per iteration, only when reflection, expansion, AND contraction all failed to
 *   improve and the whole simplex is about to shrink - the one operation here that re-evaluates
 *   every vertex (`verticesToEvaluate` = n+1) instead of just one or two, so it's the main
 *   source of a "stuck" gap between one onProgress call and the next in a high-dimensional
 *   search. Never fired for a plain reflection/expansion/contraction (1-2 evaluates - not
 *   worth a separate notification). The first call (before any vertex in this shrink has been
 *   re-evaluated) omits `verticesEvaluated`; while the shrink is actually running, it fires
 *   again at most once every `busyReportIntervalMs` of real time, each time with
 *   `verticesEvaluated` set - a shrink that finishes quickly never gets a second call, one that
 *   takes a while gets an occasional progress update instead of one call per vertex.
 * @param {number} [args.busyReportIntervalMs=300] - Minimum real time between successive
 *   `onBusy` progress updates within the same shrink (see above). Lower only for tests that
 *   need every vertex's update to fire deterministically.
 * @param {() => Promise<void>} args.yieldToEventLoop
 * @returns {Promise<{ point: number[], loss: number, result: Object, iterations: number, converged: boolean }>} -
 *   `converged` is true iff the search stopped because the simplex's spread collapsed below
 *   `convergenceTolerance`, not because `maxIterations` ran out.
 */
export async function nelderMead({
  initialPoint, initialStepSize, evaluate, maxIterations,
  convergenceTolerance = 1e-4, onProgress, onBusy, yieldToEventLoop,
  busyReportIntervalMs = 300,
}) {
  const n = initialPoint.length;
  const ALPHA = 1, GAMMA = 2, RHO = 0.5, SIGMA = 0.5;

  const evalPoint = (point) => ({ point, ...evaluate(point) });

  // Initial simplex: vertex 0 = initialPoint, vertex i (1..n) = initialPoint with dimension
  // i-1 perturbed by initialStepSize - the standard right-angled starting simplex.
  let vertices = [evalPoint(initialPoint.slice())];
  for (let i = 0; i < n; i++) {
    const p = initialPoint.slice();
    p[i] += initialStepSize;
    vertices.push(evalPoint(p));
  }

  let best = vertices.reduce((a, b) => (b.loss < a.loss ? b : a));
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    vertices.sort((a, b) => a.loss - b.loss);
    if (vertices[0].loss < best.loss) best = vertices[0];

    if (onProgress) await onProgress(iter, vertices[0].point, vertices[0], best);
    await yieldToEventLoop();

    if (vertices[n].loss - vertices[0].loss <= convergenceTolerance) { converged = true; break; }

    const worst = vertices[n];
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      vertices[i].point.forEach((x, d) => { centroid[d] += x / n; });
    }

    const reflectedPoint = centroid.map((c, d) => c + ALPHA * (c - worst.point[d]));
    const reflected = evalPoint(reflectedPoint);

    if (reflected.loss < vertices[0].loss) {
      // Better than the current best - try pushing further in the same direction.
      const expandedPoint = centroid.map((c, d) => c + GAMMA * (reflectedPoint[d] - c));
      const expanded = evalPoint(expandedPoint);
      vertices[n] = expanded.loss < reflected.loss ? expanded : reflected;
    } else if (reflected.loss < vertices[n - 1].loss) {
      // Better than the second-worst - accept the plain reflection.
      vertices[n] = reflected;
    } else {
      // Reflection didn't help enough - contract toward whichever of {reflected, worst} is
      // better ("outside" vs "inside" contraction), or shrink the whole simplex toward the
      // best vertex if even that fails.
      const useOutside = reflected.loss < worst.loss;
      const basePoint = useOutside ? reflectedPoint : worst.point;
      const contractedPoint = centroid.map((c, d) => c + RHO * (basePoint[d] - c));
      const contracted = evalPoint(contractedPoint);
      const contractedBetter = useOutside ? contracted.loss <= reflected.loss : contracted.loss < worst.loss;
      if (contractedBetter) {
        vertices[n] = contracted;
      } else {
        if (onBusy) await onBusy({ iteration: iter, operation: 'shrink', verticesToEvaluate: n + 1 });
        const bestPoint = vertices[0].point;
        // An explicit loop (not a single .map()) so a shrink that takes a while can report
        // progress partway through - gated to at most once every `busyReportIntervalMs` of
        // real time, so a fast shrink (the common case) never gets more than the one "starting"
        // call above, while a slow one gets an occasional heartbeat instead of silence.
        const shrunkVertices = new Array(vertices.length);
        let lastBusyReportTime = Date.now();
        for (let vi = 0; vi < vertices.length; vi++) {
          shrunkVertices[vi] = evalPoint(bestPoint.map((b, d) => b + SIGMA * (vertices[vi].point[d] - b)));
          const isLast = vi === vertices.length - 1;
          const now = Date.now();
          if (onBusy && !isLast && now - lastBusyReportTime >= busyReportIntervalMs) {
            lastBusyReportTime = now;
            await onBusy({ iteration: iter, operation: 'shrink', verticesToEvaluate: n + 1, verticesEvaluated: vi + 1 });
          }
        }
        vertices = shrunkVertices;
      }
    }
  }

  vertices.sort((a, b) => a.loss - b.loss);
  if (vertices[0].loss < best.loss) best = vertices[0];

  return { point: best.point, loss: best.loss, result: best, iterations, converged };
}

/**
 * Automatically tunes each reel's own `frequency` values (one table per reel - see
 * `reelFrequencyTables`) to hit a target RTP and a target free-spin trigger rate, without
 * touching any payout values or the paytable itself. Runs the real simulator against
 * candidate reel tables, so it stays accurate to whatever SlotMath.js's actual win logic
 * does at the time it's run.
 *
 * Frequencies live only on the per-reel tables, never on `paytable` - `paytable` is used
 * only for payout-based tier ranking and type lookups (wild/scatter/exclusions), and is
 * returned unchanged (not included in the return value at all).
 *
 * Strategy:
 *  1. Scale every symbol with `paytable[symbol].triggerFreeSpins === true`'s frequency by one
 *     shared multiplier, applied identically to every reel's table (gradientDescent1D), until
 *     the free-spin trigger rate lands on target. A symbol with frequency 0 on a given reel
 *     stays 0 (0 * mult = 0).
 *  2. Jointly tune every reel's value-symbol weights via one Nelder-Mead simplex search
 *     over one free weight per (value symbol, reel) pair - true multi-dimensional
 *     optimization, not coordinate descent over reels. "A higher-paying symbol should not
 *     be more frequent than a lower-paying symbol on the same reel" is a soft penalty term
 *     added to the loss (see `nelderMead`'s `evaluate` closure below), not a hard
 *     constraint - a single scalar-per-reel tilt could not simultaneously fix an ordering
 *     violation and hit the RTP target when the two required different corrections for
 *     different symbols on the same reel; a genuinely free weight per symbol can. Any
 *     ordering violation still present once the search finishes is reported in
 *     `diagnostics.rtpPhase.orderingViolations`, not silently corrected.
 *     Any symbol with `fixed: true` on a given reel's own frequency table entry, and any
 *     symbol with baseline frequency 0 on a given reel, are excluded from the search entirely
 *     (held fixed / left at 0). `fixed` lives on the reel data itself, per (symbol, reel) -
 *     not derived from the paytable's `type` - so it's independent per reel: a symbol can be
 *     fixed on one reel and freely tuned on another.
 *     Phase 2 itself runs in short rounds rather than one long search: a round that fails to
 *     improve RTP error, the ordering-violation total, and the limit-violation total (each
 *     tracked independently) restarts from the best point found so far with a wider step and
 *     a different search seed, and gives up early after several such stalls rather than
 *     grinding through the rest of the iteration budget on a target that was never reachable -
 *     see `diagnostics.rtpPhase.reason` for why a given run stopped.
 *
 * @param {Object} paytable - Rules only (payout, type, wild, wildPenalty, wildExcludes,
 *   aloneBonus, friendlyName) - no `.frequency` field. Not mutated, not returned.
 * @param {Object[]} reelFrequencyTables - One table per reel, each
 *   `{ defaults?: { minGap?, maxStack?, minStack?, minFrequency?, maxFrequency? }, symbols: {
 *   symbol: { frequency, fixed?, minFrequency?, maxFrequency?, minGap?, maxStack?, minStack? } } }`
 *   (see generateReel's own doc in core/SlotMath.js for the shape and its `minGap`/`maxStack`/
 *   `minStack` fields - `tuneFrequencies` itself only reads/writes `.symbols[symbol].frequency`,
 *   `.fixed`, `.minFrequency`, `.maxFrequency` (both resolved via `resolveFrequencyBounds`, so a
 *   reel-level `defaults.minFrequency`/`.maxFrequency` applies to any symbol that doesn't
 *   override it); `.defaults` and any `.symbols[symbol].minGap`/`.maxStack`/`.minStack` pass
 *   through untouched). `fixed: true` is optional
 *   (defaults to falsy/tunable) and excludes that symbol from Phase 2 on that specific reel
 *   only - its frequency is left exactly as passed in. `min` and/or `max` are optional soft
 *   bounds (same units as `frequency`) on that symbol's frequency on that specific reel -
 *   like the ordering preference, a discouraged-but-not-forbidden preference (see
 *   `limitPenaltyWeight` below), not a hard clamp. Not mutated; a tuned clone is returned.
 * @param {Object} [options]
 * @param {number} [options.reelsCount=reelFrequencyTables.length]
 * @param {number} [options.rowsCount=3]
 * @param {number} [options.reelLength=220] - Virtual reel strip length passed to generateReel.
 * @param {number[]} [options.reelSeeds] - Base seeds, one per reel (reused/offset if fewer than reelsCount).
 * @param {number} [options.betPerLine=1]
 * @param {number} [options.linesCount=10]
 * @param {number} [options.targetRtp=96] - Target RTP as a percent (e.g. 96 for 96%).
 * @param {number} [options.rtpTolerancePct=1.5] - Acceptable +/- band around targetRtp.
 * @param {number} [options.targetTriggerRatePct=0.6] - Target % of spins that trigger free spins.
 * @param {number} [options.triggerRateTolerancePct=0.15] - Acceptable +/- band around that.
 * @param {number} [options.trialSpins=800000] - Base spins simulated per candidate.
 * @param {number} [options.trialsPerPoint=3] - Independent trials averaged per candidate (reduces rare-event noise).
 * @param {number} [options.maxIterations=150] - Nelder-Mead iterations for the one joint
 *   Phase 2 search (each iteration is cheap - usually one measure() call).
 * @param {number} [options.orderingPenaltyWeight=0.5] - Weight of the soft ordering-violation
 *   penalty added to Phase 2's loss alongside RTP error - higher discourages violations more
 *   strongly, but RTP convergence always wins when the two genuinely conflict.
 * @param {number} [options.limitPenaltyWeight=0.5] - Weight of the soft per-symbol min/max
 *   frequency penalty (see `reelFrequencyTables`' `min`/`max` above) added to Phase 2's loss
 *   alongside RTP error and the ordering penalty - same soft-preference semantics.
 * @param {number} [options.uniformityPenaltyWeight=0] - Weight of a soft per-reel penalty
 *   discouraging any one tunable symbol's frequency from landing far from a straight-line
 *   target across that reel's payout tiers - NOT a flat "every symbol should be equal" target.
 *   The line's slope is set by that reel's own `orderingBiasByReel` entry (direction and
 *   Strength together - see below): bias 0 (no ordering preference) collapses the line to
 *   flat/equal, same as if every symbol truly should match the reel's equal share; a nonzero
 *   bias tilts the line the same direction ordering already prefers (e.g. bias -1 tilts it so
 *   lower-paying symbols sit above the reel's equal share and higher-paying ones below, matching
 *   "high pay rarer"), so this penalty pulls toward the tilt ordering wants instead of fighting
 *   it with a competing flat preference. `uniformityPenaltyWeight` itself only controls how hard
 *   the search is pushed toward that line - it never changes the line's own slope, which is
 *   entirely `orderingBiasByReel`'s (Strength's) job. Any symbol with
 *   `paytable[symbol].type === 'scatter'` is excluded from this comparison entirely (neither
 *   pulled toward a target nor counted toward computing one), even one that doesn't happen to
 *   trigger free spins - a scatter's ideal frequency plays a fundamentally different role than
 *   the value symbols this penalty compares. Off by default (0) since it's an opt-in extra
 *   preference, not a default assumption about what a good distribution looks like; independent
 *   of orderingPenaltyWeight itself (a reel can be perfectly ordered by payout tier and still
 *   have one wildly disproportionate symbol relative to the ideal line) and of
 *   limitPenaltyWeight (which only fires for symbols with an explicit min/max configured, not
 *   every tunable symbol on the reel). Like the other two, always a soft preference - it steers
 *   the search but never blocks 'converged'/'converged-with-violations' classification (real
 *   payout-tiered reels essentially never land exactly on any target line, so requiring this to
 *   hit exactly 0 would make 'converged' unreachable whenever it's enabled).
 * @param {number[]} [options.orderingBiasByReel] - Per-reel direction/strength for the
 *   ordering preference, indexed by reel. `-1` (the default for every reel, if omitted or if
 *   a specific reel's entry is missing) keeps today's behavior: a higher-paying symbol is
 *   discouraged from being *more* frequent than a lower-paying one on that reel. `1` reverses
 *   it for that reel: a higher-paying symbol is discouraged from being *less* frequent than a
 *   lower-paying one - useful for engineering a near-miss feel (e.g. reels 1 and 3 show
 *   premium symbols often, reel 2 almost never does, so lines rarely complete despite looking
 *   close). `0` disables the preference entirely for that reel. Any other magnitude scales
 *   how strongly that reel's preference is enforced relative to `orderingPenaltyWeight`.
 * @param {number} [options.initialStepSize=0.5] - Log-space perturbation used to build Phase
 *   2's initial Nelder-Mead simplex.
 * @param {number} [options.searchSeed=12345] - Base PRNG seed for the common-random-numbers
 *   gradient/simplex estimates - a given seed always explores the same sequence, for
 *   reproducible runs.
 * @param {number} [options.stallWindowIterations=15] - Phase 2 runs nelderMead() in rounds of
 *   this many iterations, checking after each round whether RTP error, the ordering-violation
 *   total, or the limit-violation total improved by at least 2% relative to its own
 *   best-so-far. A round where none of the three improved is a stall.
 * @param {number} [options.stallWidenFactor=1.5] - Multiplier applied to the Nelder-Mead initial
 *   step size each time a stall triggers a restart.
 * @param {number} [options.maxStallRestarts=4] - Consecutive stalled rounds before Phase 2
 *   gives up early (rather than spending the rest of maxIterations on a dead end) and reports
 *   `diagnostics.rtpPhase.reason` as `'stalled'` or `'converged-with-violations'`.
 * @param {number} [options.earlyAcceptErrorPct=0.01] - RTP error threshold (in percentage
 *   points) below which Phase 2 stops immediately if ordering/limit violations are also fully
 *   resolved - no reason to spend more budget refining an already-essentially-exact result.
 * @param {number} [options.freeSpinsCount] - Passed straight through to simulateSpins as
 *   `config.freeSpinsCount` - see its own doc. Only matters if `paytable` has a
 *   `triggerFreeSpins: true` symbol.
 * @param {Object} [options.freeSpinsAwardTable] - Passed straight through to simulateSpins as
 *   `config.freeSpinsAwardTable` (the real game's own scatter-count -> awarded-spins schedule)
 *   so a measured candidate's RTP reflects the same free-spins economics the live game actually
 *   awards, not a flat guess.
 * @param {Object} [options.retriggerFreeSpinsAwardTable] - Passed straight through to
 *   simulateSpins as `config.retriggerFreeSpinsAwardTable` - omitting both this and
 *   `freeSpinsAwardTable` measures with no retriggers at all, which understates RTP for any
 *   game whose live engine does support retriggering.
 * @param {boolean} [options.hasExpandingWild] - Passed straight through to simulateSpins as
 *   `config.hasExpandingWild` - see its own doc. Omitting this for a game that really does have
 *   an expanding-wild free-spins bonus understates its RTP.
 * @param {Object} [options.mechanic] - Spin-resolution mechanic (see simulateSpins' own doc) -
 *   defaults to LineMechanic. A cascade game passes CascadeSpinMechanic (core/
 *   CascadeSpinMechanic.js) instead, alongside `winEvaluator`/`scatterSymbol`/`freeSpinsMode`
 *   in place of `paylines`/`wildSymbol`/`hasExpandingWild`.
 * @param {Object} [options.freeSpinsMode] - Cascade-mechanic-only: passed straight through to
 *   simulateSpins as `config.freeSpinsMode` - see its own doc.
 * @param {(paytable: Object, symbol: string) => number} [options.payoutOf] - How Phase 2 ranks
 *   "value" symbols against each other for the soft ordering preference below - defaults to
 *   `mechanic.defaultPayoutOf` (line-pay: highest N-of-a-kind payout; cascade: highest
 *   cluster-payout tier). Override only for a mechanic whose payout shape doesn't fit either
 *   convention.
 * @param {'provided'|'uniform'|'normal'} [options.initialWeightStrategy='provided'] - How Phase
 *   2's starting point is chosen for a dimension that has BOTH a minFrequency and a
 *   maxFrequency configured (via `resolveFrequencyBounds` - a symbol missing either bound has
 *   no defined range to sample from, so it always starts from its provided baseline frequency
 *   regardless of this setting). `'provided'` (the default) starts every dimension at whatever
 *   frequency `reelFrequencyTables` already had - unchanged behavior. `'uniform'` picks a value
 *   uniformly at random between that dimension's min and max. `'normal'` picks from a normal
 *   distribution centered at the midpoint of min/max (std = a quarter of the range, clamped
 *   back into [min, max] as a backstop against the rare extreme tail sample) - useful for
 *   exploring whether the search reliably converges to the same answer from a meaningfully
 *   different starting shape, or gets stuck depending on where it started. Sampling is drawn
 *   from a dedicated RNG seeded off `searchSeed`, so the whole run - including which random
 *   starting point gets used - stays a pure function of `searchSeed` (same determinism
 *   guarantee as every other seeded part of this search).
 * @param {(phase: 'initial'|'scatter'|'shape'|'restart', iteration: number, multiplier: number|null, result: Object, best: Object) => (void|Promise<void>)} [options.onProgress] -
 *   Called (and awaited, if it returns a promise) at several points during the search:
 *   - `'initial'`: fired exactly once, before Phase 1 runs, with `result.trial` set to Phase
 *     2's actual starting reel tables (reflecting `initialWeightStrategy`) - `multiplier` and
 *     `best` are both `null` here, nothing has been measured yet.
 *   - `'scatter'`: one call per Phase 1 iteration, `result` is `{rtp, triggerRate, error}`.
 *   - `'shape'`: one call per Phase 2 iteration, after each candidate is measured. `multiplier`
 *     is always `null` here (Phase 2 moves every dimension together each iteration, so there's
 *     no longer one scalar to report per step).
 *   - `'restart'`: fired whenever a stalled round triggers a restart, with `result` set to
 *     `{stepSize, restarts, stallStreak, maxStallRestarts, willStopNow}` - `multiplier` is
 *     `null`; `best` is the best vertex found so far. Without this, a stall/restart is
 *     invisible to a caller: the per-iteration `'shape'` log looks identical whether or not a
 *     restart just happened underneath it.
 *   - `'busy'`: fired at most once per iteration (`'scatter'` or `'shape'`), only when that
 *     iteration is doing several times its usual amount of work before it has anything new to
 *     report - a Phase 2 Nelder-Mead simplex shrink (re-evaluates every vertex, not just one or
 *     two) or a Phase 1 gradient-descent plateau-widening retry (see `gradientDescent1D`'s/
 *     `nelderMead`'s own `onBusy` doc for exactly when each fires). `result` is
 *     `{iteration, operation: 'shrink'|'widen-probe', sourcePhase: 'scatter'|'shape',
 *     verticesToEvaluate?, verticesEvaluated?, probeAttempt?}` - `sourcePhase` says which phase
 *     this came from, since `i` alone doesn't (Phase 1 and Phase 2 both number from 0). Use it
 *     to label a 'busy' line the same way as that phase's own progress lines (e.g. "Scatter
 *     frequency N" vs "Step N"). `multiplier` and `best` are always `null`. Deliberately NOT
 *     fired for the common case (a normal reflection, or a slope found on the first probe) - this is for
 *     explaining an otherwise silent, unusually long gap between two ordinary progress lines,
 *     not a per-measurement log. If the gap is long enough, a 'busy' event fires again -
 *     `verticesEvaluated`/`probeAttempt` set on that second and later calls - but throttled to
 *     at most once every `busyReportIntervalMs`, so a shrink/widen that resolves quickly still
 *     only ever fires once.
 * @param {number} [options.busyReportIntervalMs=300] - Minimum real time between successive
 *   'busy' progress updates within the same shrink/widen-probe - see above. Passed straight
 *   through to `gradientDescent1D`/`nelderMead`.
 * @returns {Promise<{ reelFrequencyTables: Object[], rtp: number, triggerRatePct: number, diagnostics: Object }>}
 */
export async function tuneFrequencies(paytable, reelFrequencyTables, options = {}) {
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('tuneFrequencies requires a paytable');
  }
  // Checked before destructuring options below - `reelsCount`'s default reads
  // `reelFrequencyTables.length`, which would throw an unrelated TypeError first if this
  // isn't actually an array.
  if (!Array.isArray(reelFrequencyTables) || reelFrequencyTables.length === 0) {
    throw new Error('tuneFrequencies requires a non-empty array of reelFrequencyTables');
  }

  const {
    reelsCount = reelFrequencyTables.length,
    rowsCount = 3,
    reelLength = 220,
    reelSeeds = [1234, 567, 89, 765, 3321],
    betPerLine = 1,
    linesCount = 10,
    paylines,
    winEvaluator,
    wildSymbol = null,
    scatterSymbol = null,
    targetRtp = 96,
    rtpTolerancePct = 1.5,
    targetTriggerRatePct = 0.6,
    triggerRateTolerancePct = 0.15,
    trialSpins = 800000,
    trialsPerPoint = 3,
    maxIterations = 150,
    orderingPenaltyWeight = 0.5,
    limitPenaltyWeight = 0.5,
    uniformityPenaltyWeight = 0,
    orderingBiasByReel = null,
    initialStepSize = 0.5,
    searchSeed = 12345,
    stallWindowIterations = 15,
    stallWidenFactor = 1.5,
    maxStallRestarts = 4,
    earlyAcceptErrorPct = 0.01,
    freeSpinsCount,
    freeSpinsAwardTable,
    retriggerFreeSpinsAwardTable,
    hasExpandingWild,
    mechanic = LineMechanic,
    freeSpinsMode,
    payoutOf = mechanic.defaultPayoutOf,
    initialWeightStrategy = 'provided',
    busyReportIntervalMs = 300,
    onProgress = null,
  } = options;

  const orderingBiasFor = (r) => (orderingBiasByReel && orderingBiasByReel[r] != null) ? orderingBiasByReel[r] : -1;

  const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

  if (reelFrequencyTables.length !== reelsCount) {
    throw new Error(`tuneFrequencies requires reelFrequencyTables to be an array of length reelsCount (${reelsCount})`);
  }

  const baseReelTables = reelFrequencyTables.map(rt => JSON.parse(JSON.stringify(rt)));
  const triggerSymbols = Object.keys(paytable).filter(s => paytable[s].triggerFreeSpins === true);

  function buildReelStrips(reelTables) {
    // paytable (this function's outer `paytable` param, the real canonical rules table) is
    // passed as the 6th arg so generateReel's scatter min-gap spacing works correctly even
    // though these per-reel tables carry only `.frequency`, never `.type`. Seeded identically
    // to how every game.js itself builds its production REEL_STRIPS (generateReel(rt,
    // reelLength, reelSeeds[i], ...), no extra offset) - a mismatched seed here would tune
    // against a reel arrangement that's never actually the one built and shipped, which
    // previously made a candidate's measured RTP a (small but real) misprediction of what
    // pasting the same frequencies back into game.js would actually produce.
    return reelTables.map((rt, i) => generateReel(rt, reelLength, reelSeeds[i % reelSeeds.length], [], 3, paytable));
  }

  // rngSeed is optional - omitted, this falls back to unseeded Math.random per trial (via
  // simulateSpins' own default). When provided, each trialsPerPoint repeat gets its own
  // derived seed, but that derived seed is identical across different candidate measurements
  // for the same trial index and rngSeed - the common-random-numbers property gradientDescent1D's
  // finite difference relies on.
  function measure(reelTables, rngSeed) {
    const reelStrips = buildReelStrips(reelTables);
    const config = {
      reelsCount, rowsCount, paytable, reelStrips, paylines, winEvaluator, wildSymbol, scatterSymbol,
      freeSpinsCount, freeSpinsAwardTable, retriggerFreeSpinsAwardTable, hasExpandingWild,
      mechanic, freeSpinsMode,
    };
    let rtpSum = 0, triggerSum = 0;
    for (let i = 0; i < trialsPerPoint; i++) {
      const rng = rngSeed != null ? createSeededRng(rngSeed + i * 104729) : Math.random;
      const results = simulateSpins(config, trialSpins, betPerLine, linesCount, rng);
      rtpSum += results.rtpRaw * 100;
      triggerSum += (results.freeSpinsTriggered / results.baseSpins) * 100;
    }
    return { rtp: rtpSum / trialsPerPoint, triggerRate: triggerSum / trialsPerPoint };
  }

  // ---- Early preview: report Phase 2's chosen starting point immediately, before Phase 1 runs ----
  // Without this, initialWeightStrategy's effect stayed invisible in a live caller (e.g. the
  // TUNE FREQUENCIES panel) until well after Phase 1's scatter-frequency rounds finished AND
  // Phase 2's own first Nelder-Mead iteration completed - and even then, that first reported
  // vertex can be one of the simplex's *perturbed* corners rather than the literal sampled
  // starting point (nelderMead sorts its initial n+1 vertices by loss before its own first
  // onProgress call, so whichever corner happens to score lowest is reported, not necessarily
  // vertex 0). This block independently recomputes just the starting shape - using the exact
  // same seed formula and dims iteration order as Phase 2's own setup further below, so the
  // sampled values agree exactly - purely to report it early; it doesn't feed into or replace
  // Phase 2's own computation, so there's no risk of the two ever disagreeing about what the
  // real search actually starts from.
  if (onProgress) {
    const previewRng = createSeededRng(searchSeed + 424242);
    const previewSampleUniform = (min, max) => min + previewRng() * (max - min);
    const previewSampleNormal = (min, max) => {
      const mean = (min + max) / 2, std = (max - min) / 4;
      const u1 = Math.max(previewRng(), Number.EPSILON), u2 = previewRng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.min(max, Math.max(min, mean + z * std));
    };
    const previewTrial = baseReelTables.map(rt => JSON.parse(JSON.stringify(rt)));
    baseReelTables.forEach((reelTable, r) => {
      const symbolsTable = reelTable.symbols;
      const nonScatterSymbols = Object.keys(symbolsTable).filter(s => !triggerSymbols.includes(s) && symbolsTable[s].frequency > 0);
      const valueSymbols = nonScatterSymbols.filter(s => symbolsTable[s].fixed !== true);
      if (valueSymbols.length === 0) return;
      const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
      const fixedShapeTotal = nonScatterSymbols.filter(s => symbolsTable[s].fixed === true)
        .reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
      const valueBudget = nonScatterTotal - fixedShapeTotal;
      if (valueBudget <= 0) return;
      const raw = {};
      valueSymbols.forEach(s => {
        const bounds = resolveFrequencyBounds(reelTable, s);
        const provided = symbolsTable[s].frequency;
        if (initialWeightStrategy === 'provided' || bounds.minFrequency == null || bounds.maxFrequency == null) {
          raw[s] = provided;
        } else {
          const sampled = initialWeightStrategy === 'normal'
            ? previewSampleNormal(bounds.minFrequency, bounds.maxFrequency)
            : previewSampleUniform(bounds.minFrequency, bounds.maxFrequency);
          raw[s] = Math.max(sampled, Number.MIN_VALUE);
        }
      });
      const renormalized = renormalizeWeights(raw, valueBudget);
      Object.keys(renormalized).forEach(s => { previewTrial[r].symbols[s].frequency = renormalized[s]; });
    });
    await onProgress('initial', 0, null, { trial: previewTrial }, null);
  }

  // ---- Phase 1: scale trigger symbol(s) to hit the target trigger rate ----
  // One shared multiplier applied identically to every reel's table - a symbol with
  // frequency 0 on a given reel stays 0 (0 * mult = 0), so this is safe even for reels
  // that don't carry the trigger symbol at all.
  //
  // This is the ONLY place a triggerFreeSpins symbol's frequency can change - Phase 2 (below)
  // explicitly excludes trigger symbols from its dimensions entirely (they're filtered out
  // of nonScatterSymbols before valueSymbols/fixedShapeSymbols are even computed), so a
  // trigger symbol untouched here stays untouched for the rest of the run.
  //
  // It's expected - not a bug - for this phase to converge with mult staying at its
  // gradientDescent1D starting value of 1 (i.e. the trigger symbol's frequency doesn't
  // change at all): the search starts there and stops as soon as the measured trigger rate
  // is within `triggerRateTolerancePct` of `targetTriggerRatePct`, so if the *baseline*
  // frequency already lands inside that band, there's simply nothing to correct. Confirmed
  // for games/bookbookbook/game.js's real data: baseline trigger rate ~0.57% already sits
  // inside the default 0.6% +/- 0.15 target band, so `diagnostics.scatterPhase.multiplier`
  // comes back exactly 1 and `book`'s frequency is unchanged on every reel.
  let currentReelTables = baseReelTables;
  let scatterPhase = null;
  if (triggerSymbols.length > 0) {
    scatterPhase = await gradientDescent1D({
      initialParam: 1,
      minParam: 0.05,
      maxParam: 8,
      target: targetTriggerRatePct,
      tolerance: triggerRateTolerancePct,
      buildTrial: (mult) => baseReelTables.map(rt => {
        const trial = JSON.parse(JSON.stringify(rt));
        triggerSymbols.forEach(s => { if (trial.symbols[s]) trial.symbols[s].frequency = rt.symbols[s].frequency * mult; });
        return trial;
      }),
      metricOf: (result) => result.triggerRate,
      measure,
      maxIterations,
      seedBase: searchSeed,
      onProgress: onProgress ? (i, mult, result, best) => onProgress('scatter', i, mult, result, best) : null,
      onBusy: onProgress ? (info) => onProgress('busy', info.iteration, null, { ...info, sourcePhase: 'scatter' }, null) : null,
      busyReportIntervalMs,
      yieldToEventLoop,
    });
    currentReelTables = scatterPhase.trial;
  }

  // ---- Phase 2: joint multi-dimensional tuning of every reel's value-symbol weights ----
  // One free weight per (value symbol, reel) pair, searched jointly via Nelder-Mead -
  // replacing the old per-reel scalar-tilt coordinate descent, which could not
  // simultaneously fix an ordering violation and hit the RTP target when the two required
  // different corrections (see the design doc for the concrete case that proved this: a
  // single scalar can't move one symbol without dragging every other symbol on that reel
  // along with it). "Higher payout should not be more frequent" is now a soft penalty term
  // in the loss (below), not a hard post-hoc floor - the optimizer can accept a small
  // remaining violation rather than force RTP far off target, and any violation still
  // present at the end is reported in diagnostics rather than silently corrected.
  const dims = []; // [{ reelIndex, symbol }] - one entry per free parameter
  const fixedSymbols = []; // [{ reel, symbol }] - excluded from the search entirely (fixed: true)
  const valueBudgetByReel = [];
  const tierOfByReel = [];
  const equalShareByReel = []; // valueBudgetByReel[r] / (tunable symbol count on reel r)
  const isFixed = (symbolsTable, s) => symbolsTable[s].fixed === true;
  currentReelTables.forEach((reelTable, r) => {
    const symbolsTable = reelTable.symbols;
    const nonScatterSymbols = Object.keys(symbolsTable).filter(s => !triggerSymbols.includes(s) && symbolsTable[s].frequency > 0);
    const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
    const fixedShapeSymbols = nonScatterSymbols.filter(s => isFixed(symbolsTable, s));
    const valueSymbols = nonScatterSymbols.filter(s => !isFixed(symbolsTable, s));
    const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
    const valueBudget = nonScatterTotal - fixedShapeTotal;
    valueBudgetByReel[r] = valueBudget;
    tierOfByReel[r] = computeValueRanks(paytable, valueSymbols, payoutOf);
    fixedShapeSymbols.forEach(s => fixedSymbols.push({ reel: r, symbol: s }));
    if (valueSymbols.length > 0 && valueBudget > 0) {
      equalShareByReel[r] = valueBudget / valueSymbols.length;
      valueSymbols.forEach(s => {
        const bounds = resolveFrequencyBounds(reelTable, s);
        dims.push({ reelIndex: r, symbol: s, min: bounds.minFrequency, max: bounds.maxFrequency });
      });
    }
  });

  // uniformityPenaltyOf's own per-symbol targets - excluded from any symbol whose paytable
  // `type` is 'scatter' - even one that doesn't happen to trigger free spins (the only thing
  // that otherwise excludes a symbol from `dims` above). A scatter's ideal frequency plays a
  // fundamentally different role (rare, spread out) than the "value" symbols this penalty
  // compares, so it should neither be pulled toward a target nor count toward computing one.
  // Ordering/limit penalties are untouched by this - a scatter still participates in those, and
  // in the search itself (`dims`), same as before.
  //
  // The target ISN'T flat ("every symbol should equal the reel's equal share") - it's a
  // straight line across tier rank, tilted the same direction and strength as that reel's own
  // ordering preference (orderingBiasFor(r), already direction * Strength from the tune panel's
  // per-reel dropdown/input). uniformityPenaltyWeight controls how hard the search is pushed
  // toward this line; the bias controls the line's slope - two independent knobs, not one
  // fighting the other the way a flat target vs. a genuine ordering preference otherwise would.
  // bias === 0 (no ordering preference for that reel) collapses the line back to flat/equal,
  // exactly the old behavior - `centered` term drops out entirely below.
  const uniformityDimsByReel = Array.from({ length: reelsCount }, () => []);
  dims.forEach(d => {
    if (paytable[d.symbol]?.type !== 'scatter') uniformityDimsByReel[d.reelIndex].push(d);
  });
  const uniformityTargetsByReel = uniformityDimsByReel.map((reelDims, r) => {
    if (reelDims.length === 0) return null;
    const budget = reelDims.reduce((sum, d) => sum + currentReelTables[r].symbols[d.symbol].frequency, 0);
    const equalShare = budget / reelDims.length;
    const bias = orderingBiasFor(r);
    const ranks = reelDims.map(d => tierOfByReel[r][d.symbol]);
    const meanRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    // How far tier ranks spread from their own mean, on this reel - normalizes `centered` to
    // roughly [-1, 1] regardless of how many tiers/symbols this specific reel has, so the same
    // bias magnitude tilts every reel comparably.
    const maxSpread = Math.max(...ranks.map(t => Math.abs(t - meanRank))) || 1;
    const targets = {};
    reelDims.forEach(d => {
      // Sign matches orderingPenaltyOf's own convention exactly (see its doc): bias < 0
      // ("high pay rarer") wants frequency to INCREASE with tier rank (worse-paying symbols
      // more frequent); bias > 0 ("high pay more frequent") wants it to DECREASE.
      const centered = (tierOfByReel[r][d.symbol] - meanRank) / maxSpread;
      targets[d.symbol] = equalShare * (1 - bias * centered);
    });
    return targets;
  });

  let rtpPhaseResult = null;

  if (dims.length > 0) {
    // Dedicated RNG for initialWeightStrategy sampling, seeded off searchSeed like every other
    // random part of this search - so which random starting point gets used (when the
    // strategy isn't 'provided') stays a pure function of searchSeed, not of call order or
    // wall-clock time.
    const initialWeightRng = createSeededRng(searchSeed + 424242);
    function sampleUniformFrequency(min, max) {
      return min + initialWeightRng() * (max - min);
    }
    // Box-Muller transform, centered at the min/max midpoint with std = a quarter of the
    // range (so [min, max] covers roughly the middle 95%) - clamped back into [min, max] as a
    // backstop against the rare sample landing outside that range in either tail.
    function sampleNormalFrequency(min, max) {
      const mean = (min + max) / 2;
      const std = (max - min) / 4;
      const u1 = Math.max(initialWeightRng(), Number.EPSILON); // avoid log(0)
      const u2 = initialWeightRng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.min(max, Math.max(min, mean + z * std));
    }
    // A dimension only has a defined [min, max] to sample from once both bounds are
    // configured (via resolveFrequencyBounds - symbol override or reel default) - one missing
    // either bound, or the strategy being 'provided', always starts at its baseline frequency.
    const initialPoint = dims.map(d => {
      const provided = currentReelTables[d.reelIndex].symbols[d.symbol].frequency;
      if (initialWeightStrategy === 'provided' || d.min == null || d.max == null) {
        return Math.log(provided);
      }
      const sampled = initialWeightStrategy === 'normal'
        ? sampleNormalFrequency(d.min, d.max)
        : sampleUniformFrequency(d.min, d.max);
      return Math.log(Math.max(sampled, Number.MIN_VALUE));
    });
    // Generous per-dimension bounds (relative to that dimension's own starting frequency,
    // not a shared absolute range) - wide enough to not artificially constrain the search,
    // just enough to keep the simplex from drifting to a degenerate near-zero or runaway
    // value on a reel whose other symbols have a very different scale.
    const dimBounds = dims.map(d => {
      const base = currentReelTables[d.reelIndex].symbols[d.symbol].frequency;
      return { minX: Math.log(base * 0.001), maxX: Math.log(base * 1000) };
    });

    // Turns a raw parameter vector into a full N-reel array: clamp each dimension to its
    // bounds, exponentiate out of log-space, then renormalize each reel's value-symbol
    // weights back to that reel's fixed budget - every other reel/symbol not in `dims`
    // (scatter, wild-excluded, or baseline-zero) is carried through from currentReelTables
    // untouched.
    function projectPoint(x) {
      const reelTables = currentReelTables.map(rt => JSON.parse(JSON.stringify(rt)));
      const rawByReel = {};
      dims.forEach((d, i) => {
        const xi = Math.min(dimBounds[i].maxX, Math.max(dimBounds[i].minX, x[i]));
        (rawByReel[d.reelIndex] ??= {})[d.symbol] = Math.exp(xi);
      });
      Object.keys(rawByReel).forEach(rIdxStr => {
        const rIdx = Number(rIdxStr);
        const renormalized = renormalizeWeights(rawByReel[rIdx], valueBudgetByReel[rIdx]);
        Object.keys(renormalized).forEach(s => { reelTables[rIdx].symbols[s].frequency = renormalized[s]; });
      });
      return reelTables;
    }

    // Soft ordering penalty: sums, per reel, how much that reel's own preferred direction is
    // violated for each pair of value symbols present. Direction/strength is per-reel via
    // orderingBiasFor(r): bias -1 (default) penalizes a higher-paying symbol (a) being more
    // frequent than a lower-paying one (b) on the same reel; bias +1 reverses that (penalizes
    // a being *less* frequent than b instead - e.g. for a "near-miss" reel design where
    // premium symbols should show up often but rarely align); bias 0 disables the preference
    // for that reel. diff = bias * (freq(b) - freq(a)) unifies both directions: it's positive
    // exactly when that reel's own preference is violated, by construction, for either sign
    // of bias.
    function orderingPenaltyOf(reelTables) {
      let total = 0;
      const violations = [];
      dims.forEach(({ reelIndex: r, symbol: a }) => {
        const bias = orderingBiasFor(r);
        if (bias === 0) return;
        const tierOf = tierOfByReel[r];
        dims.forEach(({ reelIndex: r2, symbol: b }) => {
          if (r !== r2 || a === b || tierOf[a] >= tierOf[b]) return;
          const diff = bias * (reelTables[r].symbols[b].frequency - reelTables[r].symbols[a].frequency);
          if (diff > 0) {
            total += diff;
            violations.push({ reel: r, higherPaySymbol: a, lowerPaySymbol: b, amount: diff, bias });
          }
        });
      });
      return { total, violations };
    }

    // Soft per-symbol frequency limits: each dim optionally carries its own `min`/`max`
    // (from that symbol's entry in its reel's frequency table - see reelFrequencyTables'
    // doc above). Violating either costs `limitPenaltyWeight` times how far outside the
    // bound the symbol's *projected* (post-renormalization) frequency actually landed - a
    // preference, like ordering, not a hard clamp: the search can still cross a limit if
    // hitting the RTP target genuinely requires it, and any crossing is reported rather than
    // silently prevented.
    function limitPenaltyOf(reelTables) {
      let total = 0;
      const violations = [];
      dims.forEach(({ reelIndex: r, symbol: s, min, max }) => {
        const freq = reelTables[r].symbols[s].frequency;
        if (min != null && freq < min) {
          const amount = min - freq;
          total += amount;
          violations.push({ reel: r, symbol: s, bound: 'min', limit: min, amount });
        }
        if (max != null && freq > max) {
          const amount = freq - max;
          total += amount;
          violations.push({ reel: r, symbol: s, bound: 'max', limit: max, amount });
        }
      });
      return { total, violations };
    }

    // Soft uniformity penalty: discourages any one tunable symbol's frequency on a reel from
    // sitting drastically far from that reel's "equal share" (valueBudget split evenly across
    // every tunable symbol on that reel) - e.g. one symbol at 1.45 while its reel-mates sit at
    // 0.02-0.065. Deliberately measured as a *relative* deviation (how many multiples of
    // equalShare a symbol's frequency is off by), not an absolute one, so it means the same
    // thing on a reel whose budget is spread thin across many symbols as on one with few -
    // and left unbounded above (no cap on how "high" a symbol can be penalized) so a single
    // runaway outlier costs proportionally more than a handful of comparatively modest ones,
    // matching what actually goes wrong in practice. This is independent of - and can pull in
    // a different direction than - orderingPenaltyOf: ordering only cares that higher-paying
    // symbols land on the correct side of lower-paying ones, not by how much, so a reel can be
    // perfectly ordered and still have one symbol drastically more/less frequent than the rest.
    function uniformityPenaltyOf(reelTables) {
      let total = 0;
      dims.forEach(({ reelIndex: r, symbol: s }) => {
        if (paytable[s]?.type === 'scatter') return;
        const target = uniformityTargetsByReel[r]?.[s];
        if (!(target > 0)) return;
        const freq = reelTables[r].symbols[s].frequency;
        total += Math.abs(freq - target) / target;
      });
      return total;
    }

    // Base seed for Phase 2's common-random-numbers comparability - every point evaluated
    // within one round needs to stay directly comparable. A stalled restart shifts this by a
    // large offset per restart (see the round loop below) so it explores under genuinely
    // different Monte Carlo noise, not just a wider step at the same noisy seed - the whole
    // sequence is still a pure function of `searchSeed`, so tuneFrequencies stays
    // deterministic end-to-end (verified by a dedicated regression test).
    const baseNmSeed = searchSeed + 700000;

    let rtpMin = Infinity, rtpMax = -Infinity;

    function makeEvaluate(nmSeed) {
      return function evaluate(x) {
        const reelTables = projectPoint(x);
        const measured = measure(reelTables, nmSeed);
        const { total: orderPenalty, violations: orderingViolations } = orderingPenaltyOf(reelTables);
        const { total: boundsPenalty, violations: limitViolations } = limitPenaltyOf(reelTables);
        const uniformityPenalty = uniformityPenaltyOf(reelTables);
        const error = Math.abs(measured.rtp - targetRtp);
        if (measured.rtp < rtpMin) rtpMin = measured.rtp;
        if (measured.rtp > rtpMax) rtpMax = measured.rtp;
        return {
          loss: error + orderingPenaltyWeight * orderPenalty + limitPenaltyWeight * boundsPenalty + uniformityPenaltyWeight * uniformityPenalty,
          rtp: measured.rtp,
          triggerRate: measured.triggerRate,
          error,
          orderingPenalty: orderPenalty,
          limitPenalty: boundsPenalty,
          uniformityPenalty,
          orderingViolations,
          limitViolations,
          trial: reelTables,
        };
      };
    }

    // A value only counts as "improved" if it beat its own best-so-far by more than 2%
    // relative - a small, fixed threshold isn't used since RTP error, ordering-penalty
    // totals, and limit-penalty totals live on completely different scales across games.
    function improved(newValue, prevBest) {
      if (prevBest <= 0) return false; // already at zero - nothing left to improve
      return (prevBest - newValue) > prevBest * 0.02;
    }

    // Phase 2 runs nelderMead() in rounds of `stallWindowIterations` iterations rather than
    // one long call. A round that improves none of RTP error, the ordering-violation total,
    // or the limit-violation total (each tracked against its own best-so-far, not blended
    // into one number - this is what lets "RTP is stuck but ordering is still improving" keep
    // the search going instead of restarting) is a stall: the next round restarts from the
    // best point found so far, with a wider step and a shifted seed, rather than continuing
    // to grind at the same spot. After `maxStallRestarts` consecutive stalls, the search gives
    // up early rather than spending the rest of `maxIterations` on a dead end - see the design
    // doc for the barfruits case (a genuinely infeasible target that used to run the full
    // budget with no way to notice or explain that) that motivated this.
    let point = initialPoint;
    let stepSize = initialStepSize;
    let restarts = 0;
    let iterationsUsed = 0;
    let best = null; // best-ever vertex across all rounds, by RTP error
    let bestOrderingPenalty = Infinity;
    let bestLimitPenalty = Infinity;
    let bestUniformityPenalty = Infinity;
    let stallStreak = 0;
    let stalledOut = false;
    let stillImproving = { rtp: true, ordering: true, limits: true, uniformity: true };

    do {
      const roundIterations = Math.min(stallWindowIterations, maxIterations - iterationsUsed);
      const nmSeed = baseNmSeed + restarts * 1300021;
      const roundStartIterations = iterationsUsed;
      const nm = await nelderMead({
        initialPoint: point,
        initialStepSize: stepSize,
        evaluate: makeEvaluate(nmSeed),
        maxIterations: roundIterations,
        onProgress: onProgress
          ? (i, pt, result, roundBest) => onProgress('shape', roundStartIterations + i, null, result, roundBest)
          : null,
        onBusy: onProgress
          ? (info) => onProgress('busy', roundStartIterations + info.iteration, null, { ...info, sourcePhase: 'shape' }, null)
          : null,
        busyReportIntervalMs,
        yieldToEventLoop,
      });
      iterationsUsed += nm.iterations;

      const prevBestError = best ? best.error : Infinity;
      const prevBestOrdering = bestOrderingPenalty;
      const prevBestLimit = bestLimitPenalty;
      const prevBestUniformity = bestUniformityPenalty;

      if (!best || nm.result.loss < best.loss) best = nm.result;
      if (nm.result.orderingPenalty < bestOrderingPenalty) bestOrderingPenalty = nm.result.orderingPenalty;
      if (nm.result.limitPenalty < bestLimitPenalty) bestLimitPenalty = nm.result.limitPenalty;
      if (nm.result.uniformityPenalty < bestUniformityPenalty) bestUniformityPenalty = nm.result.uniformityPenalty;

      stillImproving = {
        rtp: improved(best.error, prevBestError),
        ordering: improved(bestOrderingPenalty, prevBestOrdering),
        limits: improved(bestLimitPenalty, prevBestLimit),
        uniformity: improved(bestUniformityPenalty, prevBestUniformity),
      };

      const fullyResolved = best.error <= earlyAcceptErrorPct && bestOrderingPenalty <= 0 && bestLimitPenalty <= 0;
      if (fullyResolved) break;

      if (stillImproving.rtp || stillImproving.ordering || stillImproving.limits || stillImproving.uniformity) {
        stallStreak = 0;
        point = nm.point;
      } else {
        stallStreak++;
        restarts++;
        point = best.point;
        stepSize *= stallWidenFactor;
        // A distinct progress event (not folded into the per-iteration 'shape' one above) so a
        // caller can announce the restart explicitly - otherwise a stall is invisible in a live
        // view: the per-iteration log line looks the same whether or not a restart just fired,
        // even though the search jumped back to `best.point` with a wider step underneath it.
        if (onProgress) {
          await onProgress('restart', iterationsUsed, null,
            { stepSize, restarts, stallStreak, maxStallRestarts, willStopNow: stallStreak >= maxStallRestarts }, best);
        }
        if (stallStreak >= maxStallRestarts) {
          stalledOut = true;
          break;
        }
      }
    } while (iterationsUsed < maxIterations);

    currentReelTables = best.trial;
    const reason = (() => {
      const rtpOk = best.error <= rtpTolerancePct;
      const violationsOk = bestOrderingPenalty <= 0 && bestLimitPenalty <= 0;
      if (rtpOk && violationsOk) return 'converged';
      if (rtpOk) return 'converged-with-violations';
      if (stalledOut) return 'stalled';
      return 'exhausted';
    })();

    rtpPhaseResult = {
      ...best,
      iterations: iterationsUsed,
      restarts,
      reason,
      rtpRange: { min: rtpMin, max: rtpMax },
      orderingPenaltyRemaining: bestOrderingPenalty,
      limitPenaltyRemaining: bestLimitPenalty,
      uniformityPenaltyRemaining: bestUniformityPenalty,
      stillImproving,
      fixedSymbols,
    };
  }

  const finalReelTables = currentReelTables;
  const finalResult = rtpPhaseResult
    ? { rtp: rtpPhaseResult.rtp, triggerRate: rtpPhaseResult.triggerRate }
    : measure(finalReelTables);

  return {
    reelFrequencyTables: finalReelTables,
    rtp: finalResult.rtp,
    triggerRatePct: finalResult.triggerRate,
    diagnostics: {
      scatterPhase: scatterPhase ? { multiplier: scatterPhase.mult, error: scatterPhase.error, converged: !!scatterPhase.converged, ...scatterPhase.result } : null,
      rtpPhase: rtpPhaseResult ? {
        error: rtpPhaseResult.error,
        converged: rtpPhaseResult.error <= rtpTolerancePct,
        reason: rtpPhaseResult.reason,
        rtp: rtpPhaseResult.rtp,
        triggerRate: rtpPhaseResult.triggerRate,
        iterationsRun: rtpPhaseResult.iterations,
        iterationsBudget: maxIterations,
        restarts: rtpPhaseResult.restarts,
        rtpRange: rtpPhaseResult.rtpRange,
        orderingViolations: rtpPhaseResult.orderingViolations,
        orderingPenaltyRemaining: rtpPhaseResult.orderingPenaltyRemaining,
        limitViolations: rtpPhaseResult.limitViolations,
        limitPenaltyRemaining: rtpPhaseResult.limitPenaltyRemaining,
        uniformityPenaltyRemaining: rtpPhaseResult.uniformityPenaltyRemaining,
        stillImproving: rtpPhaseResult.stillImproving,
        fixedSymbols: rtpPhaseResult.fixedSymbols,
      } : null,
    }
  };
}
