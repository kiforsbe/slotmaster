# Per-Symbol Nelder-Mead Frequency Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `tuneFrequencies`' per-reel scalar-tilt Phase 2 (proven incapable of reducing
RTP on real data - see design doc) with a genuine multi-dimensional Nelder-Mead search over
one free weight per (value symbol, reel) pair, with "higher payout ⇒ lower/equal frequency"
as a soft loss penalty instead of a hard post-hoc floor.

**Architecture:** A new generic, pure `nelderMead` simplex optimizer (mirrors
`gradientDescent1D`'s existing style/conventions) drives a single joint search across all
value-symbol-per-reel dimensions. `tuneFrequencies`'s Phase 1 (scatter/trigger-rate tuning)
is untouched. Phase 2 gets a new `evaluate(point)` closure combining measured RTP error and
an ordering-violation penalty into one scalar loss, with weights projected (clamped +
renormalized to each reel's fixed value-budget) before every evaluation.

**Tech Stack:** Plain ES modules, no build step, no new npm dependency (no bundler exists in
this repo to resolve one into the browser) - Nelder-Mead is vendored as a small, standard,
clearly-commented implementation.

## Global Constraints

- No new runtime dependencies (no bundler in this repo - see design doc's Decision section).
- Symbols with baseline frequency `0` on a given reel must never become nonzero (structural
  guarantee: excluded from the parameter set entirely, not merely floored).
- Symbols whose `type` is in `valueOrderExcludeTypes` (default `['wild']`) stay fixed,
  exactly as today.
- Design doc: `docs/superpowers/specs/2026-07-25-nelder-mead-per-symbol-tuning-design.md`

---

### Task 1: Generic Nelder-Mead simplex optimizer

**Files:**
- Modify: `core/SpinSimulator.js` (add `nelderMead`, after `gradientDescent1D`)
- Test: `tests/tunefrequencies.test.mjs` (add tests near the existing `gradientDescent1D` tests)

**Interfaces:**
- Produces: `export async function nelderMead({ initialPoint, initialStepSize, evaluate, maxIterations, convergenceTolerance = 1e-4, onProgress, yieldToEventLoop }) => Promise<{ point: number[], loss: number, result: Object, iterations: number, converged: boolean }>`
  - `evaluate: (point: number[]) => ({ loss: number, [key: string]: any })` - synchronous;
    extra fields on the return value are carried through onto the vertex object (and thus
    onto `result`/`best` passed to `onProgress`, and the final returned `result`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/tunefrequencies.test.mjs`, right after the existing `gradientDescent1D` tests
(so `import { gradientDescent1D, tuneFrequencies }` becomes `import { gradientDescent1D, nelderMead, tuneFrequencies }`):

```js
test('nelderMead minimizes a simple 2D quadratic bowl', async () => {
  // loss(x, y) = (x-3)^2 + (y+2)^2 - deterministic, minimum at (3, -2), loss 0 there.
  const { point, loss, converged } = await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 100,
    convergenceTolerance: 1e-6,
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(converged, `expected convergence, got loss=${loss}`);
  assert.ok(Math.abs(point[0] - 3) < 0.01, `expected x near 3, got ${point[0]}`);
  assert.ok(Math.abs(point[1] - (-2)) < 0.01, `expected y near -2, got ${point[1]}`);
});

test('nelderMead respects maxIterations and still returns the best point found', async () => {
  const { loss, iterations } = await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 3,
    convergenceTolerance: 1e-9, // unreachable in 3 iterations, forces the cap
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(iterations <= 3, `expected iterations capped at 3, got ${iterations}`);
  assert.ok(loss < 13, `expected some improvement over the initial loss (9+4=13), got ${loss}`);
});

test('nelderMead carries extra evaluate() fields through onto the returned result', async () => {
  const { result } = await nelderMead({
    initialPoint: [0],
    initialStepSize: 1,
    evaluate: ([x]) => ({ loss: (x - 5) ** 2, tag: 'custom-field' }),
    maxIterations: 20,
    onProgress: null,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(result.tag, 'custom-field');
});

test('nelderMead reports per-iteration progress via onProgress', async () => {
  const iterationsSeen = [];
  await nelderMead({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 10,
    convergenceTolerance: 1e-9, // unreachable, so all 10 iterations run
    onProgress: (i, point, result, best) => { iterationsSeen.push(i); },
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.deepEqual(iterationsSeen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: FAIL with `nelderMead is not a function` (not yet exported).

- [ ] **Step 3: Implement `nelderMead`**

Add to `core/SpinSimulator.js`, directly after `gradientDescent1D`'s closing brace:

```js
/**
 * Generic Nelder-Mead simplex minimizer over an n-dimensional parameter vector.
 * Derivative-free - compares function values across n+1 simplex vertices (reflect, expand,
 * contract, shrink) rather than estimating a gradient - the standard choice (same algorithm
 * behind scipy.optimize.minimize(method='Nelder-Mead') / MATLAB's fminsearch) for objectives
 * that are noisy or expensive to differentiate, both true here: `evaluate` wraps a Monte
 * Carlo RTP measurement, not a closed-form function, and a numerical gradient across many
 * dimensions would need one extra evaluation per dimension per iteration, where Nelder-Mead
 * typically needs only one or two.
 *
 * Callers are responsible for their own CRN (common random numbers) discipline if
 * `evaluate` wraps something stochastic - e.g. closing over one fixed RNG seed for the
 * whole call, so every point (old or new) is evaluated under directly comparable
 * conditions and vertices never need re-evaluating just because time passed.
 *
 * @param {Object} args
 * @param {number[]} args.initialPoint - Starting parameter vector.
 * @param {number} args.initialStepSize - Perturbation used to build the initial simplex
 *   (vertex i = initialPoint with dimension i-1 offset by this amount).
 * @param {(point: number[]) => ({ loss: number, [key: string]: any })} args.evaluate -
 *   Evaluates one point; must return at least `{ loss }` (lower is better). Any extra
 *   fields are carried through onto the vertex object returned via onProgress/result.
 * @param {number} args.maxIterations
 * @param {number} [args.convergenceTolerance=1e-4] - Stop early once the spread between the
 *   simplex's best and worst loss is at or below this.
 * @param {(iteration: number, point: number[], result: Object, best: Object) => (void|Promise<void>)} [args.onProgress]
 * @param {() => Promise<void>} args.yieldToEventLoop
 * @returns {Promise<{ point: number[], loss: number, result: Object, iterations: number, converged: boolean }>} -
 *   `converged` is true iff the search stopped because the simplex's spread collapsed below
 *   `convergenceTolerance`, not because `maxIterations` ran out.
 */
export async function nelderMead({
  initialPoint, initialStepSize, evaluate, maxIterations,
  convergenceTolerance = 1e-4, onProgress, yieldToEventLoop,
}) {
  const n = initialPoint.length;
  const ALPHA = 1, GAMMA = 2, RHO = 0.5, SIGMA = 0.5;

  const evalPoint = (point) => ({ point, ...evaluate(point) });

  // Initial simplex: vertex 0 = initialPoint, vertex i (1..n) = initialPoint with dimension
  // i-1 perturbed by initialStepSize - the standard right-angled starting simplex.
  let vertices = [evalPoint(initialPoint.slice())];
  for (let i = 0; i < n; i++) {
    const p = initialPoint.slice();
    p[i] += initialStepSize;
    vertices.push(evalPoint(p));
  }

  let best = vertices.reduce((a, b) => (b.loss < a.loss ? b : a));
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    vertices.sort((a, b) => a.loss - b.loss);
    if (vertices[0].loss < best.loss) best = vertices[0];

    if (onProgress) await onProgress(iter, vertices[0].point, vertices[0], best);
    await yieldToEventLoop();

    if (vertices[n].loss - vertices[0].loss <= convergenceTolerance) { converged = true; break; }

    const worst = vertices[n];
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      vertices[i].point.forEach((x, d) => { centroid[d] += x / n; });
    }

    const reflectedPoint = centroid.map((c, d) => c + ALPHA * (c - worst.point[d]));
    const reflected = evalPoint(reflectedPoint);

    if (reflected.loss < vertices[0].loss) {
      // Better than the current best - try pushing further in the same direction.
      const expandedPoint = centroid.map((c, d) => c + GAMMA * (reflectedPoint[d] - c));
      const expanded = evalPoint(expandedPoint);
      vertices[n] = expanded.loss < reflected.loss ? expanded : reflected;
    } else if (reflected.loss < vertices[n - 1].loss) {
      // Better than the second-worst - accept the plain reflection.
      vertices[n] = reflected;
    } else {
      // Reflection didn't help enough - contract toward whichever of {reflected, worst} is
      // better ("outside" vs "inside" contraction), or shrink the whole simplex toward the
      // best vertex if even that fails.
      const useOutside = reflected.loss < worst.loss;
      const basePoint = useOutside ? reflectedPoint : worst.point;
      const contractedPoint = centroid.map((c, d) => c + RHO * (basePoint[d] - c));
      const contracted = evalPoint(contractedPoint);
      const contractedBetter = useOutside ? contracted.loss <= reflected.loss : contracted.loss < worst.loss;
      if (contractedBetter) {
        vertices[n] = contracted;
      } else {
        const bestPoint = vertices[0].point;
        vertices = vertices.map(v => evalPoint(bestPoint.map((b, d) => b + SIGMA * (v.point[d] - b))));
      }
    }
  }

  vertices.sort((a, b) => a.loss - b.loss);
  if (vertices[0].loss < best.loss) best = vertices[0];

  return { point: best.point, loss: best.loss, result: best, iterations, converged };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS (all tests, including the 3 pre-existing `gradientDescent1D` ones plus the 4 new `nelderMead` ones).

- [ ] **Step 5: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "feat: add generic Nelder-Mead simplex optimizer to SpinSimulator.js"
```

---

### Task 2: Rewrite `tuneFrequencies`'s Phase 2 to use `nelderMead`

**Files:**
- Modify: `core/SpinSimulator.js`

**Interfaces:**
- Consumes: `nelderMead` (Task 1), existing `computeValueRanks`, `renormalizeWeights`, `gradientDescent1D` (Phase 1, untouched).
- Produces: `tuneFrequencies(paytable, reelFrequencyTables, options)` keeps its existing
  signature and top-level return shape `{ reelFrequencyTables, rtp, triggerRatePct, diagnostics }`,
  but `options.rounds` and `options.tiltBounds` are removed, `options.orderingPenaltyWeight`
  and `options.initialStepSize` are added, and `diagnostics.rtpPhase` drops `roundsRun`,
  adds `iterationsRun` and `orderingViolations`. `onProgress`'s `'shape'`-phase call drops
  the `context` argument entirely (5 args instead of 6: `(phase, iteration, mult, result, best)`,
  with `mult` always `null` for phase `'shape'` since there's no longer one scalar per step).

- [ ] **Step 1: Delete `tieredRawWeights` and `minOrderSafeTilt`**

In `core/SpinSimulator.js`, delete both functions entirely (there is no more hard floor to
enforce - ordering becomes a loss term inside the new Phase 2, see Step 3). Delete:
- `tieredRawWeights` (the whole function, including its leading comment block)
- `minOrderSafeTilt` (the whole function, including its leading comment block)

`computeValueRanks` and `renormalizeWeights` stay - both are reused by the new Phase 2.

- [ ] **Step 2: Replace the `options` destructuring**

Find this block in `tuneFrequencies`:

```js
    trialSpins = 800000,
    trialsPerPoint = 3,
    maxIterations = 14,
    rounds = 3,
    valueOrderExcludeTypes = ['wild'],
    tiltBounds = [1, 40],
    searchSeed = 12345,
```

Replace with:

```js
    trialSpins = 800000,
    trialsPerPoint = 3,
    maxIterations = 150,
    orderingPenaltyWeight = 0.5,
    initialStepSize = 0.5,
    valueOrderExcludeTypes = ['wild'],
    searchSeed = 12345,
```

(`maxIterations` default raised from 14 to 150: it now means total Nelder-Mead iterations
for one joint ~24-dimensional search, not gradient steps for one reel's single scalar -
each iteration is cheap, usually one `measure()` call, so this stays fast. `rounds` and
`tiltBounds` are gone.)

- [ ] **Step 3: Replace Phase 2 entirely**

Find the whole block from the `// ---- Phase 2: coordinate descent over reels...` comment
through the `const rtpPhaseRan = rtpPhaseStepCount > 0;` / `const finalReelTables = ...` /
`const finalResult = ...` lines (i.e. everything between the end of Phase 1's `if
(scatterSymbols.length > 0) { ... }` block and the final `return { ... }` statement).
Replace it with:

```js
  // ---- Phase 2: joint multi-dimensional tuning of every reel's value-symbol weights ----
  // One free weight per (value symbol, reel) pair, searched jointly via Nelder-Mead -
  // replacing the old per-reel scalar-tilt coordinate descent, which could not
  // simultaneously fix an ordering violation and hit the RTP target when the two required
  // different corrections (see the design doc for the concrete case that proved this: a
  // single scalar can't move one symbol without dragging every other symbol on that reel
  // along with it). "Higher payout should not be more frequent" is now a soft penalty term
  // in the loss (below), not a hard post-hoc floor - the optimizer can accept a small
  // remaining violation rather than force RTP far off target, and any violation still
  // present at the end is reported in diagnostics rather than silently corrected.
  const dims = []; // [{ reelIndex, symbol }] - one entry per free parameter
  const valueBudgetByReel = [];
  const tierOfByReel = [];
  currentReelTables.forEach((reelTable, r) => {
    const nonScatterSymbols = Object.keys(reelTable).filter(s => !scatterSymbols.includes(s) && reelTable[s].frequency > 0);
    const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);
    const fixedShapeSymbols = nonScatterSymbols.filter(s => valueOrderExcludeTypes.includes(paytable[s].type));
    const valueSymbols = nonScatterSymbols.filter(s => !valueOrderExcludeTypes.includes(paytable[s].type));
    const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);
    const valueBudget = nonScatterTotal - fixedShapeTotal;
    valueBudgetByReel[r] = valueBudget;
    tierOfByReel[r] = computeValueRanks(paytable, valueSymbols);
    if (valueSymbols.length > 0 && valueBudget > 0) {
      valueSymbols.forEach(s => dims.push({ reelIndex: r, symbol: s }));
    }
  });

  let rtpPhaseResult = null;

  if (dims.length > 0) {
    const initialPoint = dims.map(d => Math.log(currentReelTables[d.reelIndex][d.symbol].frequency));
    // Generous per-dimension bounds (relative to that dimension's own starting frequency,
    // not a shared absolute range) - wide enough to not artificially constrain the search,
    // just enough to keep the simplex from drifting to a degenerate near-zero or runaway
    // value on a reel whose other symbols have a very different scale.
    const dimBounds = dims.map(d => {
      const base = currentReelTables[d.reelIndex][d.symbol].frequency;
      return { minX: Math.log(base * 0.001), maxX: Math.log(base * 1000) };
    });

    // Turns a raw parameter vector into a full N-reel array: clamp each dimension to its
    // bounds, exponentiate out of log-space, then renormalize each reel's value-symbol
    // weights back to that reel's fixed budget (same role renormalizeWeights already plays
    // elsewhere) - every other reel/symbol not in `dims` (scatter, wild-excluded, or
    // baseline-zero) is carried through from currentReelTables untouched.
    function projectPoint(x) {
      const reelTables = currentReelTables.map(rt => JSON.parse(JSON.stringify(rt)));
      const rawByReel = {};
      dims.forEach((d, i) => {
        const xi = Math.min(dimBounds[i].maxX, Math.max(dimBounds[i].minX, x[i]));
        (rawByReel[d.reelIndex] ??= {})[d.symbol] = Math.exp(xi);
      });
      Object.keys(rawByReel).forEach(rIdxStr => {
        const rIdx = Number(rIdxStr);
        const renormalized = renormalizeWeights(rawByReel[rIdx], valueBudgetByReel[rIdx]);
        Object.keys(renormalized).forEach(s => { reelTables[rIdx][s].frequency = renormalized[s]; });
      });
      return reelTables;
    }

    // Soft ordering penalty: sums, per reel, how much any higher-paying symbol's frequency
    // exceeds a lower-paying symbol's frequency on that same reel (0 if none present).
    function orderingPenaltyOf(reelTables) {
      let total = 0;
      const violations = [];
      dims.forEach(({ reelIndex: r, symbol: a }) => {
        const tierOf = tierOfByReel[r];
        dims.forEach(({ reelIndex: r2, symbol: b }) => {
          if (r !== r2 || a === b || tierOf[a] >= tierOf[b]) return;
          const diff = reelTables[r][a].frequency - reelTables[r][b].frequency;
          if (diff > 0) {
            total += diff;
            violations.push({ reel: r, higherPaySymbol: a, lowerPaySymbol: b, amount: diff });
          }
        });
      });
      return { total, violations };
    }

    // One fixed seed for the entire Nelder-Mead call (rather than one per iteration like
    // gradientDescent1D's probes): every point evaluated - old simplex vertices or new
    // candidates - needs to stay directly comparable for the whole run, not just within one
    // iteration, since a vertex from iteration 3 may still be in play at iteration 50.
    // measure()'s own trialsPerPoint averaging keeps a single seed's estimate reasonably
    // stable per point.
    const nmSeed = searchSeed + 700000;

    function evaluate(x) {
      const reelTables = projectPoint(x);
      const measured = measure(reelTables, nmSeed);
      const { total: penalty, violations } = orderingPenaltyOf(reelTables);
      const error = Math.abs(measured.rtp - targetRtp);
      return {
        loss: error + orderingPenaltyWeight * penalty,
        rtp: measured.rtp,
        triggerRate: measured.triggerRate,
        error,
        orderingViolations: violations,
        trial: reelTables,
      };
    }

    const nm = await nelderMead({
      initialPoint,
      initialStepSize,
      evaluate,
      maxIterations,
      onProgress: onProgress ? (i, point, result, best) => onProgress('shape', i, null, result, best) : null,
      yieldToEventLoop,
    });

    currentReelTables = nm.result.trial;
    rtpPhaseResult = { ...nm.result, iterations: nm.iterations };
  }

  const finalReelTables = currentReelTables;
  const finalResult = rtpPhaseResult
    ? { rtp: rtpPhaseResult.rtp, triggerRate: rtpPhaseResult.triggerRate }
    : measure(finalReelTables);

  return {
    reelFrequencyTables: finalReelTables,
    rtp: finalResult.rtp,
    triggerRatePct: finalResult.triggerRate,
    diagnostics: {
      scatterPhase: scatterPhase ? { multiplier: scatterPhase.mult, error: scatterPhase.error, converged: !!scatterPhase.converged, ...scatterPhase.result } : null,
      rtpPhase: rtpPhaseResult ? {
        error: rtpPhaseResult.error,
        converged: rtpPhaseResult.error <= rtpTolerancePct,
        rtp: rtpPhaseResult.rtp,
        triggerRate: rtpPhaseResult.triggerRate,
        iterationsRun: rtpPhaseResult.iterations,
        orderingViolations: rtpPhaseResult.orderingViolations,
      } : null,
    }
  };
```

- [ ] **Step 4: Update `tuneFrequencies`'s JSDoc**

Update the big doc comment above `tuneFrequencies` to describe the new two-phase design
(Phase 1 unchanged; Phase 2 is now "joint Nelder-Mead over one weight per value-symbol per
reel, ordering as a soft loss penalty") instead of the old coordinate-descent/tiered-tilt
description, and update the `@param` list: remove `rounds` and `tiltBounds`, add
`orderingPenaltyWeight` and `initialStepSize` with their defaults and a one-line purpose
each (mirror the style of the other `@param` entries already there).

- [ ] **Step 5: Syntax-check**

Run: `node --check core/SpinSimulator.js`
Expected: no output (valid syntax).

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js
git commit -m "refactor: replace tuneFrequencies' per-reel tilt with joint per-symbol Nelder-Mead search"
```

---

### Task 3: Update `tests/tunefrequencies.test.mjs` for the new Phase 2

**Files:**
- Modify: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: `tuneFrequencies` (Task 2's new signature/diagnostics shape), `nelderMead` (Task 1).

- [ ] **Step 1: Replace the hard-ordering-invariant test**

Delete `assertNeverInvertsPayoutOrderPerReel` and the
`'tuneFrequencies never inverts payout order within any single reel'` test entirely (the
guarantee is now soft, not absolute - see design doc). Replace with:

```js
test('tuneFrequencies converges RTP close to target even when baseline data has a large ordering violation', async () => {
  // Old design: FREQUENCY_REEL1's melon (pays 15x) at freq 20 vs grapes (pays 10x) at
  // freq 4 forced a hard floor to t=5.0, overriding an RTP search that had already
  // converged - and that override, compounding across reels, made RTP unreachable (ended
  // near 131% against a 96% target). The new design should actually reach the target.
  const { rtp, diagnostics } = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 80,
  });
  assert.ok(Math.abs(rtp - 96) < 10, `expected RTP within 10 points of target, got ${rtp}`);
  assert.ok(typeof diagnostics.rtpPhase.orderingViolations === 'object', 'orderingViolations must be reported (possibly empty), never omitted');
});
```

- [ ] **Step 2: Update the zero-frequency test's options**

In `'tuneFrequencies never gives a reel-absent symbol (frequency 0) a nonzero frequency'`,
remove `rounds: 2` from the options object passed to `tuneFrequencies` (the option no longer
exists) - leave everything else in that test unchanged.

- [ ] **Step 3: Update the onProgress/diagnostics test for the new callback shape**

Replace `'tuneFrequencies diagnostics expose a per-step error and reel/round context via onProgress'` with:

```js
test('tuneFrequencies diagnostics expose a per-step error via onProgress, without a reel/round context', async () => {
  const stepsSeen = [];
  await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 6,
    onProgress: (phase, i, mult, result, best) => {
      if (phase === 'shape') stepsSeen.push({ error: result.error, mult });
    },
  });
  const distinct = new Set(stepsSeen.map(s => s.error.toFixed(6)));
  assert.ok(distinct.size > 1, `expected per-step error to vary across iterations, got ${stepsSeen.map(s => s.error)}`);
  assert.ok(stepsSeen.every(s => s.mult === null), 'phase "shape" no longer has one scalar per step - mult must always be null');
});
```

- [ ] **Step 4: Update the rtpPhase diagnostics-shape test**

Replace `'tuneFrequencies diagnostics.rtpPhase includes numeric error and boolean converged fields'`'s
body (keep the test name) - remove `rounds: 1` from its options, and add after the existing
two assertions:

```js
  assert.ok(typeof diagnostics.rtpPhase.iterationsRun === 'number');
  assert.ok(Array.isArray(diagnostics.rtpPhase.orderingViolations));
```

- [ ] **Step 5: Update the throws-test's options**

In `'tuneFrequencies throws if reelFrequencyTables.length does not match reelsCount'`,
remove `rounds: 1` from the options object passed to `tuneFrequencies`.

- [ ] **Step 6: Run the full test file**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add tests/tunefrequencies.test.mjs
git commit -m "test: update tunefrequencies tests for the soft-ordering-penalty Nelder-Mead design"
```

---

### Task 4: Update `core/SimulationPanel.js`'s TUNE FREQUENCIES UI

**Files:**
- Modify: `core/SimulationPanel.js`

**Interfaces:**
- Consumes: `tuneFrequencies` (Task 2's new options/diagnostics shape).

- [ ] **Step 1: Remove the "Coordinate Descent Rounds" input**

Delete this `<label>` block from the `tuneContainer.innerHTML` template (inside
`openTuneFrequenciesPanel`):

```html
        <label style="font-size: 0.8em; color: #ccc;">Coordinate Descent Rounds<br>
          <input id="tune-rounds" type="number" value="3" step="1" min="1" max="10" style="width: 100%; margin-top: 4px;">
        </label>
```

Bump the "Max Iterations / Phase" input's `max` attribute (it now covers a single joint
~24-dimensional search that needs more iterations than one reel's single-scalar search
did) and raise its default value:

```html
        <label style="font-size: 0.8em; color: #ccc;">Max Iterations<br>
          <input id="tune-max-iterations" type="number" value="150" step="10" min="10" max="1000" style="width: 100%; margin-top: 4px;">
        </label>
```

Update the explanatory `<p>` right below the input grid to describe the new design:

```html
      <p style="font-size: 0.75em; color: #888; margin: -4px 0 12px;">
        Every value symbol on every reel is tuned jointly (one search, not per-reel) via a
        Nelder-Mead simplex search. A higher-paying symbol being no more frequent than a
        lower-paying one on the same reel is a soft preference, not an absolute rule - the
        search will accept a small violation rather than push RTP far off target. Any
        violation still present at the end is listed below.
      </p>
```

- [ ] **Step 2: Update `startTuning`'s `inputs`/`options` assembly**

In `startTuning`, remove the `rounds` entry from both the `inputs` object and the `options`
object:

```js
  const inputs = {
    targetRtp: tuneContainer.querySelector('#tune-target-rtp'),
    targetTriggerRatePct: tuneContainer.querySelector('#tune-target-trigger'),
    reelLength: tuneContainer.querySelector('#tune-reel-length'),
    trialSpins: tuneContainer.querySelector('#tune-trial-spins'),
    trialsPerPoint: tuneContainer.querySelector('#tune-trials-per-point'),
    maxIterations: tuneContainer.querySelector('#tune-max-iterations'),
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
    maxIterations: parseInt(inputs.maxIterations.value, 10) || 150,
  };
```

- [ ] **Step 3: Update the `onProgress` handler's label logic**

Replace the `onProgress` callback passed to `tuneFrequencies` inside `startTuning`:

```js
      onProgress: (phase, i, mult, r, best) => {
        const label = phase === 'scatter' ? `Scatter frequency ${i + 1}` : `Step ${i + 1}`;
        const multLabel = mult == null ? '' : `  mult=${mult.toFixed(3)}`;
        appendLog(`[${label}]${multLabel}  RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  err=${r.error.toFixed(4)}  (best err=${best.error.toFixed(4)})`);
      }
```

- [ ] **Step 4: Surface remaining ordering violations in the results**

Right after the existing `if (!rtpConverged) { html += ...}` block (still inside
`startTuning`, before the per-reel tables grid), add:

```js
    const violations = diagnostics.rtpPhase?.orderingViolations ?? [];
    if (violations.length > 0) {
      const rows = violations.map(v => {
        const higher = paytable[v.higherPaySymbol]?.friendlyName || v.higherPaySymbol;
        const lower = paytable[v.lowerPaySymbol]?.friendlyName || v.lowerPaySymbol;
        return `Reel ${v.reel + 1}: ${higher} is ${v.amount.toFixed(3)} more frequent than ${lower}`;
      });
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 <strong>⚠ ${violations.length} ordering violation${violations.length > 1 ? 's' : ''} remain</strong> (accepted to keep RTP close to target):<br>
                 ${rows.join('<br>')}
               </p>`;
    }
```

- [ ] **Step 5: Syntax-check**

Run: `node --check core/SimulationPanel.js`
Expected: no output (valid syntax).

- [ ] **Step 6: Commit**

```bash
git add core/SimulationPanel.js
git commit -m "feat: rework TUNE FREQUENCIES UI for the joint Nelder-Mead search"
```

---

### Task 5: End-to-end verification against real fruitmachine data

**Files:**
- None modified - this is a verification-only task using a throwaway script.

**Interfaces:**
- Consumes: `tuneFrequencies` (Task 2), `PAYTABLE`/`FREQUENCY_REEL1/2/3`/etc. from `games/fruitmachine/game.js`.

- [ ] **Step 1: Write a throwaway verification script**

Create `verify-tune.mjs` at the repo root (not committed - delete it in Step 3):

```js
import { PAYTABLE, FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3, REELS_COUNT, ROWS_COUNT, REEL_LENGTH, REEL_SEEDS, BET_PER_LINE, LINES_COUNT, PAYLINES } from './games/fruitmachine/game.js';
import { checkWildLineWins } from './core/SlotMath.js';
import { tuneFrequencies } from './core/SpinSimulator.js';

const result = await tuneFrequencies(PAYTABLE, [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3], {
  reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, reelLength: REEL_LENGTH, reelSeeds: REEL_SEEDS,
  betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
  trialSpins: 300000, trialsPerPoint: 2, maxIterations: 150,
});

console.log('Final RTP:', result.rtp.toFixed(2) + '%', '(target 96%)');
console.log('Converged:', result.diagnostics.rtpPhase.converged);
console.log('Iterations run:', result.diagnostics.rtpPhase.iterationsRun);
console.log('Remaining ordering violations:', result.diagnostics.rtpPhase.orderingViolations.length);
result.diagnostics.rtpPhase.orderingViolations.forEach(v =>
  console.log(`  reel ${v.reel + 1}: ${v.higherPaySymbol} > ${v.lowerPaySymbol} by ${v.amount.toFixed(3)}`));
```

- [ ] **Step 2: Run it and evaluate the result**

Run: `node verify-tune.mjs`

This is a real end-to-end check against the actual data that motivated this whole redesign
(previously stuck around 131% RTP against a 96% target). Evaluate the printed RTP:
- If it lands within roughly `targetRtp ± rtpTolerancePct` (default target 96, tolerance
  1.5), the redesign resolved the original problem - proceed to Step 3.
- If it's still far off (more than ~10 points away), that means `orderingPenaltyWeight`
  (default 0.5 from Task 2 Step 2) needs recalibrating for real data - try re-running with
  `orderingPenaltyWeight: 0.1` added to the options object in the script, and if that
  resolves it, update the default in `core/SpinSimulator.js` (Task 2 Step 2) to match, and
  re-run the full test suite (`node --test tests/*.mjs`) before proceeding.

- [ ] **Step 3: Delete the throwaway script**

```bash
rm verify-tune.mjs
```

(Nothing to commit - this file was never staged.)

- [ ] **Step 4: Run the full test suite**

Run: `node --test tests/*.mjs`
Expected: all tests pass except the pre-existing, unrelated `fruit machine RTP stays near
the 96% design target` failure IF it's still present for the same known reason noted
earlier in this project (nobody has yet adopted a tuned output into `game.js`'s committed
`FREQUENCY_REEL1/2/3`) - or, if Task 5's own verification above looked good enough that you
go on to actually replace `FREQUENCY_REEL1/2/3` in `game.js` with the tuned output, that
test may now pass too. Either outcome is fine; just don't let any *other* test fail.
