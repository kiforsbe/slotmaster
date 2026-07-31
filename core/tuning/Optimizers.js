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
 * @param {(trial: Object, rngSeed: number) => (Object|Promise<Object>)} args.measure - Measures a
 *   trial (seeded, for CRN). May return a plain object or a Promise - always awaited, so a
 *   caller whose measurements run on a Worker pool (real parallelism) and one whose measurements
 *   run in-process (today's default) both work unchanged.
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
 * @param {AbortSignal} [args.signal] - Checked once per iteration, after that iteration's own
 *   measurement (so `best` is always already set) and before the potentially-expensive
 *   widen-probe section - cooperative cancellation stops there rather than throwing.
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
  signal = null,
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
    const result = await measure(trial, stepSeed);
    const metric = metricOf(result);
    const error = Math.abs(metric - target);
    const resultWithError = { ...result, error };
    if (!best || error < best.error) best = { mult: param, error, result, trial };
    if (onProgress) await onProgress(i, param, resultWithError, best);
    await yieldToEventLoop();
    if (error <= tolerance || i === maxIterations - 1) break;
    // Checked after `best` is already guaranteed set from this iteration's own measurement (so
    // stopping here never leaves the caller without a usable result) and before the potentially
    // expensive widen-probe section below - a user-requested stop shouldn't spend several more
    // measurements searching for a slope it's about to discard anyway.
    if (signal?.aborted) break;

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
        const probeResult = await measure(buildTrial(Math.exp(xProbe)), stepSeed);
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
 * Monotone 1-D bisection root-finder: finds the `param` whose measured metric lands within
 * `tolerance` of `target`, assuming the metric is monotone NON-DECREASING in `param`.
 *
 * This exists because gradientDescent1D is the wrong algorithm class for Phase 1's actual
 * objective. Trigger rate is not a smooth function of the scatter-frequency multiplier - it's
 * a coarse STEP function, because generateReel() converts each symbol's share into a whole
 * number of strip positions (`Math.max(1, Math.round(share * targetLength))`, see
 * core/SlotMath.js). Every multiplier inside one rounding bucket produces a byte-identical reel
 * strip and therefore an *exactly* identical measurement. Measured on games/bookbookbook at its
 * real REEL_LENGTH of 500, the multiplier range 0.70..1.36 contains only 13 distinct reachable
 * trigger rates, on plateaus 5-10% wide in multiplier.
 *
 * That breaks slope-based search in three compounding ways: (1) the finite-difference probe
 * (epsilon 0.05 log units = 5.1%) is usually NARROWER than a plateau, so the measured slope is
 * exactly zero and the widen-probe fallback burns up to 8 extra measurements hunting for one;
 * (2) when widening finally crosses a step edge, the "slope" is a secant across a
 * discontinuity, and the resulting Newton step (capped at 4x the probe distance, i.e. up to
 * ~49% in multiplier) overshoots the target window by several whole plateaus - the search
 * visibly flings between extremes on either side of the target; (3) `trust` decays every
 * iteration including the wasted plateau ones, so the step budget is exhausted before the
 * search settles anywhere.
 *
 * Bisection has none of those failure modes: it never estimates a slope, so a plateau is not a
 * special case and cannot stall it; it can never overshoot, since the answer stays bracketed by
 * construction; and it converges in ~log2(range/precision) iterations at ONE measurement each,
 * against gradientDescent1D's up-to-nine.
 *
 * Bisection also makes the genuinely-unreachable case detectable rather than silent. Because
 * the reachable metric values form a coarse lattice, a target can fall in the GAP between two
 * adjacent achievable values, in which case no multiplier satisfies `tolerance` and no search
 * of any kind can succeed. `reason: 'lattice-gap'` reports exactly that (with the closest
 * achievable value either side in `bracket`), instead of burning the whole iteration budget and
 * reporting a bare "did not converge" that reads like a tuning failure. The fix for that case
 * is a longer reel strip (a finer lattice) or a wider tolerance - not more search.
 *
 * Uses ONE fixed measurement seed for every evaluation, deliberately: the strips themselves are
 * already deterministic (generateReel is seeded per reel from `reelSeeds`, not from the
 * measurement seed), so holding the measurement seed fixed makes the whole objective a
 * deterministic monotone step function. That is what keeps the bracket invariant sound - a
 * per-iteration seed would let Monte Carlo noise flip a comparison and discard the half of the
 * range actually containing the answer, which bisection cannot recover from.
 *
 * @param {Object} args
 * @param {number} args.initialParam - Starting parameter (> 0). Measured FIRST, so a baseline
 *   already within tolerance costs exactly one measurement and returns unchanged - preserving
 *   the "trigger symbol's frequency doesn't need to change at all" fast path.
 * @param {number} args.minParam - Lower clamp (> 0).
 * @param {number} args.maxParam - Upper clamp (>= minParam).
 * @param {number} args.target - Target value for the metric.
 * @param {number} args.tolerance - Success means |metric - target| <= this.
 * @param {(param: number) => Object} args.buildTrial - Builds a trial from a parameter value.
 * @param {(measureResult: Object) => number} args.metricOf - Extracts the scalar metric.
 * @param {(trial: Object, rngSeed: number) => (Object|Promise<Object>)} args.measure
 * @param {number} args.maxIterations - Hard cap on total measurements.
 * @param {number} args.seedBase - The single measurement seed used for every evaluation.
 * @param {number} [args.latticeTolerance=0.002] - Bracket width in log-space below which the
 *   reachable lattice is considered exhausted (0.002 log units = 0.2% in param, far finer than
 *   any real rounding plateau). Reaching it means the target sits in a gap between two
 *   achievable values.
 * @param {(i: number, param: number, result: Object & {error: number}, best: Object) => (void|Promise<void>)} [args.onProgress]
 * @param {(info: { iteration: number, operation: 'bracket', endpoint: 'min'|'max' }) => (void|Promise<void>)} [args.onBusy] -
 *   Fired before each of the up-to-two range-endpoint measurements taken to establish the
 *   initial bracket - the only step here that isn't a plain halving, and the one a caller would
 *   otherwise see as an unexplained pause.
 * @param {() => Promise<void>} args.yieldToEventLoop
 * @param {AbortSignal} [args.signal] - Checked between measurements, after `best` is set.
 * @returns {Promise<{ mult: number, error: number, result: Object, trial: Object, converged: boolean, reason: string, bracket: Object }>} -
 *   `reason` is one of 'converged' | 'unreachable-low' (even `maxParam` measures below the
 *   target band) | 'unreachable-high' (even `minParam` measures above it) | 'lattice-gap' |
 *   'exhausted' | 'stopped'. `converged` is true iff `reason === 'converged'`.
 */
export async function bisect1D({
  initialParam, minParam, maxParam, target, tolerance,
  buildTrial, metricOf, measure, maxIterations, seedBase,
  latticeTolerance = 0.002,
  onProgress, onBusy, yieldToEventLoop,
  signal = null,
}) {
  const minX = Math.log(minParam);
  const maxX = Math.log(maxParam);
  const clampX = (x) => Math.min(maxX, Math.max(minX, x));

  let best = null;
  let evaluations = 0;

  async function evalAt(x) {
    const param = Math.exp(x);
    const trial = buildTrial(param);
    const result = await measure(trial, seedBase);
    const metric = metricOf(result);
    const error = Math.abs(metric - target);
    if (!best || error < best.error) best = { mult: param, error, result, trial, metric };
    if (onProgress) await onProgress(evaluations, param, { ...result, error }, best);
    evaluations++;
    await yieldToEventLoop();
    return metric;
  }

  let bracketInfo = null;
  const finish = (reason) => ({
    ...best,
    converged: reason === 'converged',
    reason,
    bracket: bracketInfo,
  });

  // The starting point is measured before anything else, so the common "baseline already sits
  // inside the target band" case costs exactly one measurement and leaves the parameter alone.
  const startX = clampX(Math.log(initialParam));
  const startMetric = await evalAt(startX);
  if (best.error <= tolerance) return finish('converged');
  if (signal?.aborted) return finish('stopped');

  // Establish a bracket by measuring whichever range endpoint lies on the far side of the
  // target from the starting point - monotonicity is what makes one endpoint sufficient.
  let loX, hiX, loMetric, hiMetric;
  if (startMetric < target) {
    loX = startX; loMetric = startMetric;
    if (onBusy) await onBusy({ iteration: evaluations, operation: 'bracket', endpoint: 'max' });
    hiX = maxX; hiMetric = await evalAt(maxX);
  } else {
    hiX = startX; hiMetric = startMetric;
    if (onBusy) await onBusy({ iteration: evaluations, operation: 'bracket', endpoint: 'min' });
    loX = minX; loMetric = await evalAt(minX);
  }
  bracketInfo = { loParam: Math.exp(loX), hiParam: Math.exp(hiX), loMetric, hiMetric };

  if (best.error <= tolerance) return finish('converged');
  if (signal?.aborted) return finish('stopped');
  // The whole reachable range sits on one side of the target band - no multiplier can work.
  if (hiMetric < target) return finish('unreachable-low');
  if (loMetric > target) return finish('unreachable-high');

  while (evaluations < maxIterations) {
    if (signal?.aborted) return finish('stopped');
    // The bracket has collapsed to a span far narrower than any rounding plateau, yet neither
    // side is in band: the target genuinely falls between two adjacent achievable values.
    if (hiX - loX < latticeTolerance) return finish('lattice-gap');

    const midX = (loX + hiX) / 2;
    const midMetric = await evalAt(midX);
    if (best.error <= tolerance) return finish('converged');
    if (midMetric < target) { loX = midX; loMetric = midMetric; }
    else { hiX = midX; hiMetric = midMetric; }
    bracketInfo = { loParam: Math.exp(loX), hiParam: Math.exp(hiX), loMetric, hiMetric };
  }
  return finish('exhausted');
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
 * Every vertex evaluation is awaited, so `evaluate` may be sync or async - a plain in-process
 * evaluate() works exactly as before, but one backed by a Worker pool (see
 * core/simulation/SimulationWorkerPool.js) gets genuine parallelism for free: the initial n+1-vertex
 * simplex and every simplex shrink (also n+1 vertices, and the one operation here that
 * re-evaluates the whole simplex at once) are dispatched together via Promise.all rather than
 * one at a time, so a pool-backed evaluate() measures every vertex concurrently instead of
 * queuing them on a single thread. Reflect/expand/contract stay sequential (each depends on
 * the previous result), but still benefit from whatever parallelism `evaluate` itself does
 * internally (e.g. averaging several trials per candidate across the pool).
 *
 * @param {Object} args
 * @param {number[]} args.initialPoint - Starting parameter vector.
 * @param {number} args.initialStepSize - Perturbation used to build the initial simplex
 *   (vertex i = initialPoint with dimension i-1 offset by this amount).
 * @param {(point: number[]) => ({ loss: number, [key: string]: any } | Promise<{ loss: number, [key: string]: any }>)} args.evaluate -
 *   Evaluates one point; must return (or resolve to) at least `{ loss }` (lower is better).
 *   Any extra fields are carried through onto the vertex object returned via onProgress/result.
 * @param {number} args.maxIterations
 * @param {number} [args.convergenceTolerance=1e-4] - Stop early once the spread between the
 *   simplex's best and worst loss is at or below this.
 * @param {(iteration: number, point: number[], result: Object, best: Object, attempted: Object|null) => (void|Promise<void>)} [args.onProgress] -
 *   `result`/`point` are the simplex's own best vertex (`vertices[0]`) *entering* this
 *   iteration - since only the worst vertex is normally replaced, this can be unchanged for
 *   several iterations in a row even though each one genuinely tried something new. `attempted`
 *   is that new thing: the actual vertex this iteration's reflect/expand/contract produced (or
 *   the best of a shrink's whole re-evaluated batch), regardless of whether it improved on
 *   `result`/`best` - `null` only when this iteration had nothing to try (already converged).
 *   Use `attempted` to show "what was just tried" distinct from "the best found so far", so a
 *   run of no-improvement iterations reads as active search rather than a frozen repeat.
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
 * @param {AbortSignal} [args.signal] - Checked once per iteration, before that iteration's own
 *   reflect/expand/contract/shrink work starts (safe even on iteration 0 - `best` is already
 *   valid from the initial simplex) - cooperative cancellation stops there rather than
 *   throwing, returning whatever `best` has been found so far with `iterations` less than
 *   `maxIterations`.
 * @returns {Promise<{ point: number[], loss: number, result: Object, iterations: number, converged: boolean }>} -
 *   `converged` is true iff the search stopped because the simplex's spread collapsed below
 *   `convergenceTolerance`, not because `maxIterations` ran out.
 */
export async function nelderMead({
  initialPoint, initialStepSize, evaluate, maxIterations,
  convergenceTolerance = 1e-4, onProgress, onBusy, yieldToEventLoop,
  busyReportIntervalMs = 300,
  signal = null,
}) {
  const n = initialPoint.length;
  const ALPHA = 1, GAMMA = 2, RHO = 0.5, SIGMA = 0.5;

  // `evaluate` may be sync or async (see its own caller's doc) - always awaited here so both
  // work unchanged. Awaiting a plain (non-Promise) value just resolves it on the next
  // microtask, so this is a no-op behavior change for every existing in-process caller; it's
  // what lets a caller whose `evaluate` dispatches to a Worker pool get genuine concurrency
  // out of the Promise.all batches below (initial simplex, shrink) without this function
  // needing to know or care whether that's happening.
  const evalPoint = async (point) => ({ point, ...(await evaluate(point)) });

  // Initial simplex: vertex 0 = initialPoint, vertex i (1..n) = initialPoint with dimension
  // i-1 perturbed by initialStepSize - the standard right-angled starting simplex. All n+1
  // vertices are independent of each other, so they're dispatched together via Promise.all
  // rather than one at a time - when `evaluate` is backed by a Worker pool, this lets every
  // vertex measure concurrently on its own thread instead of queuing behind the others.
  const initialVertexPoints = [initialPoint.slice()];
  for (let i = 0; i < n; i++) {
    const p = initialPoint.slice();
    p[i] += initialStepSize;
    initialVertexPoints.push(p);
  }
  let vertices = await Promise.all(initialVertexPoints.map(p => evalPoint(p)));

  let best = vertices.reduce((a, b) => (b.loss < a.loss ? b : a));
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    // `best` is already valid from the initial simplex above, so it's safe to stop here before
    // this iteration's own work even starts - unlike cmaes/gradientDescent1D, which only get a
    // usable `best` partway through their own first iteration (see their own signal-check
    // placement for why).
    if (signal?.aborted) break;
    iterations = iter + 1;
    vertices.sort((a, b) => a.loss - b.loss);
    if (vertices[0].loss < best.loss) best = vertices[0];

    // Checked here (before this iteration's own reflect/expand/contract/shrink work), same as
    // before - but the actual `break` is deferred to after onProgress fires below, so a
    // converged iteration still gets exactly one onProgress call reporting `attempted: null`
    // (nothing needed trying) rather than silently skipping it.
    const alreadyConverged = vertices[n].loss - vertices[0].loss <= convergenceTolerance;

    // The vertex this iteration's own work actually produced (reflected/expanded/contracted, or
    // the best of a shrink's batch) - distinct from `vertices[0]`/`best` above, which only ever
    // reflect a *previous* iteration's outcome until the *next* iteration's sort catches up.
    // Without this, a run of iterations that each try something new but fail to beat the
    // existing best all log the exact same "best so far" value, indistinguishable from a search
    // that's doing nothing at all - reporting the raw attempt too (even when it wasn't an
    // improvement) is what lets a caller show "this is what was just tried" alongside "this is
    // the best found so far". `null` when this iteration had nothing to try (already converged).
    let attempted = null;

    if (!alreadyConverged) {
      const worst = vertices[n];
      const centroid = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        vertices[i].point.forEach((x, d) => { centroid[d] += x / n; });
      }

      const reflectedPoint = centroid.map((c, d) => c + ALPHA * (c - worst.point[d]));
      const reflected = await evalPoint(reflectedPoint);

      if (reflected.loss < vertices[0].loss) {
        // Better than the current best - try pushing further in the same direction.
        const expandedPoint = centroid.map((c, d) => c + GAMMA * (reflectedPoint[d] - c));
        const expanded = await evalPoint(expandedPoint);
        attempted = expanded.loss < reflected.loss ? expanded : reflected;
        vertices[n] = attempted;
      } else if (reflected.loss < vertices[n - 1].loss) {
        // Better than the second-worst - accept the plain reflection.
        attempted = reflected;
        vertices[n] = reflected;
      } else {
        // Reflection didn't help enough - contract toward whichever of {reflected, worst} is
        // better ("outside" vs "inside" contraction), or shrink the whole simplex toward the
        // best vertex if even that fails.
        const useOutside = reflected.loss < worst.loss;
        const basePoint = useOutside ? reflectedPoint : worst.point;
        const contractedPoint = centroid.map((c, d) => c + RHO * (basePoint[d] - c));
        const contracted = await evalPoint(contractedPoint);
        const contractedBetter = useOutside ? contracted.loss <= reflected.loss : contracted.loss < worst.loss;
        if (contractedBetter) {
          attempted = contracted;
          vertices[n] = contracted;
        } else {
          if (onBusy) await onBusy({ iteration: iter, operation: 'shrink', verticesToEvaluate: n + 1 });
          const bestPoint = vertices[0].point;
          // Every shrunk vertex is independent of the others, so all n+1 are dispatched together
          // via Promise.all rather than one at a time - when `evaluate` is backed by a Worker
          // pool, this is the single biggest win for a high-dimensional search (e.g. Candy
          // Frenzy's ~84 tunable dims: an 85-vertex shrink that used to run 85 measurements
          // back to back on one core now spreads across every available core at once).
          // Progress is still reported the same way (an occasional heartbeat, gated by
          // `busyReportIntervalMs`, never one call per vertex) - `completed` counts actual
          // resolutions as they arrive, not loop position, since vertices can now finish out of
          // order. The throttle check-and-stamp (`lastBusyReportTime = now`) happens synchronously,
          // before this vertex's own `await onBusy(...)` - JS never runs two callbacks' synchronous
          // bodies interleaved, so a second vertex resolving while the first's onBusy call is still
          // pending sees the already-updated timestamp rather than racing it (deliberately no
          // "in flight" flag - one was tried and gated a legitimate second report behind the
          // first's own await, silently dropping it under a zero/near-zero interval).
          let completed = 0;
          let lastBusyReportTime = Date.now();
          const shrinkPromises = vertices.map((v) => {
            const point = bestPoint.map((b, d) => b + SIGMA * (v.point[d] - b));
            return evalPoint(point).then(async (result) => {
              completed++;
              const isLast = completed === vertices.length;
              const now = Date.now();
              if (onBusy && !isLast && now - lastBusyReportTime >= busyReportIntervalMs) {
                lastBusyReportTime = now;
                await onBusy({ iteration: iter, operation: 'shrink', verticesToEvaluate: n + 1, verticesEvaluated: completed });
              }
              return result;
            });
          });
          vertices = await Promise.all(shrinkPromises);
          // Representative "what this iteration's work produced" for a shrink, since it
          // replaces the whole simplex at once rather than a single vertex.
          attempted = vertices.reduce((a, b) => (b.loss < a.loss ? b : a));
        }
      }
    }

    if (onProgress) await onProgress(iter, vertices[0].point, vertices[0], best, attempted);
    await yieldToEventLoop();

    if (alreadyConverged) { converged = true; break; }
  }

  vertices.sort((a, b) => a.loss - b.loss);
  if (vertices[0].loss < best.loss) best = vertices[0];

  return { point: best.point, loss: best.loss, result: best, iterations, converged };
}

/**
 * Whether `candidate` counts as a genuine improvement over `incumbent`, accounting for each
 * side's own measurement uncertainty (`trialRtpStdError` - see `measure()`'s own doc in
 * `tuneFrequencies`) rather than a raw `loss` comparison. A `candidate` only replaces a real
 * `incumbent` once it beats it by more than their combined standard error, scaled by `z` - so a
 * "better" result that's really just a luckier Monte Carlo sample can't silently become the new
 * best. Collapses to today's raw `<` comparison whenever both sides have zero (or missing)
 * `trialRtpStdError` - i.e. a deterministic evaluate, or `trialsPerPoint: 1`, is unaffected.
 * @param {{loss: number, trialRtpStdError?: number}} candidate
 * @param {{loss: number, trialRtpStdError?: number}|null} incumbent - `null` means "no incumbent
 *   yet", always accepted
 * @param {number} z - margin multiplier (tuneFrequencies' `bestAcceptanceZ` option)
 * @returns {boolean}
 */
