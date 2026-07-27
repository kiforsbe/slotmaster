import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTuningConfig } from '../core/TuningValidation.js';

// A minimal healthy cluster config, cloned and broken one way at a time by the tests below. Kept
// deliberately small: these are arithmetic checks on the config itself, so a realistic 12-symbol
// paytable would add noise without adding coverage.
const healthyCluster = () => ({
  paytable: {
    prem: { type: 'premium', clusterPayout: [{ min: 5, multiplier: 0.75 }, { min: 7, multiplier: 1.75 }, { min: 10, multiplier: 3.00 }] },
    reg:  { type: 'regular', clusterPayout: [{ min: 5, multiplier: 0.75 }, { min: 7, multiplier: 1.25 }, { min: 10, multiplier: 1.50 }] },
    bonus: { type: 'scatter', triggerFreeSpins: true },
  },
  reelFrequencyTables: [{
    defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3, minFrequency: 0.005, maxFrequency: 0.5 },
    symbols: { prem: { frequency: 0.08 }, reg: { frequency: 0.08 }, bonus: { frequency: 0.006 } },
  }],
  reelLength: 500, reelsCount: 7, rowsCount: 7, minClusterSize: 5, scatterTriggerCount: 3,
});

const codes = (findings, code) => findings.filter(f => f.code === code);

test('a healthy config produces no errors', () => {
  const findings = validateTuningConfig(healthyCluster());
  assert.deepEqual(findings.filter(f => f.severity === 'error'), [],
    `expected no errors, got: ${findings.filter(f => f.severity === 'error').map(f => f.message).join(' | ')}`);
});

test('a cluster payout ladder that pays less for a bigger cluster is an error', () => {
  // This is Candy Frenzy's REAL premium ladder as it stood before 849bc8a: a 5-cluster paid 2.00x
  // and a 7-cluster paid 0.50x. Nothing in the tuner noticed. Worse than cosmetic - the search is
  // then rewarded for making big clusters RARER, so every frequency derived from a run against
  // that ladder was shaped by an inverted incentive.
  const cfg = healthyCluster();
  cfg.paytable.prem.clusterPayout = [
    { min: 5, multiplier: 2.00 }, { min: 7, multiplier: 0.50 },
    { min: 10, multiplier: 1.00 }, { min: 15, multiplier: 2.50 }, { min: 25, multiplier: 7.50 },
  ];
  const found = codes(validateTuningConfig(cfg), 'payout-ladder-non-monotone');
  assert.equal(found.length, 1, 'one finding per inverted step - only the 5->7 step is inverted here');
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].subject.symbol, 'prem');
  assert.equal(found[0].subject.min, 7);
  assert.match(found[0].message, /0\.5/);
  assert.ok(found[0].suggestion.length > 0, 'an error a developer cannot act on is only half reported');
});

test('an unsorted payout ladder is an error, because payout ranking reads the last tier', () => {
  // computeValueRanks ranks a cascade symbol by tiers[tiers.length - 1] (see
  // CascadeSpinMechanic.defaultPayoutOf). An unsorted ladder therefore mis-ranks the symbol
  // against every other one, which silently inverts the ordering penalty for it.
  const cfg = healthyCluster();
  cfg.paytable.prem.clusterPayout = [{ min: 10, multiplier: 3.0 }, { min: 5, multiplier: 0.75 }];
  const found = codes(validateTuningConfig(cfg), 'payout-ladder-unsorted');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
});

test('a payout tier below minClusterSize can never pay and is flagged', () => {
  const cfg = healthyCluster();
  cfg.paytable.reg.clusterPayout = [{ min: 3, multiplier: 0.5 }, { min: 5, multiplier: 0.75 }];
  const found = codes(validateTuningConfig(cfg), 'payout-ladder-floor');
  assert.equal(found.length, 1);
  assert.equal(found[0].subject.min, 3);
});

test('a premium paying less at its top tier than a regular is flagged as a tier inversion', () => {
  // Not arithmetic-broken, but it makes the ordering penalty fight itself: the search is told to
  // keep "higher paying" symbols rarer while the type labels say the opposite of the payouts.
  const cfg = healthyCluster();
  cfg.paytable.prem.clusterPayout = [{ min: 5, multiplier: 0.5 }, { min: 10, multiplier: 1.0 }];
  const found = codes(validateTuningConfig(cfg), 'tier-inversion');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
});
