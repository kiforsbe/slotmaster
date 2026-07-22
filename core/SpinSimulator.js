/**
 * A pure functional simulator for the SlotMachine game logic.
 * It models spins without any visual or audio side effects.
 */
import { checkWins, checkExpandingWins } from './SlotMath.js';

export function simulateSpins(config, numBaseSpins = 10000, betPerLine = 1, linesCount = 10) {
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

  // Helper to simulate a single spin (base or free)
  function runSingleSpin(isFreeSpin = false) {
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
      spinWin += winData.scatterWin.payout * (isFreeSpin ? linesCount : betPerLine);
      results.scatterCounts += winData.scatterWin.count;
      if (winData.scatterWin.triggerFreeSpins) {
        results.freeSpinsTriggered++;
      }
    }

    spinWin += winData.totalLinePayoutMultiplier * (isFreeSpin ? linesCount : betPerLine);

    // Check for expanding wins (relevant during free spins usually, but can happen anytime depending on rules)
    // In this game's logic, expansion is triggered by symbols on reels during free spins.
    // We check if the targetGrid contains any expanding symbols that should be active.
    // For simplicity in simulation, we'll assume expansion happens if it's a free spin 
    // and there are multiple of the same high-value symbol on a reel.
    let expandingResults = null;
    if (isFreeSpin) {
      // The engine logic: "Find which reels contain the expanding symbol"
      // We need to know what the 'expandingSymbol' is. In bookbookbook it's usually 'tut' or 'book'.
      // Let's assume 'tut' for expansion in this game context if not specified.
      const currentExpandingSymbol = 'tut'; 
      expandingResults = checkExpandingWins(targetGrid, currentExpandingSymbol, simConfig.paytable, linesCount);
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

  // Main simulation loop for base spins
  for (let i = 0; i < numBaseSpins; i++) {
    const result = runSingleSpin(false);
    
    // If free spins were triggered by this base spin, simulate them
    // The current engine seems to trigger a fixed amount of free spins when scatterCount >= 2.
    // Based on common Book of Dead mechanics, it's often 10-15 free spins. Let's assume 10 for the model if not specified elsewhere.
    if (result.winData.scatterWin && result.winData.scatterWin.triggerFreeSpins) {
      for (let j = 0; j < 10; j++) {
        runSingleSpin(true);
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
}
