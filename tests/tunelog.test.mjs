import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTuneLogEntry, describeTuneEntryQuality, summarizeTuneLogEntry, tuneLogToJson,
} from '../core/tuning/TuneLog.js';

// A search reports one final answer and throws away every candidate it accepted on the way there -
// several of which may be better for a purpose the loss function knows nothing about. "Best" means
// lowest LOSS, which is a weighted blend; the candidate that best serves what a developer actually
// cares about is often not the one the search kept.

const OPTIONS = {
  targetRtp: 96, rtpTolerancePct: 1.5,
  targetTriggerRatePct: 0.6, triggerRateTolerancePct: 0.15,
  maxRtpStdError: 1, trialSpins: 100000, trialsPerPoint: 2,
  penaltyNormalization: 'normalized',
  orderingPenaltyWeight: 1, limitPenaltyWeight: 1, uniformityPenaltyWeight: 0,
  spacingPenaltyWeight: 1, triggerRatePenaltyWeight: 1, volatilityPenaltyWeight: 0,
  stdErrorPenaltyWeight: 0,
};

const candidate = (over = {}) => ({
  loss: 1.23, rtp: 96.2, error: 0.2, triggerRate: 0.58,
  trialRtpStdDev: 0.8, trialRtpStdError: 0.4, trialRtpMin: 95.4, trialRtpMax: 97.1,
  orderingPenalty: 0, orderingPenaltyNormalized: 0,
  limitPenalty: 0, limitPenaltyNormalized: 0,
  uniformityPenalty: 0.4, uniformityPenaltyNormalized: 0.03,
  spacingPenalty: 12, spacingPenaltyNormalized: 0.05,
  triggerRatePenalty: 0, volatilityPenalty: 0,
  orderingViolations: [], limitViolations: [], spacingViolations: [],
  roundStats: {
    rounds: 200000, hitRate: 0.53, medianWin: 0.71, p99: 4.5, maxWin: 679,
    top1PctShare: 0.30, volatilityIndex: 5.5,
  },
  ...over,
});

const tables = () => [{ defaults: { minGap: 2 }, symbols: { a: { frequency: 0.5 }, b: { frequency: 0.4 } } }];

const entry = (over = {}, opts = OPTIONS) => createTuneLogEntry({
  index: 1, step: 42, stage: 'linked', candidate: candidate(over), options: opts, reelFrequencyTables: tables(),
});

test('an entry records what it achieved against what was asked for, not just the raw number', () => {
  const e = entry();
  assert.equal(e.achieved.rtp, 96.2);
  assert.equal(e.achieved.targetRtp, 96);
  assert.equal(e.achieved.withinRtpTolerance, true);
  assert.equal(Math.round(e.achieved.spinsPerTrigger), 172, 'the unit a bonus rate is reasoned about in');
  assert.equal(e.achieved.withinTriggerTolerance, true);
});

test('an entry carries its own error bar, so an exported config is never a number without one', () => {
  // A candidate can look excellent purely because its sample landed well. Exporting that as a
  // finished config with no uncertainty attached is the exact mistake maxRtpStdError exists to stop.
  const e = entry();
  assert.equal(e.measurement.trialRtpStdError, 0.4);
  assert.equal(e.measurement.reliable, true);
  const noisy = entry({ trialRtpStdError: 3.2 });
  assert.equal(noisy.measurement.reliable, false);
});

test('an exploration candidate records its actual one-trial budget as unvalidated, not the final budget', () => {
  const e = entry({ measurementSpins: 75000, measurementTrials: 1, trialRtpStdDev: 0, trialRtpStdError: 0 });
  assert.equal(e.measurement.trialSpins, 75000);
  assert.equal(e.measurement.trialsPerPoint, 1);
  assert.equal(e.measurement.varianceKnown, false);
  assert.equal(e.measurement.trialRtpStdError, null);
  assert.equal(e.measurement.reliable, false);
  assert.match(describeTuneEntryQuality(e).verdict, /variance unknown/);
});

test('an entry records the payout SHAPE, which is the whole reason to keep a history', () => {
  // Two candidates with identical RTP can be completely different games, and the loss cannot see
  // the difference - so a log that recorded only loss and RTP would not be worth keeping.
  const e = entry();
  assert.equal(e.shape.volatilityIndex, 5.5);
  assert.equal(e.shape.volatilityBand, 'medium');
  assert.equal(e.shape.top1PctShare, 0.30);
  assert.equal(e.shape.maxWin, 679);
});

test('an entry breaks the loss into what each term contributed, in the denomination in force', () => {
  const e = entry();
  const spacing = e.loss.terms.find(t => t.key === 'spacing');
  assert.equal(spacing.value, 0.05, 'normalized, because that is what this run used');
  assert.equal(spacing.contribution, 0.05);
  assert.equal(e.loss.penaltyNormalization, 'normalized');
  // A term nobody weighted is not listed - except RTP error, which is always the objective.
  assert.ok(!e.loss.terms.some(t => t.key === 'uniformity'), 'a zero-weight term is noise in a report');
  assert.ok(e.loss.terms.some(t => t.key === 'rtpError'));
});

test('an entry uses raw penalty values when the run was raw', () => {
  const e = entry({}, { ...OPTIONS, penaltyNormalization: 'raw' });
  assert.equal(e.loss.terms.find(t => t.key === 'spacing').value, 12);
});

test('an entry carries the frequencies themselves, deep-copied so later mutation cannot corrupt it', () => {
  const live = tables();
  const e = createTuneLogEntry({ index: 1, step: 1, stage: null, candidate: candidate(), options: OPTIONS, reelFrequencyTables: live });
  live[0].symbols.a.frequency = 999;
  assert.equal(e.reelFrequencyTables[0].symbols.a.frequency, 0.5,
    'a log entry that changes when the search moves on is not a log');
});

test('quality says "meets every target" only when it genuinely does', () => {
  assert.equal(describeTuneEntryQuality(entry()).ok, true);
  const bad = describeTuneEntryQuality(entry({ rtp: 101.4, error: 5.4 }));
  assert.equal(bad.ok, false);
  assert.match(bad.verdict, /RTP off by 5\.40pp/);
});

test('quality names every reason to reject, not just the first', () => {
  const q = describeTuneEntryQuality(entry({
    rtp: 101.4, error: 5.4, trialRtpStdError: 3.2,
    orderingViolations: [{}, {}], limitViolations: [{}],
  }));
  assert.equal(q.problems.length, 4, `expected RTP, noise, ordering and limits: ${q.verdict}`);
  assert.match(q.verdict, /noisy/);
  assert.match(q.verdict, /2 ordering/);
  assert.match(q.verdict, /1 limit/);
});

test('quality always surfaces payout concentration, even when nothing is wrong', () => {
  // The thing most likely to make a numerically perfect candidate feel wrong to play. Reporting it
  // only when extreme would mean the one case a developer needs it is the one they never see.
  const q = describeTuneEntryQuality(entry());
  assert.equal(q.ok, true);
  assert.ok(q.notes.some(n => /top 1% carry 30%/.test(n)), q.notes.join(' | '));
  assert.ok(q.notes.some(n => /medium volatility/.test(n)));
});

test('the summary line leads with what identifies the entry and what it achieved', () => {
  const s = summarizeTuneLogEntry(entry());
  assert.match(s, /#1/);
  assert.match(s, /step 42/);
  assert.match(s, /linked/);
  assert.match(s, /RTP 96\.20%/);
  assert.match(s, /vol 5\.5x/);
});

test('the JSON export carries a run header, since frequencies alone are not reproducible', () => {
  const json = tuneLogToJson([entry(), entry({ rtp: 95.1, error: 0.9 })], {
    game: 'candyfrenzy',
    inputParameters: { searchSeed: 12345, reelLength: 500, trialSpins: 100000 },
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.game, 'candyfrenzy');
  assert.equal(parsed.run.searchSeed, 12345);
  assert.equal(parsed.entryCount, 2);
  assert.equal(parsed.entries.length, 2);
  assert.ok(parsed.entries[0].quality, 'the verdict travels with the entry - a reader should not have to re-derive it');
  assert.ok(parsed.entries[0].reelFrequencyTables[0].symbols.a);
});

test('exporting one entry and exporting all use the same shape', () => {
  // "Export this config" and "export the whole history" differ only in what is handed in, so a
  // consumer never needs two parsers.
  const one = JSON.parse(tuneLogToJson([entry()], {}));
  const all = JSON.parse(tuneLogToJson([entry(), entry()], {}));
  assert.equal(one.entryCount, 1);
  assert.equal(all.entryCount, 2);
  assert.deepEqual(Object.keys(one), Object.keys(all));
});
