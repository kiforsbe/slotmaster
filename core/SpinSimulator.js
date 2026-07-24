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

// Two tiers only: 'premium'-typed symbols (tier 0) vs everything else (tier 1). Coarser
// than computeValueRanks, but built on the exact same tieredRawWeights/t>=1 mechanism,
// so it's structurally guaranteed to never let a premium symbol end up more frequent than
// a non-premium one - unlike the bespoke premium/other bisection this replaces.
function computePremiumTiers(paytable, symbols) {
  const tierOf = {};
  symbols.forEach(s => { tierOf[s] = paytable[s].type === 'premium' ? 0 : 1; });
  return tierOf;
}

// weight(s) = baseFreq(s) * t^tierOf(s), before renormalization. Non-decreasing as
// tierOf(s) increases whenever t >= 1 - this is what makes "higher-tier symbols end up no
// more frequent" hold by construction rather than by chance, for rankTilt/premiumSplit.
function tieredRawWeights(valueSymbols, baseFreq, tierOf, t) {
  const raw = {};
  valueSymbols.forEach(s => { raw[s] = baseFreq[s] * Math.pow(t, tierOf[s]); });
  return raw;
}

// Scales any positive per-symbol raw-weight map so it sums to valueBudget - shared by
// every Phase 2 mode (tieredRawWeights' t^tier construction, and randomSearch's jittered
// tier sampling) so they all scale into the same fixed budget Phase 1's trigger-rate share
// depends on, regardless of how the raw weights themselves were produced.
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
 * @returns {Promise<{ mult: number, error: number, result: Object, paytable: Object, converged: boolean }>} -
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
    if (!best || error < best.error) best = { mult: param, error, result, paytable: trial };
    if (onProgress) await onProgress(i, param, resultWithError, best);
    await yieldToEventLoop();
    if (error <= tolerance || i === maxIterations - 1) break;

    // Probe for a measurable slope, widening the probe distance (and, failing that,
    // trying the opposite direction) when the first probe lands on a flat plateau -
    // generateReel() rounds symbol counts to whole numbers per reel, so a small parameter
    // change can measure as an *exactly* zero slope even though the metric does move at a
    // larger step. Without this, the search stalls permanently at the first such plateau
    // (trust decays every iteration regardless, but x itself never moves).
    let slope = 0;
    outer: for (const sign of [1, -1]) {
      for (let widen = 1; widen <= 8; widen *= 2) {
        const xProbe = Math.min(maxX, Math.max(minX, x + sign * epsilon * widen));
        const dx = xProbe - x;
        if (dx === 0) continue;
        const probeResult = measure(buildTrial(Math.exp(xProbe)), stepSeed);
        slope = (metricOf(probeResult) - metric) / dx;
        if (slope !== 0) break outer;
      }
    }
    if (slope !== 0) {
      const step = ((target - metric) / slope) * trust;
      x = Math.min(maxX, Math.max(minX, x + step));
    }
    trust *= trustFactorDecay;
  }

  return { ...best, converged: best.error <= tolerance };
}

/**
 * Automatically tunes symbol `frequency` values in a paytable to hit a target RTP and a
 * target free-spin trigger rate - without touching any payout values. Runs the real
 * simulator against candidate paytables, so it stays accurate to whatever SlotMath.js's
 * actual win logic does at the time it's run (it doesn't hardcode any game-specific math).
 *
 * Strategy: symbols are grouped by `paytable[symbol].type`.
 *  1. Scale every 'scatter' symbol's frequency together (gradientDescent1D) until the
 *     free-spin trigger rate lands on target, holding all other frequencies fixed.
 *  2. Reallocate non-scatter weight to hit the target RTP, holding total non-scatter weight
 *     constant so the trigger rate found in step 1 is preserved exactly. `options.frequencyMode`
 *     picks how weight is grouped into tiers - but every mode shares the same underlying
 *     guarantee: weight(s) = baseFreq(s) * t^tier(s) with t clamped >= 1, so a higher-paying
 *     symbol can never end up more frequent than a lower-paying one.
 *       - 'rankTilt' (default): tiers = one per distinct payout value (fine-grained).
 *       - 'premiumSplit': tiers = 'premium'-typed symbols (tier 0) vs everything else (tier 1) -
 *         a coarser, 2-tier version of the same mechanism, kept for continuity with the
 *         original "move weight between premium and the rest" behavior. Order *within* the
 *         non-premium tier still depends on the base paytable already being ordered there.
 *       - 'randomSearch': samples many random monotonic (by payout) weight distributions
 *         and keeps the one closest to target RTP, so the search isn't limited to a single
 *         tilt shape. Reports its best few attempts in diagnostics.rtpPhase.topCandidates.
 *     If every candidate symbol lands in the same tier (e.g. 'premiumSplit' requested on a
 *     paytable with no 'premium'-typed symbols), falls back to scaling every non-scatter
 *     symbol together instead.
 *
 * Both phases use gradientDescent1D (see above) rather than bisection, with common random
 * numbers reducing simulation noise in the gradient estimate, and track the best candidate
 * seen (not just the final step): generateReel() rounds symbol counts to whole numbers per
 * reel, so the achievable trigger rate / RTP is quantized with occasional jumps rather than
 * a smooth dial - a single step can straddle a jump without landing inside the tolerance band.
 *
 * @param {Object} paytable - Paytable to tune (not mutated; a tuned clone is returned).
 * @param {Object} [options]
 * @param {number} [options.reelsCount=5]
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
 * @param {number} [options.maxIterations=14] - Gradient-descent steps (or random trials) per phase.
 * @param {'rankTilt'|'premiumSplit'|'randomSearch'} [options.frequencyMode='rankTilt'] - RTP reallocation strategy, see above.
 * @param {string[]} [options.valueOrderExcludeTypes=['wild']] - Symbol `type`s excluded from the
 *   tier assignment in 'rankTilt'/'premiumSplit'/'randomSearch' (held fixed at their post-scatter-phase
 *   frequency instead) - wilds don't "pay" in the normal sense, so tiering them by payout would
 *   nonsensically treat them as the cheapest, most-common tier.
 * @param {[number, number]} [options.tiltBounds=[1, 40]] - Search bounds for the tilt parameter shared by
 *   'rankTilt'/'premiumSplit' (gradient descent) and 'randomSearch' (sampled log-uniformly). Values
 *   below 1 are clamped up to 1 - the tilt is a per-tier growth multiplier, and anything below 1
 *   would shrink lower-paying tiers' share back below the top tier's, inverting the ordering
 *   guarantee these modes exist to provide.
 * @param {number} [options.searchSeed=12345] - Base PRNG seed for 'randomSearch' and for the
 *   common-random-numbers gradient estimates in the other modes - a given seed always explores
 *   the same sequence, for reproducible runs.
 * @param {(phase: 'scatter'|'shape', iteration: number, multiplier: number|null, result: {rtp: number, triggerRate: number, error: number}, best: {mult: number, error: number, result: Object, paytable: Object}) => (void|Promise<void>)} [options.onProgress] -
 *   Called (and awaited, if it returns a promise) after each candidate is measured, before yielding to the
 *   event loop - a caller can safely touch the DOM here and see it rendered before the next (heavier) candidate runs.
 * @returns {Promise<{ paytable: Object, rtp: number, triggerRatePct: number, diagnostics: Object }>}
 */
export async function tuneFrequencies(paytable, options = {}) {
  const {
    reelsCount = 5,
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
    maxIterations = 14,
    frequencyMode = 'rankTilt',
    valueOrderExcludeTypes = ['wild'],
    tiltBounds = [1, 40],
    searchSeed = 12345,
    onProgress = null,
  } = options;

  // Each candidate measurement is itself a synchronous, CPU-bound block (simulateSpins
  // doesn't yield internally) - but yielding *between* candidates via a macrotask lets a
  // browser tab repaint after each onProgress call, so a caller can render live, iterative
  // results instead of the whole run appearing to freeze the page until it's done.
  const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

  if (!paytable || typeof paytable !== 'object') {
    throw new Error('tuneFrequencies requires a paytable');
  }

  const basePaytable = JSON.parse(JSON.stringify(paytable));
  const scatterSymbols = Object.keys(basePaytable).filter(s => basePaytable[s].type === 'scatter');

  function buildReelStrips(pt) {
    const strips = [];
    for (let i = 0; i < reelsCount; i++) {
      strips.push(generateReel(pt, reelLength, reelSeeds[i % reelSeeds.length] + i * 100000));
    }
    return strips;
  }

  // rngSeed is optional - omitted, this falls back to unseeded Math.random per trial (via
  // simulateSpins' own default). When provided, each trialsPerPoint repeat gets its own
  // derived seed (so multiple trials still average over genuinely different sequences),
  // but that derived seed is identical across different candidate measurements for the
  // same trial index and rngSeed - the common-random-numbers property gradientDescent1D's
  // finite difference relies on.
  function measure(pt, rngSeed) {
    const reelStrips = buildReelStrips(pt);
    const config = { reelsCount, rowsCount, paytable: pt, reelStrips, paylines, winEvaluator, wildSymbol, scatterSymbol };
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
  let pt1 = basePaytable;
  let scatterPhase = null;
  if (scatterSymbols.length > 0) {
    const scatterBaseFreq = {};
    scatterSymbols.forEach(s => { scatterBaseFreq[s] = basePaytable[s].frequency; });

    scatterPhase = await gradientDescent1D({
      initialParam: 1,
      minParam: 0.05,
      maxParam: 8,
      target: targetTriggerRatePct,
      tolerance: triggerRateTolerancePct,
      buildTrial: (mult) => {
        const trial = JSON.parse(JSON.stringify(basePaytable));
        scatterSymbols.forEach(s => { trial[s].frequency = scatterBaseFreq[s] * mult; });
        return trial;
      },
      metricOf: (result) => result.triggerRate,
      measure,
      maxIterations,
      seedBase: searchSeed,
      onProgress: onProgress ? (i, mult, result, best) => onProgress('scatter', i, mult, result, best) : null,
      yieldToEventLoop,
    });
    pt1 = scatterPhase.paytable;
  }

  // ---- Phase 2: reallocate non-scatter weight to hit the target RTP ----
  // Total non-scatter weight is held fixed throughout, so scatter's share (and therefore
  // the trigger rate locked in above) doesn't drift while RTP is being tuned.
  const nonScatterSymbols = Object.keys(pt1).filter(s => !scatterSymbols.includes(s));
  const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + pt1[s].frequency, 0);
  let rtpPhase = null;

  const fixedShapeSymbols = nonScatterSymbols.filter(s => valueOrderExcludeTypes.includes(pt1[s].type));
  const valueSymbols = nonScatterSymbols.filter(s => !valueOrderExcludeTypes.includes(pt1[s].type));
  const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + pt1[s].frequency, 0);
  const valueBudget = nonScatterTotal - fixedShapeTotal;

  const tierOf = valueSymbols.length > 0
    ? (frequencyMode === 'premiumSplit' ? computePremiumTiers(pt1, valueSymbols) : computeValueRanks(pt1, valueSymbols))
    : {};
  const tieredModeUsable = valueSymbols.length > 0 && valueBudget > 0 && new Set(Object.values(tierOf)).size > 1;

  if (tieredModeUsable) {
    const baseFreq = {}; valueSymbols.forEach(s => { baseFreq[s] = pt1[s].frequency; });

    // Applies an already-renormalized (summing to valueBudget) per-symbol weight map to a
    // clone of pt1, leaving the excluded types (e.g. wilds) untouched at their Phase 1
    // frequency.
    function applyWeights(weights) {
      const trial = JSON.parse(JSON.stringify(pt1));
      valueSymbols.forEach(s => { trial[s].frequency = weights[s]; });
      return trial;
    }

    // Tilt values below 1 would shrink higher-tier (lower-paying) symbols' multiplier below
    // the top tier's fixed 1x, pulling weight back toward the top and inverting the very
    // ordering guarantee these modes exist to provide - so 1 is a hard floor regardless of
    // what tiltBounds is passed.
    const tiltLo = Math.max(1, tiltBounds[0]);
    const tiltHi = Math.max(tiltLo, tiltBounds[1]);

    if (frequencyMode === 'randomSearch') {
      // Sample many candidate distributions instead of committing to one tilt shape. Each
      // trial draws its own log-uniform tilt across the full [tiltLo, tiltHi] range (so the
      // same fully-concentrated extremes rankTilt/premiumSplit can reach are reachable here
      // too) plus independent per-tier jitter - jitter is bounded to [1, 1.5] so every
      // per-tier growth step is still >=1x, preserving the ordering guarantee on every
      // single sampled candidate.
      const maxTier = Math.max(...Object.values(tierOf));
      const tiers = [];
      for (let r = 0; r <= maxTier; r++) tiers.push(valueSymbols.filter(s => tierOf[s] === r));
      const rng = createSeededRng(searchSeed);

      let best = null;
      const attempts = [];
      for (let i = 0; i < maxIterations; i++) {
        const tilt = tiltLo * Math.pow(tiltHi / tiltLo, rng());
        const tierWeight = new Array(maxTier + 1);
        tierWeight[0] = 1;
        for (let r = 1; r <= maxTier; r++) {
          const jitter = 1 + rng() * 0.5;
          tierWeight[r] = tierWeight[r - 1] * tilt * jitter;
        }
        const raw = {};
        tiers.forEach((tierSymbols, r) => {
          const tierBaseTotal = tierSymbols.reduce((sum, s) => sum + baseFreq[s], 0) || 1;
          tierSymbols.forEach(s => { raw[s] = tierWeight[r] * (baseFreq[s] / tierBaseTotal); });
        });
        const trial = applyWeights(renormalizeWeights(raw, valueBudget));
        // Seeded for reproducible runs, offset well clear of the gradient-descent phases'
        // per-step seeds elsewhere so the two can never coincide.
        const result = measure(trial, searchSeed + 600000 + i * 7919);
        const error = Math.abs(result.rtp - targetRtp);
        const resultWithError = { ...result, error };
        const candidate = { mult: tilt, error, result, paytable: trial, converged: error <= rtpTolerancePct };
        if (!best || error < candidate.error) best = candidate;
        attempts.push(candidate);
        if (onProgress) await onProgress('shape', i, tilt, resultWithError, best);
        await yieldToEventLoop();
        if (error <= rtpTolerancePct) break;
      }
      attempts.sort((a, b) => a.error - b.error);
      best.topCandidates = attempts.slice(0, 5).map(c => ({
        rtp: c.result.rtp,
        triggerRate: c.result.triggerRate,
        error: c.error,
        frequencies: Object.fromEntries(valueSymbols.map(s => [s, c.paytable[s].frequency])),
      }));
      rtpPhase = best;
    } else {
      // rankTilt or premiumSplit: identical mechanism, differing only in how tierOf groups
      // symbols (computed above). weight(s) = baseFreq(s) * t^tierOf(s), t clamped >= 1.
      rtpPhase = await gradientDescent1D({
        initialParam: 1,
        minParam: tiltLo,
        maxParam: tiltHi,
        target: targetRtp,
        tolerance: rtpTolerancePct,
        buildTrial: (t) => applyWeights(renormalizeWeights(tieredRawWeights(valueSymbols, baseFreq, tierOf, t), valueBudget)),
        metricOf: (result) => result.rtp,
        measure,
        maxIterations,
        seedBase: searchSeed + 300000,
        onProgress: onProgress ? (i, t, result, best) => onProgress('shape', i, t, result, best) : null,
        yieldToEventLoop,
      });
    }
  } else if (nonScatterSymbols.length > 0) {
    // Degenerate case (e.g. 'premiumSplit' requested on a paytable with no 'premium'-typed
    // symbols, or every non-excluded symbol landed in the same tier): fall back to scaling
    // every non-scatter symbol together. No ordering concern here since a uniform multiplier
    // never changes relative proportions, so the tilt isn't floored at 1.
    const baseFreq = {}; nonScatterSymbols.forEach(s => { baseFreq[s] = pt1[s].frequency; });
    rtpPhase = await gradientDescent1D({
      initialParam: 1,
      minParam: 0.2,
      maxParam: 5,
      target: targetRtp,
      tolerance: rtpTolerancePct,
      buildTrial: (mult) => {
        const trial = JSON.parse(JSON.stringify(pt1));
        nonScatterSymbols.forEach(s => { trial[s].frequency = baseFreq[s] * mult; });
        return trial;
      },
      metricOf: (result) => result.rtp,
      measure,
      maxIterations,
      seedBase: searchSeed + 900000,
      onProgress: onProgress ? (i, mult, result, best) => onProgress('shape', i, mult, result, best) : null,
      yieldToEventLoop,
    });
  }

  const finalPaytable = rtpPhase ? rtpPhase.paytable : pt1;
  const finalResult = rtpPhase ? rtpPhase.result : measure(finalPaytable);

  return {
    paytable: finalPaytable,
    rtp: finalResult.rtp,
    triggerRatePct: finalResult.triggerRate,
    diagnostics: {
      scatterPhase: scatterPhase ? { multiplier: scatterPhase.mult, error: scatterPhase.error, converged: !!scatterPhase.converged, ...scatterPhase.result } : null,
      rtpPhase: rtpPhase ? {
        multiplier: rtpPhase.mult,
        error: rtpPhase.error,
        converged: !!rtpPhase.converged,
        ...rtpPhase.result,
        ...(rtpPhase.topCandidates ? { topCandidates: rtpPhase.topCandidates } : {}),
      } : null,
    }
  };
}
