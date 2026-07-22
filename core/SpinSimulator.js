/**
 * A pure functional simulator for the SlotMachine game logic.
 * It models spins without any visual or audio side effects.
 */
import { checkWins, checkExpandingWins } from './SlotMath.js';

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
  
  // Get configuration values with defaults
  const freeSpinsCount = simConfig.freeSpinsCount || 10;
  const expandingSymbol = simConfig.expandingSymbol || 'anubis';
  const expandingPaytable = simConfig.expandingPaytable || null;

  // Main simulation loop for base spins
  for (let i = 0; i < numBaseSpins; i++) {
    const result = _runSingleSpin(false);
    
    // If free spins were triggered by this base spin, simulate them
    if (result.winData.scatterWin && result.winData.scatterWin.triggerFreeSpins) {
      for (let j = 0; j < freeSpinsCount; j++) {
        const freeSpinResult = _runSingleSpin(true);
        // Accumulate free spin results into the stats
        results.totalWins += freeSpinResult.spinWin;
        if (freeSpinResult.spinWin > results.maxWin) results.maxWin = freeSpinResult.spinWin;
        if (freeSpinResult.spinWin < results.minWin) results.minWin = freeSpinResult.spinWin;
        results.winDistribution[freeSpinResult.spinWin] = (results.winDistribution[freeSpinResult.spinWin] || 0) + 1;
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
    winDistribution: results.winDistribution
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

    // Evaluate wins using the existing math logic
    let winData = checkWins(
      targetGrid,
      simConfig.paytable,
      linesCount,
      'book', // Wild/Scatter symbol
      'book'  // Scatter symbol for this specific game
    );

    let spinWin = 0;
    if (winData.scatterWin) {
      // Scatter payouts are always totalBet-scaled, matching the engine behavior.
      spinWin += winData.scatterWin.payout * simConfig.totalBet;
      results.scatterCounts += winData.scatterWin.count;
      if (winData.scatterWin.triggerFreeSpins) {
        results.freeSpinsTriggered++;
      }
    }

    // Line wins use betPerLine (each line's payout is multiplied by betPerLine)
    spinWin += winData.totalLinePayoutMultiplier * betPerLine;

    // Check for expanding wins (relevant during free spins usually, but can happen anytime depending on rules)
    // In this game's logic, expansion is triggered by symbols on reels during free spins.
    // We check if the targetGrid contains any expanding symbols that should be active.
    // For simplicity in simulation, we'll assume expansion happens if it's a free spin 
    // and there are multiple of the same high-value symbol on a reel.
    let expandingResults = null;
    if (isFreeSpin) {
      // Check for expanding wins using the configured expanding symbol and paytable
      expandingResults = checkExpandingWins(targetGrid, expandingSymbol, simConfig.paytable, linesCount, expandingPaytable);
    }

    if (expandingResults) {
      spinWin += expandingResults.totalPayoutMultiplier;
    }

    // Update stats
    results.totalWins += spinWin;
    if (spinWin > results.maxWin) results.maxWin = spinWin;
    if (spinWin < results.minWin) results.minWin = spinWin;
    results.winDistribution[spinWin] = (results.winDistribution[spinWin] || 0) + 1;

    return { spinWin, winData, expandingResults };
  }
}
