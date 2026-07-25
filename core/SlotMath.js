// Core Slot Mathematics Engine

/**
 * Check normal line wins and scatters for a slot grid.
 * Grid structure: grid[col][row], where col is 0..reelsCount-1 and row is 0..rowsCount-1.
 * @param {Array<Array<string>>} grid - reelsCount x rowsCount grid of symbol names
 * @param {Object} paytable - Maps symbol names to payout arrays (indexed by hit count)
 * @param {Array<Array<number>>} paylines - Payline definitions; each entry has one row index per reel
 * @param {number} activeLinesCount - Number of active paylines (default 10)
 * @param {string|null} wildSymbol - Symbol that acts as wild (default none)
 * @param {string|null} scatterSymbol - Symbol that acts as scatter (default none)
 * @param {number} scatterTriggerCount - Minimum scatter count to trigger free spins (default 3)
 * @returns {Object} Object containing lineWins, scatterWin, and total payouts
 */
export function checkWins(grid, paytable, paylines, activeLinesCount = 10, wildSymbol = null, scatterSymbol = null, scatterTriggerCount = 3) {
  // Input validation
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0) {
    throw new Error('Grid must be a non-empty reelsCount x rowsCount array');
  }
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('Invalid paytable');
  }
  if (!paylines || !Array.isArray(paylines) || paylines.length === 0) {
    throw new Error('paylines must be a non-empty array');
  }
  const reelsCount = grid.length;
  const rowsCount = grid[0].length;
  activeLinesCount = Math.min(activeLinesCount, paylines.length);

  const lineWins = [];
  let totalLinePayoutMultiplier = 0;

  // 1. Evaluate Line Wins (Left to Right)
  for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, paylines.length); lineIdx++) {
    const path = paylines[lineIdx];

    // Read symbols along the line path
    const lineSymbols = [];
    for (let col = 0; col < reelsCount; col++) {
      const row = path[col];
      lineSymbols.push(grid[col][row]);
    }

    // Determine the winning combination starting from the left
    let matchCount = 0;
    let targetSymbol = null;
    const winningPositions = [];

    for (let col = 0; col < reelsCount; col++) {
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
  for (let col = 0; col < reelsCount; col++) {
    for (let row = 0; row < rowsCount; row++) {
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
 * @param {Array<Array<string>>} grid - reelsCount x rowsCount grid of symbol names
 * @param {string} expandingSymbol - The symbol that expands during free spins
 * @param {Object} paytable - Maps symbol names to payout arrays (used for fallback)
 * @param {Array<Array<number>>} paylines - Payline definitions; each entry has one row index per reel
 * @param {number} activeLinesCount - Number of active paylines (default 10)
 * @param {Object|null} expandingPaytable - Separate paytable for expanding wins; if null, falls back to paytable
 * @returns {Object|null} Expanding win data or null if no win
 */
export function checkExpandingWins(grid, expandingSymbol, paytable, paylines, activeLinesCount = 10, expandingPaytable = null) {
  // Input validation
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0) {
    throw new Error('Grid must be a non-empty reelsCount x rowsCount array');
  }
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('Invalid paytable');
  }
  if (!paylines || !Array.isArray(paylines) || paylines.length === 0) {
    throw new Error('paylines must be a non-empty array');
  }
  const reelsCount = grid.length;
  const rowsCount = grid[0].length;

  // Find which reels contain the expanding symbol
  const expandingReels = [];
  const expandedPositions = [];

  for (let col = 0; col < reelsCount; col++) {
    let hasSymbol = false;
    for (let row = 0; row < rowsCount; row++) {
      if (grid[col][row] === expandingSymbol) {
        hasSymbol = true;
        break;
      }
    }
    if (hasSymbol) {
      expandingReels.push(col);
      // Once expanded, the symbol occupies every row of this column
      for (let row = 0; row < rowsCount; row++) {
        expandedPositions.push([col, row]);
      }
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
  for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, paylines.length); lineIdx++) {
    wins.push({
      lineIndex: lineIdx,
      symbol: expandingSymbol,
      count: count,
      payout: payoutPerLine,
      // The winning positions on this payline are the intersections of the payline and the expanded columns
      winningPositions: paylines[lineIdx].map((row, col) => {
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
 * Check line wins where certain symbols act as wilds restricted to the LAST grid position
 * of a line only, with optional per-target-symbol payout penalties and a flat "lands but
 * doesn't complete a win" bonus for a wild symbol. Fully data-driven from paytable fields -
 * no symbol names are hardcoded here, so this is reusable by any game with reel-restricted
 * wilds, not just one specific paytable.
 *
 * Paytable fields read (all optional except payout):
 *   payout: [pay-for-1, pay-for-2, ..., pay-for-reelsCount] per symbol, left-to-right from reel 1.
 *   wild: true - this symbol can substitute in the LAST grid position of a line only.
 *   wildExcludes: [symbols] - target symbols this wild can NOT substitute for.
 *   wildOnly: [symbols] - if present, this wild substitutes ONLY for these target symbols.
 *   wildPenalty: number - subtracted from the full-match payout when won via this wild.
 *   aloneBonus: number - flat payout when this wild lands in the last position without
 *     completing a win for that line.
 *
 * @param {Array<Array<string>>} grid - reelsCount x rowsCount grid of symbol names
 * @param {Object} paytable - see field table above
 * @param {Array<Array<number>>} paylines - payline definitions, one row index per reel
 * @param {number} activeLinesCount - number of active paylines to evaluate
 * @returns {Object} { lineWins, totalLinePayoutMultiplier }
 */
export function checkWildLineWins(grid, paytable, paylines, activeLinesCount) {
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0) {
    throw new Error('Grid must be a non-empty reelsCount x rowsCount array');
  }
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('Invalid paytable');
  }
  if (!paylines || !Array.isArray(paylines) || paylines.length === 0) {
    throw new Error('paylines must be a non-empty array');
  }

  const reelsCount = grid.length;
  const isWildFor = (wildSymbolName, targetSymbol) => {
    const meta = paytable[wildSymbolName];
    if (!meta || !meta.wild) return false;
    if (meta.wildOnly) return meta.wildOnly.includes(targetSymbol);
    if (meta.wildExcludes) return !meta.wildExcludes.includes(targetSymbol);
    return true;
  };

  const lineWins = [];
  let totalLinePayoutMultiplier = 0;

  for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, paylines.length); lineIdx++) {
    const path = paylines[lineIdx];
    const lineSymbols = [];
    for (let col = 0; col < reelsCount; col++) {
      lineSymbols.push(grid[col][path[col]]);
    }

    const s0 = lineSymbols[0];
    const lastCol = reelsCount - 1;
    const lastSymbol = lineSymbols[lastCol];
    const s0Meta = paytable[s0];

    // 1. Natural contiguous run length from reel 1
    let run = 1;
    for (let col = 1; col < reelsCount; col++) {
      if (lineSymbols[col] === s0) run++;
      else break;
    }

    let payout = 0;
    let wildUsed = false;

    if (run === reelsCount) {
      // Natural full match
      payout = (s0Meta && s0Meta.payout && s0Meta.payout[run - 1]) || 0;
    } else if (run === reelsCount - 1 && isWildFor(lastSymbol, s0)) {
      // A wild in the last position completes the match
      const fullPayout = (s0Meta && s0Meta.payout && s0Meta.payout[reelsCount - 1]) || 0;
      const penalty = (s0Meta && s0Meta.wildPenalty) || 0;
      payout = Math.max(0, fullPayout - penalty);
      wildUsed = true;
    } else if (s0Meta && s0Meta.payout && s0Meta.payout[run - 1] > 0) {
      // Partial match - only symbols with a nonzero partial payout (e.g. cherries) pay here
      payout = s0Meta.payout[run - 1];
    }

    // 2. Alone bonus: the last symbol has one defined, and it wasn't already used above
    // to complete a win (using it for both would double-pay the same wild).
    const lastMeta = paytable[lastSymbol];
    let aloneBonus = 0;
    if (lastMeta && lastMeta.aloneBonus && !wildUsed) {
      aloneBonus = lastMeta.aloneBonus;
    }

    const totalLinePayout = payout + aloneBonus;
    if (totalLinePayout > 0) {
      // Reported as up to two separate wins rather than one combined entry under `s0` -
      // a wild-completed match and an unrelated alone-bonus payout are different events
      // that can co-occur on the same line, and folding them together previously made
      // per-symbol win breakdowns misattribute the alone bonus to whatever symbol was on
      // reel 1, and hid wild-assisted matches behind a "partial pay" looking count.
      if (payout > 0) {
        const winningPositions = [];
        for (let col = 0; col < run; col++) {
          winningPositions.push([col, path[col]]);
        }
        if (wildUsed) {
          winningPositions.push([lastCol, path[lastCol]]);
        }

        lineWins.push({
          lineIndex: lineIdx,
          symbol: s0,
          count: run,
          payout,
          winningPositions,
          wildUsed
        });
      }
      if (aloneBonus > 0) {
        lineWins.push({
          lineIndex: lineIdx,
          symbol: lastSymbol,
          count: 1,
          payout: aloneBonus,
          winningPositions: [[lastCol, path[lastCol]]],
          alone: true
        });
      }
      totalLinePayoutMultiplier += totalLinePayout;
    }
  }

  return { lineWins, totalLinePayoutMultiplier };
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

/**
 * Builds one weighted reel strip, with optional per-symbol spacing constraints.
 *
 * `reelWeights` is either the structured shape `{ defaults?: { minGap?, maxStack? },
 * symbols: { symbol: { frequency, minGap?, maxStack?, ... } } }`, or a flat legacy shape
 * (`{ symbol: { frequency, ... } }` directly, no `.symbols` wrapper) - auto-detected by the
 * presence of a `.symbols` key. The flat shape has no way to express reel-level defaults.
 *
 * Two independent spacing constraints, each resolved per symbol as: symbol-level override ->
 * reel `defaults` -> built-in fallback (`minGap: 1` / `maxStack: Infinity`, i.e.
 * unconstrained - except a symbol with `paytable[symbol].triggerFreeSpins === true` falls
 * back to `defaultTriggerMinGap` instead of 1, so a free-spins-triggering symbol is spaced
 * out by default without needing to be configured):
 *   - `minGap`: minimum circular distance enforced between any two occurrences of that
 *     symbol on the built strip (self-spacing only - a symbol's minGap constrains its own
 *     occurrences relative to each other, not to other symbols).
 *   - `maxStack`: maximum run length of consecutive identical occurrences of that symbol
 *     allowed on the built strip (circular - a run can wrap from the end to the start).
 * Both are best-effort: a reel too dense to fully satisfy a constraint just gets as close as
 * it can, it doesn't throw or infinite-loop.
 *
 * @param {Object} reelWeights - This reel's own weights (see shape above).
 * @param {number} targetLength - Desired reel strip length.
 * @param {number} seed - RNG seed for the shuffle and constraint repairs (deterministic).
 * @param {string[]} [exclude=[]] - Symbols to omit from this reel entirely.
 * @param {number} [defaultTriggerMinGap=3] - Fallback `minGap` for a symbol with
 *   `paytable[symbol].triggerFreeSpins === true`, when neither the symbol nor the reel's
 *   `defaults` specify one.
 * @param {Object} [paytable=reelWeights] - Rules table read only for `.triggerFreeSpins` -
 *   defaults to `reelWeights` itself so a caller passing one flat combined table (frequency +
 *   triggerFreeSpins together) keeps working unchanged. A per-reel weights table (which
 *   carries neither) needs the real canonical paytable passed here explicitly instead.
 * @returns {string[]} The built reel strip (symbol names, length ~targetLength).
 */
export function generateReel(reelWeights, targetLength, seed, exclude=[], defaultTriggerMinGap=3, paytable=reelWeights) {
  const symbolsTable = reelWeights.symbols || reelWeights;
  const reelDefaults = reelWeights.defaults || {};

  function _shuffle(array, rng) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // A plain weighted shuffle can, by chance, place two occurrences of the same
  // minGap-constrained symbol within `minGap` positions of each other. Spread them out so no
  // two ever land within that circular distance.
  function _enforceMinGap(reel, symbol, minGap, rng) {
    const n = reel.length;
    if (n === 0 || minGap <= 1) return reel;
    const circularDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n - d); };

    for (let pass = 0; pass < n; pass++) {
      const positions = [];
      for (let i = 0; i < n; i++) if (reel[i] === symbol) positions.push(i);
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
        if (reel[k] === symbol) continue;
        if (violation.keep.every(p => circularDist(k, p) >= minGap)) candidates.push(k);
      }
      if (candidates.length === 0) return reel; // reel too dense to fully space out; best effort

      const swapIdx = candidates[Math.floor(rng() * candidates.length)];
      [reel[violation.moveFrom], reel[swapIdx]] = [reel[swapIdx], reel[violation.moveFrom]];
    }
    return reel;
  }

  // Caps how many times `symbol` can appear consecutively (circularly) in a row. Finds a
  // "seam" (a position where the run breaks) to scan linearly from, since the strip wraps -
  // if the whole reel is one symbol, there's no seam and nothing to do (best effort).
  function _enforceMaxStack(reel, symbol, maxStack, rng) {
    const n = reel.length;
    if (n === 0 || maxStack >= n) return reel;

    for (let pass = 0; pass < n; pass++) {
      let seam = -1;
      for (let i = 0; i < n; i++) {
        if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; }
      }
      if (seam === -1) return reel; // entire reel is one symbol - best effort, give up

      let violation = null;
      let i = 0;
      while (i < n) {
        const idx = (seam + i) % n;
        if (reel[idx] === symbol) {
          let runLen = 1;
          while (runLen < n && reel[(seam + i + runLen) % n] === symbol) runLen++;
          if (runLen > maxStack) { violation = { start: i }; break; }
          i += runLen;
        } else {
          i++;
        }
      }
      if (!violation) return reel;

      const excessIdx = (seam + violation.start + maxStack) % n;
      const candidates = [];
      for (let k = 0; k < n; k++) { if (reel[k] !== symbol) candidates.push(k); }
      if (candidates.length === 0) return reel; // nothing to swap with - best effort

      const swapIdx = candidates[Math.floor(rng() * candidates.length)];
      [reel[excessIdx], reel[swapIdx]] = [reel[swapIdx], reel[excessIdx]];
    }
    return reel;
  }

  // Step 1 & 2: Compute weights and calculate counts in one pass. An explicit
  // frequency: 0 means "never place this symbol on this reel" - excluded from `weights`
  // entirely, same as `exclude` - not defaulted to 1 (which `freq || 1` did, since 0 is
  // falsy) and not floored to a guaranteed single occurrence below.
  const weights = {};
  for (const symbol in symbolsTable) {
    if (exclude.includes(symbol)) continue;
    const freq = symbolsTable[symbol].frequency ?? 1;
    if (freq > 0) weights[symbol] = freq;
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

  // Step 5: Apply each present symbol's own minGap/maxStack - resolved as symbol override ->
  // reel defaults -> built-in fallback. minGap passes run first (the coarser, whole-strip
  // constraint), then maxStack cleans up runs in the result, so a minGap swap can't undo a
  // maxStack fix.
  function resolveMinGap(symbol) {
    const override = symbolsTable[symbol].minGap;
    if (override != null) return override;
    if (reelDefaults.minGap != null) return reelDefaults.minGap;
    const triggersFreeSpins = paytable[symbol] && paytable[symbol].triggerFreeSpins === true;
    return triggersFreeSpins ? defaultTriggerMinGap : 1;
  }
  function resolveMaxStack(symbol) {
    const override = symbolsTable[symbol].maxStack;
    if (override != null) return override;
    if (reelDefaults.maxStack != null) return reelDefaults.maxStack;
    return Infinity;
  }

  for (const symbol in weights) {
    const gap = resolveMinGap(symbol);
    if (gap > 1) _enforceMinGap(reel, symbol, gap, rng);
  }
  for (const symbol in weights) {
    const cap = resolveMaxStack(symbol);
    if (cap < Infinity) _enforceMaxStack(reel, symbol, cap, rng);
  }

  return reel;
}
