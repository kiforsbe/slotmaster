# Per-Reel Frequency Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tuneFrequencies` tune the three per-reel frequency tables (`FREQUENCY_REEL1/2/3`) that fruit machine's paytable now actually uses, instead of a single flat `paytable.frequency` field that no longer exists - each reel gets its own independently-tuned tilt via coordinate descent, while still guaranteeing a higher-paying symbol is never more frequent than a lower-paying one within any single reel.

**Architecture:** `core/SpinSimulator.js`'s `tuneFrequencies` gets a new signature - `tuneFrequencies(paytable, reelFrequencyTables, options)` - and its RTP-reallocation phase becomes coordinate descent: `options.rounds` rounds cycling through every reel, each reel's turn calling the existing, unmodified `gradientDescent1D` to find that reel's own tilt while holding the other reels fixed. `premiumSplit`/`randomSearch` and the `frequencyMode` option are deleted - only per-reel rank-tilt remains. `core/SimulationPanel.js`'s UI and `games/fruitmachine/game.js`'s wiring follow.

**Tech Stack:** Vanilla JS (ES modules), Node's built-in `node:test` runner (`node --test tests/*.mjs`), no build step, no new dependencies.

## Global Constraints

- `paytable` never carries a `.frequency` field, anywhere in this change - frequency data lives exclusively on the per-reel tables (`{ symbol: { frequency } }`, the shape `generateReel` already accepts). `paytable` is used only for payout-based tier ranking and `type` lookups.
- The "higher-paying symbol is never more frequent than a lower-paying one" guarantee applies **per reel**: within any single reel's own tuned table, checked only over symbols present (nonzero base frequency) on that specific reel.
- `premiumSplit` and `randomSearch` frequency modes, `computePremiumTiers`, `frequencyMode` option, and the `topCandidates` mechanism are all deleted - not deprecated, removed.
- The scatter-frequency phase is unchanged in mechanism: one shared multiplier applied identically to every reel's table (not upgraded to independent-per-reel).
- No true multi-dimensional gradient descent. Per-reel tuning is coordinate descent - `gradientDescent1D` itself is not modified, just called once per reel per round.
- Full regression suite (`node --test tests/*.mjs`) must keep passing except the one pre-existing, unrelated `fruit machine RTP stays near the 96% design target` failure.
- Spec reference: `docs/superpowers/specs/2026-07-25-per-reel-frequency-tuning-design.md`.

---

### Task 1: Document `reel.strip` vs `reel.symbols` in `core/SlotEngine.js`

**Files:**
- Modify: `core/SlotEngine.js` (the `this.reels.push({...})` object literal inside `setupReels()`)

**Interfaces:** None - comment-only change, no behavior or signature affected.

- [ ] **Step 1: Add the clarifying comment**

In `core/SlotEngine.js`, find this block inside `setupReels()`:

```js
      this.reels.push({
        symbols: symbols,           // Array of symbol names (e.g. ['tut', 'jack', 'ace', ...])
        offsetY: 0,                 // Vertical scrolling pixel offset
        speed: 0,                   // Speed in pixels/frame - cosmetic, only used while 'spinning'
        state: 'idle',              // idle, spinning, landing, bounce
        strip: strip,               // The reel strip configuration
```

Replace it with:

```js
      this.reels.push({
        // `symbols` and `strip` are NOT redundant, despite both being arrays of symbol
        // names: `strip` is the full, static, correctly-weighted virtual reel (built once
        // by generateReel - more entries for common symbols, fewer for rare ones), the
        // canonical probability data. `symbols` is a small rolling window (rowsCount + 3
        // entries) of what's currently drawn on screen - refilled every frame from `strip`
        // while spinning, set to a specific consecutive slice of `strip` on landing. It has
        // no weighting logic of its own because it doesn't need any - it's a view into
        // `strip`, not a second, independent source of randomness.
        symbols: symbols,           // Array of symbol names (e.g. ['tut', 'jack', 'ace', ...])
        offsetY: 0,                 // Vertical scrolling pixel offset
        speed: 0,                   // Speed in pixels/frame - cosmetic, only used while 'spinning'
        state: 'idle',              // idle, spinning, landing, bounce
        strip: strip,               // The reel strip configuration
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check core/SlotEngine.js`
Expected: no output (valid syntax)

- [ ] **Step 3: Commit**

```bash
git add core/SlotEngine.js
git commit -m "docs: clarify reel.strip vs reel.symbols aren't redundant"
```

---

### Task 2: Rewrite `tuneFrequencies` for per-reel coordinate-descent tuning

**Files:**
- Modify: `core/SpinSimulator.js` (rename `gradientDescent1D`'s internal `paytable` field to `trial`; delete `computePremiumTiers`; rewrite `tuneFrequencies`)
- Modify: `tests/tunefrequencies.test.mjs` (rewrite integration tests for the new per-reel API/fixtures)

**Interfaces:**
- Consumes: `gradientDescent1D` (unmodified except the field rename below), `computeValueRanks`, `tieredRawWeights`, `renormalizeWeights` (all unchanged), `simulateSpins(..., rng)`, `createSeededRng`, `generateReel` (all pre-existing).
- Produces: `tuneFrequencies(paytable, reelFrequencyTables, options)` returning
  `Promise<{ reelFrequencyTables: Object[], rtp: number, triggerRatePct: number, diagnostics: Object }>`.
  `options.onProgress` is now called as
  `onProgress(phase: 'scatter'|'shape', iteration, multiplier, result, best, context?)` where
  `context` is `{ reelIndex, round }` during phase `'shape'` (absent during `'scatter'`).
  Task 3 (`core/SimulationPanel.js`) depends on this exact signature and callback shape.

- [ ] **Step 1: Rename `gradientDescent1D`'s internal `paytable` field to `trial`**

This field held "whatever `buildTrial` returned" even before this change - the name `paytable` was only ever accurate when that happened to be a paytable-like object. Per-reel tuning needs it to hold an *array* of reel tables instead, so the generic name is now load-bearing, not just misleading.

In `core/SpinSimulator.js`, find:

```js
    if (!best || error < best.error) best = { mult: param, error, result, paytable: trial };
```

Replace with:

```js
    if (!best || error < best.error) best = { mult: param, error, result, trial };
```

Then find the JSDoc return line just above the function:

```js
 * @returns {Promise<{ mult: number, error: number, result: Object, paytable: Object, converged: boolean }>} -
```

Replace with:

```js
 * @returns {Promise<{ mult: number, error: number, result: Object, trial: Object, converged: boolean }>} -
```

- [ ] **Step 2: Delete `computePremiumTiers`**

In `core/SpinSimulator.js`, delete this entire block:

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

```

(Leave `tieredRawWeights` and `renormalizeWeights`, defined immediately after it, untouched.)

- [ ] **Step 3: Write the failing tests**

Replace the entire contents of `tests/tunefrequencies.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { gradientDescent1D, tuneFrequencies } from '../core/SpinSimulator.js';
import { checkWildLineWins } from '../core/SlotMath.js';
import {
  PAYTABLE, REELS_COUNT, ROWS_COUNT, PAYLINES, REEL_SEEDS, BET_PER_LINE, LINES_COUNT, REEL_LENGTH,
  FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3,
} from '../games/fruitmachine/game.js';

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

const REEL_TABLES = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3];

function assertNeverInvertsPayoutOrderPerReel(paytable, reelFrequencyTables) {
  reelFrequencyTables.forEach((reelTable, reelIdx) => {
    const present = Object.keys(reelTable).filter(s => paytable[s].type !== 'wild' && reelTable[s].frequency > 0);
    for (const a of present) {
      for (const b of present) {
        const payoutA = paytable[a].payout.at(-1);
        const payoutB = paytable[b].payout.at(-1);
        if (payoutA > payoutB) {
          assert.ok(
            reelTable[a].frequency <= reelTable[b].frequency,
            `reel ${reelIdx + 1}: ${a} (payout ${payoutA}, freq ${reelTable[a].frequency}) should not be more ` +
            `frequent than ${b} (payout ${payoutB}, freq ${reelTable[b].frequency})`
          );
        }
      }
    }
  });
}

test('tuneFrequencies never inverts payout order within any single reel', async () => {
  const { reelFrequencyTables } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 8000, trialsPerPoint: 1, maxIterations: 4, rounds: 2,
  });
  assertNeverInvertsPayoutOrderPerReel(PAYTABLE, reelFrequencyTables);
});

test('tuneFrequencies never gives a reel-absent symbol (frequency 0) a nonzero frequency', async () => {
  const { reelFrequencyTables } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 8000, trialsPerPoint: 1, maxIterations: 4, rounds: 2,
  });
  // FREQUENCY_REEL1 and FREQUENCY_REEL2 both define star/strawberry at frequency: 0 (only
  // reel 3 carries them) - tuning must never turn those into nonzero frequencies.
  assert.equal(reelFrequencyTables[0].star.frequency, 0);
  assert.equal(reelFrequencyTables[0].strawberry.frequency, 0);
  assert.equal(reelFrequencyTables[1].star.frequency, 0);
  assert.equal(reelFrequencyTables[1].strawberry.frequency, 0);
});

test('tuneFrequencies diagnostics expose a per-step error and reel/round context via onProgress', async () => {
  const stepsSeen = [];
  await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 3, rounds: 2,
    onProgress: (phase, i, mult, result, best, context) => {
      if (phase === 'shape') stepsSeen.push({ error: result.error, context });
    },
  });
  const distinct = new Set(stepsSeen.map(s => s.error.toFixed(6)));
  assert.ok(distinct.size > 1, `expected per-step error to vary across iterations, got ${stepsSeen.map(s => s.error)}`);
  assert.ok(stepsSeen.every(s => s.context && typeof s.context.reelIndex === 'number' && typeof s.context.round === 'number'),
    'every "shape" phase progress callback must include { reelIndex, round }');
});

test('tuneFrequencies diagnostics.rtpPhase includes numeric error and boolean converged fields', async () => {
  const { diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 3, rounds: 1,
  });
  assert.ok(typeof diagnostics.rtpPhase.error === 'number');
  assert.ok(typeof diagnostics.rtpPhase.converged === 'boolean');
  // Fruit machine's paytable has no scatter-typed symbol, so this phase should be a no-op.
  assert.equal(diagnostics.scatterPhase, null);
});

test('tuneFrequencies throws if reelFrequencyTables.length does not match reelsCount', async () => {
  await assert.rejects(
    () => tuneFrequencies(PAYTABLE, [FREQUENCY_REEL1, FREQUENCY_REEL2], {
      reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
      reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
      trialSpins: 1000, maxIterations: 1, rounds: 1,
    }),
    /reelFrequencyTables/
  );
});
```

- [ ] **Step 4: Run tests to verify the new/changed ones fail**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: the 3 `gradientDescent1D` tests still PASS unchanged. The 5 `tuneFrequencies` tests FAIL - `tuneFrequencies(PAYTABLE, REEL_TABLES, {...})` is called with 3 arguments but the current implementation only accepts `(paytable, options)`, so `REEL_TABLES` is silently ignored as an extra argument and the real second argument (`options`) never reaches the function - `reelFrequencyTables` comes back `undefined` at minimum, and most assertions error out or fail.

- [ ] **Step 5: Rewrite `tuneFrequencies` in `core/SpinSimulator.js`**

Replace the entire JSDoc comment and function body - everything from the `/**` immediately before `export async function tuneFrequencies` down to that function's closing `}` - with:

```js
/**
 * Automatically tunes each reel's own `frequency` values (one table per reel - see
 * `reelFrequencyTables`) to hit a target RTP and a target free-spin trigger rate, without
 * touching any payout values or the paytable itself. Runs the real simulator against
 * candidate reel tables, so it stays accurate to whatever SlotMath.js's actual win logic
 * does at the time it's run.
 *
 * Frequencies live only on the per-reel tables, never on `paytable` - `paytable` is used
 * only for payout-based tier ranking and type lookups (wild/scatter/exclusions), and is
 * returned unchanged (not included in the return value at all).
 *
 * Strategy:
 *  1. Scale every 'scatter'-typed symbol's frequency by one shared multiplier, applied
 *     identically to every reel's table (gradientDescent1D), until the free-spin trigger
 *     rate lands on target. A symbol with frequency 0 on a given reel stays 0 (0 * mult = 0).
 *  2. Tune each reel's own value-symbol weights independently via coordinate descent: for
 *     `options.rounds` rounds, visit reel 0, then reel 1, ... then reel N-1 in turn. Each
 *     reel's turn runs the existing gradientDescent1D (unmodified) to find that reel's own
 *     tilt `t_r`, holding every other reel's table fixed at its current value - so this is
 *     coordinate descent over reels, not true multi-dimensional gradient descent.
 *     Within one reel's turn: weight(s) = baseFreq_r(s) * t_r^tierOf(s), t_r clamped >= 1,
 *     tierOf from computeValueRanks(paytable, ...) over the symbols actually present
 *     (nonzero base frequency) on that reel - so a higher-paying symbol present on a given
 *     reel can never end up more frequent than a lower-paying symbol also present on that
 *     same reel. If a reel has no tunable tiers (e.g. every present value-symbol shares one
 *     payout, or the reel has no non-excluded symbols at all), that reel is scaled uniformly
 *     instead (no ordering concern - a uniform multiplier never changes relative proportions).
 *  A global best (full reel-table combination + its measured RTP) is tracked across every
 *  sub-call in both phases, not just the final one: generateReel() rounds symbol counts to
 *  whole numbers per reel, so achievable trigger rate / RTP is quantized with occasional
 *  jumps rather than a smooth dial.
 *
 * @param {Object} paytable - Rules only (payout, type, wild, wildPenalty, wildExcludes,
 *   aloneBonus, friendlyName) - no `.frequency` field. Not mutated, not returned.
 * @param {Object[]} reelFrequencyTables - One table per reel, each `{ symbol: { frequency } }`
 *   (same shape generateReel already accepts). Not mutated; a tuned clone is returned.
 * @param {Object} [options]
 * @param {number} [options.reelsCount=reelFrequencyTables.length]
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
 * @param {number} [options.maxIterations=14] - Gradient-descent steps per reel per round.
 * @param {number} [options.rounds=3] - Coordinate-descent rounds over reels.
 * @param {string[]} [options.valueOrderExcludeTypes=['wild']] - Symbol `type`s excluded from
 *   tier assignment on every reel (held fixed at their post-scatter-phase frequency instead).
 * @param {[number, number]} [options.tiltBounds=[1, 40]] - Search bounds for each reel's tilt
 *   parameter. Values below 1 are clamped up to 1 regardless of what's passed - the tilt is a
 *   per-tier growth multiplier, and anything below 1 would invert the ordering guarantee.
 * @param {number} [options.searchSeed=12345] - Base PRNG seed for the common-random-numbers
 *   gradient estimates - a given seed always explores the same sequence, for reproducible runs.
 * @param {(phase: 'scatter'|'shape', iteration: number, multiplier: number|null, result: {rtp: number, triggerRate: number, error: number}, best: Object, context?: {reelIndex: number, round: number}) => (void|Promise<void>)} [options.onProgress] -
 *   Called (and awaited, if it returns a promise) after each candidate is measured. `context`
 *   is only present during phase 'shape', identifying which reel/round the step belongs to.
 * @returns {Promise<{ reelFrequencyTables: Object[], rtp: number, triggerRatePct: number, diagnostics: Object }>}
 */
export async function tuneFrequencies(paytable, reelFrequencyTables, options = {}) {
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('tuneFrequencies requires a paytable');
  }
  // Checked before destructuring options below - `reelsCount`'s default reads
  // `reelFrequencyTables.length`, which would throw an unrelated TypeError first if this
  // isn't actually an array.
  if (!Array.isArray(reelFrequencyTables) || reelFrequencyTables.length === 0) {
    throw new Error('tuneFrequencies requires a non-empty array of reelFrequencyTables');
  }

  const {
    reelsCount = reelFrequencyTables.length,
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
    rounds = 3,
    valueOrderExcludeTypes = ['wild'],
    tiltBounds = [1, 40],
    searchSeed = 12345,
    onProgress = null,
  } = options;

  const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

  if (reelFrequencyTables.length !== reelsCount) {
    throw new Error(`tuneFrequencies requires reelFrequencyTables to be an array of length reelsCount (${reelsCount})`);
  }

  const baseReelTables = reelFrequencyTables.map(rt => JSON.parse(JSON.stringify(rt)));
  const scatterSymbols = Object.keys(paytable).filter(s => paytable[s].type === 'scatter');

  function buildReelStrips(reelTables) {
    return reelTables.map((rt, i) => generateReel(rt, reelLength, reelSeeds[i % reelSeeds.length] + i * 100000));
  }

  // rngSeed is optional - omitted, this falls back to unseeded Math.random per trial (via
  // simulateSpins' own default). When provided, each trialsPerPoint repeat gets its own
  // derived seed, but that derived seed is identical across different candidate measurements
  // for the same trial index and rngSeed - the common-random-numbers property gradientDescent1D's
  // finite difference relies on.
  function measure(reelTables, rngSeed) {
    const reelStrips = buildReelStrips(reelTables);
    const config = { reelsCount, rowsCount, paytable, reelStrips, paylines, winEvaluator, wildSymbol, scatterSymbol };
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
  // One shared multiplier applied identically to every reel's table - a symbol with
  // frequency 0 on a given reel stays 0 (0 * mult = 0), so this is safe even for reels
  // that don't carry the scatter symbol at all.
  let currentReelTables = baseReelTables;
  let scatterPhase = null;
  if (scatterSymbols.length > 0) {
    scatterPhase = await gradientDescent1D({
      initialParam: 1,
      minParam: 0.05,
      maxParam: 8,
      target: targetTriggerRatePct,
      tolerance: triggerRateTolerancePct,
      buildTrial: (mult) => baseReelTables.map(rt => {
        const trial = JSON.parse(JSON.stringify(rt));
        scatterSymbols.forEach(s => { if (trial[s]) trial[s].frequency = rt[s].frequency * mult; });
        return trial;
      }),
      metricOf: (result) => result.triggerRate,
      measure,
      maxIterations,
      seedBase: searchSeed,
      onProgress: onProgress ? (i, mult, result, best) => onProgress('scatter', i, mult, result, best) : null,
      yieldToEventLoop,
    });
    currentReelTables = scatterPhase.trial;
  }

  // ---- Phase 2: coordinate descent over reels, tuning each reel's own value weights ----
  let globalBest = { reelTables: currentReelTables, error: Infinity, result: null, converged: false };
  let rtpPhaseStepCount = 0;

  for (let round = 0; round < rounds; round++) {
    for (let r = 0; r < reelsCount; r++) {
      const reelTable = currentReelTables[r];
      const nonScatterSymbols = Object.keys(reelTable).filter(s => !scatterSymbols.includes(s) && reelTable[s].frequency > 0);
      const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);

      const fixedShapeSymbols = nonScatterSymbols.filter(s => valueOrderExcludeTypes.includes(paytable[s].type));
      const valueSymbols = nonScatterSymbols.filter(s => !valueOrderExcludeTypes.includes(paytable[s].type));
      const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);
      const valueBudget = nonScatterTotal - fixedShapeTotal;

      if (valueSymbols.length === 0 || valueBudget <= 0) {
        // Nothing tunable on this reel this round - leave it untouched and move to the next reel.
        continue;
      }

      const tierOf = computeValueRanks(paytable, valueSymbols);
      const tieredModeUsable = new Set(Object.values(tierOf)).size > 1;
      const baseFreq = {}; valueSymbols.forEach(s => { baseFreq[s] = reelTable[s].frequency; });

      // Applies an already-computed per-symbol weight map to a clone of this reel's table,
      // then returns the *full* N-reel array (this reel updated, every other reel untouched
      // at its current value) - `measure()` always needs the complete set to build strips.
      function applyWeights(weights) {
        const newReel = JSON.parse(JSON.stringify(reelTable));
        valueSymbols.forEach(s => { newReel[s].frequency = weights[s]; });
        const trial = currentReelTables.slice();
        trial[r] = newReel;
        return trial;
      }

      const tiltLo = Math.max(1, tiltBounds[0]);
      const tiltHi = Math.max(tiltLo, tiltBounds[1]);

      const reelResult = tieredModeUsable
        ? await gradientDescent1D({
            // weight(s) = baseFreq(s) * t^tierOf(s), t clamped >= 1 - guarantees a
            // higher-paying symbol present on this reel is never more frequent than a
            // lower-paying symbol also present on this reel.
            initialParam: 1,
            minParam: tiltLo,
            maxParam: tiltHi,
            target: targetRtp,
            tolerance: rtpTolerancePct,
            buildTrial: (t) => applyWeights(renormalizeWeights(tieredRawWeights(valueSymbols, baseFreq, tierOf, t), valueBudget)),
            metricOf: (result) => result.rtp,
            measure,
            maxIterations,
            seedBase: searchSeed + 300000 + r * 50000 + round * 5000,
            onProgress: onProgress ? (i, t, result, best) => onProgress('shape', i, t, result, best, { reelIndex: r, round }) : null,
            yieldToEventLoop,
          })
        : await gradientDescent1D({
            // Degenerate case for this reel (every present value-symbol shares one payout
            // tier): scale them uniformly instead. No ordering concern - a uniform
            // multiplier never changes relative proportions, so the tilt isn't floored at 1.
            initialParam: 1,
            minParam: 0.2,
            maxParam: 5,
            target: targetRtp,
            tolerance: rtpTolerancePct,
            buildTrial: (mult) => {
              const weights = {}; valueSymbols.forEach(s => { weights[s] = baseFreq[s] * mult; });
              return applyWeights(weights);
            },
            metricOf: (result) => result.rtp,
            measure,
            maxIterations,
            seedBase: searchSeed + 900000 + r * 50000 + round * 5000,
            onProgress: onProgress ? (i, mult, result, best) => onProgress('shape', i, mult, result, best, { reelIndex: r, round }) : null,
            yieldToEventLoop,
          });

      currentReelTables = reelResult.trial;
      rtpPhaseStepCount++;
      if (reelResult.error < globalBest.error) {
        globalBest = { reelTables: currentReelTables, error: reelResult.error, result: reelResult.result, converged: reelResult.converged };
      }
    }
  }

  const rtpPhaseRan = rtpPhaseStepCount > 0;
  const finalReelTables = rtpPhaseRan ? globalBest.reelTables : currentReelTables;
  const finalResult = rtpPhaseRan ? globalBest.result : measure(finalReelTables);

  return {
    reelFrequencyTables: finalReelTables,
    rtp: finalResult.rtp,
    triggerRatePct: finalResult.triggerRate,
    diagnostics: {
      scatterPhase: scatterPhase ? { multiplier: scatterPhase.mult, error: scatterPhase.error, converged: !!scatterPhase.converged, ...scatterPhase.result } : null,
      rtpPhase: rtpPhaseRan ? {
        error: globalBest.error,
        converged: !!globalBest.converged,
        rtp: globalBest.result.rtp,
        triggerRate: globalBest.result.triggerRate,
        roundsRun: rounds,
      } : null,
    }
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS (8 tests: 3 `gradientDescent1D` + 5 `tuneFrequencies`)

- [ ] **Step 7: Run the full suite to confirm no other regressions**

Run: `node --test tests/*.mjs`
Expected: PASS for all tests except the one pre-existing, unrelated `fruit machine RTP stays near the 96% design target` failure. In particular `tests/spinsimulator.test.mjs` and `tests/slotmath.test.mjs` (which don't touch `tuneFrequencies`) must be untouched by this rewrite.

- [ ] **Step 8: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "refactor: tune per-reel frequency tables via coordinate descent, remove premiumSplit/randomSearch"
```

**Addendum (found during execution, not in the original Step 5 code above):** the "never inverts payout order" test failed against the real, non-idealized `FREQUENCY_REEL1/2/3` data (historical machine weights aren't monotonic-by-payout to start with) and exposed two real gaps in the Step 5 design as originally written:

1. `gradientDescent1D` stops once its RTP metric is within tolerance (or iterations run out) - neither condition has any connection to whether every tier pair on a reel has individually crossed over yet. A search that reaches "good enough RTP" at a small tilt can leave a lower-paying pair still inverted. Fix: a new pure helper `minOrderSafeTilt(valueSymbols, baseFreq, tierOf)` (added next to `renormalizeWeights`) computes the analytic smallest `t >= 1` that satisfies every present pair on that reel, independent of RTP; after each reel's `gradientDescent1D` call, if `safeTilt > reelResult.mult`, the code re-measures at `safeTilt` and adopts that as `reelResult` instead.
2. The originally-planned `globalBest` (tracking whichever step *anywhere in the whole run* had the lowest RTP error) could point at a snapshot from before some reel's safety floor was applied, silently reintroducing the violation the later step fixed. Fix: dropped `globalBest` entirely: the final result is `currentReelTables` as it stands after the full round/reel loop completes (`lastReelResult` replaces it purely for reporting the final step's own `.error`/`.converged`/`.result` in diagnostics) - since every reel gets its safety floor enforced on its last visit and is never touched again after, the post-loop state is order-safe by construction.

Net effect on the plan's stated interfaces: unchanged (`tuneFrequencies`'s signature, return shape, and `onProgress` callback shape are exactly as specified above) - this only changed internals. The test file content in Step 3 needed one adjustment beyond what's shown above: the "never inverts payout order" test's `maxIterations` was bumped from 4 to 20 (real per-reel crossover points can require a non-trivial tilt to reach, unlike toy fixtures).

---

### Task 3: Update `core/SimulationPanel.js` for per-reel tuning UI

**Files:**
- Modify: `core/SimulationPanel.js`

**Interfaces:**
- Consumes: `tuneFrequencies(paytable, reelFrequencyTables, options)` from Task 2 - exact signature and `onProgress(phase, i, mult, result, best, context)` shape.
- Produces: `openTuneFrequenciesPanel({ paytable, reelFrequencyTables, tuneConfig, domRefs })` - Task 4 depends on this new `reelFrequencyTables` parameter. `formatReelFrequencyTablesForCopy(reelFrequencyTables)` replaces `formatPaytableForCopy` (deleted - it had no other callers).

- [ ] **Step 1: Replace `formatPaytableForCopy` with `formatReelFrequencyTablesForCopy`**

In `core/SimulationPanel.js`, replace the entire `formatPaytableForCopy` function (from its doc comment through its closing `}`):

```js
/**
 * Formats a paytable back out as a paste-ready `const PAYTABLE = { ... }` literal,
 * column-aligned. Field-agnostic: formats whichever scalar/array/boolean fields are
 * present (union across all symbols, first-seen order), so it works unchanged for
 * paytables with different field sets. `friendlyName` (if present) always renders last.
 */
export function formatPaytableForCopy(paytable) {
  const symbols = Object.keys(paytable);
  if (symbols.length === 0) return 'const PAYTABLE = {};';

  const keyWidth = Math.max(...symbols.map(s => s.length + 1));

  const fieldNames = [];
  symbols.forEach(s => {
    Object.keys(paytable[s]).forEach(field => {
      if (field !== 'payout' && field !== 'friendlyName' && !fieldNames.includes(field)) {
        fieldNames.push(field);
      }
    });
  });

  const payoutLen = paytable[symbols[0]].payout.length;
  const payoutColWidths = Array.from({ length: payoutLen }, (_, col) =>
    Math.max(...symbols.map(s => String(paytable[s].payout[col]).length))
  );
  const fmtPayout = (arr) =>
    '[' + arr.map((v, i) => String(v).padStart(payoutColWidths[i])).join(', ') + ']';

  const renderValue = (value) => {
    if (Array.isArray(value)) return `[${value.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ')}]`;
    if (typeof value === 'string') return `'${value}'`;
    return String(value);
  };

  const fmtField = (fieldName) => {
    const rendered = {};
    symbols.forEach(s => {
      rendered[s] = (fieldName in paytable[s]) ? `${fieldName}: ${renderValue(paytable[s][fieldName])},` : '';
    });
    const width = Math.max(...symbols.map(s => rendered[s].length));
    const padded = {};
    symbols.forEach(s => { padded[s] = rendered[s].padEnd(width); });
    return padded;
  };

  const fieldColumns = fieldNames.map(fmtField);

  const lines = symbols.map(symbol => {
    const data = paytable[symbol];
    const keyPart = `${symbol}:`.padEnd(keyWidth);
    const fieldsPart = fieldColumns.map(col => col[symbol]).filter(s => s.length > 0).join(' ');
    const namePart = data.friendlyName !== undefined ? ` friendlyName: '${data.friendlyName}'` : '';
    return `  ${keyPart} { payout: ${fmtPayout(data.payout)}, ${fieldsPart}${namePart} },`;
  });

  return `const PAYTABLE = {\n${lines.join('\n')}\n};`;
}
```

with:

```js
/**
 * Formats an array of per-reel frequency tables back out as paste-ready
 * `export const FREQUENCY_REELn = { ... }` literals, column-aligned - matching the exact
 * style already used in games/fruitmachine/game.js.
 */
export function formatReelFrequencyTablesForCopy(reelFrequencyTables) {
  return reelFrequencyTables.map((table, i) => {
    const symbols = Object.keys(table);
    if (symbols.length === 0) return `export const FREQUENCY_REEL${i + 1} = {};`;

    const keyWidth = Math.max(...symbols.map(s => s.length + 1));
    const lines = symbols.map(symbol => {
      const keyPart = `${symbol}:`.padEnd(keyWidth);
      return `  ${keyPart} { frequency: ${table[symbol].frequency.toFixed(1)} },`;
    });
    return `export const FREQUENCY_REEL${i + 1} = {\n${lines.join('\n')}\n};`;
  }).join('\n\n');
}
```

- [ ] **Step 2: Update `openTuneFrequenciesPanel`'s signature and mode dropdown**

Replace:

```js
/**
 * Opens (or reuses) the frequency auto-balancer panel (SpinSimulator.js's tuneFrequencies)
 * with inputs for the tuning targets, showing live iteration-by-iteration progress. Only
 * ever reports a suggestion - never mutates the caller's live paytable/reels itself
 * (applying a result means regenerating reel strips, a deliberate source change).
 * @param {Object} args
 * @param {Object} args.paytable
 * @param {Object} args.tuneConfig - { reelsCount, rowsCount, paylines, reelSeeds, betPerLine, linesCount, reelLength, winEvaluator, wildSymbol, scatterSymbol }
 * @param {Object} args.domRefs - { simModal, simStats }
 */
export function openTuneFrequenciesPanel({ paytable, tuneConfig, domRefs }) {
```

with:

```js
/**
 * Opens (or reuses) the frequency auto-balancer panel (SpinSimulator.js's tuneFrequencies)
 * with inputs for the tuning targets, showing live iteration-by-iteration progress. Only
 * ever reports a suggestion - never mutates the caller's live paytable/reels itself
 * (applying a result means regenerating reel strips, a deliberate source change).
 * @param {Object} args
 * @param {Object} args.paytable
 * @param {Object[]} args.reelFrequencyTables - One table per reel, each `{ symbol: { frequency } }`.
 * @param {Object} args.tuneConfig - { reelsCount, rowsCount, paylines, reelSeeds, betPerLine, linesCount, reelLength, winEvaluator, wildSymbol, scatterSymbol }
 * @param {Object} args.domRefs - { simModal, simStats }
 */
export function openTuneFrequenciesPanel({ paytable, reelFrequencyTables, tuneConfig, domRefs }) {
```

Then, in the same function, replace:

```js
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
      <button id="tune-start-btn" class="btn-close-sim">START TUNING</button>
      <div id="tune-progress-log" style="display: none; margin-top: 12px; max-height: 160px; overflow-y: auto; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;"></div>
      <div id="tune-results"></div>
    `;
    tuneContainer.querySelector('#tune-start-btn').addEventListener('click', () => startTuning({ paytable, tuneConfig, tuneContainer }));
```

with:

```js
        <label style="font-size: 0.8em; color: #ccc;">Coordinate Descent Rounds<br>
          <input id="tune-rounds" type="number" value="3" step="1" min="1" max="10" style="width: 100%; margin-top: 4px;">
        </label>
      </div>
      <p style="font-size: 0.75em; color: #888; margin: -4px 0 12px;">
        Each reel is tuned independently (coordinate descent: reel 1, then reel 2, ... then back to reel 1,
        for this many rounds), guaranteeing a higher-paying symbol is never more frequent than a lower-paying
        one within that same reel. For some paytables the target RTP may not be reachable under that
        constraint (achieved RTP will fall short; see the result below).
      </p>
      <button id="tune-start-btn" class="btn-close-sim">START TUNING</button>
      <div id="tune-progress-log" style="display: none; margin-top: 12px; max-height: 160px; overflow-y: auto; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;"></div>
      <div id="tune-results"></div>
    `;
    tuneContainer.querySelector('#tune-start-btn').addEventListener('click', () => startTuning({ paytable, reelFrequencyTables, tuneConfig, tuneContainer }));
```

- [ ] **Step 3: Rewrite `startTuning`**

Replace the entire `startTuning` function (from `async function startTuning` through its closing `}`) with:

```js
async function startTuning({ paytable, reelFrequencyTables, tuneConfig, tuneContainer }) {
  const startBtn = tuneContainer.querySelector('#tune-start-btn');
  const logEl = tuneContainer.querySelector('#tune-progress-log');
  const resultsEl = tuneContainer.querySelector('#tune-results');
  const inputs = {
    targetRtp: tuneContainer.querySelector('#tune-target-rtp'),
    targetTriggerRatePct: tuneContainer.querySelector('#tune-target-trigger'),
    reelLength: tuneContainer.querySelector('#tune-reel-length'),
    trialSpins: tuneContainer.querySelector('#tune-trial-spins'),
    trialsPerPoint: tuneContainer.querySelector('#tune-trials-per-point'),
    maxIterations: tuneContainer.querySelector('#tune-max-iterations'),
    rounds: tuneContainer.querySelector('#tune-rounds'),
  };

  const options = {
    reelsCount: tuneConfig.reelsCount,
    rowsCount: tuneConfig.rowsCount,
    paylines: tuneConfig.paylines,
    reelSeeds: tuneConfig.reelSeeds,
    betPerLine: tuneConfig.betPerLine,
    linesCount: tuneConfig.linesCount,
    winEvaluator: tuneConfig.winEvaluator,
    wildSymbol: tuneConfig.wildSymbol,
    scatterSymbol: tuneConfig.scatterSymbol,
    reelLength: parseInt(inputs.reelLength.value, 10) || tuneConfig.reelLength,
    targetRtp: parseFloat(inputs.targetRtp.value) || 96,
    targetTriggerRatePct: parseFloat(inputs.targetTriggerRatePct.value) || 0.6,
    trialSpins: parseInt(inputs.trialSpins.value, 10) || 300000,
    trialsPerPoint: parseInt(inputs.trialsPerPoint.value, 10) || 2,
    maxIterations: parseInt(inputs.maxIterations.value, 10) || 10,
    rounds: parseInt(inputs.rounds.value, 10) || 3,
  };

  Object.values(inputs).forEach(el => { el.disabled = true; });
  startBtn.disabled = true;
  startBtn.textContent = 'TUNING...';
  resultsEl.innerHTML = '';
  logEl.style.display = 'block';
  logEl.innerHTML = '';

  const appendLog = (line) => {
    const row = document.createElement('div');
    row.textContent = line;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  };

  try {
    const { reelFrequencyTables: tunedReelTables, rtp, triggerRatePct, diagnostics } = await tuneFrequencies(paytable, reelFrequencyTables, {
      ...options,
      onProgress: (phase, i, mult, r, best, context) => {
        const label = phase === 'scatter'
          ? `Scatter frequency ${i + 1}`
          : `Reel ${context.reelIndex + 1} · round ${context.round + 1} · step ${i + 1}`;
        const multLabel = mult == null ? '' : `  mult=${mult.toFixed(3)}`;
        appendLog(`[${label}]${multLabel}  RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  err=${r.error.toFixed(4)}  (best err=${best.error.toFixed(4)})`);
      }
    });

    const rtpConverged = !!diagnostics.rtpPhase?.converged;
    const scatterConverged = diagnostics.scatterPhase == null || !!diagnostics.scatterPhase.converged;
    appendLog(
      rtpConverged && scatterConverged
        ? `Done. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%`
        : `⚠ Did NOT converge. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%  (this is the closest attempt found, not a successful tune)`
    );
    console.log('Frequency tuner diagnostics:', diagnostics);

    let html = `<p style="font-size: 0.85em; color: #ccc; margin: 12px 0 8px;">Achieved RTP: <strong>${rtp.toFixed(2)}%</strong> &nbsp;|&nbsp; Free spin trigger rate: <strong>${triggerRatePct.toFixed(3)}%</strong> (1 in ${(100 / triggerRatePct).toFixed(0)})</p>`;

    const targetRtp = options.targetRtp;
    if (!rtpConverged) {
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 <strong>⚠ Target RTP (${targetRtp}%) was NOT reached</strong> under the per-reel ordering constraint -
                 the closest attempt found is off by ${diagnostics.rtpPhase.error.toFixed(2)} percentage points. This can mean the
                 current frequencies/payouts don't allow ${targetRtp}% RTP while keeping every symbol no more frequent than a
                 lower-paying one on the same reel - don't treat the RTP shown above as final without checking this.
               </p>`;
    }

    html += `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;">`;
    reelFrequencyTables.forEach((baseReelTable, reelIdx) => {
      const tunedReelTable = tunedReelTables[reelIdx];
      html += `<div><h4 style="margin: 0 0 6px; font-size: 0.8em; color: #aaa; text-transform: uppercase;">Reel ${reelIdx + 1}</h4>`;
      html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.85em;">`;
      html += `<thead><tr style="color: #888; font-size: 0.75em; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.15);">
                  <th style="text-align: left; padding: 3px;">Symbol</th>
                  <th style="text-align: right; padding: 3px;">Current</th>
                  <th style="text-align: right; padding: 3px;">Suggested</th>
                  <th style="text-align: right; padding: 3px;">Δ</th>
                </tr></thead><tbody>`;
      Object.keys(baseReelTable).forEach(symbol => {
        const current = baseReelTable[symbol].frequency;
        const suggested = tunedReelTable[symbol].frequency;
        const delta = suggested - current;
        const deltaColor = Math.abs(delta) < 0.001 ? '#888' : (delta > 0 ? '#7fd97f' : '#e67f7f');
        html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 3px;">${paytable[symbol]?.friendlyName || symbol}</td>
                    <td style="text-align: right; padding: 3px;">${current.toFixed(4)}</td>
                    <td style="text-align: right; padding: 3px; font-weight: bold;">${suggested.toFixed(4)}</td>
                    <td style="text-align: right; padding: 3px; color: ${deltaColor};">${delta >= 0 ? '+' : ''}${delta.toFixed(4)}</td>
                  </tr>`;
      });
      html += `</tbody></table></div>`;
    });
    html += `</div>`;
    html += `<p style="font-size: 0.75em; color: #888; margin-top: 10px;">This is a suggestion only - apply it by replacing FREQUENCY_REEL1/2/3 in game.js and reloading, so REEL_STRIPS regenerates from the new weights.</p>`;

    html += `<div style="margin-top: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">Copy-paste ready FREQUENCY_REEL tables</span>
                  <button id="tune-copy-btn" class="btn-icon btn-sim-btn" style="padding: 4px 10px; font-size: 0.75em;">COPY</button>
                </div>
                <textarea id="tune-paytable-output" readonly style="width: 100%; height: 200px; box-sizing: border-box; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.4); color: #ddd; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 8px; resize: vertical;"></textarea>
              </div>`;

    resultsEl.innerHTML = html;

    const paytableOutput = resultsEl.querySelector('#tune-paytable-output');
    paytableOutput.value = formatReelFrequencyTablesForCopy(tunedReelTables);

    const copyBtn = resultsEl.querySelector('#tune-copy-btn');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(paytableOutput.value);
      } catch (err) {
        paytableOutput.select();
      }
      const original = copyBtn.textContent;
      copyBtn.textContent = 'COPIED!';
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    });
  } catch (error) {
    console.error('Frequency tuning failed:', error);
    appendLog(`Error: ${error.message}`);
  } finally {
    Object.values(inputs).forEach(el => { el.disabled = false; });
    startBtn.disabled = false;
    startBtn.textContent = 'START TUNING';
  }
}
```

- [ ] **Step 4: Syntax-check the file**

Run: `node --check core/SimulationPanel.js`
Expected: no output (valid syntax)

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `node --test tests/*.mjs`
Expected: PASS for all tests except the one pre-existing, unrelated fruitmachine RTP failure (this file has no direct test coverage, but the suite must still be green elsewhere).

- [ ] **Step 6: Commit**

```bash
git add core/SimulationPanel.js
git commit -m "feat: rework TUNE FREQUENCIES UI for per-reel tables and coordinate-descent rounds"
```

---

### Task 4: Wire `reelFrequencyTables` into `games/fruitmachine/game.js`

**Files:**
- Modify: `games/fruitmachine/game.js`

**Interfaces:**
- Consumes: `openTuneFrequenciesPanel({ paytable, reelFrequencyTables, tuneConfig, domRefs })` from Task 3.

- [ ] **Step 1: Pass the three reel frequency tables into the panel**

In `games/fruitmachine/game.js`, replace:

```js
      openTuneFrequenciesPanel({
        paytable: PAYTABLE,
        tuneConfig: {
```

with:

```js
      openTuneFrequenciesPanel({
        paytable: PAYTABLE,
        reelFrequencyTables: [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3],
        tuneConfig: {
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check games/fruitmachine/game.js`
Expected: no output (valid syntax)

- [ ] **Step 3: Run the full test suite to confirm no regressions**

Run: `node --test tests/*.mjs`
Expected: PASS for all tests except the one pre-existing, unrelated fruitmachine RTP failure.

- [ ] **Step 4: Commit**

```bash
git add games/fruitmachine/game.js
git commit -m "feat: pass per-reel frequency tables into the TUNE FREQUENCIES panel"
```

---

### Task 5: End-to-end verification

**Files:** none modified - verification only.

**Interfaces:** none.

- [ ] **Step 1: Run the full automated test suite**

Run: `node --test tests/*.mjs`
Expected: all tests pass except `fruit machine RTP stays near the 96% design target` (pre-existing, unrelated - the whole point of this plan is to make that target reachable again, but hitting it depends on actually running the tuner against the live paytable and adopting its output, not guaranteed by the code change alone).

- [ ] **Step 2: Manually verify the live fruitmachine reel tables end-to-end with a throwaway script**

Run this via the Bash tool (not saved to the repo):

```bash
node --input-type=module -e "
import { tuneFrequencies } from './core/SpinSimulator.js';
import { checkWildLineWins } from './core/SlotMath.js';
import {
  PAYTABLE, REELS_COUNT, ROWS_COUNT, PAYLINES, REEL_SEEDS, BET_PER_LINE, LINES_COUNT, REEL_LENGTH,
  FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3,
} from './games/fruitmachine/game.js';

const steps = [];
const { rtp, reelFrequencyTables, diagnostics } = await tuneFrequencies(
  PAYTABLE, [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3],
  {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 40000, trialsPerPoint: 1, maxIterations: 8, rounds: 3,
    onProgress: (phase, i, mult, r, best, context) => {
      if (phase === 'shape') steps.push(\`reel\${context.reelIndex + 1}/round\${context.round + 1}: err=\${r.error.toFixed(3)}\`);
    },
  }
);
console.log('rtp=', rtp.toFixed(2), 'converged=', diagnostics.rtpPhase.converged, 'error=', diagnostics.rtpPhase.error.toFixed(3));
console.log('step errors:', steps.join(', '));
reelFrequencyTables.forEach((table, i) => {
  const order = Object.keys(table).filter(s => PAYTABLE[s].type !== 'wild' && table[s].frequency > 0)
    .sort((a, b) => PAYTABLE[b].payout.at(-1) - PAYTABLE[a].payout.at(-1));
  console.log(\`reel\${i + 1}:\`, order.map(s => \`\${s}(pay\${PAYTABLE[s].payout.at(-1)})=\${table[s].frequency.toFixed(2)}\`).join(' '));
});
"
```

Expected: the step-errors list shows genuinely different values (not a repeated frozen number), `diagnostics.rtpPhase.error` is a real number, and within each reel's printed symbol list (ordered highest-payout first, only symbols present on that reel), frequency values are non-decreasing left to right.

- [ ] **Step 3: Confirm live gameplay, RUN SIMULATION, and TUNE FREQUENCIES all work in the browser**

Serve the repo root (reuse the `run` skill's static-server approach), navigate to `games/fruitmachine/index.html`:
- Click SPIN a few times, confirm balance/win behavior is unchanged from before this plan.
- Open RUN SIMULATION, confirm it still completes and shows results.
- Open TUNE FREQUENCIES, confirm the mode dropdown is gone and a "Coordinate Descent Rounds" input is present, click START TUNING, confirm the progress log shows `Reel N · round M · step K` labels with varying `err=` values, confirm the results section shows three side-by-side reel tables, and confirm the COPY button produces valid `export const FREQUENCY_REEL1 = {...}` / `FREQUENCY_REEL2` / `FREQUENCY_REEL3` text.

- [ ] **Step 4: Confirm every spec goal has a corresponding completed task**

Re-read `docs/superpowers/specs/2026-07-25-per-reel-frequency-tuning-design.md`'s Goals section and confirm each goal maps to a task above. No code changes expected here - this is a final cross-check, not a new step.
