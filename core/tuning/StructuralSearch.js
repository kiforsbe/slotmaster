/**
 * What should I set the structural knobs TO?
 *
 * Phase 0c (core/StructuralSensitivity.js) ranks knobs one at a time: it answers "which knob do I
 * turn" and "how far, if I turn only that one". Neither question is quite the one a developer
 * actually has, because the knobs interact - `maxStack` only matters if `stackChance` is high
 * enough to produce vertical runs at all, so the one-at-a-time elasticity of each understates what
 * they do together. This module searches them jointly and hands back a single combination to
 * accept or reject.
 *
 * Grid search, deliberately, not CMA-ES or a simplex. Three of the four knobs are small integers,
 * and the continuous one has a mode discontinuity at 1.0 (`resolveStackChance() >= 1` switches
 * generateReel from _computeStackedPlacements to _computeClusterSizes - a different mechanic, not
 * more stacking). A method that assumes a smooth continuous landscape is the wrong tool for a
 * space that is mostly a handful of integers with a cliff in it.
 *
 * The affordability trick is that the grid is RANKED for free and MEASURED sparingly. Every cell's
 * RTP is predicted by composing Phase 0c's already-paid-for ladder ratios; only the handful of
 * cells that prediction likes are ever simulated. 600 cells cost 8 measurements.
 *
 * Runs no simulation itself - the caller injects `measure` - so it stays a pure, directly testable
 * unit, the same way core/StructuralSensitivity.js does.
 */

// The reel-arrangement knobs, which is to say the ones that live on a reel table's `defaults` and
// are reachable through `withStructuralDefaults`.
//
// `payoutScale` and `reelLength` are deliberately absent even though Phase 0c ladders both.
// payoutScale is an EXACT lever - RTP is strictly proportional to it - so it is solved in closed
// form and searching it would spend measurements rediscovering arithmetic. reelLength is not a
// free RTP dial either: it sets simulation cost and the granularity of the trigger-rate lattice,
// so moving it to hit an RTP target trades away something the developer never offered.
export const SEARCHABLE_KNOBS = ['stackChance', 'maxStack', 'minStack', 'minGap'];

// Knobs whose values are continuous, and therefore worth bisecting between measured ladder points.
// An integer knob has nothing between 3 and 4 to look at.
const CONTINUOUS_KNOBS = new Set(['stackChance']);

// Crossing this is a change of mechanic rather than more of the same knob (see the module doc), so
// a recommendation never does it silently, whatever respectDesignIntent says.
const MODE_SWITCH = { stackChance: (v) => v >= 1 };

function ladderFor(ladders, knob) {
  return ladders.find(l => l.knob === knob) ?? null;
}

/** Every combination of the requested knobs' measured ladder values. */
export function buildGrid(ladders, knobNames) {
  let cells = [{}];
  knobNames.forEach(knob => {
    const l = ladderFor(ladders, knob);
    if (!l) return;
    const values = l.ladder.map(p => p.value).filter(v => !(MODE_SWITCH[knob]?.(v)));
    const next = [];
    cells.forEach(cell => values.forEach(value => next.push({ ...cell, [knob]: value })));
    cells = next;
  });
  return cells.filter(c => Object.keys(c).length > 0);
}

/**
 * Predicted RTP for a cell, by composing each knob's own measured ratio against its current value.
 *
 * An approximation, and knowingly so - it assumes the knobs' effects multiply, which they only
 * roughly do. It is used to RANK cells for measurement, never to report a result: what comes back
 * from `structuralSearch` is always a number that was actually simulated.
 */
export function predictRtp(cell, ladders, baselineRtp) {
  let rtp = baselineRtp;
  Object.entries(cell).forEach(([knob, value]) => {
    const l = ladderFor(ladders, knob);
    if (!l) return;
    const at = l.ladder.find(p => p.value === value);
    const atCurrent = l.ladder.find(p => p.value === l.current);
    if (!at || !atCurrent || !(atCurrent.rtp > 0)) return;
    rtp *= at.rtp / atCurrent.rtp;
  });
  return rtp;
}

// Internally contradictory combinations are worse than no recommendation: generateReel resolves
// them silently, in a way nobody chose.
function isCoherent(cell, currentOf) {
  const minStack = cell.minStack ?? currentOf('minStack');
  const maxStack = cell.maxStack ?? currentOf('maxStack');
  if (minStack != null && maxStack != null && minStack > maxStack) return false;
  return true;
}

// Sum of each knob's move as a fraction of its own laddered range, so knobs on different scales
// contribute comparably - the same reasoning that makes Phase 0c's elasticity per UNIT rather
// than per step.
function distanceFromCurrent(cell, ladders) {
  let d = 0;
  Object.entries(cell).forEach(([knob, value]) => {
    const l = ladderFor(ladders, knob);
    if (!l) return;
    const values = l.ladder.map(p => p.value);
    const range = Math.max(...values) - Math.min(...values);
    d += Math.abs(value - l.current) / (range || 1);
  });
  return d;
}

/**
 * @param {Object} args
 * @param {Array} args.ladders - Phase 0c's ladder results: `{knob, current, flat, ladder: [{value, rtp}]}`.
 * @param {number} args.baselineRtp - RTP at the current settings, measured under the same conditions.
 * @param {number} args.targetRtp
 * @param {number} [args.rtpTolerancePct=1.5]
 * @param {string[]} [args.knobs] - which knobs to search. Defaults to every searchable knob Phase
 *   0c found a measurable effect for.
 * @param {boolean} [args.respectDesignIntent=true] - among combinations that hit the target, prefer
 *   the one that moves least from what the developer already chose.
 * @param {number} [args.maxMeasurements=8] - hard cap on simulations spent ranking cells.
 * @param {boolean} [args.refine=true] - bisect continuous knobs around the winner.
 * @param {Function} args.measure - `(params) => Promise<{rtp}>`.
 * @param {Function} [args.onPoint] - called with each measured cell as it lands.
 * @param {{aborted: boolean}} [args.signal]
 */
export async function structuralSearch({
  ladders, baselineRtp, targetRtp, rtpTolerancePct = 1.5, noiseFloorPct = 0,
  knobs = null, respectDesignIntent = true, maxMeasurements = 8, refine = true,
  measure, onPoint = null, signal = null,
}) {
  // The band this search can actually resolve. When the sweep's own noise floor is wider than the
  // RTP tolerance - on Candy Frenzy, measured, ±17.89pp against a ±1.5pp tolerance - then "landed
  // within 1.5pp of target" is not a property of the cell, it is a property of the draw. Measure
  // ten cells at that noise level and one will hit the band by chance; picking it and calling it a
  // recommendation is the multiple-comparisons trap, and it is the same mistake as comparing two
  // stages' carried losses across different Monte Carlo draws.
  //
  // So selection widens to what is measurable, and `resolvable` records whether the distinction
  // being drawn is real. It never silently narrows: a claim this search cannot support is not made.
  const resolvable = noiseFloorPct <= rtpTolerancePct;
  const selectionBand = Math.max(rtpTolerancePct, noiseFloorPct);
  // A knob Phase 0c measured as flat is an axis known to be noise. Searching it anyway multiplies
  // the grid - and therefore the measurements - to explore something already established as
  // pointless. An explicit list overrules that: the caller may know something the sweep didn't.
  const knobsSearched = (knobs ?? SEARCHABLE_KNOBS.filter(k => {
    const l = ladderFor(ladders, k);
    return l && !l.flat;
  })).filter(k => SEARCHABLE_KNOBS.includes(k) && ladderFor(ladders, k));

  const currentOf = (knob) => ladderFor(ladders, knob)?.current ?? null;
  const current = {};
  knobsSearched.forEach(k => { current[k] = currentOf(k); });

  if (knobsSearched.length === 0) {
    return {
      knobs: {}, knobsSearched: [], current, targetRtp,
      predictedRtp: baselineRtp, measuredRtp: null, measurementsUsed: 0,
      reachedTarget: false, appliedAutomatically: false, candidates: [],
      note: 'No structural knob had a measurable effect to search - nothing here can move RTP, so there is nothing to recommend.',
    };
  }

  const grid = buildGrid(ladders, knobsSearched)
    .filter(cell => isCoherent(cell, currentOf))
    .map(cell => ({ cell, predictedRtp: predictRtp(cell, ladders, baselineRtp) }))
    .sort((a, b) => Math.abs(a.predictedRtp - targetRtp) - Math.abs(b.predictedRtp - targetRtp));

  const measured = [];
  const runCell = async (cell, predictedRtp) => {
    const m = await measure(cell);
    const point = { knobs: cell, predictedRtp, rtp: m.rtp, error: Math.abs(m.rtp - targetRtp) };
    measured.push(point);
    if (onPoint) await onPoint(point);
    return point;
  };

  for (const { cell, predictedRtp } of grid.slice(0, maxMeasurements)) {
    if (signal?.aborted) break;
    await runCell(cell, predictedRtp);
  }

  if (measured.length === 0) {
    return {
      knobs: {}, knobsSearched, current, targetRtp,
      predictedRtp: baselineRtp, measuredRtp: null, measurementsUsed: 0,
      reachedTarget: false, appliedAutomatically: false, candidates: [],
      note: 'The structural search was stopped before it measured anything.',
    };
  }

  // Among everything that actually hit the target, prefer the smallest change - see
  // distanceFromCurrent. With nothing inside tolerance there is no choice to make: take the
  // closest miss and say plainly that it missed.
  const inBand = measured.filter(p => p.error <= selectionBand);
  let best;
  if (respectDesignIntent && inBand.length > 0) {
    best = inBand.slice().sort((a, b) =>
      distanceFromCurrent(a.knobs, ladders) - distanceFromCurrent(b.knobs, ladders))[0];
  } else {
    best = measured.slice().sort((a, b) => a.error - b.error)[0];
  }

  // Local refinement, continuous knobs only: bisect between the winning value and each of its
  // measured neighbours. Integers have nothing in between to look at, and the ladder points ARE
  // the reachable values.
  if (refine && !signal?.aborted) {
    for (const knob of knobsSearched) {
      if (!CONTINUOUS_KNOBS.has(knob) || signal?.aborted) continue;
      const l = ladderFor(ladders, knob);
      const values = l.ladder.map(p => p.value).sort((a, b) => a - b);
      const i = values.indexOf(best.knobs[knob]);
      const midpoints = [values[i - 1], values[i + 1]]
        .filter(v => v != null)
        .map(v => (v + best.knobs[knob]) / 2)
        .filter(v => !(MODE_SWITCH[knob]?.(v)));
      for (const value of midpoints) {
        if (signal?.aborted) break;
        const cell = { ...best.knobs, [knob]: value };
        if (!isCoherent(cell, currentOf)) continue;
        const point = await runCell(cell, predictRtp(cell, ladders, baselineRtp));
        if (point.error < best.error) best = point;
      }
    }
  }

  // Strict: the claim "this hits your target" is only ever made against the tolerance the caller
  // asked for, never against the widened selection band.
  const reachedTarget = best.error <= rtpTolerancePct;
  const indistinguishable = measured.filter(p => p.error <= selectionBand).length;
  // Which of the searched knobs actually moved. Separate from `knobs` rather than replacing it: a
  // caller building the recommended tables needs every searched value (including the ones that
  // came back unchanged, which is a real finding - "leave this alone" is advice), while a reader
  // needs the difference highlighted rather than having to diff two lists themselves.
  const changed = {};
  Object.entries(best.knobs).forEach(([k, v]) => { if (v !== current[k]) changed[k] = v; });

  return {
    knobs: best.knobs,
    changed,
    knobsSearched,
    current,
    targetRtp,
    // Which selection rule produced this, since the two answer different questions - "the smallest
    // change that hits the target" and "the closest to the target" are not the same recommendation
    // and a reader should not have to guess which one they are looking at.
    respectedDesignIntent: respectDesignIntent,
    predictedRtp: best.predictedRtp,
    // Always a simulated number, never the prediction - see predictRtp's own doc.
    measuredRtp: best.rtp,
    measurementsUsed: measured.length,
    reachedTarget,
    // Whether the measurements could tell these combinations apart at all. False means every
    // number above is a draw, not a finding - see selectionBand.
    resolvable,
    noiseFloorPct,
    indistinguishable,
    // Never true. Which structural values a game ships is a design decision, and this whole
    // package exists to put the developer in a position to accept or reject one.
    appliedAutomatically: false,
    candidates: measured.slice().sort((a, b) => a.error - b.error).slice(0, 5),
    // Deliberately never states a conclusion the measurements cannot support. An unresolvable run
    // says so first, because "nothing needs changing" read off a ±18pp measurement is not a
    // conservative recommendation - it is a wrong one that happens to look reassuring.
    note: !resolvable
      ? `These measurements cannot tell the combinations apart: the sweep's own noise floor is ±${noiseFloorPct.toFixed(2)}pp, `
        + `wider than the ±${rtpTolerancePct}pp tolerance being tested against, and ${indistinguishable} of ${measured.length} `
        + `combination${indistinguishable === 1 ? ' lands' : 's land'} inside it. The one shown is the smallest change among those - not a demonstrated winner. `
        + 'Raise Trial Spins (the sweep uses a quarter of it per point) before deciding anything on this.'
      : reachedTarget
      ? (Object.keys(changed).length === 0
        ? `The current structural settings already reach ${targetRtp}% at even frequencies - nothing needs changing.`
        : null)
      : `The structural search could not reach ${targetRtp}% with these knobs: the closest combination measured `
        + `${best.rtp.toFixed(2)}%, off by ${best.error.toFixed(2)}pp. Widen the knob set, or change something outside it `
        + '(payout values are the exact lever).',
  };
}
