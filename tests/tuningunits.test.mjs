import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spinsPerTriggerToPct, pctToSpinsPerTrigger,
  volatilityBandToSigma, sigmaToVolatilityBand, VOLATILITY_BANDS,
  intentToWeight, weightToIntent, INTENT_LEVELS,
} from '../core/tuning/Units.js';

test('trigger rate round-trips between percent and 1-in-N without losing precision', () => {
  // The panel asks for "1 in N spins" because that is how the number is actually reasoned about,
  // but tuneFrequencies takes a percentage. A lossy conversion would silently tune toward a
  // different target than the one typed in - the same class of bug as the old .toFixed(1)
  // frequency output, which looked plausible and quietly described a different game.
  for (const pct of [0.6, 0.53, 0.125, 2.04, 100]) {
    const back = spinsPerTriggerToPct(pctToSpinsPerTrigger(pct));
    assert.ok(Math.abs(back - pct) < 1e-9, `round trip failed for ${pct}%: got ${back}`);
  }
  assert.equal(Math.round(pctToSpinsPerTrigger(0.6)), 167);
  assert.equal(spinsPerTriggerToPct(200), 0.5);
});

test('a zero or negative trigger rate has no 1-in-N form and says so instead of returning Infinity', () => {
  // A game with no trigger symbol at all measures 0%. Rendering that as "1 in Infinity spins"
  // in an input box gives a control that cannot be typed back into.
  assert.equal(pctToSpinsPerTrigger(0), null);
  assert.equal(pctToSpinsPerTrigger(-1), null);
  assert.equal(spinsPerTriggerToPct(0), 0);
  assert.equal(spinsPerTriggerToPct(null), 0);
});

test('volatility bands map to sigma ranges and classify a measured sigma back', () => {
  const low = volatilityBandToSigma('low');
  assert.ok(low.min < low.max);
  // Candy Frenzy measured sigma = 1.9x bet at 849bc8a - the game this whole design was built
  // against must land in the band a developer would call it by eye.
  assert.equal(sigmaToVolatilityBand(1.9), 'low');
  assert.equal(sigmaToVolatilityBand(4.5), 'medium');
  assert.equal(sigmaToVolatilityBand(9.0), 'high');
});

test('every volatility band classifies back to itself at its own midpoint', () => {
  // Guards the boundaries: a band whose midpoint classifies as a NEIGHBOUR would mean the panel
  // shows a different label than the one just selected.
  for (const band of Object.keys(VOLATILITY_BANDS)) {
    const { min, max } = volatilityBandToSigma(band);
    const mid = Number.isFinite(max) ? (min + max) / 2 : min * 1.5;
    assert.equal(sigmaToVolatilityBand(mid), band, `${band} midpoint ${mid} classified elsewhere`);
  }
});

test('intent levels map onto normalized penalty weights', () => {
  assert.equal(intentToWeight('off'), 0);
  assert.equal(intentToWeight('prefer'), 1);
  assert.equal(intentToWeight('insist'), 4);
  assert.equal(intentToWeight('require'), 12);
  for (const level of Object.keys(INTENT_LEVELS)) {
    assert.equal(weightToIntent(intentToWeight(level)), level, `${level} did not round-trip`);
  }
});

test('a hand-typed weight that matches no level reports as custom rather than snapping', () => {
  // The advanced numeric override stays authoritative. Rounding 2.5 to "prefer" would make the
  // dropdown lie about what the search is actually doing, which is the whole failure mode these
  // named levels exist to fix.
  assert.equal(weightToIntent(2.5), 'custom');
  assert.equal(weightToIntent(0.5), 'custom');
  assert.equal(intentToWeight('custom'), null);
  assert.equal(intentToWeight('nonsense'), null);
});
