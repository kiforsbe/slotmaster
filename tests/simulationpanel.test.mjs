import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReelFrequencyTablesForCopy, renderDiagnosisHtml,
  formatScaledPaytableForCopy, renderPayoutScaleHtml, renderLossBudgetHtml, describePenaltyStateNow, renderTargetChipsHtml, renderPlayerExperienceHtml, renderTuneLogHtml,
} from '../core/ui/dev/tuning/TuningReports.js';
import { scalePaytable } from '../core/tuning/Payouts.js';

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

// ---- Task 1.8: the payout-scale solve reaching the panel ----------------------------------
// Until this landed there were ZERO references to solvePayoutScale/payoutScale/scaledPaytable
// anywhere in ui/dev/SimulationPanel.js: the one EXACT RTP lever the tuner has was unreachable from the
// UI, while the diagnosis panel above it printed "scale every payout by 0.6922 (exact)" as its
// top recommendation. These cover the two halves of closing that - the emitted code and the
// rendered result.

test('formatScaledPaytableForCopy groups symbols sharing a payout ladder into one named constant', () => {
  // A game that points several symbols at ONE ladder has one constant to paste over, not one
  // object literal per symbol to reassemble by hand. Grouping is by ladder VALUE, so the
  // shared-reference structure survives `scalePaytable`'s per-entry copy. Every group here has at
  // least two members deliberately - a solo ladder is named after its symbol instead, which is a
  // different rule covered by its own test.
  const PREMIUM = [{ min: 5, multiplier: 0.75 }, { min: 7, multiplier: 1.75 }];
  const REGULAR = [{ min: 5, multiplier: 0.2 }];
  const original = {
    gum:   { type: 'premium', clusterPayout: PREMIUM, friendlyName: 'Bubble Gum' },
    cake:  { type: 'premium', clusterPayout: PREMIUM, friendlyName: 'Cake Slice' },
    mint:  { type: 'regular', clusterPayout: REGULAR, friendlyName: 'Mint' },
    bean:  { type: 'regular', clusterPayout: REGULAR, friendlyName: 'Jelly Bean' },
    bonus: { type: 'scatter', triggerFreeSpins: true, friendlyName: 'Bonus' },
  };
  const out = formatScaledPaytableForCopy(scalePaytable(original, 0.5), { scale: 0.5 });

  assert.equal((out.match(/export const PREMIUM_PAYOUT/g) || []).length, 1,
    'the shared premium ladder must be emitted once, not once per symbol');
  assert.equal((out.match(/export const REGULAR_PAYOUT/g) || []).length, 1);
  assert.match(out, /multiplier: 0\.375/, 'premium 0.75 x 0.5');
  assert.match(out, /multiplier: 0\.1\b/, 'regular 0.2 x 0.5');
  // Which symbols a ladder belongs to is the only way to know where to paste it.
  assert.match(out, /gum, cake/);
  assert.match(out, /mint, bean/);
  // A scatter has no payout ladder at all and must not invent one.
  assert.ok(!/bonus/.test(out), 'a symbol with no payout ladder must not appear');
});

test('the reproducibility header rounds the trigger target and gives it in the unit the panel asks for', () => {
  // The panel asks for "1 in N spins" and converts, so the percentage is a repeating fraction:
  // 1 in 167 is 0.5988023952095808%, which is what the header printed verbatim. Nobody types that
  // back in, and the number they would type - the spins - was missing entirely.
  const out = formatReelFrequencyTablesForCopy([{ defaults: {}, symbols: { bar: { frequency: 2 } } }], {
    rtp: 96, triggerRatePct: 0.6,
    inputParameters: { targetTriggerRatePct: 100 / 167, triggerRateTolerancePct: 0.15, targetRtp: 96, rtpTolerancePct: 1.5 },
  });
  assert.ok(!/0\.5988023952095808/.test(out), 'a 16-digit float has no place in pasted source');
  assert.match(out, /target trigger 0\.5988% \(1 in 167\) \+\/-0\.15/);
});

test('formatScaledPaytableForCopy names a ladder after its symbol when only one symbol uses it', () => {
  // Candy Frenzy gives every symbol its OWN ladder, so grouping by type would emit
  // PREMIUM_PAYOUT, PREMIUM_PAYOUT_2, PREMIUM_PAYOUT_3 - three names matching nothing in the file
  // they are meant to be pasted into, and two of them silently wrong about which symbol they pay.
  const original = {
    cottoncandy: { type: 'premium', clusterPayout: [{ min: 5, multiplier: 2 }, { min: 15, multiplier: 300 }] },
    gum:         { type: 'premium', clusterPayout: [{ min: 5, multiplier: 1.5 }, { min: 15, multiplier: 200 }] },
    cake:        { type: 'premium', clusterPayout: [{ min: 5, multiplier: 1 }, { min: 15, multiplier: 120 }] },
  };
  const out = formatScaledPaytableForCopy(scalePaytable(original, 0.5), { scale: 0.5 });

  assert.match(out, /export const COTTONCANDY_PAYOUT/);
  assert.match(out, /export const GUM_PAYOUT/);
  assert.match(out, /export const CAKE_PAYOUT/);
  assert.ok(!/PREMIUM_PAYOUT/.test(out), 'a per-symbol ladder must not be named after its type group');
  assert.ok(!/Used by:/.test(out), "a solo ladder's own name already says which symbol uses it");
  assert.match(out, /multiplier: 150\b/, 'cottoncandy 300 x 0.5');
});

test('formatScaledPaytableForCopy emits per-symbol payout arrays for a line-pay paytable', () => {
  const original = {
    bar:    { type: 'regular', payout: [0, 0, 5, 20, 100] },
    seven:  { type: 'premium', payout: [0, 0, 10, 50, 250] },
  };
  const out = formatScaledPaytableForCopy(scalePaytable(original, 0.5), { scale: 0.5 });
  assert.match(out, /bar\b[^\n]*\[0, 0, 2\.5, 10, 50\]/);
  assert.match(out, /seven\b[^\n]*\[0, 0, 5, 25, 125\]/);
});

test('formatReelFrequencyTablesForCopy emits the scaled paytable as real code when one was solved', () => {
  // Same reasoning as REEL_LENGTH in 2548ac2: a result that depends on a rescaled paytable is not
  // reproducible from frequencies alone, and a comment is not something you can paste.
  const output = formatReelFrequencyTablesForCopy([{ defaults: {}, symbols: { bar: { frequency: 2 } } }], {
    rtp: 96.0, triggerRatePct: 0.6,
    inputParameters: { reelLength: 500, searchSeed: 12345, reelSeeds: [101] },
    scaledPaytable: { bar: { type: 'regular', clusterPayout: [{ min: 5, multiplier: 0.709 }] } },
    payoutScale: { scale: 0.946, verified: true, verifiedRtp: 96.02, rtpBeforeScaling: 101.5 },
  });
  assert.match(output, /payout scale 0\.946/);
  assert.match(output, /multiplier: 0\.709/);
  // Still emits the frequencies it was always emitting - the paytable is an addition, not a swap.
  assert.match(output, /export const FREQUENCY_REEL1/);
});

test('formatReelFrequencyTablesForCopy is unchanged when no payout scale was solved', () => {
  const context = {
    rtp: 96.0, triggerRatePct: 0.6,
    inputParameters: { reelLength: 500, searchSeed: 12345, reelSeeds: [101] },
  };
  const out = formatReelFrequencyTablesForCopy([{ defaults: {}, symbols: { bar: { frequency: 2 } } }], context);
  assert.ok(!/payout scale/i.test(out), 'off by default means absent from the output entirely');
});

test('renderPayoutScaleHtml states the arithmetic AND whether measurement confirmed it', () => {
  const out = renderPayoutScaleHtml({
    scale: 0.6922, rtpBeforeScaling: 138.68, verifiedRtp: 96.02, verified: true, verificationNote: null,
  }, { targetRtp: 96 });
  assert.match(out, /0\.6922/);
  assert.match(out, /138\.68/);
  assert.match(out, /96\.02/);
});

test('renderPayoutScaleHtml says so loudly when the verification run could not confirm the scale', () => {
  // The failure mode this exists for: a cascade game's winEvaluator captured its own paytable, so
  // the verification run measured the ORIGINAL payouts. The scale is still exact arithmetic - but
  // presenting an unconfirmed number identically to a confirmed one is how a wrong paytable ships.
  const out = renderPayoutScaleHtml({
    scale: 0.6922, rtpBeforeScaling: 138.68, verifiedRtp: 138.7, verified: false,
    verificationNote: 'Could not verify the scaled paytable: this game\'s winEvaluator captured its own paytable.',
  }, { targetRtp: 96 });
  assert.match(out, /could not verify/i);
  assert.match(out, /winEvaluator captured its own paytable/);
  assert.ok(!/verified/i.test(out.replace(/could not verify/ig, '')) || /not verif/i.test(out),
    'must not read as verified');
});

test('renderPayoutScaleHtml renders nothing at all when the solve was not requested', () => {
  assert.equal(renderPayoutScaleHtml(null, { targetRtp: 96 }), '');
});

// ---- Task 1.9: Phase 0d, the structural recommendation ------------------------------------

const recFixture = (over = {}) => ({
  knobs: { stackChance: 0.4, maxStack: 4 },
  changed: { stackChance: 0.4 },
  knobsSearched: ['stackChance', 'maxStack'],
  current: { stackChance: 0.1, maxStack: 4 },
  targetRtp: 96, predictedRtp: 94.1, measuredRtp: 95.8, measurementsUsed: 8,
  reachedTarget: true, respectedDesignIntent: true, appliedAutomatically: false,
  candidates: [], note: null, ...over,
});

test('renderDiagnosisHtml shows what changed and what stayed, not just the new values', () => {
  // A recommendation that restates six settings with one of them different makes the reader find
  // the difference themselves. Both directions matter: "leave maxStack alone" is advice too.
  const out = renderDiagnosisHtml({ structuralRecommendation: recFixture() });
  assert.match(out, /0\.1/, 'the value being moved away from must be visible');
  assert.match(out, /0\.4/);
  assert.match(out, /95\.8/, 'the MEASURED rtp backs the recommendation');
  assert.match(out, /→/, 'a moved knob is marked as moved');
  assert.match(out, /=/, 'an unmoved knob is marked as unmoved');
});

test('renderDiagnosisHtml says plainly when the recommendation is to change nothing', () => {
  const out = renderDiagnosisHtml({ structuralRecommendation: recFixture({
    changed: {}, knobs: { stackChance: 0.1 }, current: { stackChance: 0.1 },
    note: 'The current structural settings already reach 96% at even frequencies - nothing needs changing.',
  }) });
  assert.match(out, /no change needed/i);
  assert.match(out, /nothing needs changing/i);
  assert.ok(!/APPLY TO THE OUTPUT/.test(out),
    'there is nothing to apply when nothing changed - offering the button would be a no-op that looks like an action');
});

test('renderDiagnosisHtml reports an unreachable target as unreachable rather than recommending the nearest miss', () => {
  const out = renderDiagnosisHtml({ structuralRecommendation: recFixture({
    reachedTarget: false, measuredRtp: 140,
    note: 'The structural search could not reach 96% with these knobs: the closest combination measured 140.00%, off by 44.00pp.',
  }) });
  assert.match(out, /could not reach/i);
});

test('renderDiagnosisHtml renders nothing for a structural recommendation that was never run', () => {
  assert.equal(renderDiagnosisHtml({ structuralRecommendation: null }), '');
});

test('formatReelFrequencyTablesForCopy applies recommended defaults only when asked, and says it did', () => {
  // The measured RTP in the header describes the config that was SEARCHED. Emitting recommended
  // structural defaults under it silently attaches that number to settings it was never measured
  // against - which is exactly how a plausible-looking output describes a different game.
  const table = { defaults: { stackChance: 0.1, maxStack: 4 }, symbols: { bar: { frequency: 2 } } };
  const context = { rtp: 96, triggerRatePct: 0.6, inputParameters: { reelLength: 500, reelSeeds: [1] } };

  const asSearched = formatReelFrequencyTablesForCopy([table], context);
  assert.match(asSearched, /stackChance: 0\.1/);
  assert.ok(!/NOTE: the structural recommendation/.test(asSearched));

  const applied = formatReelFrequencyTablesForCopy([table], { ...context, structuralDefaults: { stackChance: 0.4 } });
  assert.match(applied, /stackChance: 0\.4/);
  assert.match(applied, /maxStack: 4/, 'a default the recommendation did not touch must survive');
  assert.match(applied, /measured BEFORE that change/);
});

test('renderDiagnosisHtml does not dress an unresolvable recommendation as a confirmed one', () => {
  // Observed live on Candy Frenzy before the noise guard: a ±17.89pp noise floor against a ±1.5pp
  // tolerance produced "nothing needs changing" in confident green. The card must carry the
  // caveat in its own heading, not bury it in a sentence under a green bar.
  const out = renderDiagnosisHtml({ structuralRecommendation: recFixture({
    resolvable: false, noiseFloorPct: 17.89, indistinguishable: 7, changed: {},
    note: "These measurements cannot tell the combinations apart: the sweep's own noise floor is ±17.89pp.",
  }) });
  assert.match(out, /not resolvable at this sample size/i);
  assert.match(out, /cannot tell the combinations apart/i);
  assert.ok(!out.includes('#7fd97f'), 'an unresolvable result must not be drawn in the confirmed-green accent');
});

// ---- Package 2.3: the loss budget in the panel ---------------------------------------------

const lossPreviewFixture = (over = {}) => ({
  penaltyNormalization: 'normalized', total: 100, dominant: 'rtpError', rtpIsDominant: true,
  terms: [
    { key: 'rtpError', label: 'RTP error', weight: 1, value: 60, contribution: 60, contributionPct: 60 },
    { key: 'spacing', label: 'Reel spacing', weight: 2, value: 15, contribution: 30, contributionPct: 30 },
    { key: 'ordering', label: 'Payout ordering', weight: 0.5, value: 20, contribution: 10, contributionPct: 10 },
    { key: 'uniformity', label: 'Even spread', weight: 0, value: 3, contribution: 0, contributionPct: 0 },
  ],
  ...over,
});

test('renderLossBudgetHtml shows each term with its own weight, not just the product', () => {
  // "Ordering contributes 10" is not actionable alone: the fix differs depending on whether that
  // is weight 0.5 against a penalty of 20 or weight 20 against a penalty of 0.5.
  const out = renderLossBudgetHtml(lossPreviewFixture());
  assert.match(out, /×2/, 'the spacing weight must be visible');
  assert.match(out, /×0\.5/);
  assert.match(out, /30\.00/);
});

test('renderLossBudgetHtml calls out a penalty that outweighs RTP error', () => {
  // The whole reason this exists: 150 iterations is a long time to discover the search was
  // optimizing spacing rather than RTP.
  const out = renderLossBudgetHtml(lossPreviewFixture({
    dominant: 'spacing', rtpIsDominant: false,
    terms: [
      { key: 'spacing', label: 'Reel spacing', weight: 0.25, value: 301, contribution: 75, contributionPct: 75 },
      { key: 'rtpError', label: 'RTP error', weight: 1, value: 21, contribution: 21, contributionPct: 21 },
    ],
  }));
  assert.match(out, /Reel spacing/);
  assert.match(out, /outweighs RTP error/);
  assert.match(out, /75\.00.*21\.00|21\.00/s);
});

test('renderLossBudgetHtml lists a switched-off term instead of hiding it', () => {
  // "Where did my spacing constraint go" is answered by seeing it listed as off, not by its
  // absence - an absent row is indistinguishable from a term that does not exist.
  const out = renderLossBudgetHtml(lossPreviewFixture());
  assert.match(out, /Even spread/);
  assert.match(out, />off</);
});

test('renderLossBudgetHtml warns that raw penalty units are not comparable', () => {
  const out = renderLossBudgetHtml(lossPreviewFixture({ penaltyNormalization: 'raw' }));
  assert.match(out, /not comparable/i);
});

test('renderLossBudgetHtml renders nothing when no preview was produced', () => {
  assert.equal(renderLossBudgetHtml(null), '');
  assert.equal(renderLossBudgetHtml({ terms: [] }), '');
});

test('renderDiagnosisHtml flags a loss the search will not spend on RTP, in the heading', () => {
  const out = renderDiagnosisHtml({ lossPreview: lossPreviewFixture({ dominant: 'spacing', rtpIsDominant: false }) });
  assert.match(out, /not RTP/);
});

// ---- Package 2.2: intent-named controls ----------------------------------------------------

test('describePenaltyStateNow reports the measured quantity AND what it costs', () => {
  // "Insist" is a choice about a real, currently-measured quantity. Without this column it is an
  // incantation, which is the complaint that started this package: "5 penalty weight on
  // uniformity - what?"
  const now = describePenaltyStateNow({
    total: 100, terms: [
      { key: 'spacing', value: 301, contribution: 75, contributionPct: 75 },
      { key: 'ordering', value: 0, contribution: 0, contributionPct: 0 },
    ],
  });
  assert.match(now.spacing, /301\.00/, 'the measured quantity');
  assert.match(now.spacing, /75\.00/, 'what it costs the search');
  assert.match(now.spacing, /75%/, 'and its share of the loss');
});

test('describePenaltyStateNow says "satisfied" rather than 0, which reads as switched off', () => {
  const now = describePenaltyStateNow({ total: 10, terms: [{ key: 'ordering', value: 0, contribution: 0, contributionPct: 0 }] });
  assert.equal(now.ordering, 'satisfied');
});

test('describePenaltyStateNow shows em dashes before anything has been measured', () => {
  // A zero here would claim a measurement that never happened.
  const now = describePenaltyStateNow(null);
  assert.equal(now.ordering, '—');
  assert.equal(now.spacing, '—');
  assert.ok(Object.keys(now).length >= 5, 'every row must be represented, measured or not');
});

test('the reproducibility header records which denomination the weights were in', () => {
  // The same numbers mean entirely different things in the two denominations - measured on Candy
  // Frenzy, a raw spacing weight of 0.25 is worth 43.75 of the loss against an RTP error of 1.76.
  // A weight list without its denomination does not describe a run.
  const table = { defaults: {}, symbols: { bar: { frequency: 2 } } };
  const out = formatReelFrequencyTablesForCopy([table], {
    rtp: 96, triggerRatePct: 0.6,
    inputParameters: { reelLength: 500, reelSeeds: [1], orderingPenaltyWeight: 1, penaltyNormalization: 'normalized' },
  });
  assert.match(out, /loss weights \(normalized\)/);
});

// ---- Package 3.2: did I get what I asked for, and what does it feel like --------------------

test('renderTargetChipsHtml passes a value inside tolerance and fails one outside', () => {
  const pass = renderTargetChipsHtml({ rtp: 96.2, targetRtp: 96, rtpTolerancePct: 1.5 });
  assert.match(pass, /96\.20%/);
  assert.match(pass, /✓/);
  const fail = renderTargetChipsHtml({ rtp: 101.4, targetRtp: 96, rtpTolerancePct: 1.5 });
  assert.match(fail, /✗/);
});

test('renderTargetChipsHtml states the bonus rate in spins, the unit it is reasoned about in', () => {
  const out = renderTargetChipsHtml({ triggerRatePct: 0.53, targetTriggerRatePct: 0.6, triggerRateTolerancePct: 0.15 });
  assert.match(out, /1 in 189/);
});

test('renderTargetChipsHtml does not fail a volatility nobody set a target for', () => {
  // With no target asked for there is nothing to pass or fail against - inventing a standard to
  // judge it by would be a red cross for a requirement the developer never stated.
  const out = renderTargetChipsHtml({ volatilityClass: 'high', targetVolatility: null });
  assert.match(out, /HIGH/);
  assert.ok(!/✗/.test(out));
  const mismatched = renderTargetChipsHtml({ volatilityClass: 'high', targetVolatility: 'low' });
  assert.match(mismatched, /✗/);
});

test('renderTargetChipsHtml renders nothing when there is nothing to compare', () => {
  assert.equal(renderTargetChipsHtml({}), '');
});

test('renderPlayerExperienceHtml renders the lines it is given and escapes them', () => {
  const out = renderPlayerExperienceHtml({ lines: ['Something pays on 52% of spins', 'A <script> tag'] });
  assert.match(out, /52% of spins/);
  assert.ok(!/<script>/.test(out), 'report text must be escaped like any other config-derived string');
  assert.equal(renderPlayerExperienceHtml(null), '');
  assert.equal(renderPlayerExperienceHtml({ lines: [] }), '');
});

// ---- The accepted-best log in the panel -----------------------------------------------------

const logEntryFixture = (over = {}) => ({
  index: 3, step: 47, stage: 'linked',
  achieved: { rtp: 96.2, rtpError: 0.2, targetRtp: 96, withinRtpTolerance: true,
    triggerRatePct: 0.58, spinsPerTrigger: 172.4, targetTriggerRatePct: 0.6, withinTriggerTolerance: true },
  measurement: { trialRtpStdError: 0.4, reliable: true },
  shape: { volatilityIndex: 5.5, volatilityBand: 'medium', hitRate: 0.53, maxWin: 679, top1PctShare: 0.30 },
  violations: { ordering: 0, limits: 0, spacing: 0 },
  loss: { total: 1.2345, penaltyNormalization: 'normalized', terms: [] },
  reelFrequencyTables: [],
  ...over,
});

test('renderTuneLogHtml leads each row with a verdict, so "is any of this good" is one column', () => {
  const out = renderTuneLogHtml([logEntryFixture()]);
  assert.match(out, /meets every target/);
  assert.match(out, /96\.20%/);
  assert.match(out, /1 in 172/);
  assert.match(out, /5\.5x medium/);
  assert.match(out, /top1% 30%/);
});

test('renderTuneLogHtml shows each entry its own error bar next to its RTP', () => {
  // An exported config is a number without an error bar otherwise - the exact mistake the tuner
  // itself made before maxRtpStdError existed.
  const out = renderTuneLogHtml([logEntryFixture()]);
  assert.match(out, /±0\.40/);
});

test('renderTuneLogHtml flags an entry that misses, without hiding it', () => {
  // A rejected-looking entry still belongs in the log: it may be the one that suits a purpose the
  // loss function cannot see.
  const out = renderTuneLogHtml([logEntryFixture({
    achieved: { ...logEntryFixture().achieved, rtp: 101.4, rtpError: 5.4, withinRtpTolerance: false },
    violations: { ordering: 2, limits: 0, spacing: 0 },
  })]);
  assert.match(out, /101\.40%/);
  assert.match(out, /RTP off by 5\.40pp/);
  assert.match(out, /2 ordering/);
});

test('renderTuneLogHtml orders newest first and offers per-entry and whole-log export', () => {
  const out = renderTuneLogHtml([logEntryFixture({ index: 1 }), logEntryFixture({ index: 2 })]);
  assert.ok(out.indexOf('#2') < out.indexOf('#1'), 'the most recent accepted candidate leads');
  assert.match(out, /tune-log-copy" data-index="2"/);
  assert.match(out, /tune-log-export" data-index="1"/);
  assert.match(out, /id="tune-log-copy-all"/);
  assert.match(out, /id="tune-log-export-all"/);
  assert.match(out, /became the best \(2\)/);
});

test('renderTuneLogHtml renders nothing before anything has been accepted', () => {
  assert.equal(renderTuneLogHtml([]), '');
  assert.equal(renderTuneLogHtml(null), '');
});

test('a log entry copied as JS says which entry it is, not just what it achieved', () => {
  // Pasting a history entry as though it were the run's final answer is how a config with a known
  // problem gets shipped believing it won. The reason to reach past the winner is usually that an
  // earlier candidate was measured more reliably, so the error bar travels with the code.
  const out = formatReelFrequencyTablesForCopy(
    [{ defaults: { minGap: 2 }, symbols: { bar: { frequency: 2 } } }],
    {
      rtp: 105.6, triggerRatePct: 0.512,
      inputParameters: { reelLength: 500, searchSeed: 12345, reelSeeds: [101] },
      tuneLogEntry: logEntryFixture({
        index: 2, step: 3, stage: 'linked',
        achieved: { ...logEntryFixture().achieved, rtp: 105.6, rtpError: 9.6, withinRtpTolerance: false },
        measurement: { trialRtpStdError: 0.97, reliable: true },
      }),
    });
  assert.match(out, /accepted-best entry #2 \(step 3, linked\)/);
  assert.match(out, /\+\/-0\.97pp/, 'the error bar is the whole reason to pick this one');
  assert.match(out, /NOT necessarily its final result/);
  assert.match(out, /RTP off by 9\.60pp/, 'and its known problem travels with it');
  assert.match(out, /volatility 5\.5x \(medium\)/);
  // Still the same paste-ready code as any other export.
  assert.match(out, /export const FREQUENCY_REEL1/);
  assert.match(out, /export const REEL_LENGTH = 500;/);
});

test('the ordinary end-of-tune output is unchanged when no log entry is involved', () => {
  const out = formatReelFrequencyTablesForCopy(
    [{ defaults: {}, symbols: { bar: { frequency: 2 } } }],
    { rtp: 96, triggerRatePct: 0.6, inputParameters: { reelLength: 500, reelSeeds: [1] } });
  assert.ok(!/accepted-best entry/.test(out));
  assert.ok(!/NOT necessarily/.test(out));
  assert.match(out, /^\/\/ ---- Tuned \d{4}-\d{2}-\d{2} ----/);
});

test('renderTuneLogHtml offers JS code alongside JSON for every entry', () => {
  const out = renderTuneLogHtml([logEntryFixture()]);
  assert.match(out, /tune-log-copy-js" data-index="3"/);
  assert.match(out, />COPY JS</);
  assert.match(out, />JSON</);
  assert.match(out, />FILE</);
});
