// Core Slot Mathematics Engine

export const PAYLINES = [
  [1, 1, 1, 1, 1], // Line 1: Horizontal Middle Row
  [0, 0, 0, 0, 0], // Line 2: Horizontal Top Row
  [2, 2, 2, 2, 2], // Line 3: Horizontal Bottom Row
  [0, 1, 2, 1, 0], // Line 4: V-Shape
  [2, 1, 0, 1, 2], // Line 5: Inverted V-Shape
  [0, 0, 1, 2, 2], // Line 6: Step Down-Up
  [2, 2, 1, 0, 0], // Line 7: Step Up-Down
  [1, 2, 2, 2, 1], // Line 8: U-Shape Bottom
  [1, 0, 0, 0, 1], // Line 9: U-Shape Top
  [0, 1, 0, 1, 0]  // Line 10: Zigzag
];

/**
 * Check normal line wins and scatters for a slot grid.
 * Grid structure: grid[col][row], where col is 0..4 and row is 0..2.
 */
export function checkWins(grid, paytable, activeLinesCount = 10, wildSymbol = 'book', scatterSymbol = 'book') {
  const lineWins = [];
  let totalLinePayoutMultiplier = 0;

  // 1. Evaluate Line Wins (Left to Right)
  for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, PAYLINES.length); lineIdx++) {
    const path = PAYLINES[lineIdx];
    
    // Read symbols along the line path
    const lineSymbols = [];
    for (let col = 0; col < 5; col++) {
      const row = path[col];
      lineSymbols.push(grid[col][row]);
    }

    // Determine the winning combination starting from the left
    let matchCount = 0;
    let targetSymbol = null;
    const winningPositions = [];

    for (let col = 0; col < 5; col++) {
      const sym = lineSymbols[col];
      
      if (col === 0) {
        targetSymbol = sym;
        matchCount = 1;
        winningPositions.push([col, path[col]]);
      } else {
        const isWild = (sym === wildSymbol);
        const targetIsWild = (targetSymbol === wildSymbol);

        if (targetIsWild && !isWild) {
          // If first symbol was wild and current is not, target becomes the current symbol
          targetSymbol = sym;
          matchCount++;
          winningPositions.push([col, path[col]]);
        } else if (sym === targetSymbol || isWild) {
          // Normal match or wild substitution
          matchCount++;
          winningPositions.push([col, path[col]]);
        } else {
          // Win sequence is broken
          break;
        }
      }
    }

    // Resolve wild-only lines (e.g. Book, Book, Book on line 1)
    // If the line consists only of wilds or we broke early, check targetSymbol.
    // If targetSymbol is wild and there are other symbols later, we already handled it.
    // But if targetSymbol remains wild, it evaluates as a Wild win.
    
    // Evaluate if the matchCount pays anything for the targetSymbol
    if (targetSymbol) {
      const payouts = paytable[targetSymbol];
      if (payouts && payouts[matchCount] > 0) {
        const payout = payouts[matchCount];
        lineWins.push({
          lineIndex: lineIdx,
          symbol: targetSymbol,
          count: matchCount,
          payout: payout,
          winningPositions: winningPositions.slice(0, matchCount)
        });
        totalLinePayoutMultiplier += payout;
      }
    }
  }

  // 2. Evaluate Scatter Wins (Books anywhere)
  let scatterCount = 0;
  const scatterPositions = [];
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 3; row++) {
      if (grid[col][row] === scatterSymbol) {
        scatterCount++;
        scatterPositions.push([col, row]);
      }
    }
  }

  let scatterWin = null;
  let triggerFreeSpins = false;
  if (scatterCount >= 3) {
    triggerFreeSpins = true;
  }

  // Scatters pay based on total bet, usually defined separately in the paytable
  const scatterPayouts = paytable[scatterSymbol];
  if (scatterPayouts && scatterPayouts[scatterCount] > 0) {
    const payout = scatterPayouts[scatterCount];
    scatterWin = {
      symbol: scatterSymbol,
      count: scatterCount,
      payout: payout, // multiplier of total bet
      winningPositions: scatterPositions,
      triggerFreeSpins: triggerFreeSpins
    };
  } else if (triggerFreeSpins) {
    // Retrigger or trigger free spins even if no payout is defined at this level
    scatterWin = {
      symbol: scatterSymbol,
      count: scatterCount,
      payout: 0,
      winningPositions: scatterPositions,
      triggerFreeSpins: true
    };
  }

  return {
    lineWins,
    scatterWin,
    totalLinePayoutMultiplier,
    totalScatterPayoutMultiplier: scatterWin ? scatterWin.payout : 0
  };
}

/**
 * Check Book of Dead style expanding wins during Free Spins.
 * Reels with the expanding symbol will have it expand to cover the entire reel.
 * Wins are evaluated on all active lines without needing to be adjacent.
 */
export function checkExpandingWins(grid, expandingSymbol, paytable, activeLinesCount = 10) {
  // Find which reels contain the expanding symbol
  const expandingReels = [];
  const expandedPositions = [];

  for (let col = 0; col < 5; col++) {
    let hasSymbol = false;
    for (let row = 0; row < 3; row++) {
      if (grid[col][row] === expandingSymbol) {
        hasSymbol = true;
        break;
      }
    }
    if (hasSymbol) {
      expandingReels.push(col);
      // Once expanded, the symbol occupies row 0, 1, 2 of this column
      expandedPositions.push([col, 0], [col, 1], [col, 2]);
    }
  }

  const count = expandingReels.length;
  const payouts = paytable[expandingSymbol];
  
  // High value symbols pay for 2 or more reels, low value for 3 or more.
  // We can determine this by checking if payout exists for count.
  const hasWin = payouts && payouts[count] > 0;

  if (!hasWin || count === 0) {
    return null;
  }

  const wins = [];
  const payoutPerLine = payouts[count];
  let totalPayout = 0;

  // In expanding mode, since the symbol covers all positions on the expanded reels,
  // it is active on all paylines on those reels. And since it doesn't need to be adjacent,
  // every active line gets a win of size equal to the number of expanding reels!
  for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, PAYLINES.length); lineIdx++) {
    wins.push({
      lineIndex: lineIdx,
      symbol: expandingSymbol,
      count: count,
      payout: payoutPerLine,
      // The winning positions on this payline are the intersections of the payline and the expanded columns
      winningPositions: PAYLINES[lineIdx].map((row, col) => {
        if (expandingReels.includes(col)) {
          return [col, row];
        }
        return null;
      }).filter(pos => pos !== null)
    });
    totalPayout += payoutPerLine;
  }

  return {
    symbol: expandingSymbol,
    expandedReels,
    expandedPositions,
    wins,
    totalPayoutMultiplier: totalPayout
  };
}
