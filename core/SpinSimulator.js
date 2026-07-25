/**
 * A pure functional simulator for the SlotMachine game logic.
 * It models spins without any visual or audio side effects.
 */
import { checkWins, checkExpandingWins, generateReel, generateTargetGrid, createSeededRng } from './SlotMath.js';

/**
 * Simulates multiple spins and returns statistical analysis.
 * @param {Object} config - Slot machine configuration with reelStrips, paytable, etc.
 * @param {number} numBaseSpins - Number of base spins to simulate (default 100000)
 * @param {number} betPerLine - Bet per line (default 1)
 * @param {number} linesCount - Number of active paylines (default 10)
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

  const winEvaluator = simConfig.winEvaluator || checkWins;

  // Get configuration values with defaults
  const freeSpinsCount = simConfig.freeSpinsCount || 10;
  let expandingSymbol = simConfig.expandingSymbol || 'anubis';

  // Main simulation loop for base spins
  for (let i = 0; i < numBaseSpins; i++) {
    const result = _runSingleSpin(false);
    
    // If free spins were triggered by this base spin, simulate them
    if (result.winData.scatterWin && result.winData.scatterWin.triggerFreeSpins) {
      // Randomize the expanding symbol for each new free spin session.
      // Scatter symbols (e.g. book) can never be the expanding symbol - derive
      // eligibility from the paytable's own type rather than hardcoding a symbol name.
      const eligibleSymbols = Object.keys(simConfig.paytable || {})
        .filter(s => simConfig.paytable[s].type !== 'scatter');
      expandingSymbol = eligibleSymbols.length > 0
        ? eligibleSymbols[Math.floor(rng() * eligibleSymbols.length)]
        : expandingSymbol;

      for (let j = 0; j < freeSpinsCount; j++) {
        _runSingleSpin(true); // _runSingleSpin accumulates into results internally
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
    detailedWins: results.detailedWins
  };

  // Helper to simulate a single spin (base or free)
  function _runSingleSpin(isFreeSpin = false) {
    const totalSpinBet = isFreeSpin ? 0 : simConfig.betPerLine * linesCount;
    if (!isFreeSpin) results.totalBets += totalSpinBet;
    results.totalSimulatedSpins++;

    // Target grid generation - pure/seeded via generateTargetGrid (SlotMath.js), so a
    // caller can pass a seeded rng (e.g. tuneFrequencies' common-random-numbers gradient
    // steps) for a reproducible run; defaults to Math.random for today's behavior.
    const targetGrid = generateTargetGrid(simConfig.reelStrips, simConfig.rowsCount, rng);

    // Evaluate wins using this config's win evaluator (defaults to checkWins above)
    let winData = winEvaluator(
      targetGrid,
      simConfig.paytable,
      simConfig.paylines,
      linesCount,
      simConfig.wildSymbol ?? null,
      simConfig.scatterSymbol ?? null
    );

    let spinWin = 0;
    if (winData.scatterWin) {
      // Scatter payouts are always totalBet-scaled, matching the engine behavior.
      spinWin += winData.scatterWin.payout * simConfig.totalBet;
      results.scatterCounts += winData.scatterWin.count;
      if (winData.scatterWin.triggerFreeSpins) {
        results.freeSpinsTriggered++;
      }

      // Track scatter wins in detailed stats
      results.detailedWins.push({
        type: 'scatter',
        symbol: 'book',
        count: winData.scatterWin.count,
        isFreeSpin: false, // Scatters trigger FS but are usually counted as base spin wins
        winAmount: winData.scatterWin.payout * simConfig.totalBet
      });
    }

    // Line wins use betPerLine (each line's payout is multiplied by betPerLine)
    spinWin += winData.totalLinePayoutMultiplier * betPerLine;
    
    if (winData.lineWins && winData.lineWins.length > 0) {
      winData.lineWins.forEach((lw, idx) => {
        results.detailedWins.push({
          type: lw.alone ? 'alone' : 'line',
          symbol: lw.symbol,
          count: lw.count,
          wildUsed: !!lw.wildUsed,
          isFreeSpin: isFreeSpin,
          winAmount: lw.payout * betPerLine
        });
      });
    }

    // Check for expanding wins (relevant during free spins usually, but can happen anytime depending on rules)
    // In this game's logic, expansion is triggered by symbols on reels during free spins.
    // We check if the targetGrid contains any expanding symbols that should be active.
    // For simplicity in simulation, we'll assume expansion happens if it's a free spin 
    // and there are multiple of the same high-value symbol on a reel.
    let expandingResults = null;
    if (isFreeSpin) {
      // Check for expanding wins using the configured expanding symbol and paytable
      expandingResults = checkExpandingWins(targetGrid, expandingSymbol, simConfig.paytable, simConfig.paylines, linesCount);
    }

    if (expandingResults) {
      // totalPayoutMultiplier is per-line; multiply by betPerLine for actual payout.
      // Matches SlotEngine.evaluateSpinResult(), which adds the normal line-win payout
      // (already included in spinWin above) and the expanding-win payout independently,
      // with no reconciliation between them - the simulator must mirror that exactly to
      // produce an accurate RTP estimate, even if that double-credit is itself worth
      // revisiting as a gameplay design question.
      const expandingWinAmount = expandingResults.totalPayoutMultiplier * betPerLine;
      spinWin += expandingWinAmount;

      // Track expanding wins in detailed stats
      results.detailedWins.push({
        type: 'expanding',
        symbol: expandingSymbol,
        count: expandingResults.expandingReels.length, // Number of reels that expanded
        isFreeSpin: true,
        winAmount: expandingWinAmount
      });
    }

    // Update stats
    results.totalWins += spinWin;
    if (spinWin > results.maxWin) results.maxWin = spinWin;
    if (spinWin < results.minWin) results.minWin = spinWin;
    results.winDistribution[spinWin] = (results.winDistribution[spinWin] || 0) + 1;

    return { spinWin, winData, expandingResults };
  }
}

// Ranks symbols by descending payout (highest single-line payout = rank 0), tying symbols
// with equal payout to the same rank so their relative weight is preserved as a group.
function computeValueRanks(paytable, symbols) {
  const payoutOf = (s) => {
    const arr = paytable[s].payout;
    return arr && arr.length ? arr[arr.length - 1] : 0;
  };
  const sorted = [...symbols].sort((a, b) => payoutOf(b) - payoutOf(a));
  const rankOf = {};
  let rank = -1, lastPayout = null;
  for (const s of sorted) {
    const p = payoutOf(s);
    if (p !== lastPayout) { rank++; lastPayout = p; }
    rankOf[s] = rank;
  }
  return rankOf;
}

// Scales any positive per-symbol raw-weight map so it sums to valueBudget - used both to
// project Phase 2's Nelder-Mead candidates back onto each reel's fixed budget, and (via
// Phase 1) to keep the scatter-symbol scaling on the same footing.
function renormalizeWeights(raw, valueBudget) {
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
  onProgress, yieldToEventLoop,
  trustFactor = 0.8, trustFactorDecay = 0.9, epsilon = 0.05,
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
    outer: for (const sign of [1, -1]) {
      for (let widen = 1; widen <= 8; widen *= 2) {
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
 * @param {() => Promise<void>} args.yieldToEventLoop
 * @returns {Promise<{ point: number[], loss: number, result: Object, iterations: number, converged: boolean }>} -
 *   `converged` is true iff the search stopped because the simplex's spread collapsed below
 *   `convergenceTolerance`, not because `maxIterations` ran out.
 */
export async function nelderMead({
  initialPoint, initialStepSize, evaluate, maxIterations,
  convergenceTolerance = 1e-4, onProgress, yieldToEventLoop,
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
        const bestPoint = vertices[0].point;
        vertices = vertices.map(v => evalPoint(bestPoint.map((b, d) => b + SIGMA * (v.point[d] - b))));
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
 *  1. Scale every 'scatter'-typed symbol's frequency by one shared multiplier, applied
 *     identically to every reel's table (gradientDescent1D), until the free-spin trigger
 *     rate lands on target. A symbol with frequency 0 on a given reel stays 0 (0 * mult = 0).
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
 *
 * @param {Object} paytable - Rules only (payout, type, wild, wildPenalty, wildExcludes,
 *   aloneBonus, friendlyName) - no `.frequency` field. Not mutated, not returned.
 * @param {Object[]} reelFrequencyTables - One table per reel, each `{ symbol: { frequency,
 *   fixed?, min?, max? } }`. `frequency` is the same shape generateReel already accepts.
 *   `fixed: true` is optional (defaults to falsy/tunable) and excludes that symbol from
 *   Phase 2 on that specific reel only - its frequency is left exactly as passed in. `min`
 *   and/or `max` are optional soft bounds (same units as `frequency`) on that symbol's
 *   frequency on that specific reel - like the ordering preference, a discouraged-but-not-
 *   forbidden preference (see `limitPenaltyWeight` below), not a hard clamp. Not mutated; a
 *   tuned clone is returned.
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
 * @param {(phase: 'scatter'|'shape', iteration: number, multiplier: number|null, result: {rtp: number, triggerRate: number, error: number}, best: Object) => (void|Promise<void>)} [options.onProgress] -
 *   Called (and awaited, if it returns a promise) after each candidate is measured.
 *   `multiplier` is always `null` during phase 'shape' (Phase 2 moves every dimension
 *   together each iteration, so there's no longer one scalar to report per step).
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
    orderingBiasByReel = null,
    initialStepSize = 0.5,
    searchSeed = 12345,
    onProgress = null,
  } = options;

  const orderingBiasFor = (r) => (orderingBiasByReel && orderingBiasByReel[r] != null) ? orderingBiasByReel[r] : -1;

  const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

  if (reelFrequencyTables.length !== reelsCount) {
    throw new Error(`tuneFrequencies requires reelFrequencyTables to be an array of length reelsCount (${reelsCount})`);
  }

  const baseReelTables = reelFrequencyTables.map(rt => JSON.parse(JSON.stringify(rt)));
  const scatterSymbols = Object.keys(paytable).filter(s => paytable[s].type === 'scatter');

  function buildReelStrips(reelTables) {
    return reelTables.map((rt, i) => generateReel(rt, reelLength, reelSeeds[i % reelSeeds.length] + i * 100000));
  }

  // rngSeed is optional - omitted, this falls back to unseeded Math.random per trial (via
  // simulateSpins' own default). When provided, each trialsPerPoint repeat gets its own
  // derived seed, but that derived seed is identical across different candidate measurements
  // for the same trial index and rngSeed - the common-random-numbers property gradientDescent1D's
  // finite difference relies on.
  function measure(reelTables, rngSeed) {
    const reelStrips = buildReelStrips(reelTables);
    const config = { reelsCount, rowsCount, paytable, reelStrips, paylines, winEvaluator, wildSymbol, scatterSymbol };
    let rtpSum = 0, triggerSum = 0;
    for (let i = 0; i < trialsPerPoint; i++) {
      const rng = rngSeed != null ? createSeededRng(rngSeed + i * 104729) : Math.random;
      const results = simulateSpins(config, trialSpins, betPerLine, linesCount, rng);
      rtpSum += results.rtpRaw * 100;
      triggerSum += (results.freeSpinsTriggered / results.baseSpins) * 100;
    }
    return { rtp: rtpSum / trialsPerPoint, triggerRate: triggerSum / trialsPerPoint };
  }

  // ---- Phase 1: scale scatter symbol(s) to hit the target trigger rate ----
  // One shared multiplier applied identically to every reel's table - a symbol with
  // frequency 0 on a given reel stays 0 (0 * mult = 0), so this is safe even for reels
  // that don't carry the scatter symbol at all.
  let currentReelTables = baseReelTables;
  let scatterPhase = null;
  if (scatterSymbols.length > 0) {
    scatterPhase = await gradientDescent1D({
      initialParam: 1,
      minParam: 0.05,
      maxParam: 8,
      target: targetTriggerRatePct,
      tolerance: triggerRateTolerancePct,
      buildTrial: (mult) => baseReelTables.map(rt => {
        const trial = JSON.parse(JSON.stringify(rt));
        scatterSymbols.forEach(s => { if (trial[s]) trial[s].frequency = rt[s].frequency * mult; });
        return trial;
      }),
      metricOf: (result) => result.triggerRate,
      measure,
      maxIterations,
      seedBase: searchSeed,
      onProgress: onProgress ? (i, mult, result, best) => onProgress('scatter', i, mult, result, best) : null,
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
  const valueBudgetByReel = [];
  const tierOfByReel = [];
  const isFixed = (reelTable, s) => reelTable[s].fixed === true;
  currentReelTables.forEach((reelTable, r) => {
    const nonScatterSymbols = Object.keys(reelTable).filter(s => !scatterSymbols.includes(s) && reelTable[s].frequency > 0);
    const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);
    const fixedShapeSymbols = nonScatterSymbols.filter(s => isFixed(reelTable, s));
    const valueSymbols = nonScatterSymbols.filter(s => !isFixed(reelTable, s));
    const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);
    const valueBudget = nonScatterTotal - fixedShapeTotal;
    valueBudgetByReel[r] = valueBudget;
    tierOfByReel[r] = computeValueRanks(paytable, valueSymbols);
    if (valueSymbols.length > 0 && valueBudget > 0) {
      valueSymbols.forEach(s => dims.push({ reelIndex: r, symbol: s, min: reelTable[s].min, max: reelTable[s].max }));
    }
  });

  let rtpPhaseResult = null;

  if (dims.length > 0) {
    const initialPoint = dims.map(d => Math.log(currentReelTables[d.reelIndex][d.symbol].frequency));
    // Generous per-dimension bounds (relative to that dimension's own starting frequency,
    // not a shared absolute range) - wide enough to not artificially constrain the search,
    // just enough to keep the simplex from drifting to a degenerate near-zero or runaway
    // value on a reel whose other symbols have a very different scale.
    const dimBounds = dims.map(d => {
      const base = currentReelTables[d.reelIndex][d.symbol].frequency;
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
        Object.keys(renormalized).forEach(s => { reelTables[rIdx][s].frequency = renormalized[s]; });
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
          const diff = bias * (reelTables[r][b].frequency - reelTables[r][a].frequency);
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
        const freq = reelTables[r][s].frequency;
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

    // One fixed seed for the entire Nelder-Mead call (rather than one per iteration like
    // gradientDescent1D's probes): every point evaluated - old simplex vertices or new
    // candidates - needs to stay directly comparable for the whole run, not just within one
    // iteration, since a vertex from iteration 3 may still be in play at iteration 50.
    // measure()'s own trialsPerPoint averaging keeps a single seed's estimate reasonably
    // stable per point.
    const nmSeed = searchSeed + 700000;

    function evaluate(x) {
      const reelTables = projectPoint(x);
      const measured = measure(reelTables, nmSeed);
      const { total: orderPenalty, violations: orderingViolations } = orderingPenaltyOf(reelTables);
      const { total: boundsPenalty, violations: limitViolations } = limitPenaltyOf(reelTables);
      const error = Math.abs(measured.rtp - targetRtp);
      return {
        loss: error + orderingPenaltyWeight * orderPenalty + limitPenaltyWeight * boundsPenalty,
        rtp: measured.rtp,
        triggerRate: measured.triggerRate,
        error,
        orderingViolations,
        limitViolations,
        trial: reelTables,
      };
    }

    const nm = await nelderMead({
      initialPoint,
      initialStepSize,
      evaluate,
      maxIterations,
      onProgress: onProgress ? (i, point, result, best) => onProgress('shape', i, null, result, best) : null,
      yieldToEventLoop,
    });

    currentReelTables = nm.result.trial;
    rtpPhaseResult = { ...nm.result, iterations: nm.iterations };
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
        rtp: rtpPhaseResult.rtp,
        triggerRate: rtpPhaseResult.triggerRate,
        iterationsRun: rtpPhaseResult.iterations,
        orderingViolations: rtpPhaseResult.orderingViolations,
        limitViolations: rtpPhaseResult.limitViolations,
      } : null,
    }
  };
}
