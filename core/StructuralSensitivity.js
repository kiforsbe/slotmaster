/**
 * Which structural knob actually moves RTP, and by how much.
 *
 * The tuner searches symbol frequencies. On a cluster-cascade game that is the WEAKEST lever it
 * has, and nothing told a developer so. Measured on Candy Frenzy at 849bc8a (40k spins, seed
 * 4242, uniform frequencies):
 *
 *     maxStack      2->9%   3->40%   4->101%   5->189%   6->304%
 *     stackChance 0.1->36%  0.3->101%  0.5->145%  0.7->181%   [1.0->40%, a MODE SWITCH]
 *     minGap        1->105% ... 6->102%                       (flat, at the noise floor)
 *
 * One integer step of `maxStack` is worth +87pp. The entire 84-dimensional frequency search is
 * worth roughly +/-10pp, and on the shipped tables it was worth MINUS 27pp. `minGap`, which had
 * been treated as an RTP tradeoff for weeks, does nothing measurable at all.
 *
 * This module owns the ladders, the elasticity arithmetic and the "how do I reach the target from
 * here" routes. It runs no simulation itself - the caller injects a measure function - so it stays
 * a pure, directly testable unit and cannot accidentally depend on the simulator's own state.
 */

// Structural knobs live on a reel table's `defaults`. Each entry says how to ladder one.
//
// Ladders are deliberately short. The point is to rank knobs by leverage and show the shape of
// each one's response, not to map the space finely - a finer grid costs measurements without
// changing which knob a developer should reach for first.
const KNOB_LADDERS = {
  // Never crosses 1.0. At 1 or above generateReel switches from _computeStackedPlacements to
  // _computeClusterSizes, so a point there is not "more stacking" - it is a different mechanic,
  // and putting it on the same ladder would read as "more stacking pays less".
  stackChance: { values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.7], integer: false, isModeSwitch: (v) => v >= 1 },
  maxStack:    { relative: [-2, -1, 0, 1, 2], integer: true, floorKey: 'minStack', floor: 1 },
  minStack:    { relative: [-1, 0, 1, 2], integer: true, floor: 1, ceilingKey: 'maxStack' },
  minGap:      { values: [1, 2, 4, 6, 8], integer: true, floor: 1 },
};

/**
 * @param {Object[]} reelTables - the game's per-reel frequency tables.
 * @param {Object} opts
 * @param {number} opts.reelLength
 * @returns {Array<{knob: string, current: number, values: number[], integer: boolean, isModeSwitch?: Function}>}
 */
export function buildLadders(reelTables, { reelLength } = {}) {
  const defaults = reelTables?.[0]?.defaults ?? {};
  const ladders = [];

  Object.entries(KNOB_LADDERS).forEach(([knob, spec]) => {
    const current = defaults[knob];
    // A knob the game never configured is not laddered. Reporting an effect for changing
    // something absent from the config is worse than saying nothing about it.
    if (current == null) return;

    const floor = spec.floorKey != null ? (defaults[spec.floorKey] ?? spec.floor ?? 1) : (spec.floor ?? -Infinity);
    const ceiling = spec.ceilingKey != null ? (defaults[spec.ceilingKey] ?? Infinity) : Infinity;

    let values = spec.values
      ? [...spec.values]
      : spec.relative.map(d => current + d);
    values.push(current);
    values = values
      .filter(v => v >= floor && v <= ceiling && (!spec.isModeSwitch || !spec.isModeSwitch(v)))
      .filter(v => !spec.integer || Number.isInteger(v));
    values = [...new Set(values)].sort((a, b) => a - b);

    ladders.push({ knob, current, values, integer: spec.integer, isModeSwitch: spec.isModeSwitch ?? (() => false) });
  });

  // Reel length is not a `defaults` entry but is every bit as structural - it sets how fine the
  // reachable lattice is, which is what makes a trigger-rate target reachable or not.
  if (reelLength > 0) {
    ladders.push({
      knob: 'reelLength', current: reelLength, integer: true,
      values: [reelLength, reelLength * 2, reelLength * 4], isModeSwitch: () => false,
    });
  }

  // Not a reel setting at all - a global multiplier on every payout. Included because it is the
  // one lever whose effect on RTP is exactly linear and therefore solvable in closed form.
  ladders.push({
    knob: 'payoutScale', current: 1, integer: false,
    values: [0.8, 0.9, 1.0, 1.1, 1.25], isModeSwitch: () => false,
  });

  return ladders;
}

/**
 * @param {{rtp: number, triggerRate?: number, hitRate?: number}} baseline - measured at the
 *   current config, under the same conditions as every ladder point.
 * @param {Array<{knob, current, ladder: Array<{value, rtp, triggerRate?, hitRate?}>}>} ladderResults
 * @param {Object} opts
 * @param {number} opts.targetRtp
 * @param {number} opts.noiseFloorPct - 2 sigma of the measurement, in RTP percentage points.
 *   Ladders whose whole span fits inside this are reported as flat rather than given a tiny,
 *   meaningless elasticity.
 */
export function summarize(baseline, ladderResults, { targetRtp, noiseFloorPct = 0 }) {
  const knobs = ladderResults.map(({ knob, current, ladder }) => {
    const sorted = [...ladder].sort((a, b) => a.value - b.value);
    const rtps = sorted.map(p => p.rtp);
    const span = Math.max(...rtps) - Math.min(...rtps);

    // Mean absolute RTP change per unit of the knob, across adjacent ladder steps. Per UNIT, not
    // per step, so knobs on different scales (an integer maxStack against a 0.1-grained
    // stackChance) are directly comparable - which is the whole basis for ranking them.
    let weighted = 0, totalWidth = 0;
    for (let i = 1; i < sorted.length; i++) {
      const width = sorted[i].value - sorted[i - 1].value;
      if (width <= 0) continue;
      weighted += Math.abs(sorted[i].rtp - sorted[i - 1].rtp);
      totalWidth += width;
    }
    const elasticityRtpPerUnit = totalWidth > 0 ? weighted / totalWidth : 0;

    // A ladder whose whole span fits inside twice the noise floor has not demonstrated an effect,
    // and reporting its elasticity would dress a tie up as a finding. Twice, not once, because
    // `span` is the range of several independent measurements, and the range of n noisy samples
    // exceeds a single measurement's own 2-sigma band routinely.
    //
    // This is a deliberately conservative bar, and it means a knob can be reported with a real but
    // tiny elasticity rather than as flat. That is the honest outcome: measured on Candy Frenzy,
    // minGap spans 3.10pp across its whole range against a 1.3pp noise floor - too large to call
    // "no effect", ~90x below maxStack, and best presented as exactly that rather than rounded to
    // either "matters" or "doesn't".
    const flat = span <= noiseFloorPct * 2;

    return { knob, current, ladder: sorted, span, flat, elasticityRtpPerUnit: flat ? 0 : elasticityRtpPerUnit };
  }).sort((a, b) => b.elasticityRtpPerUnit - a.elasticityRtpPerUnit);

  const routesToTarget = [];

  // The exact one. RTP is strictly proportional to a global multiplier on every payout - verified
  // on Candy Frenzy to 5 significant figures at both uniform and heavily skewed frequencies - so
  // this needs no search and no interpolation.
  if (baseline.rtp > 0) {
    routesToTarget.push({ knob: 'payoutScale', value: targetRtp / baseline.rtp, exact: true });
  }

  // Everything else: linear interpolation between the two measured points that bracket the target.
  // A knob whose ladder never reaches the target offers no route at all - extrapolating past the
  // measured range would invent a number ("set minGap to 4.7") that nothing supports.
  knobs.forEach(({ knob, ladder, flat }) => {
    if (flat || knob === 'payoutScale') return;
    for (let i = 1; i < ladder.length; i++) {
      const lo = ladder[i - 1], hi = ladder[i];
      const brackets = (lo.rtp - targetRtp) * (hi.rtp - targetRtp) <= 0;
      if (!brackets || lo.rtp === hi.rtp) continue;
      const t = (targetRtp - lo.rtp) / (hi.rtp - lo.rtp);
      routesToTarget.push({
        knob, value: lo.value + t * (hi.value - lo.value), exact: false,
        interpolatedFrom: [lo.value, hi.value],
      });
      return;
    }
  });

  return { baseline, knobs, routesToTarget, noiseFloorPct, targetRtp };
}
