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

// The smallest t >= 1 that satisfies the ordering guarantee for every present pair on this
// reel, independent of any RTP target. weight(s) = baseFreq(s) * t^tierOf(s) is only
// non-decreasing-by-tier once t clears each pair's own crossover point - a lower-tier
// (higher-paying) symbol a with baseFreq(a) > baseFreq(b) for some higher-tier (lower-paying)
// b needs t^(tierOf(b)-tierOf(a)) >= baseFreq(a)/baseFreq(b), i.e.
// t >= (baseFreq(a)/baseFreq(b))^(1/(tierOf(b)-tierOf(a))). Renormalization (a shared
// positive scale factor across all symbols) never changes pairwise ordering, so this can be
// computed on raw baseFreq values directly. Needed because gradientDescent1D stops once its
// RTP metric is within tolerance (or iterations run out) - neither condition has any direct
// connection to whether every tier pair has individually crossed over yet, so the search
// alone cannot be trusted to reach an order-safe t on its own.
function minOrderSafeTilt(valueSymbols, baseFreq, tierOf) {
  let minT = 1;
  for (const a of valueSymbols) {
    for (const b of valueSymbols) {
      if (tierOf[a] < tierOf[b] && baseFreq[a] > baseFreq[b]) {
        const neededT = Math.pow(baseFreq[a] / baseFreq[b], 1 / (tierOf[b] - tierOf[a]));
        if (neededT > minT) minT = neededT;
      }
    }
  }
  return minT;
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
 *  2. Tune each reel's own value-symbol weights independently via coordinate descent: for
 *     `options.rounds` rounds, visit reel 0, then reel 1, ... then reel N-1 in turn. Each
 *     reel's turn runs the existing gradientDescent1D (unmodified) to find that reel's own
 *     tilt `t_r`, holding every other reel's table fixed at its current value - so this is
 *     coordinate descent over reels, not true multi-dimensional gradient descent.
 *     Within one reel's turn: weight(s) = baseFreq_r(s) * t_r^tierOf(s), t_r clamped >= 1,
 *     tierOf from computeValueRanks(paytable, ...) over the symbols actually present
 *     (nonzero base frequency) on that reel - so a higher-paying symbol present on a given
 *     reel can never end up more frequent than a lower-paying symbol also present on that
 *     same reel. If a reel has no tunable tiers (e.g. every present value-symbol shares one
 *     payout, or the reel has no non-excluded symbols at all), that reel is scaled uniformly
 *     instead (no ordering concern - a uniform multiplier never changes relative proportions).
 *  A global best (full reel-table combination + its measured RTP) is tracked across every
 *  sub-call in both phases, not just the final one: generateReel() rounds symbol counts to
 *  whole numbers per reel, so achievable trigger rate / RTP is quantized with occasional
 *  jumps rather than a smooth dial.
 *
 * @param {Object} paytable - Rules only (payout, type, wild, wildPenalty, wildExcludes,
 *   aloneBonus, friendlyName) - no `.frequency` field. Not mutated, not returned.
 * @param {Object[]} reelFrequencyTables - One table per reel, each `{ symbol: { frequency } }`
 *   (same shape generateReel already accepts). Not mutated; a tuned clone is returned.
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
 * @param {number} [options.maxIterations=14] - Gradient-descent steps per reel per round.
 * @param {number} [options.rounds=3] - Coordinate-descent rounds over reels.
 * @param {string[]} [options.valueOrderExcludeTypes=['wild']] - Symbol `type`s excluded from
 *   tier assignment on every reel (held fixed at their post-scatter-phase frequency instead).
 * @param {[number, number]} [options.tiltBounds=[1, 40]] - Search bounds for each reel's tilt
 *   parameter. Values below 1 are clamped up to 1 regardless of what's passed - the tilt is a
 *   per-tier growth multiplier, and anything below 1 would invert the ordering guarantee.
 * @param {number} [options.searchSeed=12345] - Base PRNG seed for the common-random-numbers
 *   gradient estimates - a given seed always explores the same sequence, for reproducible runs.
 * @param {(phase: 'scatter'|'shape', iteration: number, multiplier: number|null, result: {rtp: number, triggerRate: number, error: number}, best: Object, context?: {reelIndex: number, round: number}) => (void|Promise<void>)} [options.onProgress] -
 *   Called (and awaited, if it returns a promise) after each candidate is measured. `context`
 *   is only present during phase 'shape', identifying which reel/round the step belongs to.
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
    maxIterations = 14,
    rounds = 3,
    valueOrderExcludeTypes = ['wild'],
    tiltBounds = [1, 40],
    searchSeed = 12345,
    onProgress = null,
  } = options;

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

  // ---- Phase 2: coordinate descent over reels, tuning each reel's own value weights ----
  // Deliberately NOT tracking a "best RTP seen across the whole run" snapshot here (unlike
  // gradientDescent1D's own single-parameter search): a step from earlier in the run - before
  // some reel had its order-safety floor applied - can have a lower RTP error than the fully
  // safety-corrected final state, and blindly preferring it would silently reintroduce an
  // ordering violation the later step fixed. Using the state after the full loop instead
  // guarantees every reel was safety-floored on its last visit, since no reel is touched
  // again after that.
  let rtpPhaseStepCount = 0;
  let lastReelResult = null;

  for (let round = 0; round < rounds; round++) {
    for (let r = 0; r < reelsCount; r++) {
      const reelTable = currentReelTables[r];
      const nonScatterSymbols = Object.keys(reelTable).filter(s => !scatterSymbols.includes(s) && reelTable[s].frequency > 0);
      const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);

      const fixedShapeSymbols = nonScatterSymbols.filter(s => valueOrderExcludeTypes.includes(paytable[s].type));
      const valueSymbols = nonScatterSymbols.filter(s => !valueOrderExcludeTypes.includes(paytable[s].type));
      const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);
      const valueBudget = nonScatterTotal - fixedShapeTotal;

      if (valueSymbols.length === 0 || valueBudget <= 0) {
        // Nothing tunable on this reel this round - leave it untouched and move to the next reel.
        continue;
      }

      const tierOf = computeValueRanks(paytable, valueSymbols);
      const tieredModeUsable = new Set(Object.values(tierOf)).size > 1;
      const baseFreq = {}; valueSymbols.forEach(s => { baseFreq[s] = reelTable[s].frequency; });

      // Applies an already-computed per-symbol weight map to a clone of this reel's table,
      // then returns the *full* N-reel array (this reel updated, every other reel untouched
      // at its current value) - `measure()` always needs the complete set to build strips.
      function applyWeights(weights) {
        const newReel = JSON.parse(JSON.stringify(reelTable));
        valueSymbols.forEach(s => { newReel[s].frequency = weights[s]; });
        const trial = currentReelTables.slice();
        trial[r] = newReel;
        return trial;
      }

      const tiltLo = Math.max(1, tiltBounds[0]);
      const tiltHi = Math.max(tiltLo, tiltBounds[1]);

      let reelResult = tieredModeUsable
        ? await gradientDescent1D({
            // weight(s) = baseFreq(s) * t^tierOf(s), t clamped >= 1 - guarantees a
            // higher-paying symbol present on this reel is never more frequent than a
            // lower-paying symbol also present on this reel, once t reaches the floor
            // enforced below.
            initialParam: 1,
            minParam: tiltLo,
            maxParam: tiltHi,
            target: targetRtp,
            tolerance: rtpTolerancePct,
            buildTrial: (t) => applyWeights(renormalizeWeights(tieredRawWeights(valueSymbols, baseFreq, tierOf, t), valueBudget)),
            metricOf: (result) => result.rtp,
            measure,
            maxIterations,
            seedBase: searchSeed + 300000 + r * 50000 + round * 5000,
            onProgress: onProgress ? (i, t, result, best) => onProgress('shape', i, t, result, best, { reelIndex: r, round }) : null,
            yieldToEventLoop,
          })
        : await gradientDescent1D({
            // Degenerate case for this reel (every present value-symbol shares one payout
            // tier): scale them uniformly instead. No ordering concern - a uniform
            // multiplier never changes relative proportions, so the tilt isn't floored at 1.
            initialParam: 1,
            minParam: 0.2,
            maxParam: 5,
            target: targetRtp,
            tolerance: rtpTolerancePct,
            buildTrial: (mult) => {
              const weights = {}; valueSymbols.forEach(s => { weights[s] = baseFreq[s] * mult; });
              return applyWeights(weights);
            },
            metricOf: (result) => result.rtp,
            measure,
            maxIterations,
            seedBase: searchSeed + 900000 + r * 50000 + round * 5000,
            onProgress: onProgress ? (i, mult, result, best) => onProgress('shape', i, mult, result, best, { reelIndex: r, round }) : null,
            yieldToEventLoop,
          });

      // gradientDescent1D stops once its RTP metric is within tolerance (or iterations run
      // out) - neither has any direct connection to whether every tier pair on this reel has
      // individually crossed over yet, so a search landing at a "good enough" RTP can still
      // leave a lower-paying pair inverted. Enforce the analytic floor unconditionally: never
      // let the chosen tilt be smaller than what the data itself requires.
      if (tieredModeUsable) {
        const safeTilt = Math.min(tiltHi, minOrderSafeTilt(valueSymbols, baseFreq, tierOf));
        if (safeTilt > reelResult.mult) {
          const safeTrial = applyWeights(renormalizeWeights(tieredRawWeights(valueSymbols, baseFreq, tierOf, safeTilt), valueBudget));
          const safeMeasured = measure(safeTrial, searchSeed + 300000 + r * 50000 + round * 5000 + 1);
          const safeError = Math.abs(safeMeasured.rtp - targetRtp);
          reelResult = { mult: safeTilt, error: safeError, result: safeMeasured, trial: safeTrial, converged: safeError <= rtpTolerancePct };
        }
      }

      currentReelTables = reelResult.trial;
      rtpPhaseStepCount++;
      lastReelResult = reelResult;
    }
  }

  const rtpPhaseRan = rtpPhaseStepCount > 0;
  const finalReelTables = currentReelTables;
  const finalResult = rtpPhaseRan ? lastReelResult.result : measure(finalReelTables);

  return {
    reelFrequencyTables: finalReelTables,
    rtp: finalResult.rtp,
    triggerRatePct: finalResult.triggerRate,
    diagnostics: {
      scatterPhase: scatterPhase ? { multiplier: scatterPhase.mult, error: scatterPhase.error, converged: !!scatterPhase.converged, ...scatterPhase.result } : null,
      rtpPhase: rtpPhaseRan ? {
        error: lastReelResult.error,
        converged: !!lastReelResult.converged,
        rtp: lastReelResult.result.rtp,
        triggerRate: lastReelResult.result.triggerRate,
        roundsRun: rounds,
      } : null,
    }
  };
}
