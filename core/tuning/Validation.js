/**
 * Static, simulation-free checks on a game's tuning configuration.
 *
 * Everything here is arithmetic on the config itself - no reels are built, no spins are run - so
 * it is cheap enough to run unconditionally before every tune, and pure enough to unit-test
 * directly. It exists because the parameters that most determine a game's RTP are hand-written
 * constants that nothing validated. Candy Frenzy shipped a premium payout ladder where a 7-symbol
 * cluster paid 0.50x against a 5-symbol cluster's 2.00x (fixed in 849bc8a), and the tuner ran
 * against it for days - silently optimizing toward an inverted incentive, since the cheapest way
 * to raise RTP under that ladder is to make big clusters RARER.
 *
 * Severity:
 *   'error'   - the config is arithmetically broken; no amount of searching can compensate, so
 *               the tune must not start.
 *   'warning' - very likely a mistake, but a deliberate one is conceivable; reported, tune proceeds.
 *   'note'    - worth knowing, not worth stopping for.
 *
 * Every finding carries a `suggestion`. An error a developer cannot act on is only half reported,
 * and the whole point of this module is to answer "what do I change?" rather than "something is
 * wrong".
 */

/**
 * @param {Object} config
 * @param {Object} config.paytable - the game's real PAYTABLE (rules, not frequencies).
 * @param {Object[]} config.reelFrequencyTables - one per reel, `{ defaults?, symbols }`.
 * @param {number} config.reelLength
 * @param {number} config.reelsCount
 * @param {number} config.rowsCount
 * @param {number|null} [config.minClusterSize] - cluster games only.
 * @param {number|null} [config.scatterTriggerCount] - how many scatters trigger free spins.
 * @returns {Array<{severity: string, code: string, message: string, suggestion: string, subject: Object}>}
 */
export function validateTuningConfig({
  paytable, reelFrequencyTables, reelLength, reelsCount, rowsCount,
  minClusterSize = null, scatterTriggerCount = null,
}) {
  const findings = [];
  const add = (severity, code, message, suggestion, subject = {}) =>
    findings.push({ severity, code, message, suggestion, subject });

  checkPayoutLadders({ paytable, minClusterSize }, add);
  checkGridGeometry({ reelsCount, rowsCount, minClusterSize, scatterTriggerCount }, add);
  (reelFrequencyTables ?? []).forEach((reelTable, reel) => {
    checkReelStructure({ reelTable, reel, reelLength, paytable, multiReel: reelFrequencyTables.length > 1 }, add);
  });

  return findings;
}

// Reels are 0-indexed everywhere in code but exported as FREQUENCY_REEL1..n, so a message naming
// "reel 0" sends a developer looking for something that does not exist in game.js. Messages use
// the 1-based name; `subject.reel` stays 0-based for anything consuming these programmatically.
const reelName = (reel) => `reel ${reel + 1}`;

// ---- Grid geometry ----
// Cheap "can this even happen?" arithmetic. Both of these describe a target that no configuration
// of frequencies can ever produce, which makes them errors rather than warnings.
function checkGridGeometry({ reelsCount, rowsCount, minClusterSize, scatterTriggerCount }, add) {
  const cells = reelsCount * rowsCount;
  if (minClusterSize != null && minClusterSize > cells) {
    add('error', 'cluster-size-reachable',
      `The minimum cluster size (${minClusterSize}) is larger than the whole grid (${reelsCount}x${rowsCount} = ${cells} cells) - no cluster can ever pay.`,
      `Lower minClusterSize to at most ${cells}, or enlarge the grid.`,
      { minClusterSize, cells });
  }
  if (scatterTriggerCount != null && scatterTriggerCount > cells) {
    add('error', 'scatter-trigger-reachable',
      `Free spins need ${scatterTriggerCount} scatters but the grid only has ${cells} cells - the bonus can never trigger.`,
      `Lower the scatter trigger count to at most ${cells}, or enlarge the grid.`,
      { scatterTriggerCount, cells });
  }
}

// ---- Per-reel structure ----
// Resolution order mirrors generateReel's own (symbol override -> reel defaults -> built-in
// fallback, see core/SlotMath.js), so a constraint is read here exactly as the strip builder reads
// it. Reading it any other way would produce findings about a config that is not the one running.
function checkReelStructure({ reelTable, reel, reelLength, paytable, multiReel }, add) {
  const defaults = reelTable.defaults ?? {};
  const symbols = reelTable.symbols ?? {};
  const where = multiReel ? ` on ${reelName(reel)}` : '';
  const resolve = (symbol, key, fallback) => symbols[symbol]?.[key] ?? defaults[key] ?? fallback;

  // stackChance is the single highest-leverage structural knob on a cluster game AND the one with
  // a discontinuity in it - see the warning text. Checked at reel level and per symbol.
  const stackChanceSites = [
    { value: defaults.stackChance, symbol: null },
    ...Object.keys(symbols).map(s => ({ value: symbols[s].stackChance, symbol: s })),
  ].filter(site => site.value != null && site.value >= 1);
  stackChanceSites.forEach(({ value, symbol }) => {
    add('warning', 'stack-chance-mode-switch',
      `stackChance is ${value}${symbol ? ` for ${symbol}` : ''}${where} - at 1 or above generateReel takes a different code path entirely (an even split across clusters), not "always stack".`,
      'Measured on Candy Frenzy at uniform frequencies, stackChance 0.7 pays 181% RTP and 1.0 pays 40%. It is not a continuum: 1 or above switches from _computeStackedPlacements to _computeClusterSizes. Use 0.9 if you want "nearly always stacked"; use 1 only if you specifically want the even-split behavior.',
      { reel, symbol, stackChance: value });
  });

  // Contradictions are reported once at the level where they were CONFIGURED, not once per symbol
  // that inherits them. A reel-level `minStack: 5, maxStack: 3` is one mistake in one line of
  // game.js; reporting it once per symbol would bury it twelve-deep on a real reel and imply
  // twelve separate things to fix. Symbols are only reported when their own override is what
  // creates the contradiction.
  const checkStackPair = (minStack, maxStack, symbol) => {
    const subject = symbol ? `${symbol}${where}` : `${where.trim() || 'this reel'}'s defaults`;
    if (minStack > maxStack) {
      add('error', 'stack-bounds',
        `${subject} has minStack ${minStack} above maxStack ${maxStack} - no run length satisfies both.`,
        `Set minStack to at most ${maxStack}, or raise maxStack to at least ${minStack}.`,
        { reel, symbol: symbol ?? null, minStack, maxStack });
    } else if (minStack < 1 || maxStack < 1) {
      add('error', 'stack-bounds',
        `${subject} has a stack bound below 1 (minStack ${minStack}, maxStack ${maxStack}) - a run cannot be shorter than one position.`,
        'Set both to 1 or higher.',
        { reel, symbol: symbol ?? null, minStack, maxStack });
    }
  };
  const defaultMinStack = defaults.minStack ?? 1;
  const defaultMaxStack = defaults.maxStack ?? Infinity;
  checkStackPair(defaultMinStack, defaultMaxStack, null);
  Object.keys(symbols).forEach(symbol => {
    if (symbols[symbol].minStack == null && symbols[symbol].maxStack == null) return;
    const minStack = resolve(symbol, 'minStack', 1);
    const maxStack = resolve(symbol, 'maxStack', Infinity);
    // Already reported at reel level if the symbol changed neither side of the comparison.
    if (minStack === defaultMinStack && maxStack === defaultMaxStack) return;
    checkStackPair(minStack, maxStack, symbol);
  });

  const checkFrequencyPair = (min, max, symbol) => {
    if (min == null || max == null || min <= max) return;
    const subject = symbol ? `${symbol}${where}` : `${where.trim() || 'this reel'}'s defaults`;
    add('error', 'frequency-bounds-contradiction',
      `${subject} has minFrequency ${min} above maxFrequency ${max} - the limit penalty can never reach zero.`,
      `Swap them, or widen one. As it stands every candidate violates one bound or the other, so the search carries a floor of unavoidable penalty and can never report a clean 'converged'.`,
      { reel, symbol: symbol ?? null, minFrequency: min, maxFrequency: max });
  };
  checkFrequencyPair(defaults.minFrequency, defaults.maxFrequency, null);
  Object.keys(symbols).forEach(symbol => {
    if (symbols[symbol].minFrequency == null && symbols[symbol].maxFrequency == null) return;
    const min = symbols[symbol].minFrequency ?? defaults.minFrequency;
    const max = symbols[symbol].maxFrequency ?? defaults.maxFrequency;
    if (min === defaults.minFrequency && max === defaults.maxFrequency) return;
    checkFrequencyPair(min, max, symbol);
  });

  // The hard floor: a symbol whose runs must sit `minGap` apart can have at most
  // floor(reelLength / minGap) of them, and every symbol on the reel needs at least one run. Below
  // this length no arrangement satisfies the constraint - and generateReel does not fail, it hits
  // its `candidates.length === 0` bailout and silently returns a strip that clumps far more than
  // the config asked for.
  const present = Object.keys(symbols).filter(s => symbols[s].frequency > 0);
  const worstGap = present.reduce((worst, s) => {
    const gap = resolve(s, 'minGap', paytable?.[s]?.triggerFreeSpins === true ? 3 : 1);
    return Math.max(worst, gap);
  }, 1);
  const needed = present.length * worstGap;
  if (worstGap > 1 && needed > reelLength) {
    add('error', 'reel-length-floor',
      `${present.length} symbols${where} each needing minGap ${worstGap} require at least ${needed} strip positions, but the reel length is ${reelLength}.`,
      `Raise reel length to at least ${needed}, lower minGap to ${Math.floor(reelLength / present.length)} or below, or carry fewer symbols on this reel. generateReel will not report this: it enforces spacing best-effort and silently gives up on a strip too dense, so the shipped reels clump far more than the config asks.`,
      { reel, symbolCount: present.length, minGap: worstGap, needed, reelLength });
  }
}

// ---- Payout ladders ----
// A cluster game's `clusterPayout` is an ordered list of `{ min, multiplier }` breakpoints. Three
// things can be wrong with one, and all three are invisible at a glance in a game.js file.
function checkPayoutLadders({ paytable, minClusterSize }, add) {
  const topTierOf = (entry) => {
    const ladder = entry.clusterPayout;
    return Array.isArray(ladder) && ladder.length ? ladder[ladder.length - 1].multiplier : null;
  };

  Object.entries(paytable).forEach(([symbol, entry]) => {
    const ladder = entry.clusterPayout;
    if (!Array.isArray(ladder) || ladder.length === 0) return;

    for (let i = 1; i < ladder.length; i++) {
      if (ladder[i].min <= ladder[i - 1].min) {
        add('error', 'payout-ladder-unsorted',
          `${symbol}'s payout ladder is not sorted by cluster size: tier ${i} starts at ${ladder[i].min} after ${ladder[i - 1].min}.`,
          'Sort clusterPayout ascending by `min`. Symbol ranking reads the LAST tier only, so an unsorted ladder mis-ranks this symbol against every other one and silently inverts the ordering preference for it.',
          { symbol, index: i, min: ladder[i].min });
      }
      if (ladder[i].multiplier < ladder[i - 1].multiplier) {
        add('error', 'payout-ladder-non-monotone',
          `${symbol} pays LESS for a bigger cluster: ${ladder[i].min}+ pays ${ladder[i].multiplier}x but ${ladder[i - 1].min}+ pays ${ladder[i - 1].multiplier}x.`,
          `Raise the ${ladder[i].min}+ multiplier above ${ladder[i - 1].multiplier}x. Until then the cheapest way for the tuner to raise RTP is to make big clusters RARER, so every frequency it derives is shaped by an inverted incentive.`,
          { symbol, min: ladder[i].min, multiplier: ladder[i].multiplier, previousMultiplier: ladder[i - 1].multiplier });
      }
    }

    if (minClusterSize != null && ladder[0].min < minClusterSize) {
      add('warning', 'payout-ladder-floor',
        `${symbol}'s lowest payout tier starts at ${ladder[0].min}, below the minimum cluster size of ${minClusterSize} - it can never pay.`,
        `Raise that tier's min to ${minClusterSize}, or remove it. A tier below the cluster floor is dead weight that makes the ladder look more generous than it is.`,
        { symbol, min: ladder[0].min, minClusterSize });
    }
  });

  // A "premium" that tops out below a "regular" makes the ordering preference fight itself: the
  // type labels say one thing about which symbol should be rarer and the payouts say the other.
  const topByType = {};
  Object.entries(paytable).forEach(([symbol, entry]) => {
    const top = topTierOf(entry);
    if (top == null || !entry.type) return;
    (topByType[entry.type] ??= []).push({ symbol, top });
  });
  const premiums = topByType.premium ?? [];
  const regulars = topByType.regular ?? [];
  premiums.forEach(p => {
    regulars.forEach(r => {
      if (p.top >= r.top) return;
      add('warning', 'tier-inversion',
        `${p.symbol} is typed 'premium' but tops out at ${p.top}x, below the 'regular' ${r.symbol} at ${r.top}x.`,
        `Either raise ${p.symbol}'s top tier above ${r.top}x or retype it. Symbols are ranked by payout, not by type, so as it stands the ordering preference will try to make ${r.symbol} the rarer of the two - the opposite of what the type labels imply.`,
        { symbol: p.symbol, topMultiplier: p.top, comparedTo: r.symbol, comparedTopMultiplier: r.top });
    });
  });
}
