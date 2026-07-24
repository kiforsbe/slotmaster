/**
 * A pure functional simulator for the SlotMachine game logic.
 * It models spins without any visual or audio side effects.
 */
import { checkWins, checkExpandingWins, generateReel, generateTargetGrid } from './SlotMath.js';

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

// Deterministic PRNG (mulberry32) so a given searchSeed always explores the same sequence
// of candidate distributions - reproducible tuning runs, same as generateReel's seeding.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
 * @returns {Promise<{ mult: number, error: number, result: Object, paytable: Object }>}
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

    const xProbe = Math.min(maxX, x + epsilon);
    const dx = xProbe - x;
    if (dx > 0) {
      const probeResult = measure(buildTrial(Math.exp(xProbe)), stepSeed);
      const slope = (metricOf(probeResult) - metric) / dx;
      if (slope !== 0) {
        const step = ((target - metric) / slope) * trust;
        x = Math.min(maxX, Math.max(minX, x + step));
      }
    }
    trust *= trustFactorDecay;
  }

  return best;
}

/**
 * Automatically tunes symbol `frequency` values in a paytable to hit a target RTP and a
 * target free-spin trigger rate - without touching any payout values. Runs the real
 * simulator against candidate paytables, so it stays accurate to whatever SlotMath.js's
 * actual win logic does at the time it's run (it doesn't hardcode any game-specific math).
 *
 * Strategy (mirrors manual balancing): symbols are grouped by `paytable[symbol].type`.
 *  1. Scale every 'scatter' symbol's frequency together (bisection) until the free-spin
 *     trigger rate lands on target, holding all other frequencies fixed.
 *  2. Reallocate non-scatter weight to hit the target RTP, holding total non-scatter weight
 *     constant so the trigger rate found in step 1 is preserved exactly. `options.frequencyMode`
 *     picks the reallocation strategy:
 *       - 'premiumSplit' (default): a single multiplier moves weight between 'premium'-typed
 *         symbols and everything else. Simple, but for paytables where the premium symbol is
 *         the only one with a payout meaningfully above the rest, hitting a high target RTP
 *         can force that symbol to become common - the exact "highest payer, most frequent"
 *         outcome slot design usually avoids. If there's no 'premium' type, every non-scatter
 *         symbol is scaled together instead.
 *       - 'rankTilt': symbols (excluding wilds by default) are ranked by payout and a single
 *         bisected tilt parameter shifts weight toward the lower-paying tiers as it grows -
 *         guaranteed by construction to never make a higher-paying symbol more frequent than
 *         a lower-paying one. May not reach the target RTP if the paytable's payout ceilings
 *         are too low for common symbols to carry it alone (see diagnostics.rtpPhase.error).
 *       - 'randomSearch': samples many random monotonic (by payout) weight distributions
 *         and keeps the one closest to target RTP, so the search isn't limited to a single
 *         tilt shape. Reports its best few attempts in diagnostics.rtpPhase.topCandidates.
 *
 * Both bisection phases track the best candidate seen (not just the final bisection midpoint):
 * generateReel() rounds symbol counts to whole numbers per reel, so the achievable trigger
 * rate / RTP is quantized with occasional jumps rather than a smooth dial - plain bisection
 * can straddle a jump without any single point landing inside the tolerance band.
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
 * @param {number} [options.maxIterations=14] - Bisection steps (or random trials) per phase.
 * @param {'premiumSplit'|'rankTilt'|'randomSearch'} [options.frequencyMode='premiumSplit'] - RTP reallocation strategy, see above.
 * @param {string[]} [options.valueOrderExcludeTypes=['wild']] - Symbol `type`s excluded from the
 *   payout-order ranking in 'rankTilt'/'randomSearch' (held fixed at their post-scatter-phase
 *   frequency instead) - wilds don't "pay" in the normal sense, so ranking them by payout would
 *   nonsensically treat them as the cheapest, most-common tier.
 * @param {[number, number]} [options.tiltBounds=[1, 40]] - Search bounds for the tilt parameter shared by
 *   'rankTilt' (bisected) and 'randomSearch' (sampled log-uniformly). Values below 1 are clamped up to 1 -
 *   the tilt is a per-tier growth multiplier, and anything below 1 would shrink lower-paying tiers'
 *   share back below the top tier's, inverting the ordering guarantee these modes exist to provide.
 * @param {number} [options.searchSeed=12345] - PRNG seed for 'randomSearch', for reproducible runs.
 * @param {(phase: 'scatter'|'rtp'|'shape', iteration: number, multiplier: number|null, result: {rtp:number, triggerRate:number}, best: {mult:number, error:number, result:Object, paytable:Object}) => (void|Promise<void>)} [options.onProgress] -
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
    frequencyMode = 'premiumSplit',
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
  const premiumSymbols = Object.keys(basePaytable).filter(s => basePaytable[s].type === 'premium');
  const otherSymbols = Object.keys(basePaytable)
    .filter(s => !scatterSymbols.includes(s) && !premiumSymbols.includes(s));
  const hasPremiumSplit = premiumSymbols.length > 0 && otherSymbols.length > 0;

  function buildReelStrips(pt) {
    const strips = [];
    for (let i = 0; i < reelsCount; i++) {
      strips.push(generateReel(pt, reelLength, reelSeeds[i % reelSeeds.length] + i * 100000));
    }
    return strips;
  }

  function measure(pt) {
    const reelStrips = buildReelStrips(pt);
    const config = { reelsCount, rowsCount, paytable: pt, reelStrips, paylines, winEvaluator, wildSymbol, scatterSymbol };
    let rtpSum = 0, triggerSum = 0;
    for (let i = 0; i < trialsPerPoint; i++) {
      const results = simulateSpins(config, trialSpins, betPerLine, linesCount);
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

    let lo = 0.05, hi = 8, best = null;
    for (let i = 0; i < maxIterations; i++) {
      // Geometric midpoint: trigger rate is a highly nonlinear (roughly power-law) function
      // of scatter frequency, so bisecting in log-space converges much faster than linear.
      const mid = Math.sqrt(lo * hi);
      const trial = JSON.parse(JSON.stringify(basePaytable));
      scatterSymbols.forEach(s => { trial[s].frequency = scatterBaseFreq[s] * mid; });
      const result = measure(trial);
      const error = Math.abs(result.triggerRate - targetTriggerRatePct);
      if (!best || error < best.error) best = { mult: mid, error, result, paytable: trial };
      if (onProgress) await onProgress('scatter', i, mid, result, best);
      await yieldToEventLoop();
      if (error <= triggerRateTolerancePct) break;
      if (result.triggerRate < targetTriggerRatePct) lo = mid; else hi = mid;
    }
    scatterPhase = best;
    pt1 = best.paytable;
  }

  // ---- Phase 2: reallocate non-scatter weight to hit the target RTP ----
  // Total non-scatter weight is held fixed throughout, so scatter's share (and therefore
  // the trigger rate locked in above) doesn't drift while RTP is being tuned.
  const nonScatterSymbols = Object.keys(pt1).filter(s => !scatterSymbols.includes(s));
  const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + pt1[s].frequency, 0);
  let rtpPhase = null;

  if (frequencyMode === 'rankTilt' || frequencyMode === 'randomSearch') {
    const fixedShapeSymbols = nonScatterSymbols.filter(s => valueOrderExcludeTypes.includes(pt1[s].type));
    const valueSymbols = nonScatterSymbols.filter(s => !valueOrderExcludeTypes.includes(pt1[s].type));
    const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + pt1[s].frequency, 0);
    const valueBudget = nonScatterTotal - fixedShapeTotal;

    if (valueSymbols.length > 0 && valueBudget > 0) {
      const rankOf = computeValueRanks(pt1, valueSymbols);
      const baseFreq = {}; valueSymbols.forEach(s => { baseFreq[s] = pt1[s].frequency; });

      // Renormalizes a set of per-symbol raw weights to valueBudget, applied to a clone of
      // pt1 with the excluded types (e.g. wilds) left untouched at their Phase 1 frequency.
      function buildTrial(raw) {
        const rawTotal = Object.values(raw).reduce((a, b) => a + b, 0);
        const scale = valueBudget / rawTotal;
        const trial = JSON.parse(JSON.stringify(pt1));
        valueSymbols.forEach(s => { trial[s].frequency = raw[s] * scale; });
        return trial;
      }

      // Tilt values below 1 would shrink higher-rank (lower-paying) tiers' multiplier below
      // the top tier's fixed 1x, pulling weight back toward the top and inverting the very
      // ordering guarantee these two modes exist to provide - so 1 is a hard floor
      // regardless of what tiltBounds is passed.
      const tiltLo = Math.max(1, tiltBounds[0]);
      const tiltHi = Math.max(tiltLo, tiltBounds[1]);

      if (frequencyMode === 'rankTilt') {
        // A single tilt parameter t: at t=1, the original per-tier shape is preserved
        // (just renormalized to valueBudget). As t grows, weight shifts toward higher-rank
        // (lower-paying) tiers exponentially faster than lower-rank ones, so a higher-paying
        // symbol can never end up more frequent than a lower-paying one - unlike premiumSplit,
        // which only has two groups to trade weight between.
        let lo = tiltLo, hi = tiltHi, best = null;
        for (let i = 0; i < maxIterations; i++) {
          const mid = Math.sqrt(lo * hi);
          const raw = {}; valueSymbols.forEach(s => { raw[s] = baseFreq[s] * Math.pow(mid, rankOf[s]); });
          const trial = buildTrial(raw);
          const result = measure(trial);
          const error = Math.abs(result.rtp - targetRtp);
          if (!best || error < best.error) best = { mult: mid, error, result, paytable: trial };
          if (onProgress) await onProgress('shape', i, mid, result, best);
          await yieldToEventLoop();
          if (error <= rtpTolerancePct) break;
          if (result.rtp < targetRtp) lo = mid; else hi = mid;
        }
        rtpPhase = best;
      } else {
        // randomSearch: sample many candidate distributions instead of committing to one
        // tilt shape. Each trial draws its own log-uniform tilt across the full [tiltLo,
        // tiltHi] range (so the same fully-concentrated extremes rankTilt can reach are
        // reachable here too) plus independent per-tier jitter - jitter is bounded to
        // [1, 1.5] so every per-tier growth step is still >=1x, preserving the same
        // "higher payout, lower frequency" guarantee on every single sampled candidate.
        const maxRank = Math.max(...Object.values(rankOf));
        const tiers = [];
        for (let r = 0; r <= maxRank; r++) tiers.push(valueSymbols.filter(s => rankOf[s] === r));
        const rng = mulberry32(searchSeed);

        let best = null;
        const attempts = [];
        for (let i = 0; i < maxIterations; i++) {
          const tilt = tiltLo * Math.pow(tiltHi / tiltLo, rng());
          const tierWeight = new Array(maxRank + 1);
          tierWeight[0] = 1;
          for (let r = 1; r <= maxRank; r++) {
            const jitter = 1 + rng() * 0.5;
            tierWeight[r] = tierWeight[r - 1] * tilt * jitter;
          }
          const raw = {};
          tiers.forEach((tierSymbols, r) => {
            const tierBaseTotal = tierSymbols.reduce((sum, s) => sum + baseFreq[s], 0) || 1;
            tierSymbols.forEach(s => { raw[s] = tierWeight[r] * (baseFreq[s] / tierBaseTotal); });
          });
          const trial = buildTrial(raw);
          const result = measure(trial);
          const error = Math.abs(result.rtp - targetRtp);
          const candidate = { mult: tilt, error, result, paytable: trial };
          if (!best || error < candidate.error) best = candidate;
          attempts.push(candidate);
          if (onProgress) await onProgress('shape', i, tilt, result, best);
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
      }
    }
  } else if (hasPremiumSplit) {
    const premiumBaseTotal = premiumSymbols.reduce((sum, s) => sum + pt1[s].frequency, 0);
    const otherBaseTotal = otherSymbols.reduce((sum, s) => sum + pt1[s].frequency, 0);
    const premiumBaseFreq = {}; premiumSymbols.forEach(s => { premiumBaseFreq[s] = pt1[s].frequency; });
    const otherBaseFreq = {}; otherSymbols.forEach(s => { otherBaseFreq[s] = pt1[s].frequency; });

    // regularScale must stay positive - cap the multiplier short of consuming the whole budget.
    const maxMult = (nonScatterTotal / premiumBaseTotal) * 0.98;
    let lo = 0.1, hi = Math.max(maxMult, 0.11), best = null;
    for (let i = 0; i < maxIterations; i++) {
      const mid = (lo + hi) / 2;
      const trial = JSON.parse(JSON.stringify(pt1));
      const newPremiumTotal = premiumBaseTotal * mid;
      const otherScale = Math.max((nonScatterTotal - newPremiumTotal) / otherBaseTotal, 0.001);
      premiumSymbols.forEach(s => { trial[s].frequency = premiumBaseFreq[s] * mid; });
      otherSymbols.forEach(s => { trial[s].frequency = otherBaseFreq[s] * otherScale; });
      const result = measure(trial);
      const error = Math.abs(result.rtp - targetRtp);
      if (!best || error < best.error) best = { mult: mid, error, result, paytable: trial };
      if (onProgress) await onProgress('rtp', i, mid, result, best);
      await yieldToEventLoop();
      if (error <= rtpTolerancePct) break;
      if (result.rtp < targetRtp) lo = mid; else hi = mid;
    }
    rtpPhase = best;
  } else if (nonScatterSymbols.length > 0) {
    // No premium/other split available - scale every non-scatter symbol together instead.
    const baseFreq = {}; nonScatterSymbols.forEach(s => { baseFreq[s] = pt1[s].frequency; });
    let lo = 0.2, hi = 5, best = null;
    for (let i = 0; i < maxIterations; i++) {
      const mid = Math.sqrt(lo * hi);
      const trial = JSON.parse(JSON.stringify(pt1));
      nonScatterSymbols.forEach(s => { trial[s].frequency = baseFreq[s] * mid; });
      const result = measure(trial);
      const error = Math.abs(result.rtp - targetRtp);
      if (!best || error < best.error) best = { mult: mid, error, result, paytable: trial };
      if (onProgress) await onProgress('rtp', i, mid, result, best);
      await yieldToEventLoop();
      if (error <= rtpTolerancePct) break;
      if (result.rtp < targetRtp) lo = mid; else hi = mid;
    }
    rtpPhase = best;
  }

  const finalPaytable = rtpPhase ? rtpPhase.paytable : pt1;
  const finalResult = rtpPhase ? rtpPhase.result : measure(finalPaytable);

  return {
    paytable: finalPaytable,
    rtp: finalResult.rtp,
    triggerRatePct: finalResult.triggerRate,
    diagnostics: {
      scatterPhase: scatterPhase ? { multiplier: scatterPhase.mult, ...scatterPhase.result } : null,
      rtpPhase: rtpPhase ? {
        multiplier: rtpPhase.mult,
        ...rtpPhase.result,
        ...(rtpPhase.topCandidates ? { topCandidates: rtpPhase.topCandidates } : {}),
      } : null,
    }
  };
}
