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

// ---- Structural and geometry checks ----

test('stackChance at or above 1 is flagged as a mode switch, not "more stacking"', () => {
  // Measured on Candy Frenzy at uniform frequencies: stackChance 0.7 pays 181% RTP and 1.0 pays
  // 40%. It is not a continuum. resolveStackChance() >= 1 makes generateReel take a different
  // code path entirely (_computeClusterSizes, an even split) instead of _computeStackedPlacements.
  // A designer writing 1 to mean "always stack" gets LESS stacking value than 0.3, and nothing
  // about the name or the number hints at that.
  const cfg = healthyCluster();
  cfg.reelFrequencyTables[0].defaults.stackChance = 1;
  const found = codes(validateTuningConfig(cfg), 'stack-chance-mode-switch');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.match(found[0].message, /different|mode|path/i);
});

test('a stackChance below 1 is not flagged', () => {
  assert.equal(codes(validateTuningConfig(healthyCluster()), 'stack-chance-mode-switch').length, 0);
});

test('minStack above maxStack is an error', () => {
  const cfg = healthyCluster();
  cfg.reelFrequencyTables[0].defaults.minStack = 5;
  cfg.reelFrequencyTables[0].defaults.maxStack = 3;
  const found = codes(validateTuningConfig(cfg), 'stack-bounds');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
});

test('a reel too short for its symbols at the configured minGap is an error', () => {
  // 12 symbols each needing minGap 8 cannot coexist on a 50-position strip. generateReel does not
  // fail here - _enforceMinGap hits its candidates.length === 0 bailout and returns the strip
  // as-is - so the game ships reels that clump far more than the config asks, silently.
  const symbols = Object.fromEntries('abcdefghijkl'.split('').map(s => [s, { frequency: 1 }]));
  const cfg = {
    paytable: Object.fromEntries(Object.keys(symbols).map(s => [s, { type: 'regular', clusterPayout: [{ min: 5, multiplier: 1 }] }])),
    reelFrequencyTables: [{ defaults: { minGap: 8 }, symbols }],
    reelLength: 50, reelsCount: 7, rowsCount: 7, minClusterSize: 5,
  };
  const found = codes(validateTuningConfig(cfg), 'reel-length-floor');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.match(found[0].suggestion, /96|reel length|minGap/i);
});

test('a cluster floor larger than the grid can never be reached', () => {
  const cfg = healthyCluster();
  cfg.reelsCount = 3; cfg.rowsCount = 3; cfg.minClusterSize = 20;
  const found = codes(validateTuningConfig(cfg), 'cluster-size-reachable');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
});

test('a scatter trigger count larger than the grid can never be reached', () => {
  const cfg = healthyCluster();
  cfg.reelsCount = 3; cfg.rowsCount = 3; cfg.scatterTriggerCount = 15;
  assert.equal(codes(validateTuningConfig(cfg), 'scatter-trigger-reachable').length, 1);
});

test('contradictory frequency bounds are an error, because the limit penalty can never reach zero', () => {
  const cfg = healthyCluster();
  cfg.reelFrequencyTables[0].symbols.prem.minFrequency = 0.9;
  cfg.reelFrequencyTables[0].symbols.prem.maxFrequency = 0.1;
  const found = codes(validateTuningConfig(cfg), 'frequency-bounds-contradiction');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].subject.symbol, 'prem');
});

test('findings name the reel they came from when there is more than one', () => {
  // "minStack above maxStack" is useless without knowing which of seven reels to open.
  const cfg = healthyCluster();
  cfg.reelFrequencyTables.push(JSON.parse(JSON.stringify(cfg.reelFrequencyTables[0])));
  cfg.reelFrequencyTables[1].defaults.minStack = 9;
  const found = codes(validateTuningConfig(cfg), 'stack-bounds');
  assert.equal(found.length, 1);
  assert.equal(found[0].subject.reel, 1);
  assert.match(found[0].message, /reel 2/i, 'reels are 0-indexed in code and 1-indexed in FREQUENCY_REELn names - the message must use the name a developer will search for');
});
