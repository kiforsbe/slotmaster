/**
 * A pure functional simulator for the SlotMachine game logic.
 * It models spins without any visual or audio side effects.
 */
import { checkWins, checkExpandingWins, generateReel } from './SlotMath.js';

/**
 * Simulates multiple spins and returns statistical analysis.
 * @param {Object} config - Slot machine configuration with reelStrips, paytable, etc.
 * @param {number} numBaseSpins - Number of base spins to simulate (default 100000)
 * @param {number} betPerLine - Bet per line (default 1)
 * @param {number} linesCount - Number of active paylines (default 10)
 * @returns {Object} Simulation results including RTP, win distribution, etc.
 */
export function simulateSpins(config, numBaseSpins = 100000, betPerLine = 1, linesCount = 10) {
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
        ? eligibleSymbols[Math.floor(Math.random() * eligibleSymbols.length)]
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

    // Simulate target grid generation
    const targetGrid = [];
    for (let col = 0; col < simConfig.reelsCount; col++) {
      const reelCol = [];
      const strip = simConfig.reelStrips[col];
      const stopIndex = Math.floor(Math.random() * strip.length);
      for (let row = 0; row < simConfig.rowsCount; row++) {
        reelCol.push(strip[(stopIndex + row) % strip.length]);
      }
      targetGrid.push(reelCol);
    }

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
          type: 'line',
          symbol: lw.symbol,
          count: lw.count,
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

/**
 * Automatically tunes symbol `frequency` values in a paytable to hit a target RTP and a
 * target free-spin trigger rate - without touching any payout values. Runs the real
 * simulator against candidate paytables, so it stays accurate to whatever SlotMath.js's
 * actual win logic does at the time it's run (it doesn't hardcode any game-specific math).
 *
 * Strategy (mirrors manual balancing): symbols are grouped by `paytable[symbol].type`.
 *  1. Scale every 'scatter' symbol's frequency together (bisection) until the free-spin
 *     trigger rate lands on target, holding all other frequencies fixed.
 *  2. Reallocate weight between 'premium' symbols and everything else non-scatter (a single
 *     multiplier, bisected against RTP) while holding total non-scatter weight constant -
 *     so the trigger rate found in step 1 is preserved exactly. If the paytable has no
 *     'premium'-tagged symbols, every non-scatter symbol is scaled together instead.
 *
 * Both phases track the best candidate seen (not just the final bisection midpoint):
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
 * @param {number} [options.maxIterations=14] - Bisection steps per phase.
 * @param {(phase: 'scatter'|'rtp', iteration: number, multiplier: number, result: {rtp:number, triggerRate:number}, best: {mult:number, error:number, result:Object, paytable:Object}) => (void|Promise<void>)} [options.onProgress] -
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

  // ---- Phase 2: reallocate premium vs. other non-scatter weight to hit the target RTP ----
  // Total non-scatter weight is held fixed throughout, so scatter's share (and therefore
  // the trigger rate locked in above) doesn't drift while RTP is being tuned.
  const nonScatterSymbols = Object.keys(pt1).filter(s => !scatterSymbols.includes(s));
  const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + pt1[s].frequency, 0);
  let rtpPhase = null;

  if (hasPremiumSplit) {
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
      rtpPhase: rtpPhase ? { multiplier: rtpPhase.mult, ...rtpPhase.result } : null,
    }
  };
}
