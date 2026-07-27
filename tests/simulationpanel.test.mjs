import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReelFrequencyTablesForCopy } from '../core/SimulationPanel.js';

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
