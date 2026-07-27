import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, predictRtp, structuralSearch, SEARCHABLE_KNOBS } from '../core/StructuralSearch.js';

// Phase 0c ranks knobs one at a time. That answers "which knob do I turn" but not "what do I set
// them ALL to" - and the knobs interact (maxStack only matters if stackChance is high enough to
// produce runs at all). This module searches them jointly, seeded from Phase 0c's measurements so
// the expensive part is already paid for.

// stackChance and maxStack, measured one at a time from a 100% baseline. Each ladder's point at
// the CURRENT value is the baseline, which is what makes the ratios composable.
function ladders() {
  return [
    {
      knob: 'stackChance', current: 0.3, integer: false, flat: false,
      ladder: [
        { value: 0.1, rtp: 40 }, { value: 0.3, rtp: 100 }, { value: 0.5, rtp: 150 }, { value: 0.7, rtp: 180 },
      ],
    },
    {
      knob: 'maxStack', current: 4, integer: true, flat: false,
      ladder: [{ value: 3, rtp: 50 }, { value: 4, rtp: 100 }, { value: 5, rtp: 200 }],
    },
  ];
}

test('the grid is the cartesian product of the ladder values of the requested knobs only', () => {
  const grid = buildGrid(ladders(), ['stackChance']);
  assert.equal(grid.length, 4);
  assert.deepEqual([...new Set(grid.map(c => Object.keys(c).join()))], ['stackChance'],
    'a knob that was not asked for must not appear in a single cell');
});

test('a cell is predicted by composing the one-at-a-time ladder ratios, not by re-measuring', () => {
  // This is what makes the search affordable: 600 cells cost nothing to rank, and only a handful
  // are ever actually simulated.
  const l = ladders();
  // 0.5 is 1.5x the baseline; maxStack 5 is 2x. Composed: 100 * 1.5 * 2 = 300.
  assert.equal(predictRtp({ stackChance: 0.5, maxStack: 5 }, l, 100), 300);
  assert.equal(predictRtp({ stackChance: 0.3, maxStack: 4 }, l, 100), 100, 'the current cell predicts the baseline');
});

test('the search recommends without applying, and never touches a knob it was not given', async () => {
  // A recommendation, not a mutation: which structural values a game ships is a design decision,
  // and the whole point of this package is to put the developer in a position to accept or reject.
  const measured = [];
  const rec = await structuralSearch({
    ladders: ladders(), baselineRtp: 100, targetRtp: 96, knobs: ['stackChance'],
    measure: async (params) => { measured.push(params); return { rtp: params.stackChance * 300 }; },
  });
  assert.ok(rec.knobs.stackChance != null);
  assert.equal(rec.knobs.maxStack, undefined, 'a knob not listed must not be touched');
  assert.equal(rec.appliedAutomatically, false);
  assert.ok(measured.every(p => p.maxStack === undefined), 'no trial may vary an unlisted knob');
});

test('the number of simulations is capped regardless of how large the grid is', async () => {
  let calls = 0;
  await structuralSearch({
    ladders: ladders(), baselineRtp: 100, targetRtp: 96, maxMeasurements: 3, refine: false,
    measure: async () => { calls++; return { rtp: 96 }; },
  });
  assert.ok(calls <= 3, `expected at most 3 measurements, made ${calls}`);
});

test('respectDesignIntent picks the recommendation closest to what the developer already chose', async () => {
  // Many combinations land on target. Picking by RTP error alone hands back whichever noisy cell
  // happened to measure best - often a wholesale redesign when a small tweak would do. "Closest to
  // the current config, among those that hit the target" is the difference between a suggestion a
  // developer can accept and one they have to argue with.
  const measure = async () => ({ rtp: 96 }); // every cell is a perfect hit
  const near = await structuralSearch({
    ladders: ladders(), baselineRtp: 100, targetRtp: 96, rtpTolerancePct: 1.5,
    respectDesignIntent: true, refine: false, measure,
  });
  const far = await structuralSearch({
    ladders: ladders(), baselineRtp: 100, targetRtp: 96, rtpTolerancePct: 1.5,
    respectDesignIntent: false, refine: false, measure,
  });
  const dist = (r) => Math.abs(r.knobs.stackChance - 0.3) + Math.abs(r.knobs.maxStack - 4);
  assert.ok(dist(near) <= dist(far),
    `respecting design intent must not wander further than ignoring it (near=${dist(near)}, far=${dist(far)})`);
  assert.equal(dist(near), 0, 'when the current config already hits target, the recommendation is to change nothing');
});

test('a flat knob is left out of the search rather than multiplying its cost for nothing', async () => {
  // Phase 0c already established minGap does nothing measurable on this game. Searching it anyway
  // would multiply the grid by 5 to explore an axis known to be noise.
  const withFlat = [...ladders(), {
    knob: 'minGap', current: 4, integer: true, flat: true,
    ladder: [{ value: 1, rtp: 100 }, { value: 4, rtp: 100 }, { value: 8, rtp: 100 }],
  }];
  const rec = await structuralSearch({
    ladders: withFlat, baselineRtp: 100, targetRtp: 96, refine: false,
    measure: async () => ({ rtp: 96 }),
  });
  assert.equal(rec.knobs.minGap, undefined);
  assert.ok(rec.knobsSearched.includes('stackChance'));
  assert.ok(!rec.knobsSearched.includes('minGap'));
});

test('an explicitly requested flat knob is still searched - the caller overrules the heuristic', async () => {
  const withFlat = [...ladders(), {
    knob: 'minGap', current: 4, integer: true, flat: true,
    ladder: [{ value: 1, rtp: 100 }, { value: 4, rtp: 100 }],
  }];
  const rec = await structuralSearch({
    ladders: withFlat, baselineRtp: 100, targetRtp: 96, knobs: ['minGap'], refine: false,
    measure: async () => ({ rtp: 96 }),
  });
  assert.deepEqual(rec.knobsSearched, ['minGap']);
});

test('minStack is never recommended above maxStack', async () => {
  // An internally contradictory recommendation is worse than none - generateReel would silently
  // resolve it in a way nobody chose.
  const l = [
    { knob: 'minStack', current: 2, integer: true, flat: false, ladder: [{ value: 1, rtp: 90 }, { value: 2, rtp: 100 }, { value: 4, rtp: 130 }] },
    { knob: 'maxStack', current: 3, integer: true, flat: false, ladder: [{ value: 2, rtp: 60 }, { value: 3, rtp: 100 }] },
  ];
  const rec = await structuralSearch({
    ladders: l, baselineRtp: 100, targetRtp: 500, refine: false, measure: async () => ({ rtp: 500 }),
  });
  const minStack = rec.knobs.minStack ?? 2;
  const maxStack = rec.knobs.maxStack ?? 3;
  assert.ok(minStack <= maxStack, `recommended minStack ${minStack} above maxStack ${maxStack}`);
});

test('the recommendation reports the measurement that backs it, not just the prediction', async () => {
  // The prediction composes one-at-a-time ratios, which is an approximation - the knobs interact.
  // Reporting the prediction as if it were the result would be presenting a model as a measurement.
  const rec = await structuralSearch({
    ladders: ladders(), baselineRtp: 100, targetRtp: 96, refine: false,
    measure: async () => ({ rtp: 97.3 }),
  });
  assert.equal(rec.measuredRtp, 97.3);
  assert.ok(typeof rec.predictedRtp === 'number');
  assert.ok(rec.measurementsUsed > 0);
});

test('the search reports honestly when nothing it can reach lands on target', async () => {
  const rec = await structuralSearch({
    ladders: ladders(), baselineRtp: 100, targetRtp: 96, rtpTolerancePct: 1.5, refine: false,
    measure: async () => ({ rtp: 300 }),
  });
  assert.equal(rec.reachedTarget, false);
  assert.match(rec.note, /could not reach/i);
});

test('SEARCHABLE_KNOBS covers exactly the reel-arrangement defaults, not payoutScale or reelLength', () => {
  // payoutScale is solved in closed form (an exact lever needs no search) and reelLength changes
  // simulation cost and the trigger-rate lattice rather than being a free RTP dial - putting
  // either in a grid search would be spending measurements to rediscover something already known.
  assert.deepEqual([...SEARCHABLE_KNOBS].sort(), ['maxStack', 'minGap', 'minStack', 'stackChance']);
});

// ---- The noise guard ----------------------------------------------------------------------
// Observed live on Candy Frenzy: the sweep's noise floor was ±17.89pp and the RTP tolerance
// ±1.5pp, and Phase 0d confidently reported "the current settings already reach 96% - nothing
// needs changing" off a baseline that had just measured 101.20%. Measure ten cells at a noise
// level 12x the tolerance and one lands in the band by chance. That is the multiple-comparisons
// trap, and it is the same mistake as comparing two search stages' losses across different Monte
// Carlo draws - a difference read off two draws is not a difference.

test('a run whose noise floor dwarfs the tolerance is reported as unresolvable, not as a hit', async () => {
  const rec = await structuralSearch({
    ladders: ladders(), baselineRtp: 100, targetRtp: 96, rtpTolerancePct: 1.5, noiseFloorPct: 17.89,
    refine: false, measure: async () => ({ rtp: 96 }),
  });
  assert.equal(rec.resolvable, false);
  assert.match(rec.note, /cannot tell the combinations apart/i);
  assert.match(rec.note, /17\.89/, 'the noise floor is the reason - state it');
  assert.ok(!/already reach/.test(rec.note),
    'a claim the measurements cannot support must not be made, however reassuring it sounds');
});

test('a run with a noise floor inside the tolerance still reports a real finding', async () => {
  const rec = await structuralSearch({
    ladders: ladders(), baselineRtp: 100, targetRtp: 96, rtpTolerancePct: 1.5, noiseFloorPct: 0.4,
    refine: false, measure: async () => ({ rtp: 96 }),
  });
  assert.equal(rec.resolvable, true);
  assert.equal(rec.reachedTarget, true);
});

test('reachedTarget is judged against the requested tolerance, never the widened selection band', async () => {
  // The band widens so selection does not pretend to resolve better than the measurement can.
  // The CLAIM must not widen with it, or every noisy run reports success.
  const rec = await structuralSearch({
    ladders: ladders(), baselineRtp: 100, targetRtp: 96, rtpTolerancePct: 1.5, noiseFloorPct: 40,
    refine: false, measure: async () => ({ rtp: 120 }),
  });
  assert.equal(rec.reachedTarget, false, '120% is 24pp off a 96% target - inside the widened band, but not a hit');
  assert.equal(rec.resolvable, false);
});
