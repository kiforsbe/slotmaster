import test from 'node:test';
import assert from 'node:assert/strict';
import { describePlayerExperience } from '../core/PlayerExperience.js';

// "96% RTP" and "biggest win in 40,000 spins was 29x" are two facts about the SAME game, and only
// the first has ever been visible. This module answers the third question the whole project set
// out to answer: I have these numbers - will the player have fun?

// A deliberately flat shape: wins land often, but nothing ever pays big.
const FLAT = {
  rounds: 40000, hitRate: 0.522, meanWin: 0.96, medianWin: 0.8,
  p90: 2.5, p99: 6.0, p999: 20.5, maxWin: 29, top1PctShare: 0.098, volatilityIndex: 1.9,
  histogram: [
    { index: 0, value: 0, count: 19120 },
    { index: 30, value: 0.8, count: 16000 },
    { index: 40, value: 3.0, count: 4480 },
    { index: 50, value: 25.0, count: 400 },
  ],
};

// A spiky shape: rare hits, and the top 1% of rounds carries most of the money.
const SPIKY = {
  rounds: 40000, hitRate: 0.18, meanWin: 0.96, medianWin: 0,
  p90: 1.2, p99: 12, p999: 180, maxWin: 4200, top1PctShare: 0.61, volatilityIndex: 11.4,
  histogram: [
    { index: 0, value: 0, count: 32800 },
    { index: 35, value: 1.2, count: 6800 },
    { index: 52, value: 45, count: 380 },
    { index: 58, value: 900, count: 20 },
  ],
};

test('a flat game is described as low volatility with its big-win drought named', () => {
  const out = describePlayerExperience(FLAT, { bet: 1, rtp: 96.0, triggerRate: 0.53, sessionSpins: 500 });
  assert.equal(out.volatilityClass, 'low');
  assert.ok(out.lines.some(l => /52%/.test(l)), 'the hit rate belongs in plain language');
  assert.ok(out.lines.some(l => /29/.test(l)), 'the biggest win seen is the headline fact about a flat game');
});

test('a spiky game is described as high volatility and says where the money went', () => {
  const out = describePlayerExperience(SPIKY, { bet: 1, rtp: 96.0, triggerRate: 0.53, sessionSpins: 500 });
  assert.equal(out.volatilityClass, 'high');
  assert.ok(out.lines.some(l => /61%/.test(l)),
    'top1PctShare is the single most useful number for "flat or spiky" - it must be stated');
});

test('the comparison band is labelled a rule of thumb, not presented as measured', () => {
  // Nothing here measured what commercial games do. Presenting a remembered range beside genuinely
  // measured figures, in the same voice, is how a rule of thumb gets quoted back as a finding.
  const out = describePlayerExperience(FLAT, { bet: 1, rtp: 96.0, triggerRate: 0.53, sessionSpins: 500 });
  assert.ok(out.lines.some(l => /rule of thumb|typically|rough guide/i.test(l)));
});

test('a 96% RTP game loses the median player money over a session', () => {
  // The arithmetic nobody enjoys: RTP under 100 means the median session is down, and a report
  // that only ever says "96%" lets that stay abstract.
  const out = describePlayerExperience(FLAT, { bet: 1, rtp: 96.0, triggerRate: 0.53, sessionSpins: 500 });
  assert.ok(out.sessionOutcomes.median < 0,
    `expected the median 500-spin session to be down, got ${out.sessionOutcomes.median}`);
  assert.ok(out.sessionOutcomes.p10 <= out.sessionOutcomes.median);
  assert.ok(out.sessionOutcomes.median <= out.sessionOutcomes.p90);
});

test('session outcomes are resampled from the round histogram, not simulated again', () => {
  // The rounds have already been simulated once. Re-running them to answer "what does a session
  // look like" would pay twice for the same information.
  const out = describePlayerExperience(SPIKY, { bet: 1, rtp: 96.0, triggerRate: 0.53, sessionSpins: 200 });
  assert.equal(out.sessionOutcomes.spins, 200);
  assert.ok(Number.isFinite(out.sessionOutcomes.p10));
  // A spiky game's upside tail must be wider than a flat game's over the same session length.
  const flat = describePlayerExperience(FLAT, { bet: 1, rtp: 96.0, triggerRate: 0.53, sessionSpins: 200 });
  assert.ok((out.sessionOutcomes.p90 - out.sessionOutcomes.p10) > (flat.sessionOutcomes.p90 - flat.sessionOutcomes.p10),
    'a high-volatility game must produce a wider spread of session outcomes');
});

test('describePlayerExperience is deterministic', () => {
  // It resamples, so it needs a seed - and two identical calls reporting different session
  // outcomes would make the whole report untrustworthy for the sake of nothing.
  const a = describePlayerExperience(SPIKY, { bet: 1, rtp: 96, triggerRate: 0.5, sessionSpins: 300 });
  const b = describePlayerExperience(SPIKY, { bet: 1, rtp: 96, triggerRate: 0.5, sessionSpins: 300 });
  assert.deepEqual(a.sessionOutcomes, b.sessionOutcomes);
  assert.deepEqual(a.lines, b.lines);
});

test('a bonus that almost never lands is called out in spins, not in percent', () => {
  // "0.53%" is not a unit anyone has intuition for. "1 in 189 spins" is.
  const out = describePlayerExperience(FLAT, { bet: 1, rtp: 96.0, triggerRate: 0.53, sessionSpins: 500 });
  assert.ok(out.lines.some(l => /1 in 189|189 spins/.test(l)), out.lines.join('\n'));
});

test('describePlayerExperience degrades gracefully with nothing measured', () => {
  const out = describePlayerExperience(null, { bet: 1, rtp: 96, triggerRate: 0.5, sessionSpins: 500 });
  assert.deepEqual(out.lines, []);
  assert.equal(out.volatilityClass, null);
  assert.equal(out.sessionOutcomes, null);
});
