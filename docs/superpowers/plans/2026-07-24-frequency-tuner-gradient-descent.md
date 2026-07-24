# Frequency Tuner Gradient Descent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace bisection with a gradient-informed 1D optimizer in `tuneFrequencies`'s scatter-frequency and RTP-reallocation phases, using common random numbers to cut simulation noise out of the gradient estimate, and unify `rankTilt`/`premiumSplit` under one order-preserving tiered-tilt mechanism so no `frequencyMode` can ever make a higher-paying symbol more frequent than a lower-paying one.

**Architecture:** `core/SpinSimulator.js` gains a seeded-RNG parameter on `simulateSpins` (reusing `core/SlotMath.js`'s existing `createSeededRng`/`generateTargetGrid`, not reinventing a PRNG), a new exported `gradientDescent1D` helper (a damped Newton/secant-style root-finder: estimate the local slope via a common-random-numbers finite difference, step directly toward the target), and a generalized tiered-weight construction (`tieredRawWeights` + `renormalizeWeights`) parameterized by an injected tier map - `computeValueRanks` (existing) for `rankTilt`, a new `computePremiumTiers` for `premiumSplit`. `tuneFrequencies`'s two phases are rewritten on top of these. `core/SimulationPanel.js`'s progress log and mode dropdown get small matching updates.

**Tech Stack:** Vanilla JS (ES modules), Node's built-in `node:test` runner (`node --test tests/*.mjs`), no build step, no new dependencies.

## Global Constraints

- Every tuned parameter is a positive multiplicative scale factor - the optimizer works in log-space (`x = ln(param)`) throughout, converting back to `param = exp(x)` before building each trial paytable.
- `rankTilt` and `premiumSplit` must both guarantee, by construction, that no symbol with a strictly higher payout ever ends up with a higher frequency than a symbol with a lower payout (excluding types listed in `valueOrderExcludeTypes`, default `['wild']`) - this is the core requirement driving this entire plan.
- `frequencyMode` default changes from `'premiumSplit'` to `'rankTilt'`.
- No new UI inputs beyond the existing mode dropdown - the optimizer's internal constants (`trustFactor`, `trustFactorDecay`, `epsilon`) are parameters of `gradientDescent1D` itself, not new `tuneFrequencies` options.
- `simulateSpins`'s new `rng` parameter defaults to `Math.random` - every existing call site (live gameplay via `SlotEngine`, `RUN SIMULATION`, existing tests) is unaffected unless it explicitly opts into a seeded `rng`.
- Full regression suite (`node --test tests/*.mjs`) must keep passing except the one pre-existing, unrelated `fruit machine RTP stays near the 96% design target` failure (paytable frequencies are mid-tune from earlier work this session - out of scope here).
- Spec reference: `docs/superpowers/specs/2026-07-24-frequency-tuner-gradient-descent-design.md`.

---

### Task 1: Seeded RNG support in `simulateSpins`

**Files:**
- Modify: `core/SpinSimulator.js:5` (import), `core/SpinSimulator.js:7-15` (JSDoc + signature), `core/SpinSimulator.js:58-60` (expanding-symbol pick), `core/SpinSimulator.js:91-101` (target grid generation)
- Test: `tests/spinsimulator.test.mjs`

**Interfaces:**
- Consumes: `createSeededRng`, `generateTargetGrid` - both already exported from `core/SlotMath.js` (verified present at `core/SlotMath.js:380` and `core/SlotMath.js:398`).
- Produces: `simulateSpins(config, numBaseSpins, betPerLine, linesCount, rng = Math.random)` - the new trailing `rng` parameter, a `() => number` function. Task 3 depends on this signature to pass seeded measurements from `tuneFrequencies`.

- [ ] **Step 1: Write the failing test**

Open `tests/spinsimulator.test.mjs` and add this import and test at the end of the file (after the existing two tests, using the same `PAYTABLE`/`PAYLINES3` constants already defined near the top of the file):

```js
import { checkWildLineWins, generateReel, createSeededRng } from '../core/SlotMath.js';
```

Replace the existing line:
```js
import { checkWildLineWins, generateReel } from '../core/SlotMath.js';
```
with the line above (adds `createSeededRng` to the existing import), then append this test at the end of the file:

```js
test('simulateSpins is reproducible with a seeded rng, and varies without one', () => {
  const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));
  const config = {
    reelsCount: 3,
    rowsCount: 3,
    paytable: PAYTABLE,
    reelStrips,
    paylines: PAYLINES3,
    winEvaluator: checkWildLineWins,
  };

  const seededA = simulateSpins(config, 2000, 1, 5, createSeededRng(42));
  const seededB = simulateSpins(config, 2000, 1, 5, createSeededRng(42));
  assert.equal(seededA.totalWins, seededB.totalWins, 'same seed should reproduce identical totalWins');
  assert.equal(seededA.rtpRaw, seededB.rtpRaw, 'same seed should reproduce identical rtpRaw');

  const seededC = simulateSpins(config, 2000, 1, 5, createSeededRng(43));
  assert.notEqual(seededA.totalWins, seededC.totalWins, 'a different seed should (virtually certainly) differ');

  // Omitting rng entirely must still work exactly as before (default Math.random).
  const unseeded = simulateSpins(config, 2000, 1, 5);
  assert.ok(typeof unseeded.rtpRaw === 'number' && unseeded.rtpRaw >= 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/spinsimulator.test.mjs`
Expected: FAIL - `createSeededRng` import resolves fine (it already exists in `SlotMath.js`), but `simulateSpins` ignores its 5th argument entirely today, so `seededA.totalWins` will not equal `seededB.totalWins` (both calls use unseeded `Math.random()` internally) and the assertion `assert.equal(seededA.totalWins, seededB.totalWins, ...)` fails.

- [ ] **Step 3: Add the `rng` parameter to `simulateSpins`**

In `core/SpinSimulator.js`, replace the import line:
```js
import { checkWins, checkExpandingWins, generateReel } from './SlotMath.js';
```
with:
```js
import { checkWins, checkExpandingWins, generateReel, generateTargetGrid } from './SlotMath.js';
```

Replace the JSDoc + signature (currently lines 7-15):
```js
/**
 * Simulates multiple spins and returns statistical analysis.
 * @param {Object} config - Slot machine configuration with reelStrips, paytable, etc.
 * @param {number} numBaseSpins - Number of base spins to simulate (default 100000)
 * @param {number} betPerLine - Bet per line (default 1)
 * @param {number} linesCount - Number of active paylines (default 10)
 * @returns {Object} Simulation results including RTP, win distribution, etc.
 */
export function simulateSpins(config, numBaseSpins = 100000, betPerLine = 1, linesCount = 10) {
```
with:
```js
/**
 * Simulates multiple spins and returns statistical analysis.
 * @param {Object} config - Slot machine configuration with reelStrips, paytable, etc.
 * @param {number} numBaseSpins - Number of base spins to simulate (default 100000)
 * @param {number} betPerLine - Bet per line (default 1)
 * @param {number} linesCount - Number of active paylines (default 10)
 * @param {() => number} [rng=Math.random] - Random source for spin outcomes. Pass a seeded
 *   rng (e.g. createSeededRng(seed) from SlotMath.js) for a reproducible run; defaults to
 *   Math.random for today's non-deterministic behavior.
 * @returns {Object} Simulation results including RTP, win distribution, etc.
 */
export function simulateSpins(config, numBaseSpins = 100000, betPerLine = 1, linesCount = 10, rng = Math.random) {
```

Replace the expanding-symbol pick (currently lines 58-60):
```js
      expandingSymbol = eligibleSymbols.length > 0
        ? eligibleSymbols[Math.floor(Math.random() * eligibleSymbols.length)]
        : expandingSymbol;
```
with:
```js
      expandingSymbol = eligibleSymbols.length > 0
        ? eligibleSymbols[Math.floor(rng() * eligibleSymbols.length)]
        : expandingSymbol;
```

Replace the target-grid-building block (currently lines 91-101):
```js
    // Simulate target grid generation
    const targetGrid = [];
    for (let col = 0; col < simConfig.reelsCount; col++) {
      const reelCol = [];
      const strip = simConfig.reelStrips[col];
      const stopIndex = Math.floor(Math.random() * strip.length);
      for (let row = 0; row < simConfig.rowsCount; row++) {
        reelCol.push(strip[(stopIndex + row) % strip.length]);
      }
      targetGrid.push(reelCol);
    }
```
with:
```js
    // Target grid generation - pure/seeded via generateTargetGrid (SlotMath.js), so a
    // caller can pass a seeded rng (e.g. tuneFrequencies' common-random-numbers gradient
    // steps) for a reproducible run; defaults to Math.random for today's behavior.
    const targetGrid = generateTargetGrid(simConfig.reelStrips, simConfig.rowsCount, rng);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/spinsimulator.test.mjs`
Expected: PASS (3 tests: the 2 pre-existing plus the new one)

- [ ] **Step 5: Run the full suite to confirm no other regressions**

Run: `node --test tests/*.mjs`
Expected: PASS for all tests except `fruit machine RTP stays near the 96% design target` (pre-existing, unrelated failure - paytable frequencies mid-tune).

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js tests/spinsimulator.test.mjs
git commit -m "feat: add seeded rng support to simulateSpins for reproducible runs"
```

---

### Task 2: `gradientDescent1D` optimizer + generalized tiered-weight builder (pure helpers)

**Files:**
- Modify: `core/SpinSimulator.js` (add new helpers after `computeValueRanks`, currently ending at line 217, before the `tuneFrequencies` JSDoc)
- Create: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: nothing new (pure functions, no imports needed beyond what's already in the file).
- Produces:
  - `export async function gradientDescent1D({ initialParam, minParam, maxParam, target, tolerance, buildTrial, metricOf, measure, maxIterations, seedBase, onProgress, yieldToEventLoop, trustFactor = 0.8, trustFactorDecay = 0.9, epsilon = 0.05 }) => Promise<{ mult: number, error: number, result: Object, paytable: Object }>` - Task 3 wires this into both `tuneFrequencies` phases.
  - `function tieredRawWeights(valueSymbols, baseFreq, tierOf, t) => { [symbol]: number }` - the `t^tierOf(s)` construction, unnormalized. Task 3's `rankTilt`/`premiumSplit` path calls this directly; `randomSearch` computes its own jittered raw weights instead (its per-tier growth isn't a plain `t^tier`), so it does not call this function.
  - `function renormalizeWeights(raw, valueBudget) => { [symbol]: number }` - scales any positive raw-weight map so it sums to `valueBudget`. Shared by *all three* Phase 2 modes in Task 3 (`rankTilt`/`premiumSplit` renormalize `tieredRawWeights`'s output; `randomSearch` renormalizes its own jittered weights) - this is the piece they all have in common.
  - `function computePremiumTiers(paytable, symbols) => { [symbol]: 0 | 1 }` - Task 3's `premiumSplit` mode uses this as its `tierOf` map.

- [ ] **Step 1: Write the failing tests**

Create `tests/tunefrequencies.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { gradientDescent1D } from '../core/SpinSimulator.js';

test('gradientDescent1D converges to a target metric on a synthetic deterministic function', async () => {
  // metric(param) = 20 * ln(param) + 50 - a plain deterministic function standing in for
  // measure(), so this isolates the optimizer's own convergence behavior from Monte Carlo
  // simulation noise entirely.
  const best = await gradientDescent1D({
    initialParam: 1,
    minParam: 0.01,
    maxParam: 100,
    target: 70,
    tolerance: 0.5,
    buildTrial: (param) => ({ param }),
    metricOf: (result) => result.value,
    measure: (trial) => ({ value: 20 * Math.log(trial.param) + 50, triggerRate: 0 }),
    maxIterations: 20,
    seedBase: 1,
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });

  assert.ok(best.error <= 0.5, `expected error <= 0.5, got ${best.error}`);
  // target 70 = 20*ln(param)+50 => ln(param) = 1 => param = e
  assert.ok(Math.abs(best.mult - Math.E) < 0.1, `expected mult near e (${Math.E}), got ${best.mult}`);
});

test('gradientDescent1D clamps to maxParam when the target is unreachable within bounds', async () => {
  // metric grows without bound as param grows, but param is capped at 10 - target 1000
  // needs param far beyond 10, so the search must land at (not beyond) the boundary.
  const best = await gradientDescent1D({
    initialParam: 1,
    minParam: 1,
    maxParam: 10,
    target: 1000,
    tolerance: 0.5,
    buildTrial: (param) => ({ param }),
    metricOf: (result) => result.value,
    measure: (trial) => ({ value: 5 * trial.param, triggerRate: 0 }),
    maxIterations: 15,
    seedBase: 1,
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(best.mult <= 10.0001, `expected mult clamped to <= 10, got ${best.mult}`);
});

test('gradientDescent1D reports a distinct error per step, not a single frozen value', async () => {
  const errors = [];
  await gradientDescent1D({
    initialParam: 1,
    minParam: 0.01,
    maxParam: 100,
    target: 70,
    tolerance: 0.001, // tight enough that it won't converge in 6 steps, so all 6 report
    buildTrial: (param) => ({ param }),
    metricOf: (result) => result.value,
    measure: (trial) => ({ value: 20 * Math.log(trial.param) + 50, triggerRate: 0 }),
    maxIterations: 6,
    seedBase: 1,
    onProgress: (i, param, result) => { errors.push(result.error); },
    yieldToEventLoop: () => Promise.resolve(),
  });
  const distinct = new Set(errors.map(e => e.toFixed(8)));
  assert.ok(distinct.size > 1, `expected per-step error to vary, got ${errors}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: FAIL with something like "gradientDescent1D is not a function" or an import error - it doesn't exist yet.

- [ ] **Step 3: Add the helpers to `core/SpinSimulator.js`**

Insert this block immediately after the existing `computeValueRanks` function's closing `}` and immediately before the `tuneFrequencies` JSDoc comment (`/** ... Automatically tunes symbol frequency values ... */`) - note that Task 1's edits shift exact line numbers, so locate this by function content, not a hardcoded line number:

```js
// Two tiers only: 'premium'-typed symbols (tier 0) vs everything else (tier 1). Coarser
// than computeValueRanks, but built on the exact same tieredRawWeights/t>=1 mechanism,
// so it's structurally guaranteed to never let a premium symbol end up more frequent than
// a non-premium one - unlike the bespoke premium/other bisection this replaces.
function computePremiumTiers(paytable, symbols) {
  const tierOf = {};
  symbols.forEach(s => { tierOf[s] = paytable[s].type === 'premium' ? 0 : 1; });
  return tierOf;
}

// weight(s) = baseFreq(s) * t^tierOf(s), before renormalization. Non-decreasing as
// tierOf(s) increases whenever t >= 1 - this is what makes "higher-tier symbols end up no
// more frequent" hold by construction rather than by chance, for rankTilt/premiumSplit.
function tieredRawWeights(valueSymbols, baseFreq, tierOf, t) {
  const raw = {};
  valueSymbols.forEach(s => { raw[s] = baseFreq[s] * Math.pow(t, tierOf[s]); });
  return raw;
}

// Scales any positive per-symbol raw-weight map so it sums to valueBudget - shared by
// every Phase 2 mode (tieredRawWeights' t^tier construction, and randomSearch's jittered
// tier sampling) so they all scale into the same fixed budget Phase 1's trigger-rate share
// depends on, regardless of how the raw weights themselves were produced.
function renormalizeWeights(raw, valueBudget) {
  const rawTotal = Object.values(raw).reduce((a, b) => a + b, 0);
  const scale = valueBudget / rawTotal;
  const out = {};
  Object.keys(raw).forEach(s => { out[s] = raw[s] * scale; });
  return out;
}

/**
 * Generic 1D root-finder for tuning a single parameter against a target scalar metric,
 * replacing bisection with a gradient-informed step: at each iteration, the local
 * derivative of the metric with respect to the (log-space) parameter is estimated via a
 * finite difference, then the parameter is moved directly toward the target by an amount
 * proportional to (targetGap / estimatedSlope) - equivalent to a gradient descent step on
 * the squared-error loss (metric - target)^2, with the step size self-normalized by the
 * local slope instead of a fixed learning rate. That self-normalization is what keeps it
 * numerically stable across metrics with very different natural scales (a trigger rate
 * near 1% vs an RTP near 100%) without per-phase learning-rate tuning.
 *
 * Parameterized in log-space (x = ln(param)) since every tuned parameter here is a
 * positive multiplicative scale factor - a fixed step in x is a fixed *relative* change
 * in param regardless of its current magnitude.
 *
 * Uses common random numbers for the finite difference: both probe points in a step share
 * the same seed, so the estimated slope reflects the parameter change, not two independent
 * noisy Monte Carlo draws (measure() is stochastic unless given a fixed seed).
 *
 * Costs up to 2 simulated measurements per iteration (vs 1 for plain bisection) - the
 * probe measurement is skipped once tolerance is met or on the final iteration.
 *
 * @param {Object} args
 * @param {number} args.initialParam - Starting parameter value (> 0).
 * @param {number} args.minParam - Lower clamp (> 0).
 * @param {number} args.maxParam - Upper clamp (>= minParam).
 * @param {number} args.target - Target value for the metric.
 * @param {number} args.tolerance - Stop early once |metric - target| <= tolerance.
 * @param {(param: number) => Object} args.buildTrial - Builds a trial from a parameter value.
 * @param {(measureResult: Object) => number} args.metricOf - Extracts the scalar metric from a measure() result.
 * @param {(trial: Object, rngSeed: number) => Object} args.measure - Measures a trial (seeded, for CRN).
 * @param {number} args.maxIterations - Number of gradient steps.
 * @param {number} args.seedBase - Base seed for this phase's steps (offset per phase/mode to avoid correlated noise between phases).
 * @param {(i: number, param: number, result: Object & {error: number}, best: Object) => (void|Promise<void>)} [args.onProgress]
 * @param {() => Promise<void>} args.yieldToEventLoop
 * @param {number} [args.trustFactor=0.8] - Fraction of the suggested step actually taken each
 *   iteration (damping against noisy slope estimates); decays each step.
 * @param {number} [args.trustFactorDecay=0.9]
 * @param {number} [args.epsilon=0.05] - Finite-difference probe distance in log-space.
 * @returns {Promise<{ mult: number, error: number, result: Object, paytable: Object }>}
 */
export async function gradientDescent1D({
  initialParam, minParam, maxParam, target, tolerance,
  buildTrial, metricOf, measure, maxIterations, seedBase,
  onProgress, yieldToEventLoop,
  trustFactor = 0.8, trustFactorDecay = 0.9, epsilon = 0.05,
}) {
  const minX = Math.log(minParam);
  const maxX = Math.log(maxParam);
  let x = Math.min(maxX, Math.max(minX, Math.log(initialParam)));
  let trust = trustFactor;
  let best = null;

  for (let i = 0; i < maxIterations; i++) {
    const stepSeed = seedBase + i * 7919;
    const param = Math.exp(x);
    const trial = buildTrial(param);
    const result = measure(trial, stepSeed);
    const metric = metricOf(result);
    const error = Math.abs(metric - target);
    const resultWithError = { ...result, error };
    if (!best || error < best.error) best = { mult: param, error, result, paytable: trial };
    if (onProgress) await onProgress(i, param, resultWithError, best);
    await yieldToEventLoop();
    if (error <= tolerance || i === maxIterations - 1) break;

    const xProbe = Math.min(maxX, x + epsilon);
    const dx = xProbe - x;
    if (dx > 0) {
      const probeResult = measure(buildTrial(Math.exp(xProbe)), stepSeed);
      const slope = (metricOf(probeResult) - metric) / dx;
      if (slope !== 0) {
        const step = ((target - metric) / slope) * trust;
        x = Math.min(maxX, Math.max(minX, x + step));
      }
    }
    trust *= trustFactorDecay;
  }

  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite to confirm no other regressions**

Run: `node --test tests/*.mjs`
Expected: PASS for all tests except the one pre-existing, unrelated fruitmachine RTP failure.

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "feat: add gradientDescent1D optimizer and generalized tiered-weight builder"
```

---

### Task 3: Rewrite `tuneFrequencies` on top of `gradientDescent1D`; unify `rankTilt`/`premiumSplit`; default to `rankTilt`

**Files:**
- Modify: `core/SpinSimulator.js` (import line, remove `mulberry32`, rewrite the `tuneFrequencies` JSDoc + body currently spanning what was originally lines 189-531 before Tasks 1-2's edits shifted line numbers - locate by the `mulberry32` function declaration and the `export async function tuneFrequencies` declaration)
- Modify: `tests/tunefrequencies.test.mjs` (append integration tests)

**Interfaces:**
- Consumes: `gradientDescent1D`, `tieredRawWeights`, `renormalizeWeights`, `computePremiumTiers` (Task 2), `simulateSpins(..., rng)` (Task 1), `createSeededRng` (from `core/SlotMath.js`).
- Produces: `tuneFrequencies(paytable, options)` keeps its existing public return shape (`{ paytable, rtp, triggerRatePct, diagnostics: { scatterPhase, rtpPhase } }`), but:
  - `options.frequencyMode` now accepts `'rankTilt'` (new default), `'premiumSplit'`, `'randomSearch'`.
  - `diagnostics.scatterPhase` and `diagnostics.rtpPhase` now both include an `error` field.
  - `onProgress` phase names are now only `'scatter'` and `'shape'` (the old `'rtp'` phase name is gone - `premiumSplit` now reports as `'shape'` too, since it shares the same mechanism as `rankTilt`). Task 4 depends on this.

- [ ] **Step 1: Write the failing integration tests**

In `tests/tunefrequencies.test.mjs`, replace the existing import line:
```js
import { gradientDescent1D } from '../core/SpinSimulator.js';
```
with:
```js
import { gradientDescent1D, tuneFrequencies } from '../core/SpinSimulator.js';
import { checkWildLineWins } from '../core/SlotMath.js';
import {
  PAYTABLE, REELS_COUNT, ROWS_COUNT, PAYLINES, REEL_SEEDS, BET_PER_LINE, LINES_COUNT, REEL_LENGTH,
} from '../games/fruitmachine/game.js';
```

Then append these tests at the end of the file:

```js
function assertNeverInvertsPayoutOrder(paytable) {
  const nonWild = Object.keys(paytable).filter(s => paytable[s].type !== 'wild');
  for (const a of nonWild) {
    for (const b of nonWild) {
      const payoutA = paytable[a].payout.at(-1);
      const payoutB = paytable[b].payout.at(-1);
      if (payoutA > payoutB) {
        assert.ok(
          paytable[a].frequency <= paytable[b].frequency,
          `${a} (payout ${payoutA}, freq ${paytable[a].frequency}) should not be more ` +
          `frequent than ${b} (payout ${payoutB}, freq ${paytable[b].frequency})`
        );
      }
    }
  }
}

test('tuneFrequencies defaults to rankTilt and never inverts payout order', async () => {
  const tuned = await tuneFrequencies(PAYTABLE, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 40000, trialsPerPoint: 1, maxIterations: 12,
  });
  assertNeverInvertsPayoutOrder(tuned.paytable);
});

test('tuneFrequencies premiumSplit also never inverts payout order', async () => {
  const tuned = await tuneFrequencies(PAYTABLE, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 40000, trialsPerPoint: 1, maxIterations: 12,
    frequencyMode: 'premiumSplit',
  });
  assertNeverInvertsPayoutOrder(tuned.paytable);
});

test('tuneFrequencies diagnostics expose a per-step error via onProgress, not a single frozen value', async () => {
  const errorsSeen = [];
  await tuneFrequencies(PAYTABLE, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 10,
    onProgress: (phase, i, mult, result) => { if (phase === 'shape') errorsSeen.push(result.error); },
  });
  const distinct = new Set(errorsSeen.map(e => e.toFixed(6)));
  assert.ok(distinct.size > 1, `expected per-step error to vary across iterations, got ${errorsSeen}`);
});

test('tuneFrequencies diagnostics.rtpPhase includes a numeric error field', async () => {
  const { diagnostics } = await tuneFrequencies(PAYTABLE, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 8,
  });
  assert.ok(typeof diagnostics.rtpPhase.error === 'number');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: FAIL - `diagnostics.rtpPhase.error` is `undefined` today (not currently returned), and the `onProgress` callback's `result` object doesn't carry `.error` yet under the current `'rtp'`/`'shape'` phase split, so `errorsSeen` stays empty and the distinct-count assertion fails.

- [ ] **Step 3: Rewrite `tuneFrequencies` in `core/SpinSimulator.js`**

First, update the import line (added in Task 1, now also adding `createSeededRng`):
```js
import { checkWins, checkExpandingWins, generateReel, generateTargetGrid } from './SlotMath.js';
```
becomes:
```js
import { checkWins, checkExpandingWins, generateReel, generateTargetGrid, createSeededRng } from './SlotMath.js';
```

Delete the `mulberry32` function entirely (it's no longer used by anything after this task):
```js
// Deterministic PRNG (mulberry32) so a given searchSeed always explores the same sequence
// of candidate distributions - reproducible tuning runs, same as generateReel's seeding.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

Now replace the entire `tuneFrequencies` JSDoc comment and function body (everything from the `/**` right before `export async function tuneFrequencies` down to that function's closing `}`) with:

```js
/**
 * Automatically tunes symbol `frequency` values in a paytable to hit a target RTP and a
 * target free-spin trigger rate - without touching any payout values. Runs the real
 * simulator against candidate paytables, so it stays accurate to whatever SlotMath.js's
 * actual win logic does at the time it's run (it doesn't hardcode any game-specific math).
 *
 * Strategy: symbols are grouped by `paytable[symbol].type`.
 *  1. Scale every 'scatter' symbol's frequency together (gradientDescent1D) until the
 *     free-spin trigger rate lands on target, holding all other frequencies fixed.
 *  2. Reallocate non-scatter weight to hit the target RTP, holding total non-scatter weight
 *     constant so the trigger rate found in step 1 is preserved exactly. `options.frequencyMode`
 *     picks how weight is grouped into tiers - but every mode shares the same underlying
 *     guarantee: weight(s) = baseFreq(s) * t^tier(s) with t clamped >= 1, so a higher-paying
 *     symbol can never end up more frequent than a lower-paying one.
 *       - 'rankTilt' (default): tiers = one per distinct payout value (fine-grained).
 *       - 'premiumSplit': tiers = 'premium'-typed symbols (tier 0) vs everything else (tier 1) -
 *         a coarser, 2-tier version of the same mechanism, kept for continuity with the
 *         original "move weight between premium and the rest" behavior. Order *within* the
 *         non-premium tier still depends on the base paytable already being ordered there.
 *       - 'randomSearch': samples many random monotonic (by payout) weight distributions
 *         and keeps the one closest to target RTP, so the search isn't limited to a single
 *         tilt shape. Reports its best few attempts in diagnostics.rtpPhase.topCandidates.
 *     If every candidate symbol lands in the same tier (e.g. 'premiumSplit' requested on a
 *     paytable with no 'premium'-typed symbols), falls back to scaling every non-scatter
 *     symbol together instead.
 *
 * Both phases use gradientDescent1D (see above) rather than bisection, with common random
 * numbers reducing simulation noise in the gradient estimate, and track the best candidate
 * seen (not just the final step): generateReel() rounds symbol counts to whole numbers per
 * reel, so the achievable trigger rate / RTP is quantized with occasional jumps rather than
 * a smooth dial - a single step can straddle a jump without landing inside the tolerance band.
 *
 * @param {Object} paytable - Paytable to tune (not mutated; a tuned clone is returned).
 * @param {Object} [options]
 * @param {number} [options.reelsCount=5]
 * @param {number} [options.rowsCount=3]
 * @param {number} [options.reelLength=220] - Virtual reel strip length passed to generateReel.
 * @param {number[]} [options.reelSeeds] - Base seeds, one per reel (reused/offset if fewer than reelsCount).
 * @param {number} [options.betPerLine=1]
 * @param {number} [options.linesCount=10]
 * @param {number} [options.targetRtp=96] - Target RTP as a percent (e.g. 96 for 96%).
 * @param {number} [options.rtpTolerancePct=1.5] - Acceptable +/- band around targetRtp.
 * @param {number} [options.targetTriggerRatePct=0.6] - Target % of spins that trigger free spins.
 * @param {number} [options.triggerRateTolerancePct=0.15] - Acceptable +/- band around that.
 * @param {number} [options.trialSpins=800000] - Base spins simulated per candidate.
 * @param {number} [options.trialsPerPoint=3] - Independent trials averaged per candidate (reduces rare-event noise).
 * @param {number} [options.maxIterations=14] - Gradient-descent steps (or random trials) per phase.
 * @param {'rankTilt'|'premiumSplit'|'randomSearch'} [options.frequencyMode='rankTilt'] - RTP reallocation strategy, see above.
 * @param {string[]} [options.valueOrderExcludeTypes=['wild']] - Symbol `type`s excluded from the
 *   tier assignment in 'rankTilt'/'premiumSplit'/'randomSearch' (held fixed at their post-scatter-phase
 *   frequency instead) - wilds don't "pay" in the normal sense, so tiering them by payout would
 *   nonsensically treat them as the cheapest, most-common tier.
 * @param {[number, number]} [options.tiltBounds=[1, 40]] - Search bounds for the tilt parameter shared by
 *   'rankTilt'/'premiumSplit' (gradient descent) and 'randomSearch' (sampled log-uniformly). Values
 *   below 1 are clamped up to 1 - the tilt is a per-tier growth multiplier, and anything below 1
 *   would shrink lower-paying tiers' share back below the top tier's, inverting the ordering
 *   guarantee these modes exist to provide.
 * @param {number} [options.searchSeed=12345] - Base PRNG seed for 'randomSearch' and for the
 *   common-random-numbers gradient estimates in the other modes - a given seed always explores
 *   the same sequence, for reproducible runs.
 * @param {(phase: 'scatter'|'shape', iteration: number, multiplier: number|null, result: {rtp: number, triggerRate: number, error: number}, best: {mult: number, error: number, result: Object, paytable: Object}) => (void|Promise<void>)} [options.onProgress] -
 *   Called (and awaited, if it returns a promise) after each candidate is measured, before yielding to the
 *   event loop - a caller can safely touch the DOM here and see it rendered before the next (heavier) candidate runs.
 * @returns {Promise<{ paytable: Object, rtp: number, triggerRatePct: number, diagnostics: Object }>}
 */
export async function tuneFrequencies(paytable, options = {}) {
  const {
    reelsCount = 5,
    rowsCount = 3,
    reelLength = 220,
    reelSeeds = [1234, 567, 89, 765, 3321],
    betPerLine = 1,
    linesCount = 10,
    paylines,
    winEvaluator,
    wildSymbol = null,
    scatterSymbol = null,
    targetRtp = 96,
    rtpTolerancePct = 1.5,
    targetTriggerRatePct = 0.6,
    triggerRateTolerancePct = 0.15,
    trialSpins = 800000,
    trialsPerPoint = 3,
    maxIterations = 14,
    frequencyMode = 'rankTilt',
    valueOrderExcludeTypes = ['wild'],
    tiltBounds = [1, 40],
    searchSeed = 12345,
    onProgress = null,
  } = options;

  // Each candidate measurement is itself a synchronous, CPU-bound block (simulateSpins
  // doesn't yield internally) - but yielding *between* candidates via a macrotask lets a
  // browser tab repaint after each onProgress call, so a caller can render live, iterative
  // results instead of the whole run appearing to freeze the page until it's done.
  const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

  if (!paytable || typeof paytable !== 'object') {
    throw new Error('tuneFrequencies requires a paytable');
  }

  const basePaytable = JSON.parse(JSON.stringify(paytable));
  const scatterSymbols = Object.keys(basePaytable).filter(s => basePaytable[s].type === 'scatter');

  function buildReelStrips(pt) {
    const strips = [];
    for (let i = 0; i < reelsCount; i++) {
      strips.push(generateReel(pt, reelLength, reelSeeds[i % reelSeeds.length] + i * 100000));
    }
    return strips;
  }

  // rngSeed is optional - omitted, this falls back to unseeded Math.random per trial (via
  // simulateSpins' own default). When provided, each trialsPerPoint repeat gets its own
  // derived seed (so multiple trials still average over genuinely different sequences),
  // but that derived seed is identical across different candidate measurements for the
  // same trial index and rngSeed - the common-random-numbers property gradientDescent1D's
  // finite difference relies on.
  function measure(pt, rngSeed) {
    const reelStrips = buildReelStrips(pt);
    const config = { reelsCount, rowsCount, paytable: pt, reelStrips, paylines, winEvaluator, wildSymbol, scatterSymbol };
    let rtpSum = 0, triggerSum = 0;
    for (let i = 0; i < trialsPerPoint; i++) {
      const rng = rngSeed != null ? createSeededRng(rngSeed + i * 104729) : Math.random;
      const results = simulateSpins(config, trialSpins, betPerLine, linesCount, rng);
      rtpSum += results.rtpRaw * 100;
      triggerSum += (results.freeSpinsTriggered / results.baseSpins) * 100;
    }
    return { rtp: rtpSum / trialsPerPoint, triggerRate: triggerSum / trialsPerPoint };
  }

  // ---- Phase 1: scale scatter symbol(s) to hit the target trigger rate ----
  let pt1 = basePaytable;
  let scatterPhase = null;
  if (scatterSymbols.length > 0) {
    const scatterBaseFreq = {};
    scatterSymbols.forEach(s => { scatterBaseFreq[s] = basePaytable[s].frequency; });

    scatterPhase = await gradientDescent1D({
      initialParam: 1,
      minParam: 0.05,
      maxParam: 8,
      target: targetTriggerRatePct,
      tolerance: triggerRateTolerancePct,
      buildTrial: (mult) => {
        const trial = JSON.parse(JSON.stringify(basePaytable));
        scatterSymbols.forEach(s => { trial[s].frequency = scatterBaseFreq[s] * mult; });
        return trial;
      },
      metricOf: (result) => result.triggerRate,
      measure,
      maxIterations,
      seedBase: searchSeed,
      onProgress: onProgress ? (i, mult, result, best) => onProgress('scatter', i, mult, result, best) : null,
      yieldToEventLoop,
    });
    pt1 = scatterPhase.paytable;
  }

  // ---- Phase 2: reallocate non-scatter weight to hit the target RTP ----
  // Total non-scatter weight is held fixed throughout, so scatter's share (and therefore
  // the trigger rate locked in above) doesn't drift while RTP is being tuned.
  const nonScatterSymbols = Object.keys(pt1).filter(s => !scatterSymbols.includes(s));
  const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + pt1[s].frequency, 0);
  let rtpPhase = null;

  const fixedShapeSymbols = nonScatterSymbols.filter(s => valueOrderExcludeTypes.includes(pt1[s].type));
  const valueSymbols = nonScatterSymbols.filter(s => !valueOrderExcludeTypes.includes(pt1[s].type));
  const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + pt1[s].frequency, 0);
  const valueBudget = nonScatterTotal - fixedShapeTotal;

  const tierOf = valueSymbols.length > 0
    ? (frequencyMode === 'premiumSplit' ? computePremiumTiers(pt1, valueSymbols) : computeValueRanks(pt1, valueSymbols))
    : {};
  const tieredModeUsable = valueSymbols.length > 0 && valueBudget > 0 && new Set(Object.values(tierOf)).size > 1;

  if (tieredModeUsable) {
    const baseFreq = {}; valueSymbols.forEach(s => { baseFreq[s] = pt1[s].frequency; });

    // Applies an already-renormalized (summing to valueBudget) per-symbol weight map to a
    // clone of pt1, leaving the excluded types (e.g. wilds) untouched at their Phase 1
    // frequency.
    function applyWeights(weights) {
      const trial = JSON.parse(JSON.stringify(pt1));
      valueSymbols.forEach(s => { trial[s].frequency = weights[s]; });
      return trial;
    }

    // Tilt values below 1 would shrink higher-tier (lower-paying) symbols' multiplier below
    // the top tier's fixed 1x, pulling weight back toward the top and inverting the very
    // ordering guarantee these modes exist to provide - so 1 is a hard floor regardless of
    // what tiltBounds is passed.
    const tiltLo = Math.max(1, tiltBounds[0]);
    const tiltHi = Math.max(tiltLo, tiltBounds[1]);

    if (frequencyMode === 'randomSearch') {
      // Sample many candidate distributions instead of committing to one tilt shape. Each
      // trial draws its own log-uniform tilt across the full [tiltLo, tiltHi] range (so the
      // same fully-concentrated extremes rankTilt/premiumSplit can reach are reachable here
      // too) plus independent per-tier jitter - jitter is bounded to [1, 1.5] so every
      // per-tier growth step is still >=1x, preserving the ordering guarantee on every
      // single sampled candidate.
      const maxTier = Math.max(...Object.values(tierOf));
      const tiers = [];
      for (let r = 0; r <= maxTier; r++) tiers.push(valueSymbols.filter(s => tierOf[s] === r));
      const rng = createSeededRng(searchSeed);

      let best = null;
      const attempts = [];
      for (let i = 0; i < maxIterations; i++) {
        const tilt = tiltLo * Math.pow(tiltHi / tiltLo, rng());
        const tierWeight = new Array(maxTier + 1);
        tierWeight[0] = 1;
        for (let r = 1; r <= maxTier; r++) {
          const jitter = 1 + rng() * 0.5;
          tierWeight[r] = tierWeight[r - 1] * tilt * jitter;
        }
        const raw = {};
        tiers.forEach((tierSymbols, r) => {
          const tierBaseTotal = tierSymbols.reduce((sum, s) => sum + baseFreq[s], 0) || 1;
          tierSymbols.forEach(s => { raw[s] = tierWeight[r] * (baseFreq[s] / tierBaseTotal); });
        });
        const trial = applyWeights(renormalizeWeights(raw, valueBudget));
        // Seeded for reproducible runs, offset well clear of the gradient-descent phases'
        // per-step seeds elsewhere so the two can never coincide.
        const result = measure(trial, searchSeed + 600000 + i * 7919);
        const error = Math.abs(result.rtp - targetRtp);
        const resultWithError = { ...result, error };
        const candidate = { mult: tilt, error, result, paytable: trial };
        if (!best || error < candidate.error) best = candidate;
        attempts.push(candidate);
        if (onProgress) await onProgress('shape', i, tilt, resultWithError, best);
        await yieldToEventLoop();
        if (error <= rtpTolerancePct) break;
      }
      attempts.sort((a, b) => a.error - b.error);
      best.topCandidates = attempts.slice(0, 5).map(c => ({
        rtp: c.result.rtp,
        triggerRate: c.result.triggerRate,
        error: c.error,
        frequencies: Object.fromEntries(valueSymbols.map(s => [s, c.paytable[s].frequency])),
      }));
      rtpPhase = best;
    } else {
      // rankTilt or premiumSplit: identical mechanism, differing only in how tierOf groups
      // symbols (computed above). weight(s) = baseFreq(s) * t^tierOf(s), t clamped >= 1.
      rtpPhase = await gradientDescent1D({
        initialParam: 1,
        minParam: tiltLo,
        maxParam: tiltHi,
        target: targetRtp,
        tolerance: rtpTolerancePct,
        buildTrial: (t) => applyWeights(renormalizeWeights(tieredRawWeights(valueSymbols, baseFreq, tierOf, t), valueBudget)),
        metricOf: (result) => result.rtp,
        measure,
        maxIterations,
        seedBase: searchSeed + 300000,
        onProgress: onProgress ? (i, t, result, best) => onProgress('shape', i, t, result, best) : null,
        yieldToEventLoop,
      });
    }
  } else if (nonScatterSymbols.length > 0) {
    // Degenerate case (e.g. 'premiumSplit' requested on a paytable with no 'premium'-typed
    // symbols, or every non-excluded symbol landed in the same tier): fall back to scaling
    // every non-scatter symbol together. No ordering concern here since a uniform multiplier
    // never changes relative proportions, so the tilt isn't floored at 1.
    const baseFreq = {}; nonScatterSymbols.forEach(s => { baseFreq[s] = pt1[s].frequency; });
    rtpPhase = await gradientDescent1D({
      initialParam: 1,
      minParam: 0.2,
      maxParam: 5,
      target: targetRtp,
      tolerance: rtpTolerancePct,
      buildTrial: (mult) => {
        const trial = JSON.parse(JSON.stringify(pt1));
        nonScatterSymbols.forEach(s => { trial[s].frequency = baseFreq[s] * mult; });
        return trial;
      },
      metricOf: (result) => result.rtp,
      measure,
      maxIterations,
      seedBase: searchSeed + 900000,
      onProgress: onProgress ? (i, mult, result, best) => onProgress('shape', i, mult, result, best) : null,
      yieldToEventLoop,
    });
  }

  const finalPaytable = rtpPhase ? rtpPhase.paytable : pt1;
  const finalResult = rtpPhase ? rtpPhase.result : measure(finalPaytable);

  return {
    paytable: finalPaytable,
    rtp: finalResult.rtp,
    triggerRatePct: finalResult.triggerRate,
    diagnostics: {
      scatterPhase: scatterPhase ? { multiplier: scatterPhase.mult, error: scatterPhase.error, ...scatterPhase.result } : null,
      rtpPhase: rtpPhase ? {
        multiplier: rtpPhase.mult,
        error: rtpPhase.error,
        ...rtpPhase.result,
        ...(rtpPhase.topCandidates ? { topCandidates: rtpPhase.topCandidates } : {}),
      } : null,
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS (7 tests total: 3 from Task 2 + 4 from this task)

- [ ] **Step 5: Run the full suite to confirm no other regressions**

Run: `node --test tests/*.mjs`
Expected: PASS for all tests except the one pre-existing, unrelated fruitmachine RTP failure. In particular, `tests/slotmath.test.mjs` and `tests/spinsimulator.test.mjs` (which don't touch `tuneFrequencies`) must be untouched by this rewrite.

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "refactor: unify rankTilt/premiumSplit on gradientDescent1D; default to rankTilt"
```

---

### Task 4: Update `core/SimulationPanel.js` progress log and mode dropdown

**Files:**
- Modify: `core/SimulationPanel.js:293-306` (mode dropdown + explanatory paragraph), `core/SimulationPanel.js:371-375` (progress log line)

**Interfaces:**
- Consumes: `tuneFrequencies`'s new `onProgress` contract from Task 3 (`result` always includes `.error`; phase names are only `'scatter'` and `'shape'`).
- Produces: no new exports - this is a leaf UI file, nothing downstream depends on it.

- [ ] **Step 1: Update the mode dropdown and explanatory text**

In `core/SimulationPanel.js`, replace:
```html
        <label style="font-size: 0.8em; color: #ccc;">Frequency Mode<br>
          <select id="tune-frequency-mode" style="width: 100%; margin-top: 4px;">
            <option value="premiumSplit">Premium / Other Split</option>
            <option value="rankTilt">Rank Tilt (value-ordered)</option>
            <option value="randomSearch">Random Search (value-ordered)</option>
          </select>
        </label>
      </div>
      <p style="font-size: 0.75em; color: #888; margin: -4px 0 12px;">
        Premium/Other Split can make the highest-paying symbol the most frequent one if that's the only way
        to hit target RTP. Rank Tilt and Random Search instead guarantee every symbol stays no more frequent
        than any lower-paying one - but for some paytables the target RTP may not be reachable under that
        constraint (achieved RTP will fall short; see the result below).
      </p>
```
with:
```html
        <label style="font-size: 0.8em; color: #ccc;">Frequency Mode<br>
          <select id="tune-frequency-mode" style="width: 100%; margin-top: 4px;">
            <option value="rankTilt" selected>Rank Tilt (value-ordered, default)</option>
            <option value="premiumSplit">Premium / Other Split (value-ordered)</option>
            <option value="randomSearch">Random Search (value-ordered)</option>
          </select>
        </label>
      </div>
      <p style="font-size: 0.75em; color: #888; margin: -4px 0 12px;">
        Every mode here guarantees a higher-paying symbol is never more frequent than a lower-paying one.
        Rank Tilt groups symbols by exact payout value (finest-grained); Premium/Other Split groups them
        into just two tiers (premium vs. everything else, coarser); Random Search samples many distributions
        instead of one smooth tilt curve. For some paytables the target RTP may not be reachable under that
        constraint (achieved RTP will fall short; see the result below).
      </p>
```

- [ ] **Step 2: Show current-step error alongside best-so-far error in the progress log**

Replace:
```js
      onProgress: (phase, i, mult, r, best) => {
        const labels = { scatter: 'Scatter frequency', shape: `Frequency shape (${options.frequencyMode})`, rtp: 'Premium/regular split' };
        const multLabel = mult == null ? '' : `  mult=${mult.toFixed(3)}`;
        appendLog(`[${labels[phase] || phase} ${i + 1}]${multLabel}  RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  (best so far: err=${best.error.toFixed(4)})`);
      }
```
with:
```js
      onProgress: (phase, i, mult, r, best) => {
        const labels = { scatter: 'Scatter frequency', shape: `Frequency shape (${options.frequencyMode})` };
        const multLabel = mult == null ? '' : `  mult=${mult.toFixed(3)}`;
        appendLog(`[${labels[phase] || phase} ${i + 1}]${multLabel}  RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  err=${r.error.toFixed(4)}  (best err=${best.error.toFixed(4)})`);
      }
```

- [ ] **Step 3: Syntax-check the file**

Run: `node --check core/SimulationPanel.js`
Expected: no output (valid syntax)

- [ ] **Step 4: Run the full test suite to confirm no regressions**

Run: `node --test tests/*.mjs`
Expected: PASS for all tests except the one pre-existing, unrelated fruitmachine RTP failure (this file has no direct test coverage, but the suite must still be green elsewhere).

- [ ] **Step 5: Commit**

```bash
git add core/SimulationPanel.js
git commit -m "feat: default TUNE FREQUENCIES to rank tilt; show live per-step error in progress log"
```

---

### Task 5: End-to-end verification

**Files:** none modified - verification only.

**Interfaces:** none.

- [ ] **Step 1: Run the full automated test suite**

Run: `node --test tests/*.mjs`
Expected: all tests pass except `fruit machine RTP stays near the 96% design target` (pre-existing, unrelated - paytable frequencies mid-tune from earlier work this session).

- [ ] **Step 2: Manually verify the live fruitmachine paytable end-to-end with a throwaway script**

Run this via the Bash tool (not saved to the repo):
```bash
node --input-type=module -e "
import { tuneFrequencies } from './core/SpinSimulator.js';
import { checkWildLineWins } from './core/SlotMath.js';
import { PAYTABLE, REELS_COUNT, ROWS_COUNT, PAYLINES, REEL_SEEDS, BET_PER_LINE, LINES_COUNT, REEL_LENGTH } from './games/fruitmachine/game.js';

async function run(mode) {
  const errors = [];
  const { rtp, paytable, diagnostics } = await tuneFrequencies(PAYTABLE, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 60000, trialsPerPoint: 1, maxIterations: 14, frequencyMode: mode,
    onProgress: (phase, i, mult, r) => { if (phase === 'shape') errors.push(r.error.toFixed(3)); },
  });
  console.log(mode, '-> rtp=', rtp.toFixed(2), 'diagnostics.rtpPhase.error=', diagnostics.rtpPhase.error.toFixed(3));
  console.log('  per-step errors:', errors.join(', '));
  const order = Object.keys(paytable).filter(s => paytable[s].type !== 'wild')
    .sort((a, b) => paytable[b].payout.at(-1) - paytable[a].payout.at(-1));
  console.log('  ', order.map(s => \`\${s}(pay\${paytable[s].payout.at(-1)})=\${paytable[s].frequency.toFixed(2)}\`).join(' '));
}

await run('rankTilt');
await run('premiumSplit');
await run('randomSearch');
"
```
Expected: for each mode, the per-step errors list shows genuinely different values step to step (not a repeated frozen number), `diagnostics.rtpPhase.error` is a real number, and in the printed symbol list (ordered highest-payout first), frequency values are non-decreasing left to right.

- [ ] **Step 3: Confirm live gameplay and `RUN SIMULATION` are unaffected**

Reuse the `run` skill's static-server approach from earlier this session (or start one directly): serve the repo root, navigate to `games/fruitmachine/index.html`, click SPIN a few times and confirm balance/win behavior is unchanged from before this plan, then open the simulation modal via RUN SIMULATION and confirm it still completes and shows results (unseeded `Math.random()` default path, unaffected by any of this plan's changes).

- [ ] **Step 4: Update the design spec status note**

In `docs/superpowers/specs/2026-07-24-frequency-tuner-gradient-descent-design.md`, no changes needed - the spec describes the target design, which this plan now implements in full. No step needed here beyond confirming (by re-reading the spec's Goals section) that every goal has a corresponding completed task above.
