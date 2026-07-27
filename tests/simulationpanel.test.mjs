import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReelFrequencyTablesForCopy, renderDiagnosisHtml } from '../core/SimulationPanel.js';

test('formatReelFrequencyTablesForCopy preserves distinct small frequencies instead of collapsing them', () => {
  // Reproduces the bookbookbook bug: several genuinely distinct tuned frequencies under 1
  // all rounded to the same fixed-1-decimal-place value ("0.1" or "0.2"), silently
  // corrupting the tuned result once pasted back into game.js - book (0.051) and explorer
  // (0.079) both became "0.1", a symbol nearly 2x rarer than another reading back as
  // identical. That collapse of book's frequency alone was enough to blow RTP up to ~390%.
  const table = {
    defaults: {},
    symbols: {
      book:     { frequency: 0.051 },
      explorer: { frequency: 0.079 },
      tut:      { frequency: 0.157 },
    },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /book:\s*\{ frequency: 0\.051 \}/);
  assert.match(output, /explorer:\s*\{ frequency: 0\.079 \}/);
  assert.match(output, /tut:\s*\{ frequency: 0\.157 \}/);
});

test('formatReelFrequencyTablesForCopy round-trips stackChance instead of silently dropping it', () => {
  // stackChance was omitted from the output entirely, so pasting a tuned result back DELETED it.
  // generateReel then falls back to 1, which takes a different placement path
  // (_computeClusterSizes rather than _computeStackedPlacements) - measured on Candy Frenzy as
  // the difference between 9.7% and 94.5% RTP. Same class of silent corruption as the frequency
  // rounding bug above: the output looked plausible and quietly described a different game.
  const table = {
    defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.1, minFrequency: 0.005, maxFrequency: 0.5 },
    symbols: {
      candy: { frequency: 0.0961 },
      bonus: { frequency: 0.0064, minGap: 8, maxStack: 1, minStack: 1, stackChance: 1 },
    },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /defaults:.*stackChance: 0\.1/, 'reel-level stackChance must survive the round trip');
  assert.match(output, /bonus:\s*\{[^}]*stackChance: 1/, 'a per-symbol stackChance override must survive too');
  // Every other field generateReel or the tuner reads must still be there.
  for (const field of ['minGap: 4', 'maxStack: 4', 'minStack: 2', 'minFrequency: 0.005', 'maxFrequency: 0.5']) {
    assert.ok(output.includes(field), `expected '${field}' in the output`);
  }
});

test('formatReelFrequencyTablesForCopy emits REEL_LENGTH and the settings needed to reproduce the run', () => {
  // Frequencies alone are not a reproducible artifact - the same numbers against a different reel
  // length or seed set generate different strips and a different RTP. The copyable output has to
  // carry the geometry and the seeds, not just the tuned values.
  const table = { defaults: {}, symbols: { bar: { frequency: 2 } } };
  const output = formatReelFrequencyTablesForCopy([table], {
    rtp: 96.02,
    triggerRatePct: 0.583,
    inputParameters: {
      searchSeed: 12345, reelSeeds: [101, 202, 303], reelLength: 750, reelsCount: 3, rowsCount: 3,
      targetRtp: 96, rtpTolerancePct: 1.5, targetTriggerRatePct: 0.6, triggerRateTolerancePct: 0.15,
      trialSpins: 300000, trialsPerPoint: 2, searchAlgorithm: 'cmaes', maxIterations: 150,
      initialWeightStrategy: 'provided', maxRtpStdError: 1,
      orderingPenaltyWeight: 0.5, limitPenaltyWeight: 0.5, uniformityPenaltyWeight: 0,
      stdErrorPenaltyWeight: 0, triggerRatePenaltyWeight: 2, spacingPenaltyWeight: 0.25,
    },
  });
  assert.match(output, /export const REEL_LENGTH = 750;/, 'reel length is part of the result and must be emitted as code');
  assert.match(output, /searchSeed 12345/);
  assert.match(output, /reelSeeds \[101, 202, 303\]/);
  assert.match(output, /RTP 96\.02%/);
  assert.match(output, /trigger 0\.583%/);
  assert.match(output, /cmaes, max 150 iterations/);
  assert.match(output, /triggerRate 2/, 'loss weights must be recorded - they change what the result even means');
  assert.match(output, /spacing 0\.25/);
  // The tables themselves must still follow the header.
  assert.match(output, /export const FREQUENCY_REEL1 = \{/);
});

test('formatReelFrequencyTablesForCopy omits the header entirely when given no context', () => {
  const table = { defaults: {}, symbols: { bar: { frequency: 2 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.ok(!output.includes('REEL_LENGTH'), 'no reproducibility header without context');
  assert.ok(output.startsWith('export const FREQUENCY_REEL1'));
});

test('formatReelFrequencyTablesForCopy still reads cleanly for larger fruitmachine-scale frequencies', () => {
  const table = { defaults: {}, symbols: { bar: { frequency: 25.3 }, clover: { frequency: 8 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /bar:\s*\{ frequency: 25\.3 \}/);
  assert.match(output, /clover:\s*\{ frequency: 8 \}/);
});

test('formatReelFrequencyTablesForCopy still includes fixed/minFrequency/maxFrequency fields', () => {
  const table = {
    defaults: {},
    symbols: { star: { frequency: 24, fixed: true }, bar: { frequency: 10, minFrequency: 2, maxFrequency: 20 } },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /star:\s*\{ frequency: 24, fixed: true \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, minFrequency: 2, maxFrequency: 20 \}/);
});

test('formatReelFrequencyTablesForCopy includes minStack on a symbol that sets it', () => {
  const table = { defaults: {}, symbols: { stacked: { frequency: 10, minStack: 3 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /stacked:\s*\{ frequency: 10, minStack: 3 \}/);
});

test('formatReelFrequencyTablesForCopy emits minStack/minFrequency/maxFrequency in a non-empty defaults block', () => {
  const table = { defaults: { minStack: 2, minFrequency: 1, maxFrequency: 50 }, symbols: { bar: { frequency: 10 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /defaults:\s*\{ minStack: 2, minFrequency: 1, maxFrequency: 50 \}/);
});

test('formatReelFrequencyTablesForCopy emits a non-empty defaults block', () => {
  const table = { defaults: { minGap: 4, maxStack: 2 }, symbols: { bar: { frequency: 10 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /defaults:\s*\{ minGap: 4, maxStack: 2 \}/);
});

test('formatReelFrequencyTablesForCopy includes minGap/maxStack on a symbol that overrides them', () => {
  const table = { defaults: {}, symbols: { book: { frequency: 0.051, minGap: 5 }, bar: { frequency: 10, maxStack: 1 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /book:\s*\{ frequency: 0\.051, minGap: 5 \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, maxStack: 1 \}/);
});

test('the reproducibility header records the tolerances and seed the panel now controls', () => {
  // Target RTP tolerance, trigger tolerance and searchSeed used to be library defaults with no
  // panel input at all - a run could not be reproduced from the panel because two of the three
  // numbers defining "did this converge" were invisible. Now that they are editable they must
  // also be recorded, same reasoning as REEL_LENGTH in 2548ac2.
  const table = { defaults: {}, symbols: { bar: { frequency: 2 } } };
  const output = formatReelFrequencyTablesForCopy([table], {
    rtp: 96.0, triggerRatePct: 0.6,
    inputParameters: {
      searchSeed: 4242, reelSeeds: [1], reelLength: 500, reelsCount: 1, rowsCount: 3,
      targetRtp: 96, rtpTolerancePct: 2.5, targetTriggerRatePct: 0.6, triggerRateTolerancePct: 0.2,
      trialSpins: 1000, trialsPerPoint: 1, searchAlgorithm: 'cmaes', maxIterations: 10,
      initialWeightStrategy: 'provided', maxRtpStdError: 1,
      orderingPenaltyWeight: 0.5, limitPenaltyWeight: 0.5, uniformityPenaltyWeight: 0,
      stdErrorPenaltyWeight: 0, triggerRatePenaltyWeight: 0, spacingPenaltyWeight: 0,
    },
  });
  assert.match(output, /searchSeed 4242/);
  assert.match(output, /\+\/-2\.5/, 'the RTP tolerance actually used must be recorded, not assumed to be the default');
  assert.match(output, /\+\/-0\.2/);
});

test('formatReelFrequencyTablesForCopy records reelCoupling in the reproducibility header', () => {
  // Coupling changes what the result MEANS - identical-looking frequencies from a linked run and
  // an independent run came out of searches with very different degrees of freedom. Same class of
  // omission as the dropped stackChance in 2548ac2: a setting the output leaves out is a setting
  // the next run silently gets wrong.
  const table = { defaults: {}, symbols: { bar: { frequency: 2 } } };
  const output = formatReelFrequencyTablesForCopy([table], {
    rtp: 96.0, triggerRatePct: 0.6,
    inputParameters: {
      searchSeed: 1, reelSeeds: [1], reelLength: 500, reelsCount: 1, rowsCount: 3,
      targetRtp: 96, rtpTolerancePct: 1.5, targetTriggerRatePct: 0.6, triggerRateTolerancePct: 0.15,
      trialSpins: 1000, trialsPerPoint: 1, searchAlgorithm: 'cmaes', maxIterations: 10,
      initialWeightStrategy: 'provided', maxRtpStdError: 1,
      orderingPenaltyWeight: 0.5, limitPenaltyWeight: 0.5, uniformityPenaltyWeight: 0,
      stdErrorPenaltyWeight: 0, triggerRatePenaltyWeight: 0, spacingPenaltyWeight: 0,
      reelCoupling: 'linked-then-refine', maxReelDeviation: 0.25,
    },
  });
  assert.match(output, /reelCoupling linked-then-refine/);
  assert.match(output, /maxReelDeviation 0\.25/);
});

// ---- Phase 0c report ----

const sensitivityFixture = () => ({
  measuredAt: 'uniform', spinsPerPoint: 12000, noiseFloorPct: 5.2,
  baseline: { rtp: 100.74 }, targetRtp: 96,
  knobs: [
    { knob: 'stackChance', current: 0.3, flat: false, elasticityRtpPerUnit: 236.5, span: 142,
      ladder: [{ value: 0.1, rtp: 36 }, { value: 0.3, rtp: 105 }, { value: 0.7, rtp: 178 }] },
    { knob: 'maxStack', current: 4, flat: false, elasticityRtpPerUnit: 73.3, span: 294,
      ladder: [{ value: 3, rtp: 41 }, { value: 4, rtp: 105 }, { value: 6, rtp: 303 }] },
    { knob: 'minGap', current: 4, flat: true, elasticityRtpPerUnit: 0, span: 5,
      ladder: [{ value: 1, rtp: 105 }, { value: 4, rtp: 105 }, { value: 8, rtp: 105 }] },
  ],
  routesToTarget: [
    { knob: 'payoutScale', value: 0.953, exact: true },
    { knob: 'stackChance', value: 0.267, exact: false, interpolatedFrom: [0.2, 0.3] },
  ],
});

// The knob table renders one <tr> per knob, so a row is the unit to assert against - matching on
// whole-output regexes would happily pass while the wrong knob carried the wrong number.
const knobRows = (html) => html.split('<tr>').slice(1);
const rowFor = (html, knob) => knobRows(html).find(r => r.includes(`>${knob}</td>`));

test('renderDiagnosisHtml leads with the highest-leverage knob and marks the current value', () => {
  const out = renderDiagnosisHtml({ sensitivity: sensitivityFixture() });
  const order = knobRows(out).map(r => (r.match(/>(\w+)<\/td>/) || [])[1]);
  assert.deepEqual(order, ['stackChance', 'maxStack', 'minGap'],
    'knobs must render in leverage order, highest first');
  assert.match(rowFor(out, 'stackChance'), /236\.5/,
    'the elasticity is what ranks the knob - it has to be on the row');
  // The current value is the anchor for reading every other point on the ladder, so it must be
  // visually distinct rather than merely present. Matched as whole <span> elements: slicing the
  // row on '</span>' also picks up the elasticity bar's own markup, which carries a background of
  // its own and made this assertion pass for the wrong reason.
  const ladderSpans = [...rowFor(out, 'stackChance').matchAll(/<span style="([^"]*)"[^>]*>([^<]*)<\/span>/g)]
    .map(m => ({ style: m[1], text: m[2].trim() }));
  const current = ladderSpans.find(s => s.text === '0.3: 105%');
  const other = ladderSpans.find(s => s.text === '0.1: 36%');
  assert.ok(current && other, `expected both ladder points as spans, got ${ladderSpans.map(s => s.text).join(' | ')}`);
  assert.ok(/background:/.test(current.style), 'the current ladder point must be highlighted');
  assert.ok(!/background:/.test(other.style), 'non-current ladder points must not be highlighted');
});

test('renderDiagnosisHtml says "no measurable effect" instead of printing a tiny number', () => {
  // A knob inside the noise floor has not demonstrated anything. Printing "0.4pp per unit" beside
  // maxStack's 73.3 invites a developer to treat it as a weak-but-real lever, which is the exact
  // mistake this report exists to prevent.
  const out = renderDiagnosisHtml({ sensitivity: sensitivityFixture() });
  const row = rowFor(out, 'minGap');
  assert.match(row, /no measurable effect/i);
  assert.ok(!/pp per unit/.test(row), 'a flat knob must not also show an elasticity');
});

test('renderDiagnosisHtml escapes text that came from a game config', () => {
  // Validation messages carry symbol names straight out of a developer's own paytable. They have
  // no business being parsed as markup on the way to the panel.
  const out = renderDiagnosisHtml({
    validation: [{ severity: 'error', code: 'x', message: '<img src=x onerror=alert(1)>', suggestion: 'fix "it" & move on', subject: {} }],
  });
  assert.ok(!out.includes('<img'), 'markup in a finding must not survive into the panel');
  assert.match(out, /&lt;img/);
  assert.match(out, /&amp;/);
});

test('renderDiagnosisHtml returns nothing when there is nothing to report', () => {
  // The panel section stays hidden rather than rendering an empty card.
  assert.equal(renderDiagnosisHtml({}), '');
  assert.equal(renderDiagnosisHtml(), '');
});

test('renderDiagnosisHtml states the routes to target, marking which one is exact', () => {
  const out = renderDiagnosisHtml({ sensitivity: sensitivityFixture() });
  assert.match(out, /TO REACH 96%/i);
  assert.match(out, /0\.953/);
  assert.match(out, /exact/i);
  assert.match(out, /0\.267/);
  assert.match(out, /0\.2.*0\.3|interpolat/i, 'an interpolated route must show what it was interpolated between');
});

test('renderDiagnosisHtml reports the noise floor, the sample size, and which frequencies it used', () => {
  // Without the noise floor, a 3pp gap between two ladder points is indistinguishable from a 300pp
  // one except by size. Without the measurement basis, the numbers are not comparable across knobs
  // at all - sweeping at the CURRENT frequencies measures the knob and the existing skew together
  // and attributes the sum to the knob.
  const out = renderDiagnosisHtml({ sensitivity: sensitivityFixture() });
  assert.match(out, /5\.2/, 'noise floor');
  // Digits only, separators stripped: the panel formats numbers with toLocaleString, so the
  // thousands separator is whatever the developer's machine uses - a comma here, a non-breaking
  // space on this one. Asserting the literal separator would make the test pass or fail by locale.
  assert.match(out.replace(/[\s,.  ]/g, ''), /12000spinsperpoint/i);

  // Asserted as "the two bases read differently" rather than by matching one wording, so the
  // report stays free to phrase it for a human ("EVEN symbol frequencies") instead of echoing the
  // internal mode name.
  const atCurrent = renderDiagnosisHtml({ sensitivity: { ...sensitivityFixture(), measuredAt: 'current' } });
  const basisLine = (text) => text.split('\n').find(l => /frequencies/i.test(l));
  assert.ok(basisLine(out), 'the report must state which frequencies it measured at');
  assert.notEqual(basisLine(out), basisLine(atCurrent),
    'uniform and current must not render identically - which one was used changes what the numbers mean');
});

test('renderDiagnosisHtml surfaces a broken payoutScale measurement instead of hiding it', () => {
  const s = sensitivityFixture();
  s.knobs.push({
    knob: 'payoutScale', current: 1, flat: true, elasticityRtpPerUnit: 0, span: 0,
    ladder: [{ value: 0.8, rtp: 105 }, { value: 1.25, rtp: 105 }],
    measurementUnreliable: true,
    measurementNote: 'This ladder measured the ORIGINAL payouts at every point. Pass winEvaluatorFactory to fix it.',
  });
  const out = renderDiagnosisHtml({ sensitivity: s });
  assert.match(out, /winEvaluatorFactory/);
  const payoutLine = out.split('\n').find(l => l.includes('payoutScale') && !l.includes('scale every payout'));
  assert.ok(!/no measurable effect/i.test(payoutLine),
    'a knob whose measurement failed must not be described as having no effect - the two mean opposite things');
});
