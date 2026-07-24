// Core Slot Mathematics Engine

/**
 * Payline definitions for 5-reel, 3-row slot machine.
 * Each array defines the row index (0=top, 1=middle, 2=bottom) for each column.
 * @type {Array<Array<number>>}
 */
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
 * @param {Array<Array<string>>} grid - 5x3 grid of symbol names
 * @param {Object} paytable - Maps symbol names to payout arrays (indexed by hit count)
 * @param {number} activeLinesCount - Number of active paylines (default 10)
 * @param {string} wildSymbol - Symbol that acts as wild (default 'book')
 * @param {string} scatterSymbol - Symbol that acts as scatter (default 'book')
 * @param {number} scatterTriggerCount - Minimum scatter count to trigger free spins (default 3)
 * @returns {Object} Object containing lineWins, scatterWin, and total payouts
 */
export function checkWins(grid, paytable, activeLinesCount = 10, wildSymbol = 'book', scatterSymbol = 'book', scatterTriggerCount = 3) {
  // Input validation
  if (!grid || grid.length !== 5 || grid[0].length !== 3) {
    throw new Error('Grid must be 5 columns x 3 rows');
  }
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('Invalid paytable');
  }
  activeLinesCount = Math.min(activeLinesCount, PAYLINES.length);
  

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

    // A scatter-paymode run (e.g. Book, Book, Book on line 1) must NOT be paid as a line win:
    // scatter symbols are already paid separately below using totalBet-scaled multipliers.
    // Paying them again per-line would double-count. Gate on the paytable's own paymode
    // rather than the wild symbol, since a symbol can be scatter-only without being wild.
    const targetMeta = targetSymbol && paytable[targetSymbol];
    if (targetSymbol && targetSymbol !== wildSymbol && targetMeta && targetMeta.paymode === 'line') {
      const payouts = targetMeta.payout;
      // payout[i] is the payout for (i+1) matching symbols (index 0 = 1 match, ... index 4 = 5 matches).
      if (payouts && payouts[matchCount - 1] > 0) {
        const payout = payouts[matchCount - 1];
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
  if (scatterCount >= scatterTriggerCount) {
    triggerFreeSpins = true;
  }

  // Scatters pay based on total bet, usually defined separately in the paytable.
  // payout[i] is the payout for (i+1) scatters, same convention as line wins.
  const scatterPayouts = paytable[scatterSymbol] && paytable[scatterSymbol].payout;
  if (scatterPayouts && scatterPayouts[scatterCount - 1] > 0) {
    const payout = scatterPayouts[scatterCount - 1];
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
 * Note: Expanding symbol pays on ALL active paylines, so 3 expanding reels
 * pays payout * numActiveLines. This is Book of Dead style behavior.
 * @param {Array<Array<string>>} grid - 5x3 grid of symbol names
 * @param {string} expandingSymbol - The symbol that expands during free spins
 * @param {Object} paytable - Maps symbol names to payout arrays (used for fallback)
 * @param {number} activeLinesCount - Number of active paylines (default 10)
 * @param {Object|null} expandingPaytable - Separate paytable for expanding wins; if null, falls back to paytable
 * @returns {Object|null} Expanding win data or null if no win
 */
export function checkExpandingWins(grid, expandingSymbol, paytable, activeLinesCount = 10, expandingPaytable = null) {
  // Input validation
  if (!grid || grid.length !== 5 || grid[0].length !== 3) {
    throw new Error('Grid must be 5 columns x 3 rows');
  }
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('Invalid paytable');
  }
  
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
  // Use the dedicated expanding paytable when available (separate from normal-mode line payouts)
  const payouts = (expandingPaytable && expandingPaytable[expandingSymbol] && expandingPaytable[expandingSymbol].payout)
    || (paytable[expandingSymbol] && paytable[expandingSymbol].payout);
  
  // High value symbols pay for 2 or more reels, low value for 3 or more.
  // We can determine this by checking if payout exists for count.
  // payout[i] is the payout for (i+1) expanded reels, same convention as line wins.
  const hasWin = payouts && payouts[count - 1] > 0;

  if (!hasWin || count === 0) {
    return null;
  }

  const wins = [];
  const payoutPerLine = payouts[count - 1];
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
    expandingReels,
    expandedPositions,
    wins,
    totalPayoutMultiplier: totalPayout
  };
}

/**
 * Deterministic PRNG (mulberry32). The same seed always produces the same sequence of
 * floats in [0, 1) - this determinism is what makes a spin outcome seedable/replayable.
 * @param {number} seed
 * @returns {function(): number} rng function; call repeatedly for the next float
 */
export function createSeededRng(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

/**
 * Pick a random stop position on each reel strip and read off the visible window.
 * Pure function: the same rng sequence always produces the same grid, which is what
 * makes a spin outcome reproducible from a seed (see SlotEngine.spin()).
 * @param {Array<Array<string>>} reelStrips - one strip (array of symbol names) per reel
 * @param {number} rowsCount - visible rows per reel
 * @param {function(): number} rng - rng function as returned by createSeededRng()
 * @returns {Array<Array<string>>} grid[col][row] of symbol names
 */
export function generateTargetGrid(reelStrips, rowsCount, rng) {
  const grid = [];
  for (let col = 0; col < reelStrips.length; col++) {
    const strip = reelStrips[col];
    const reelCol = [];
    const stopIndex = Math.floor(rng() * strip.length);
    for (let row = 0; row < rowsCount; row++) {
      reelCol.push(strip[(stopIndex + row) % strip.length]);
    }
    grid.push(reelCol);
  }
  return grid;
}

export function generateReel(paytable, targetLength, seed, exclude=[], minScatterGap=3) {
  function _shuffle(array, rng) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // A plain weighted shuffle can, by chance, place the same scatter symbol twice within
  // any minScatterGap-wide window (the visible row window), which silently invalidates
  // the intended scatter-count rarity: two "books" on one reel would let 2 reels produce
  // a 3+ scatter hit instead of needing 3 separate reels. Spread scatter-type symbols out
  // so at most one can ever land in the same visible window.
  function _enforceMinScatterGap(reel, targetSymbols, minGap, rng) {
    const n = reel.length;
    if (n === 0 || targetSymbols.size === 0) return reel;
    const isTarget = (s) => targetSymbols.has(s);
    const circularDist = (a, b) => {
      const d = Math.abs(a - b);
      return Math.min(d, n - d);
    };

    for (let pass = 0; pass < n; pass++) {
      const positions = [];
      for (let i = 0; i < n; i++) if (isTarget(reel[i])) positions.push(i);
      if (positions.length <= 1) return reel;

      let violation = null;
      for (let a = 0; a < positions.length && !violation; a++) {
        for (let b = a + 1; b < positions.length; b++) {
          if (circularDist(positions[a], positions[b]) < minGap) {
            violation = { moveFrom: positions[b], keep: positions.filter((_, idx) => idx !== b) };
            break;
          }
        }
      }
      if (!violation) return reel;

      const candidates = [];
      for (let k = 0; k < n; k++) {
        if (isTarget(reel[k])) continue;
        if (violation.keep.every(p => circularDist(k, p) >= minGap)) candidates.push(k);
      }
      if (candidates.length === 0) return reel; // reel too dense to fully space out; best effort

      const swapIdx = candidates[Math.floor(rng() * candidates.length)];
      [reel[violation.moveFrom], reel[swapIdx]] = [reel[swapIdx], reel[violation.moveFrom]];
    }
    return reel;
  }

  // Step 1 & 2: Compute weights and calculate counts in one pass
  const weights = {};
  for (const symbol in paytable) {
    if (exclude.includes(symbol)) continue;
    weights[symbol] = paytable[symbol].frequency || 1;
  }

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const reel = [];

  // Step 3: Build reel directly from weights and total weight
  for (const symbol in weights) {
    const count = Math.max(1, Math.round((weights[symbol] / totalWeight) * targetLength));
    for (let i = 0; i < count; i++) reel.push(symbol);
  }

  // Step 4: Shuffle with seed
  const rng = createSeededRng(seed);
  _shuffle(reel, rng);

  // Step 5: Guarantee scatter symbols (e.g. book) can never double up inside one visible window
  const scatterSymbols = new Set(
    Object.keys(paytable).filter(s => !exclude.includes(s) && paytable[s].type === 'scatter')
  );
  return _enforceMinScatterGap(reel, scatterSymbols, minScatterGap, rng);
}
