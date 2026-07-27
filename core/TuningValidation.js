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

  return findings;
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
