import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLadders, summarize } from '../core/StructuralSensitivity.js';

const candyDefaults = { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3 };
const table = (defaults = candyDefaults) => ({ defaults, symbols: { a: { frequency: 1 }, b: { frequency: 1 } } });

test('the stackChance ladder never crosses 1.0 without labelling it a mode switch', () => {
  // stackChance is not a continuum: resolveStackChance() >= 1 makes generateReel take a different
  // placement routine entirely (_computeClusterSizes rather than _computeStackedPlacements).
  // Measured on Candy Frenzy at uniform frequencies, 0.7 pays 181% RTP and 1.0 pays 40%. An
  // unlabelled ladder point at 1.0 would read as "more stacking pays less", which is false and
  // would send a developer chasing the wrong parameter.
  const ladders = buildLadders([table()], { reelLength: 500 });
  const sc = ladders.find(l => l.knob === 'stackChance');
  assert.ok(sc, 'stackChance must be laddered when a reel configures it');
  assert.ok(sc.values.every(v => v < 1), `stackChance ladder must stay below 1.0, got ${sc.values.join(', ')}`);
  assert.equal(typeof sc.isModeSwitch, 'function');
  assert.equal(sc.isModeSwitch(1.0), true);
  assert.equal(sc.isModeSwitch(0.7), false);
});

test('ladders include the current value so a report can mark where you are', () => {
  const ladders = buildLadders([table()], { reelLength: 500 });
  ladders.forEach(l => {
    assert.ok(l.values.includes(l.current), `${l.knob} ladder ${l.values.join(',')} must contain its current value ${l.current}`);
    assert.deepEqual(l.values, [...l.values].sort((x, y) => x - y), `${l.knob} ladder must be sorted`);
    assert.equal(new Set(l.values).size, l.values.length, `${l.knob} ladder must not repeat a value`);
  });
});

test('integer knobs ladder as integers and never below their own floor', () => {
  const ladders = buildLadders([table({ ...candyDefaults, maxStack: 2, minStack: 2 })], { reelLength: 500 });
  const maxStack = ladders.find(l => l.knob === 'maxStack');
  assert.ok(maxStack.values.every(Number.isInteger), `maxStack values must be integers, got ${maxStack.values.join(',')}`);
  // maxStack below minStack is the contradiction TuningValidation rejects outright - a sweep must
  // not propose measuring one.
  assert.ok(maxStack.values.every(v => v >= 2), `maxStack must not ladder below minStack 2, got ${maxStack.values.join(',')}`);
});

test('a knob no reel configures is not laddered', () => {
  // Sweeping a knob a game never set would report an effect for changing something that is not in
  // its config, which is worse than saying nothing.
  const ladders = buildLadders([{ defaults: { minGap: 4 }, symbols: { a: { frequency: 1 } } }], { reelLength: 500 });
  assert.equal(ladders.find(l => l.knob === 'stackChance'), undefined);
  assert.ok(ladders.find(l => l.knob === 'minGap'));
});

test('summarize ranks knobs by leverage, using the real measured Candy Frenzy shape', () => {
  // Real numbers, 40k spins, seed 4242, uniform frequencies. maxStack moves RTP by tens of pp per
  // integer step; minGap wobbles by ~3pp across its whole range with no monotone trend. The report
  // has to make those read as different KINDS of knob rather than as a sorted list of numbers.
  const summary = summarize(
    { rtp: 101.48, triggerRate: 0.563, hitRate: 0.62 },
    [
      { knob: 'minGap', current: 4, ladder: [
        { value: 1, rtp: 104.58 }, { value: 2, rtp: 102.81 }, { value: 3, rtp: 103.00 },
        { value: 4, rtp: 101.48 }, { value: 6, rtp: 102.31 }] },
      { knob: 'maxStack', current: 4, ladder: [
        { value: 3, rtp: 40.28 }, { value: 4, rtp: 101.48 }, { value: 5, rtp: 188.69 }] },
    ],
    { targetRtp: 96, noiseFloorPct: 1.3 });

  assert.equal(summary.knobs[0].knob, 'maxStack', 'the highest-leverage knob must sort first');
  assert.ok(summary.knobs[0].elasticityRtpPerUnit > 50);
  const minGap = summary.knobs.find(k => k.knob === 'minGap');
  // Deliberately NOT asserted flat. Its 3.10pp span sits above a 1.3pp noise floor, so the data
  // does not support "no effect" - the honest report is a real but tiny elasticity, ranked far
  // below everything else. Claiming flat here would be the same overstatement in code that it
  // would be in prose.
  assert.equal(minGap.flat, false);
  assert.ok(summary.knobs[0].elasticityRtpPerUnit / minGap.elasticityRtpPerUnit > 50,
    `maxStack should out-lever minGap by orders of magnitude, got ${summary.knobs[0].elasticityRtpPerUnit} vs ${minGap.elasticityRtpPerUnit}`);
});

test('a ladder that genuinely sits inside the noise floor is reported as flat', () => {
  // The case "no measurable effect" is actually true for: every point within measurement error of
  // every other. Reporting an elasticity there would dress a tie up as a finding, which is exactly
  // what this report exists to prevent.
  const summary = summarize(
    { rtp: 101.48 },
    [{ knob: 'minGap', current: 4, ladder: [
      { value: 1, rtp: 101.9 }, { value: 4, rtp: 101.48 }, { value: 6, rtp: 101.6 }] }],
    { targetRtp: 96, noiseFloorPct: 1.3 });
  const minGap = summary.knobs[0];
  assert.equal(minGap.flat, true);
  assert.equal(minGap.elasticityRtpPerUnit, 0, 'a flat knob reports no elasticity rather than a noise-sized one');
});

test('summarize reports the exact payout-scale route to target', () => {
  // RTP is strictly proportional to a global payout multiplier - verified to 5 significant figures
  // at both uniform and heavily skewed frequencies - so this route is closed-form, not interpolated,
  // and is the only one that can be stated exactly.
  const summary = summarize({ rtp: 101.48, triggerRate: 0.563, hitRate: 0.62 }, [], { targetRtp: 96, noiseFloorPct: 1.3 });
  const route = summary.routesToTarget.find(r => r.knob === 'payoutScale');
  assert.equal(route.exact, true);
  assert.ok(Math.abs(route.value - 96 / 101.48) < 1e-12);
});

test('summarize interpolates a route through whichever ladder brackets the target', () => {
  const summary = summarize(
    { rtp: 101.48, triggerRate: 0.563, hitRate: 0.62 },
    [{ knob: 'stackChance', current: 0.3, ladder: [
      { value: 0.2, rtp: 76.72 }, { value: 0.3, rtp: 101.48 }, { value: 0.4, rtp: 121.29 }] }],
    { targetRtp: 96, noiseFloorPct: 1.3 });
  const route = summary.routesToTarget.find(r => r.knob === 'stackChance');
  assert.equal(route.exact, false);
  assert.ok(route.value > 0.2 && route.value < 0.3, `expected a value between the bracketing points, got ${route.value}`);
  assert.deepEqual(route.interpolatedFrom, [0.2, 0.3]);
});

test('a knob whose ladder never reaches the target offers no route', () => {
  // Saying "set minGap to 4.7" when no minGap reaches 96% would be worse than saying nothing.
  const summary = summarize(
    { rtp: 101.48, triggerRate: 0.563, hitRate: 0.62 },
    [{ knob: 'minGap', current: 4, ladder: [{ value: 1, rtp: 104.58 }, { value: 6, rtp: 102.31 }] }],
    { targetRtp: 96, noiseFloorPct: 1.3 });
  assert.equal(summary.routesToTarget.find(r => r.knob === 'minGap'), undefined);
});
