# Tuner Legibility and Structural Levers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Design doc:** `docs/superpowers/specs/2026-07-27-tuner-legibility-and-structural-levers-design.md`

**Goal:** Make the tuner tell a developer which knob to turn, what each knob means in real units, and what the resulting game feels like to play — instead of silently optimizing the weakest lever it has.

**Architecture:** Four packages, each independently shippable. Package 0 collapses Phase 2's per-reel dimensions for cluster games. Package 1 adds validation, a structural sensitivity sweep, the exact payout-scale lever, and a structural grid search. Package 2 re-denominates every penalty weight into RTP percentage points. Package 3 adds round-level win-shape metrics and a plain-language player-experience report.

**Tech Stack:** Plain ES modules, no build step. `node --test` (`npm test`). Browser UI in `core/SimulationPanel.js`. Playwright MCP for live verification against `http://localhost:5757`.

## Scope

**Packages 0, 1, 2, 3 are in scope for this plan.**

**Package 4 (search correctness) is DEFERRED and deliberately not planned here.** It is specified in the design doc §"Package 4" for when it comes up, but no tasks below implement it, and it must not be pulled forward into this work. Its three items — Phase 3 trigger-rate re-solve, cross-reel cluster-structure metric, dead-code removal of `withStructuralDefaults` — stay as written in the design until separately scheduled. One exception, called out in Task 1.10: if `structuralSearch` ends up wanting `withStructuralDefaults`, wire it up there; otherwise leave it alone.

## Global Constraints

Every task's requirements implicitly include this section.

- **No new runtime dependencies.** Plain ES modules, no build step.
- **Every new option defaults to today's behavior.** A game that does not opt in must produce byte-identical results. Regression-test this per option.
- **`tuneFrequencies` stays deterministic.** Every new random draw seeds off `searchSeed`.
- **Every new `onProgress` phase MUST get a `SimulationPanel.js` handler and an entry in the phase-contract test** in `tests/tunefrequencies.test.mjs`. An unhandled phase with `best === null` crashed the panel in `e023fb2`; the guard `if (!best) return;` and the contract test both exist — keep them passing.
- **No hash/golden tests on generated strips.** Frequencies and structural settings change constantly. Assert behavior, not output.
- **Statistical assertions use tolerances derived from the measured noise floor** (≈±1.3pp RTP at 2σ for Candy Frenzy at 40k spins), never exact values.
- **Baseline test state:** 180 tests, 176 pass, 4 pre-existing failures (barfruits `501 !== 500`; 2× `limitPenaltyWeight` cap; converged-with-violations). These are unrelated to this work and must stay at exactly 4 — a 5th means you broke something.
- **Docs footer convention:** any README/ARCHITECTURE.md edit updates the "Docs last synced" date + commit footer.

---

# Package 0 — Reel coupling

**Core issue:** On a cluster-pays game reel index carries no meaning, yet Phase 2 gives every reel its own free weight per symbol (84 dims on Candy Frenzy). The resulting per-reel asymmetry — `chewy` at 0.4105 on reel 2 against 0.0056 on reel 3 — is search noise, not design, and it is the over-abundance complaint.

## File Structure

- `core/SpinSimulator.js` — `dims` construction, `projectPoint`, a new Phase 2a/2b round loop, `diagnostics.rtpPhase.coupling`
- `core/SimulationPanel.js` — "Reel coupling" dropdown, `readTuneOptions`, reproducibility header
- `games/candyfrenzy/game.js` — opt in to `'linked-then-refine'`
- `tests/tunefrequencies.test.mjs`, `tests/simulationpanel.test.mjs`

### Task 0.1: Linked-mode dimensions and projection

**Files:**
- Modify: `core/SpinSimulator.js:1603-1627` (`dims` construction), `core/SpinSimulator.js:1720-1733` (`projectPoint`)
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: option `reelCoupling: 'independent' | 'linked' | 'linked-then-refine'` (default `'independent'`); option `maxReelDeviation: number` (default `0.25`); `dims` entries may now carry `reelIndex: null` meaning "every reel".

- [ ] **Step 1: Write the failing test**

```js
test('reelCoupling "linked" gives every reel identical tuned frequencies', async () => {
  // On a cluster game reel index means nothing - a cluster forms from grid-adjacent cells, not
  // from a payline position. Independent per-reel dims let the search invent a 70x spread
  // between reels for the same symbol, which is the "over-abundance" complaint: it is search
  // noise given 84 degrees of freedom against one scalar objective, not a design decision.
  const paytable = {
    hi:  { payout: [0, 0, 10, 40, 200], type: 'regular' },
    lo:  { payout: [0, 0,  5, 20, 100], type: 'regular' },
    scat:{ payout: [0, 0,  2,  5,  20], type: 'scatter', triggerFreeSpins: true },
  };
  const table = () => ({ defaults: {}, symbols: { hi: { frequency: 3 }, lo: { frequency: 6 }, scat: { frequency: 1 } } });
  const tables = [table(), table(), table()];

  const result = await tuneFrequencies(paytable, tables, {
    reelCoupling: 'linked',
    reelsCount: 3, rowsCount: 3, reelLength: 100, reelSeeds: [11, 22, 33],
    paylines: [[0, 0, 0]], linesCount: 1,
    trialSpins: 2000, trialsPerPoint: 1, maxIterations: 6, searchSeed: 7,
  });

  const out = result.reelFrequencyTables;
  for (const symbol of ['hi', 'lo']) {
    const values = out.map(rt => rt.symbols[symbol].frequency);
    values.forEach(v => assert.ok(Math.abs(v - values[0]) < 1e-9,
      `${symbol} must be identical across reels under 'linked', got ${values.join(', ')}`));
  }
  assert.equal(result.diagnostics.rtpPhase.coupling.mode, 'linked');
  assert.equal(result.diagnostics.rtpPhase.coupling.dimsLinked, 2, 'one dim per tunable symbol, not per (symbol, reel)');
});

test('reelCoupling defaults to independent and leaves existing results untouched', async () => {
  // The regression guard every new option in this plan needs: absent, behavior is byte-identical.
  const paytable = {
    hi:  { payout: [0, 0, 10, 40, 200], type: 'regular' },
    lo:  { payout: [0, 0,  5, 20, 100], type: 'regular' },
    scat:{ payout: [0, 0,  2,  5,  20], type: 'scatter', triggerFreeSpins: true },
  };
  const table = () => ({ defaults: {}, symbols: { hi: { frequency: 3 }, lo: { frequency: 6 }, scat: { frequency: 1 } } });
  const opts = {
    reelsCount: 3, rowsCount: 3, reelLength: 100, reelSeeds: [11, 22, 33],
    paylines: [[0, 0, 0]], linesCount: 1,
    trialSpins: 2000, trialsPerPoint: 1, maxIterations: 6, searchSeed: 7,
  };
  const a = await tuneFrequencies(paytable, [table(), table(), table()], opts);
  const b = await tuneFrequencies(paytable, [table(), table(), table()], { ...opts, reelCoupling: 'independent' });
  assert.deepEqual(b.reelFrequencyTables, a.reelFrequencyTables);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: FAIL — `coupling` is undefined, and the linked test's frequencies differ per reel.

- [ ] **Step 3: Validate the symbol sets before linking**

In `tuneFrequencies`, right after `baseReelTables` is built (`core/SpinSimulator.js:1153`):

```js
  // Linking writes ONE weight per symbol to every reel, so the reels must agree on what symbols
  // exist. Silently linking mismatched tables would write a frequency onto a reel that never
  // had that symbol (or skip one that did), producing a strip nobody configured - so this is a
  // hard error naming the offender rather than a best-effort merge.
  if (reelCoupling !== 'independent') {
    const canonical = Object.keys(baseReelTables[0].symbols).sort();
    baseReelTables.forEach((rt, r) => {
      const here = Object.keys(rt.symbols).sort();
      if (here.join(' ') !== canonical.join(' ')) {
        const missing = canonical.filter(s => !here.includes(s));
        const extra = here.filter(s => !canonical.includes(s));
        throw new Error(
          `reelCoupling '${reelCoupling}' requires every reel to carry the same symbols; reel ${r} ` +
          `${missing.length ? `is missing [${missing}] ` : ''}${extra.length ? `has extra [${extra}]` : ''}`.trim());
      }
    });
  }
```

- [ ] **Step 4: Build linked dims**

Replace the `dims.push(...)` inside the `currentReelTables.forEach` loop so that in linked mode each symbol contributes at most one dimension. Add after that loop:

```js
  // In linked mode, collapse the per-(symbol, reel) dims down to one per symbol. Bounds are the
  // TIGHTEST across reels - a bound configured on any one reel still means something once the
  // weight is shared, and taking the loosest would let the shared value violate a reel that had
  // asked for a narrower range.
  const linkedPhase = reelCoupling !== 'independent';
  let activeDims = dims;
  if (linkedPhase && dims.length > 0) {
    const bySymbol = new Map();
    dims.forEach(d => {
      const prev = bySymbol.get(d.symbol);
      if (!prev) { bySymbol.set(d.symbol, { reelIndex: null, symbol: d.symbol, min: d.min, max: d.max }); return; }
      if (d.min != null) prev.min = prev.min == null ? d.min : Math.max(prev.min, d.min);
      if (d.max != null) prev.max = prev.max == null ? d.max : Math.min(prev.max, d.max);
    });
    activeDims = [...bySymbol.values()];
  }
```

Every downstream reference to `dims` inside the `if (dims.length > 0)` block becomes `activeDims`, except the penalty functions — see Step 6.

- [ ] **Step 5: Project a linked point onto every reel**

`projectPoint` branches on `reelIndex === null`:

```js
    function projectPoint(x) {
      const reelTables = currentReelTables.map(rt => JSON.parse(JSON.stringify(rt)));
      const rawByReel = {};
      activeDims.forEach((d, i) => {
        const xi = Math.min(dimBounds[i].maxX, Math.max(dimBounds[i].minX, x[i]));
        const value = Math.exp(xi);
        // reelIndex null = a linked dimension: the same raw weight goes to every reel. Each reel
        // is still renormalized against its OWN valueBudget below, which is what preserves that
        // reel's scatter:candy ratio - so Phase 1's trigger-rate result survives linking intact.
        const targets = d.reelIndex == null ? reelTables.map((_, r) => r) : [d.reelIndex];
        targets.forEach(r => { (rawByReel[r] ??= {})[d.symbol] = value; });
      });
      Object.keys(rawByReel).forEach(rIdxStr => {
        const rIdx = Number(rIdxStr);
        const renormalized = renormalizeWeights(rawByReel[rIdx], valueBudgetByReel[rIdx]);
        Object.keys(renormalized).forEach(s => { reelTables[rIdx].symbols[s].frequency = renormalized[s]; });
      });
      return reelTables;
    }
```

`dimBounds` must be built from `activeDims`; for a linked dim use reel 0's baseline frequency as `base`.

- [ ] **Step 6: Keep the penalties per-reel**

`orderingPenaltyOf`, `limitPenaltyOf`, `uniformityPenaltyOf` iterate `dims` to find (reel, symbol) pairs. They must keep iterating the **original per-reel `dims`**, not `activeDims` — the penalties measure the projected reel tables, which always have real per-reel frequencies regardless of coupling. Leave those three functions referencing `dims` and add a comment saying why. `spacingPenaltyOf` already walks `reelTables` directly and needs no change.

- [ ] **Step 7: Run the tests**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: both new tests PASS; no previously-passing test regresses.

- [ ] **Step 8: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "feat: reelCoupling 'linked' shares one weight per symbol across every reel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 0.2: `linked-then-refine` two-stage search

**Files:**
- Modify: `core/SpinSimulator.js` — the Phase 2 round loop
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: `activeDims`, `projectPoint`, `maxReelDeviation` from Task 0.1.
- Produces: `diagnostics.rtpPhase.coupling = { mode, linkedRtp, refinedRtp, dimsLinked, dimsRefined }`.

- [ ] **Step 1: Write the failing test**

```js
test('reelCoupling "linked-then-refine" bounds per-reel deviation from the linked result', async () => {
  // Phase 2b exists so a reel CAN differ - "reel 4 runs a little heavier on cake" is a real design
  // choice. What it must not do is re-invent the 70x spread linking just removed, so every refined
  // frequency stays within maxReelDeviation of the linked value it started from.
  const paytable = {
    hi:  { payout: [0, 0, 10, 40, 200], type: 'regular' },
    lo:  { payout: [0, 0,  5, 20, 100], type: 'regular' },
    scat:{ payout: [0, 0,  2,  5,  20], type: 'scatter', triggerFreeSpins: true },
  };
  const table = () => ({ defaults: {}, symbols: { hi: { frequency: 3 }, lo: { frequency: 6 }, scat: { frequency: 1 } } });
  const result = await tuneFrequencies(paytable, [table(), table(), table()], {
    reelCoupling: 'linked-then-refine', maxReelDeviation: 0.25,
    reelsCount: 3, rowsCount: 3, reelLength: 100, reelSeeds: [11, 22, 33],
    paylines: [[0, 0, 0]], linesCount: 1,
    trialSpins: 2000, trialsPerPoint: 1, maxIterations: 12, searchSeed: 7,
  });

  const c = result.diagnostics.rtpPhase.coupling;
  assert.equal(c.mode, 'linked-then-refine');
  assert.equal(c.dimsLinked, 2);
  assert.equal(c.dimsRefined, 6, 'refine stage reopens one dim per (symbol, reel)');
  assert.ok(Number.isFinite(c.linkedRtp) && Number.isFinite(c.refinedRtp));

  for (const symbol of ['hi', 'lo']) {
    const values = result.reelFrequencyTables.map(rt => rt.symbols[symbol].frequency);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    values.forEach(v => assert.ok(Math.abs(v - mean) / mean <= 0.6,
      `${symbol} spread ${values.join(', ')} exceeds what maxReelDeviation 0.25 allows around the linked value`));
  }
});
```

The 0.6 tolerance is deliberately loose: `maxReelDeviation` bounds each dim's *pre-renormalization* raw weight, and per-reel renormalization can shift the realized frequency somewhat. The test asserts the bound is doing real work, not an exact arithmetic identity.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: FAIL — `dimsRefined` undefined.

- [ ] **Step 3: Extract the round loop into a callable stage**

Wrap the existing `do { ... } while (iterationsUsed < maxIterations)` block in a function `runSearchStage({ dims: stageDims, startPoint, iterationBudget, boundsOverride })` returning `{ best, iterationsUsed, reason, restarts, stillImproving, bestOrderingPenalty, bestLimitPenalty, bestUniformityPenalty }`. This is a pure refactor — run the full suite after it and before Step 4 to confirm nothing moved.

- [ ] **Step 4: Run the two stages**

```js
    // Phase 2a: linked. One weight per symbol, so per-reel asymmetry is not merely discouraged
    // but unrepresentable - the search cannot spend its budget discovering a spread nobody wants.
    // Phase 2b: reopen per-reel dims, starting from 2a's answer, clamped to +/-maxReelDeviation
    // around it. Splitting the budget rather than running 2b on the full budget is deliberate:
    // 2a is where the real RTP movement happens (12 dims, cheap), 2b is a refinement.
    let coupling = null;
    if (reelCoupling === 'linked-then-refine') {
      const linkedBudget = Math.max(1, Math.round(maxIterations * 0.7));
      const stageA = runSearchStage({ dims: activeDims, startPoint: initialPoint, iterationBudget: linkedBudget });
      const refineStart = dims.map(d => Math.log(stageA.best.trial[d.reelIndex].symbols[d.symbol].frequency));
      const refineBounds = refineStart.map(x => ({
        minX: x + Math.log(1 - maxReelDeviation),
        maxX: x + Math.log(1 + maxReelDeviation),
      }));
      const stageB = runSearchStage({
        dims, startPoint: refineStart, iterationBudget: maxIterations - stageA.iterationsUsed,
        boundsOverride: refineBounds,
      });
      coupling = {
        mode: reelCoupling, linkedRtp: stageA.best.rtp, refinedRtp: stageB.best.rtp,
        dimsLinked: activeDims.length, dimsRefined: dims.length,
      };
      // 2b only wins if it actually beat 2a on the same statistically-gated test `best` uses -
      // otherwise a noisier refinement could quietly undo a better linked answer.
      finalStage = beatsIncumbent(stageB.best, stageA.best, bestAcceptanceZ) ? stageB : stageA;
    }
```

For `'linked'` and `'independent'`, call `runSearchStage` once and set `coupling` with `refinedRtp: null` / `dimsRefined: 0` as appropriate.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS, 4 pre-existing failures unchanged.

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "feat: linked-then-refine runs a linked Phase 2a then a bounded per-reel Phase 2b

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 0.3: Panel control, Candy Frenzy opt-in, reproducibility header

**Files:**
- Modify: `core/SimulationPanel.js` — options block near `#tune-search-algorithm` (~L500), `inputs` map (~L730), `readTuneOptions` (~L797), `formatReelFrequencyTablesForCopy`
- Modify: `games/candyfrenzy/game.js:325-371` (`tuneConfig`)
- Modify: `core/SpinSimulator.js` — add `reelCoupling`, `maxReelDeviation` to `inputParameters`
- Test: `tests/simulationpanel.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('formatReelFrequencyTablesForCopy records reelCoupling in the reproducibility header', () => {
  // Coupling changes what the result MEANS - identical-looking frequencies from a linked run and
  // an independent run came from different searches. Same class as the dropped stackChance in
  // 2548ac2: a setting the output omits is a setting the next run silently gets wrong.
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/simulationpanel.test.mjs`
Expected: FAIL — header lacks both fields.

- [ ] **Step 3: Add the dropdown**

Insert beside the Search Algorithm select, with a `title` explaining the tradeoff in one paragraph (match the existing tooltips' depth and tone):

```html
<label title="Whether every reel gets its own frequency for each symbol, or they share one. On a CLUSTER-pays game reel index carries no meaning - a cluster forms from grid-adjacent cells, not from a payline position - so giving each reel its own free weight lets the search invent large per-reel spreads that no part of the design asked for and no part of the loss can justify. That spread IS the 'over-abundance' problem. 'Linked' searches one weight per symbol shared across every reel, which makes the spread unrepresentable rather than merely penalized, and cuts Candy Frenzy from 84 dimensions to 12. 'Linked, then refine' runs the linked search first, then reopens per-reel weights bounded to a small deviation around the linked answer, so a deliberate per-reel tilt is still expressible. Line-pay games should stay Independent - reel position genuinely does mean something there." style="font-size: 0.8em; color: #ccc;">Reel Coupling<br>
  <select id="tune-reel-coupling" style="width: 100%; margin-top: 4px;">
    <option value="independent">Independent per reel (default)</option>
    <option value="linked">Linked - one weight per symbol</option>
    <option value="linked-then-refine">Linked, then refine per reel</option>
  </select>
</label>
```

Pre-select from `tuneConfig.reelCoupling`. Wire `reelCoupling` into the `inputs` map and `readTuneOptions`.

- [ ] **Step 4: Emit both in the header, and add them to `inputParameters`**

In `formatReelFrequencyTablesForCopy`'s header, alongside the existing algorithm line. In `core/SpinSimulator.js`'s `inputParameters` object (~L2222), add `reelCoupling, maxReelDeviation`.

- [ ] **Step 5: Opt Candy Frenzy in**

In `games/candyfrenzy/game.js`'s `tuneConfig`, add with a comment recording the measured reason:

```js
          // Candy Frenzy is cluster-pays on a 7x7 grid: a cluster forms from grid-adjacent cells,
          // so reel index carries no meaning and per-reel frequency spread is search noise rather
          // than design. Measured at 849bc8a, independent per-reel tuning produced chewy at 0.4105
          // on reel 2 against 0.0056 on reel 3, and the resulting tables paid 74.70% RTP - 27pp
          // WORSE than setting every candy to the same frequency (101.48%).
          reelCoupling: 'linked-then-refine',
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: new test passes; failures still exactly 4.

- [ ] **Step 7: Verify live**

Start the dev server, open Candy Frenzy at `http://localhost:5757`, click TUNE FREQUENCIES. Confirm the Reel Coupling dropdown pre-selects "Linked, then refine per reel", run a short tune (10 iterations, 20k spins), and confirm the copied output's header carries `reelCoupling linked-then-refine` and that the seven `FREQUENCY_REEL*` blocks are near-identical. Check the console for errors beyond the known favicon 404.

- [ ] **Step 8: Commit**

```bash
git add core/SimulationPanel.js core/SpinSimulator.js games/candyfrenzy/game.js tests/simulationpanel.test.mjs
git commit -m "feat: expose reel coupling in the tuning panel; Candy Frenzy links its reels

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Package 1 — "What do these constants do?"

**Core issue:** `REEL_LENGTH`, `stackChance`, `maxStack`, `minStack`, `minGap`, `MIN_CLUSTER_SIZE` and the payout ladders are hand-written constants with no validation and no stated consequence.

## File Structure

- `core/TuningValidation.js` — **new.** Pure, no simulation. Owns every static config check.
- `core/StructuralSensitivity.js` — **new.** Owns the sweep ladders, elasticity maths, and `routesToTarget`. Takes an injected `measure` so it never imports the simulator.
- `core/SpinSimulator.js` — calls both as Phase 0a/0c; adds `winEvaluatorFactory`; adds `structuralSearch` as Phase 0d
- `core/SimulationPanel.js` — renders validation, sensitivity, payout scale
- `tests/tuningvalidation.test.mjs`, `tests/structuralsensitivity.test.mjs` — **new**

Two new modules rather than more of `SpinSimulator.js` (already 2,360 lines): both are pure and independently testable, which is what makes their tests cheap.

### Task 1.1: `core/TuningValidation.js` — payout ladder checks

**Files:**
- Create: `core/TuningValidation.js`
- Test: `tests/tuningvalidation.test.mjs`

**Interfaces:**
- Produces: `validateTuningConfig(config) -> Finding[]` where `Finding = { severity: 'error'|'warning'|'note', code: string, message: string, suggestion: string, subject: object }`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTuningConfig } from '../core/TuningValidation.js';

test('a cluster payout ladder that pays less for a bigger cluster is an error', () => {
  // This is Candy Frenzy's REAL premium ladder as it stood before 849bc8a: a 5-cluster paid 2.00x
  // and a 7-cluster paid 0.50x. Nothing in the tuner noticed. Worse than cosmetic - the search
  // would have optimized TOWARD landing exactly-5 clusters, and every symbol frequency derived
  // from that run was shaped by an inverted incentive.
  const findings = validateTuningConfig({
    paytable: {
      prem: { type: 'premium', clusterPayout: [
        { min: 5, multiplier: 2.00 }, { min: 7, multiplier: 0.50 },
        { min: 10, multiplier: 1.00 }, { min: 15, multiplier: 2.50 }, { min: 25, multiplier: 7.50 },
      ] },
    },
    reelFrequencyTables: [{ defaults: {}, symbols: { prem: { frequency: 1 } } }],
    reelLength: 500, reelsCount: 7, rowsCount: 7, minClusterSize: 5,
  });
  const errors = findings.filter(f => f.code === 'payout-ladder-non-monotone');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].severity, 'error');
  assert.equal(errors[0].subject.symbol, 'prem');
  assert.equal(errors[0].subject.min, 7);
  assert.match(errors[0].message, /0\.5/);
});

test('a healthy ladder produces no ladder findings', () => {
  const findings = validateTuningConfig({
    paytable: { prem: { type: 'premium', clusterPayout: [
      { min: 5, multiplier: 0.75 }, { min: 7, multiplier: 1.75 }, { min: 10, multiplier: 3.00 },
    ] } },
    reelFrequencyTables: [{ defaults: {}, symbols: { prem: { frequency: 1 } } }],
    reelLength: 500, reelsCount: 7, rowsCount: 7, minClusterSize: 5,
  });
  assert.equal(findings.filter(f => f.code.startsWith('payout-ladder')).length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/tuningvalidation.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module skeleton and the three ladder checks**

```js
/**
 * Static, simulation-free checks on a game's tuning configuration.
 *
 * Everything here is arithmetic on the config itself - no reels are built and no spins are run -
 * so it is cheap enough to run unconditionally before every tune, and pure enough to unit-test
 * directly. It exists because the parameters that most determine a game's RTP are hand-written
 * constants that nothing validated: Candy Frenzy shipped a premium payout ladder where a 7-symbol
 * cluster paid 0.50x against a 5-symbol cluster's 2.00x (fixed in 849bc8a), and the tuner ran
 * against it for days, silently optimizing toward an inverted incentive.
 *
 * `severity: 'error'` means the tune must not start - the config is arithmetically broken and no
 * amount of searching can compensate. 'warning' and 'note' are reported and the tune proceeds.
 */
export function validateTuningConfig({
  paytable, reelFrequencyTables, reelLength, reelsCount, rowsCount,
  minClusterSize = null, scatterTriggerCount = null,
}) {
  const findings = [];
  const add = (severity, code, message, suggestion, subject) =>
    findings.push({ severity, code, message, suggestion, subject });

  Object.entries(paytable).forEach(([symbol, entry]) => {
    const ladder = entry.clusterPayout;
    if (!Array.isArray(ladder) || ladder.length === 0) return;

    for (let i = 1; i < ladder.length; i++) {
      if (ladder[i].min <= ladder[i - 1].min) {
        add('error', 'payout-ladder-unsorted',
          `${symbol}'s payout ladder is not sorted by cluster size: tier ${i} has min ${ladder[i].min} after ${ladder[i - 1].min}.`,
          'Sort clusterPayout ascending by `min`. Payout ranking reads the LAST tier, so an unsorted ladder mis-ranks the symbol against every other one.',
          { symbol, index: i, min: ladder[i].min });
      }
      if (ladder[i].multiplier < ladder[i - 1].multiplier) {
        add('error', 'payout-ladder-non-monotone',
          `${symbol} pays LESS for a bigger cluster: ${ladder[i].min}+ pays ${ladder[i].multiplier}x but ${ladder[i - 1].min}+ pays ${ladder[i - 1].multiplier}x.`,
          `Raise the ${ladder[i].min}+ multiplier above ${ladder[i - 1].multiplier}x. Until then the tuner is rewarded for making big clusters RARER, which inverts every frequency it derives.`,
          { symbol, min: ladder[i].min, multiplier: ladder[i].multiplier, previousMultiplier: ladder[i - 1].multiplier });
      }
    }
    if (minClusterSize != null && ladder[0].min < minClusterSize) {
      add('warning', 'payout-ladder-floor',
        `${symbol}'s lowest payout tier (${ladder[0].min}) is below minClusterSize (${minClusterSize}), so it can never pay.`,
        `Raise that tier's min to ${minClusterSize} or drop it.`,
        { symbol, min: ladder[0].min, minClusterSize });
    }
  });

  return findings;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/tuningvalidation.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/TuningValidation.js tests/tuningvalidation.test.mjs
git commit -m "feat: TuningValidation catches non-monotone and unsorted cluster payout ladders

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 1.2: Structural and geometry checks

**Files:**
- Modify: `core/TuningValidation.js`
- Test: `tests/tuningvalidation.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test('stackChance at or above 1 is flagged as a mode switch, not "more stacking"', () => {
  // Measured on Candy Frenzy at uniform frequencies: stackChance 0.7 pays 181% RTP and 1.0 pays
  // 40%. It is not a continuum. resolveStackChance() >= 1 makes generateReel take a different
  // code path entirely (_computeClusterSizes, an even split) instead of _computeStackedPlacements.
  // A designer writing 1 to mean "always stack" gets LESS stacking value than 0.3.
  const findings = validateTuningConfig({
    paytable: { a: { type: 'regular', clusterPayout: [{ min: 5, multiplier: 1 }] } },
    reelFrequencyTables: [{ defaults: { stackChance: 1, minStack: 2, maxStack: 4 }, symbols: { a: { frequency: 1 } } }],
    reelLength: 500, reelsCount: 7, rowsCount: 7, minClusterSize: 5,
  });
  const f = findings.find(x => x.code === 'stack-chance-mode-switch');
  assert.ok(f, 'expected a stack-chance-mode-switch finding');
  assert.equal(f.severity, 'warning');
  assert.match(f.message, /different code path|mode/i);
});

test('minStack above maxStack is an error', () => {
  const findings = validateTuningConfig({
    paytable: { a: { type: 'regular', clusterPayout: [{ min: 5, multiplier: 1 }] } },
    reelFrequencyTables: [{ defaults: { minStack: 5, maxStack: 3 }, symbols: { a: { frequency: 1 } } }],
    reelLength: 500, reelsCount: 7, rowsCount: 7, minClusterSize: 5,
  });
  assert.equal(findings.filter(f => f.code === 'stack-bounds' && f.severity === 'error').length, 1);
});

test('a reel too short for its symbols at the configured minGap is an error', () => {
  // 12 symbols each needing minGap 8 cannot coexist on a 50-position strip. generateReel does not
  // fail here - _enforceMinGap hits its candidates.length === 0 bailout and returns the strip
  // as-is, so the game ships reels that clump far more than the config asks, silently.
  const symbols = Object.fromEntries('abcdefghijkl'.split('').map(s => [s, { frequency: 1 }]));
  const findings = validateTuningConfig({
    paytable: Object.fromEntries(Object.keys(symbols).map(s => [s, { type: 'regular', clusterPayout: [{ min: 5, multiplier: 1 }] }])),
    reelFrequencyTables: [{ defaults: { minGap: 8 }, symbols }],
    reelLength: 50, reelsCount: 7, rowsCount: 7, minClusterSize: 5,
  });
  assert.equal(findings.filter(f => f.code === 'reel-length-floor' && f.severity === 'error').length, 1);
});

test('a healthy Candy-Frenzy-shaped config produces no errors', () => {
  const symbols = Object.fromEntries('abcdefghijkl'.split('').map(s => [s, { frequency: 1 }]));
  const findings = validateTuningConfig({
    paytable: Object.fromEntries(Object.keys(symbols).map(s => [s, { type: 'regular', clusterPayout: [{ min: 5, multiplier: 0.75 }, { min: 7, multiplier: 1.25 }] }])),
    reelFrequencyTables: [{ defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3, minFrequency: 0.005, maxFrequency: 0.5 }, symbols }],
    reelLength: 500, reelsCount: 7, rowsCount: 7, minClusterSize: 5, scatterTriggerCount: 3,
  });
  assert.deepEqual(findings.filter(f => f.severity === 'error'), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/tuningvalidation.test.mjs`
Expected: 3 FAIL, the "healthy" one passes vacuously.

- [ ] **Step 3: Implement the remaining checks**

Add to `validateTuningConfig`, resolving each constraint the same way `generateReel` does (symbol override → reel `defaults` → built-in fallback), one pass per reel: `stack-bounds`, `stack-chance-mode-switch`, `reel-length-floor`, `cluster-size-reachable`, `scatter-trigger-reachable`, `frequency-bounds-contradiction`, and `tier-inversion`.

`mingap-infeasible` stays where it is — `checkReelFeasibility` in `SpinSimulator.js` needs real generated strips, which this module deliberately does not build. Cross-reference it in the `reel-length-floor` suggestion text.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/tuningvalidation.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/TuningValidation.js tests/tuningvalidation.test.mjs
git commit -m "feat: validate stack bounds, stackChance mode switch, and reel geometry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 1.3: Wire validation into the tuner and panel as Phase 0a

**Files:**
- Modify: `core/SpinSimulator.js` — call before Phase 0, emit `'validation'`, add `diagnostics.validation`
- Modify: `core/SimulationPanel.js` — handler + rendered block
- Test: `tests/tunefrequencies.test.mjs` (phase-contract test)

- [ ] **Step 1: Write the failing test**

```js
test('tuneFrequencies refuses to run on a config with validation errors', async () => {
  const paytable = { prem: { type: 'premium', clusterPayout: [{ min: 5, multiplier: 2 }, { min: 7, multiplier: 0.5 }] } };
  await assert.rejects(
    () => tuneFrequencies(paytable, [{ defaults: {}, symbols: { prem: { frequency: 1 } } }], {
      reelsCount: 1, rowsCount: 3, reelLength: 100, minClusterSize: 5,
      trialSpins: 500, trialsPerPoint: 1, maxIterations: 2,
    }),
    /payout-ladder-non-monotone|pays LESS for a bigger cluster/);
});
```

Also add `'validation'` to `KNOWN_NULL_BEST_PHASES` in the existing phase-contract test.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/tunefrequencies.test.mjs`

- [ ] **Step 3: Implement**

Call `validateTuningConfig` immediately after `baseReelTables` is built. Emit `onProgress('validation', 0, null, { findings }, null)` whenever `findings.length > 0`. Throw an `Error` listing every `severity: 'error'` finding's `message` and `suggestion` if any exist. Include `validation: findings` in `diagnostics`.

Add a `skipValidation: false` option — an escape hatch for a developer who knows better, documented as such.

- [ ] **Step 4: Panel handler**

Render errors in red and warnings in amber, each as `message` then a dimmer `suggestion` line, above the progress log. This block appears before any measurement, so it is the first thing a developer sees.

- [ ] **Step 5: Run the full suite and verify live**

Run: `npm test` — failures still exactly 4.
Live: open Candy Frenzy's tune panel and confirm no spurious errors on the current healthy config.

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js core/SimulationPanel.js tests/tunefrequencies.test.mjs
git commit -m "feat: Phase 0a validates the config and blocks a tune on arithmetic errors

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 1.4: `core/StructuralSensitivity.js` — ladders and elasticity

**Files:**
- Create: `core/StructuralSensitivity.js`
- Test: `tests/structuralsensitivity.test.mjs`

**Interfaces:**
- Produces:
  ```js
  buildLadders(reelTables, { reelLength }) -> [{ knob, current, values, isModeSwitch?: (v)=>bool }]
  summarize(baseline, ladderResults, { targetRtp, noiseFloorPct })
    -> { knobs: [{ knob, current, elasticityRtpPerUnit, ladder }], routesToTarget: [...] }
  ```
- Consumes: nothing from the simulator — `runSensitivitySweep` takes an injected `measure(tables, seed)`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLadders, summarize } from '../core/StructuralSensitivity.js';

test('the stackChance ladder never crosses 1.0 without labelling it a mode switch', () => {
  // stackChance is not a continuum: >= 1 switches generateReel to a different placement routine.
  // Measured on Candy Frenzy at uniform frequencies, 0.7 pays 181% and 1.0 pays 40%. An
  // unlabelled ladder point at 1.0 would read as "more stacking pays less", which is false and
  // would send a developer chasing the wrong parameter.
  const ladders = buildLadders(
    [{ defaults: { stackChance: 0.3, maxStack: 4, minStack: 2, minGap: 4 }, symbols: { a: { frequency: 1 } } }],
    { reelLength: 500 });
  const sc = ladders.find(l => l.knob === 'stackChance');
  assert.ok(sc.values.every(v => v < 1), `stackChance ladder must stay below 1.0, got ${sc.values.join(', ')}`);
  assert.ok(typeof sc.isModeSwitch === 'function' && sc.isModeSwitch(1.0));
});

test('summarize ranks knobs by elasticity and marks sub-noise knobs as flat', () => {
  // The real measured shape: maxStack moves RTP by tens of pp per unit, minGap by nothing.
  // A developer needs those presented as different KINDS of knob, not as a sorted list of numbers.
  const summary = summarize(
    { rtp: 101.48, triggerRate: 0.563, hitRate: 0.62 },
    [
      { knob: 'maxStack', current: 4, ladder: [
        { value: 3, rtp: 40.28 }, { value: 4, rtp: 101.48 }, { value: 5, rtp: 188.69 }] },
      { knob: 'minGap', current: 4, ladder: [
        { value: 1, rtp: 104.58 }, { value: 4, rtp: 101.48 }, { value: 6, rtp: 102.31 }] },
    ],
    { targetRtp: 96, noiseFloorPct: 1.3 });

  assert.equal(summary.knobs[0].knob, 'maxStack', 'highest-leverage knob must sort first');
  assert.ok(summary.knobs[0].elasticityRtpPerUnit > 50);
  const minGap = summary.knobs.find(k => k.knob === 'minGap');
  assert.equal(minGap.flat, true, 'a knob whose whole ladder sits inside the noise floor is flat, not weakly useful');
});

test('summarize reports the exact payout-scale route to target', () => {
  // RTP is strictly proportional to a global payout multiplier - verified to 5 significant figures
  // at both uniform and heavily skewed frequencies - so this route is closed-form, not interpolated.
  const summary = summarize({ rtp: 101.48, triggerRate: 0.563, hitRate: 0.62 }, [], { targetRtp: 96, noiseFloorPct: 1.3 });
  const route = summary.routesToTarget.find(r => r.knob === 'payoutScale');
  assert.ok(route.exact);
  assert.ok(Math.abs(route.value - 96 / 101.48) < 1e-9);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/structuralsensitivity.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`buildLadders` returns, for the knobs present in the reel `defaults`:

| knob | ladder | notes |
|---|---|---|
| `stackChance` | `[0.1, 0.2, 0.3, 0.4, 0.5, 0.7]` plus `current` | `isModeSwitch: (v) => v >= 1` |
| `maxStack` | `[current-2 … current+2]`, clamped `>= max(1, minStack)` | integers |
| `minStack` | `[1 … maxStack]` capped at 5 points | integers |
| `minGap` | `[1, 2, 4, 6, 8]` plus `current` | |
| `reelLength` | `[current, 2×, 4×]` | |
| `payoutScale` | `[0.8, 0.9, 1.0, 1.1, 1.25]` | applied to the paytable, not the reels |

`summarize` computes `elasticityRtpPerUnit` as the mean absolute ΔRTP per unit step across the ladder, sets `flat: true` when the ladder's full RTP span is `<= 2 * noiseFloorPct`, sorts `knobs` by elasticity descending, and derives `routesToTarget` — `payoutScale` closed-form (`targetRtp / baseline.rtp`, `exact: true`), every other knob by linear interpolation between the two ladder points bracketing `targetRtp` (`exact: false`, carrying `interpolatedFrom`).

- [ ] **Step 4: Run the tests**

Run: `node --test tests/structuralsensitivity.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/StructuralSensitivity.js tests/structuralsensitivity.test.mjs
git commit -m "feat: StructuralSensitivity ladders, elasticity ranking, and routes to target

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 1.5: Run the sweep as Phase 0c

**Files:**
- Modify: `core/SpinSimulator.js` — `runSensitivitySweep`, `'sensitivity'` progress phase, `diagnostics.sensitivity`
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: `buildLadders`/`summarize` from Task 1.4; `uniformizeTables` and `withStructuralDefaults` (already in `SpinSimulator.js`) for building each trial.
- Produces: `diagnostics.sensitivity`; options `measureSensitivity` (default `true`), `sensitivitySpins` (default `Math.round(trialSpins / 4)`), `sensitivityAt: 'uniform' | 'current'` (default `'uniform'`).

- [ ] **Step 1: Write the failing test**

```js
test('the sensitivity sweep reports a ladder per structural knob and its own noise floor', async () => {
  const paytable = {
    hi:  { payout: [0, 0, 10, 40, 200], type: 'regular' },
    lo:  { payout: [0, 0,  5, 20, 100], type: 'regular' },
    scat:{ payout: [0, 0,  2,  5,  20], type: 'scatter', triggerFreeSpins: true },
  };
  const table = () => ({
    defaults: { minGap: 2, maxStack: 3, minStack: 2, stackChance: 0.3 },
    symbols: { hi: { frequency: 3 }, lo: { frequency: 6 }, scat: { frequency: 1 } },
  });
  const result = await tuneFrequencies(paytable, [table(), table(), table()], {
    reelsCount: 3, rowsCount: 3, reelLength: 100, reelSeeds: [11, 22, 33],
    paylines: [[0, 0, 0]], linesCount: 1,
    trialSpins: 2000, trialsPerPoint: 1, maxIterations: 2, searchSeed: 7,
    measureSensitivity: true, sensitivitySpins: 800,
  });

  const s = result.diagnostics.sensitivity;
  assert.equal(s.measuredAt, 'uniform');
  assert.ok(Number.isFinite(s.noiseFloorPct), 'the sweep must report its own noise floor or ties read as signal');
  assert.ok(s.knobs.some(k => k.knob === 'stackChance'));
  assert.ok(s.knobs.some(k => k.knob === 'maxStack'));
  s.knobs.forEach(k => assert.ok(k.ladder.length >= 2, `${k.knob} ladder too short`));
  for (let i = 1; i < s.knobs.length; i++) {
    assert.ok(s.knobs[i - 1].elasticityRtpPerUnit >= s.knobs[i].elasticityRtpPerUnit, 'knobs must sort by leverage');
  }
});

test('measureSensitivity:false skips the sweep entirely', async () => {
  // ... same fixture, measureSensitivity: false ...
  assert.equal(result.diagnostics.sensitivity, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/tunefrequencies.test.mjs`

- [ ] **Step 3: Implement**

Immediately after the existing Phase 0b headroom block:

```js
  // ---- Phase 0c: structural sensitivity ----
  // Phase 0b answers "can an even distribution reach the target?" with one number. This answers
  // the question a developer actually has next: WHICH knob do I turn, and how far? Measured on
  // Candy Frenzy at uniform frequencies, maxStack 4->5 is worth +87pp while minGap 1->6 is worth
  // nothing at all - a difference no amount of staring at the config reveals, and one the whole
  // 84-dimensional frequency search cannot compensate for.
  //
  // Measured at UNIFORM frequencies by default so the structural effect is isolated from whatever
  // the current frequencies happen to be. Cost is ~30 measurements at sensitivitySpins (a quarter
  // of trialSpins, one trial each) - roughly 7 full candidate evaluations against a 150-iteration
  // search.
  let sensitivity = null;
  if (measureSensitivity) { /* build ladders, measure each point, summarize, emit 'sensitivity' */ }
```

The noise floor comes from re-measuring the baseline under three different seeds and taking twice the sample standard deviation. That is three extra measurements and it is what stops the report presenting a ±1pp tie as a finding.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "feat: Phase 0c measures structural sensitivity and ranks knobs by leverage

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 1.6: Render the sensitivity report

**Files:**
- Modify: `core/SimulationPanel.js` — `'sensitivity'` handler and results block
- Test: `tests/simulationpanel.test.mjs` (extract the formatter as a pure exported function and test it directly, as `formatReelFrequencyTablesForCopy` already is)

- [ ] **Step 1: Write the failing test**

```js
test('formatSensitivityReport names the highest-leverage knob and flags flat ones', () => {
  const out = formatSensitivityReport({
    measuredAt: 'uniform', noiseFloorPct: 1.3,
    baseline: { rtp: 101.48, triggerRate: 0.563, hitRate: 0.62 },
    knobs: [
      { knob: 'maxStack', current: 4, elasticityRtpPerUnit: 87.2, flat: false,
        ladder: [{ value: 3, rtp: 40.28 }, { value: 4, rtp: 101.48 }, { value: 5, rtp: 188.69 }] },
      { knob: 'minGap', current: 4, elasticityRtpPerUnit: 0.6, flat: true,
        ladder: [{ value: 1, rtp: 104.58 }, { value: 4, rtp: 101.48 }] },
    ],
    routesToTarget: [{ knob: 'payoutScale', value: 0.946, exact: true }],
  }, { targetRtp: 96 });

  assert.match(out, /maxStack/);
  assert.match(out, /\[4:101/, 'the current value must be marked in its own ladder');
  assert.match(out, /no measurable effect/i, 'a flat knob must say so rather than show a tiny number');
  assert.match(out, /0\.946/);
  assert.match(out, /exact/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/simulationpanel.test.mjs`

- [ ] **Step 3: Implement `formatSensitivityReport`**

Target shape — prose first, numbers second:

```
STRUCTURAL SENSITIVITY (uniform frequencies, 96% target, baseline 101.48%, noise floor +/-1.3pp)

  maxStack      4  →  ±1 is worth ~87pp     3:40%  [4:101%]  5:189%
  stackChance 0.30  →  ±0.1 is worth ~25pp  0.1:36%  0.2:77%  [0.3:101%]  0.4:121%
                       ⚠ 1.0 is a MODE SWITCH, not more stacking — it pays 40%
  minGap        4  →  no measurable effect  1:105%  [4:101%]  6:102%
                       spacing is free on this game — spend it on how the reels look

  TO REACH 96% FROM HERE:
   • scale every payout by 0.946        (exact — RTP is strictly proportional to payouts)
   • or set stackChance to ~0.29        (interpolated between 0.2 and 0.3)
```

- [ ] **Step 4: Run tests and verify live**

Run: `npm test`
Live: run a Candy Frenzy tune and confirm the report ranks `maxStack` above `stackChance` above `minGap`, and flags the `stackChance` mode switch.

- [ ] **Step 5: Commit**

```bash
git add core/SimulationPanel.js tests/simulationpanel.test.mjs
git commit -m "feat: render the structural sensitivity report in the tuning panel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 1.7: `winEvaluatorFactory` makes `solvePayoutScale` verifiable

**Files:**
- Modify: `core/SpinSimulator.js` — `measure()` accepts a rebuilt evaluator; payout-solve verification uses it
- Modify: `games/candyfrenzy/game.js` — supply the factory
- Test: `tests/tunefrequencies.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('winEvaluatorFactory lets the payout solve verify itself on a closure-based evaluator', async () => {
  // A cascade game's winEvaluator captures its own paytable - (grid) => checkClusterWins(grid,
  // PAYTABLE, ...) - so overriding config.paytable does nothing and the verification run measures
  // the ORIGINAL payouts. The scale is exact arithmetic either way; what was missing was any way
  // to confirm it, so the tuner correctly reported verified:false and a caveat nobody could act on.
  // ... fixture with a closure evaluator, solvePayoutScale: true, winEvaluatorFactory supplied ...
  assert.equal(result.diagnostics.payoutScale.verified, true);
  assert.ok(Math.abs(result.diagnostics.payoutScale.verifiedRtp - 96) <= 1.5);
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

Add option `winEvaluatorFactory`. In `measure(reelTables, rngSeed, lengthOverride, paytableOverride)`, when `paytableOverride && winEvaluatorFactory`, set `config.winEvaluator = winEvaluatorFactory(paytableOverride)`. Keep the existing `verificationNote` for callers without a factory.

- [ ] **Step 4: Supply it from Candy Frenzy**

```js
          // checkClusterWins is reached through a closure over PAYTABLE, so the payout-scale
          // solve cannot verify itself by swapping config.paytable - this rebuilds an equivalent
          // evaluator around the scaled paytable so the verification run measures the real thing.
          winEvaluatorFactory: (pt) => (grid) => checkClusterWins(grid, pt, MIN_CLUSTER_SIZE, 'bonus', SCATTER_TRIGGER_COUNT),
```

- [ ] **Step 5: Run tests**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js games/candyfrenzy/game.js tests/tunefrequencies.test.mjs
git commit -m "feat: winEvaluatorFactory lets the payout-scale solve verify itself

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 1.8: Expose the payout solve in the panel

**Files:**
- Modify: `core/SimulationPanel.js` — checkbox, results rendering, copy output
- Test: `tests/simulationpanel.test.mjs`

There are currently **zero** references to `solvePayoutScale`, `payoutScale` or `scaledPaytable` anywhere in `SimulationPanel.js` — the exact RTP lever is entirely unreachable from the UI.

- [ ] **Step 1: Write the failing test**

```js
test('formatReelFrequencyTablesForCopy emits the scaled paytable as real code when one was solved', () => {
  // Same reasoning as REEL_LENGTH in 2548ac2: a result that depends on a rescaled paytable is not
  // reproducible from frequencies alone, and a comment is not something you can paste.
  const output = formatReelFrequencyTablesForCopy([{ defaults: {}, symbols: { bar: { frequency: 2 } } }], {
    rtp: 96.0, triggerRatePct: 0.6,
    inputParameters: { /* ...minimal set... */ },
    scaledPaytable: { bar: { type: 'regular', clusterPayout: [{ min: 5, multiplier: 0.709 }] } },
    payoutScale: { scale: 0.946, verified: true, verifiedRtp: 96.02 },
  });
  assert.match(output, /payout scale 0\.946/);
  assert.match(output, /multiplier: 0\.709/);
});
```

- [ ] **Step 2–4: Run, implement, run**

Checkbox `#tune-solve-payout-scale` wired through `readTuneOptions`; results block rendering scale, `verifiedRtp`, and `verified`/`verificationNote`; scaled ladder emitted as pasteable code in the copy output.

- [ ] **Step 5: Commit**

```bash
git add core/SimulationPanel.js tests/simulationpanel.test.mjs
git commit -m "feat: expose the payout-scale solve in the tuning panel and copy output

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 1.9: Structural grid search as Phase 0d

**Files:**
- Modify: `core/SpinSimulator.js` — `structuralSearch()`; wire up or delete `withStructuralDefaults` (L1397)
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: Task 1.5's ladder measurements as the coarse grid.
- Produces: option `tuneStructural: false | { knobs: string[], respectDesignIntent: boolean }`; `diagnostics.structuralRecommendation = { knobs: {...}, predictedRtp, appliedAutomatically: false }`.

- [ ] **Step 1: Write the failing test**

```js
test('the structural search recommends without applying, and honors pinned knobs', async () => {
  // A recommendation, not a mutation: which structural values a game ships is a design decision,
  // and the whole point of this package is to put the developer in a position to accept or reject.
  // ... fixture with tuneStructural: { knobs: ['stackChance'], respectDesignIntent: true } ...
  const rec = result.diagnostics.structuralRecommendation;
  assert.ok(rec.knobs.stackChance != null);
  assert.equal(rec.knobs.maxStack, undefined, 'a knob not listed must not be touched');
  assert.equal(rec.appliedAutomatically, false);
  assert.deepEqual(result.reelFrequencyTables[0].defaults, tables[0].defaults, 'the returned tables keep their original structural defaults');
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

Grid search, not CMA-ES — three of four knobs are small integers and the continuous one has a mode discontinuity, so a simplex or covariance method is the wrong tool. Seed the coarse grid from Task 1.5's already-measured ladder points (no re-measurement), pick the best cell by `|rtp - targetRtp|`, then refine locally with one bisection pass per continuous knob. Runs at uniform frequencies, at `sensitivitySpins`, before Phase 1. Use `withStructuralDefaults` to build each trial — this is the call site its comment always anticipated.

- [ ] **Step 4: Panel accept/reject**

Render the recommendation with its predicted RTP and an "apply to the tables below" button that rewrites the `defaults` in the copyable output only. Never mutate the running game.

- [ ] **Step 5: Run tests, verify live, commit**

```bash
git add core/SpinSimulator.js core/SimulationPanel.js tests/tunefrequencies.test.mjs
git commit -m "feat: Phase 0d recommends structural settings via grid search

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Package 2 — "What do these knobs mean?"

**Core issue:** the loss weights are unitless and the terms are incommensurable. Ordering is in raw frequency units (5.4489 on the shipped tables); spacing is a raw violation **count** (301 shipped, 136 uniform), so at `spacingPenaltyWeight: 0.25` that term contributes 75 against an RTP term of 21 and silently takes over the search.

### Task 2.1: Normalize every penalty to RTP percentage points

**Files:**
- Modify: `core/SpinSimulator.js` — `orderingPenaltyOf`, `limitPenaltyOf`, `uniformityPenaltyOf`, `spacingPenaltyOf`, `makeEvaluate`
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Produces: option `penaltyNormalization: 'raw' | 'normalized'` (default `'raw'`); each penalty result gains `{ total, normalized, violations }`; diagnostics report both.

- [ ] **Step 1: Write the failing test**

```js
test('normalized penalties are scale-free, so the same weight means the same thing on any game', () => {
  // The concrete failure this prevents: Candy Frenzy's spacing penalty is a raw violation COUNT -
  // 301 on the shipped tables. At the panel's 0.05 step a weight of 0.25 contributes 75 to a loss
  // whose RTP term is 21, so the search abandons RTP entirely to chase spacing, and nothing in the
  // UI hints that would happen. Normalized, the same term is "fraction of runs violating" and a
  // weight of 0.25 means "a quarter of a percentage point of RTP per whole reel gone wrong".
  // ... build two fixtures identical in shape but 10x apart in raw frequency scale ...
  assert.ok(Math.abs(smallScale.normalized - largeScale.normalized) < 1e-6,
    'normalized penalties must not depend on the absolute frequency scale');
  assert.ok(Math.abs(smallScale.total - largeScale.total) > 1e-3, 'raw penalties do depend on it - that is the bug');
});

test('penaltyNormalization defaults to raw and leaves existing losses unchanged', async () => {
  // ... two tuneFrequencies runs, one omitting the option, one with 'raw' - identical results ...
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

| penalty | normalization |
|---|---|
| ordering | `total / (equalShare × pairCount)` |
| limits | mean of `amount / bound` across violations |
| uniformity | `total / dimCount` |
| spacing | `violations / totalRuns` |
| trigger rate | unchanged — already percentage points |

`makeEvaluate` uses `normalized` when `penaltyNormalization === 'normalized'`, `total` otherwise. Report both in every result object so a weight can be translated between modes.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "feat: normalize penalties so weight 1 means one RTP percentage point

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 2.2: Intent-named controls

**Files:**
- Modify: `core/SimulationPanel.js` — replace the five weight inputs
- Test: `tests/simulationpanel.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('intent levels map onto normalized weights', () => {
  assert.equal(intentToWeight('off'), 0);
  assert.equal(intentToWeight('prefer'), 1);
  assert.equal(intentToWeight('insist'), 4);
  assert.equal(intentToWeight('require'), 12);
  assert.equal(weightToIntent(4), 'insist');
  assert.equal(weightToIntent(2.5), 'custom', 'a hand-typed weight must not be silently rounded into a named level');
});
```

- [ ] **Step 2–4: Run, implement, run**

Each of ordering / uniformity / spacing / trigger-rate / std-error becomes `Off | Prefer | Insist | Require` with a numeric override behind an `<details>` "advanced" toggle. Each carries a one-sentence description **and the current measured value of that quantity**, so a level is visibly a choice about a real number. Setting `penaltyNormalization: 'normalized'` is implied whenever a game uses intents.

- [ ] **Step 5: Commit**

```bash
git add core/SimulationPanel.js tests/simulationpanel.test.mjs
git commit -m "feat: name the penalty weights by intent instead of by magnitude

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 2.3: Loss budget preview

**Files:**
- Modify: `core/SpinSimulator.js` — evaluate the starting point once, emit `'loss-preview'`
- Modify: `core/SimulationPanel.js` — handler + rendering; add `'loss-preview'` to `KNOWN_NULL_BEST_PHASES`
- Test: `tests/tunefrequencies.test.mjs`, `tests/simulationpanel.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('the loss preview reports each term in pp, sorted by contribution', async () => {
  // 150 iterations is a long time to discover that spacing was worth 15pp and RTP error 5.5pp,
  // and that the search was therefore never really optimizing RTP at all.
  // ... assert diagnostics.lossPreview.terms[0].label and descending contributionPct ...
});
```

- [ ] **Step 2–4: Run, implement, run**

Reuse `makeEvaluate(baseNmSeed)(initialPoint)` — CMA-ES already measures exactly this point for its baseline anchor, so reuse that measurement rather than paying for a second one. Render sorted descending with the dominant term arrowed.

- [ ] **Step 5: Commit**

```bash
git add core/SpinSimulator.js core/SimulationPanel.js tests/
git commit -m "feat: preview the loss budget before the search spends its iterations

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Package 3 — "Will the player have fun?"

**Core issue:** `measure()` returns RTP, trigger rate and trial spread, and throws away `winDistribution`, `maxWin` and hit counts — all of which `simulateSpins` already computes. So "rough payout per win, no massive variance" has no metric, no target, no penalty and no display.

### Task 3.1: Round-level win shape in `simulateSpins`

**Files:**
- Modify: `core/SpinSimulator.js` — `simulateSpins` accumulator; `measure()` passthrough
- Test: `tests/spinsimulator.test.mjs`

**Interfaces:**
- Produces: `results.roundStats = { rounds, hitRate, meanWin, medianWin, p90, p99, p999, maxWin, top1PctShare, volatilityIndex, histogram }`, carried through `measure()`.

- [ ] **Step 1: Write the failing test**

```js
test('roundStats folds each free-spins round back into the base spin that bought it', () => {
  // winDistribution keys individual SPINS, base and free alike, and free spins are charged 0 bet -
  // so they inflate the hit rate and deflate the mean. What a player experiences is a ROUND: one
  // paid spin plus every free spin it bought. Measured on Candy Frenzy the two differ materially.
  // ... fixture with a guaranteed trigger ...
  assert.equal(results.roundStats.rounds, numBaseSpins, 'exactly one round per paid spin');
  assert.ok(results.roundStats.maxWin >= biggestSingleSpinWin, 'a round is at least as big as its largest spin');
});

test('roundStats needs no logSpins and holds no per-spin objects', () => {
  // logSpins holds one object per spin, which is why it is off by default at 1,000,000 spins.
  // roundStats must stay cheap enough to be on always - a few counters and a fixed histogram.
  const results = simulateSpins({ ...config, logSpins: false }, 5000, 1, 1, createSeededRng(1));
  assert.ok(results.roundStats);
  assert.equal(results.spinLog.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

Accumulate per round: count, sum, sum-of-squares, max, and a fixed log-spaced histogram (~60 buckets, 0.01× to 10,000× bet). Derive percentiles from the histogram; `volatilityIndex` is σ of round return per unit bet. The base-spin loop already brackets each free-spins chain, so the round boundary is exactly where `runOneSpin(false, null)` returns.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add core/SpinSimulator.js tests/spinsimulator.test.mjs
git commit -m "feat: measure round-level win shape without holding a log

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 3.2: `core/PlayerExperience.js`

**Files:**
- Create: `core/PlayerExperience.js`
- Modify: `core/SimulationPanel.js` — render after a tune and after a plain simulation
- Test: `tests/playerexperience.test.mjs`

**Interfaces:**
- Produces: `describePlayerExperience(roundStats, { bet, rtp, triggerRate, sessionSpins })` → `{ lines: string[], volatilityClass, sessionOutcomes }`.

- [ ] **Step 1: Write the failing test**

```js
test('a flat game is described as low volatility with its big-win drought named', () => {
  // The shipped Candy Frenzy numbers. The point of this module is that "96% RTP" and "max win 29x
  // in 40,000 spins" are the same game, and only one of those two facts is currently visible.
  const out = describePlayerExperience({
    rounds: 40000, hitRate: 0.522, meanWin: 1.43, medianWin: 0.8,
    p90: 2.5, p99: 6.0, p999: 20.5, maxWin: 29, top1PctShare: 0.098, volatilityIndex: 1.9,
    histogram: /* ... */,
  }, { bet: 1, rtp: 96.0, triggerRate: 0.53, sessionSpins: 500 });

  assert.equal(out.volatilityClass, 'LOW');
  assert.ok(out.lines.some(l => /52%/.test(l)));
  assert.ok(out.lines.some(l => /rule of thumb|typically/i.test(l)),
    'the comparison band is a rule of thumb and must be labelled as one, not presented as measured');
  assert.ok(out.sessionOutcomes.median < 0, 'a 96% RTP game loses the median player money over 500 spins');
});
```

- [ ] **Step 2–4: Run, implement, run**

Session outcomes by bootstrap resampling the round histogram — no extra simulation. Volatility bands and the "commercial cluster-cascade games typically run 4–8x" reference are rules of thumb; label them as such in both the code comment and the rendered text.

- [ ] **Step 5: Verify live and commit**

```bash
git add core/PlayerExperience.js core/SimulationPanel.js tests/playerexperience.test.mjs
git commit -m "feat: describe what a tuned game actually feels like to play

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 3.3: Volatility as a tuning target

**Files:**
- Modify: `core/SpinSimulator.js` — `targetVolatility`, `volatilityTolerance`, `volatilityPenaltyWeight`
- Modify: `core/SimulationPanel.js` — target inputs beside RTP and trigger rate
- Test: `tests/tunefrequencies.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('the volatility penalty is exactly zero inside its band', () => {
  // Same shape as triggerRatePenaltyWeight: a band, not a point target, so it never competes with
  // the RTP term over a volatility that was already acceptable.
  // ... assert loss with volatilityPenaltyWeight 5 equals loss with 0 when inside the band ...
});
```

- [ ] **Step 2–4: Run, implement, run**

- [ ] **Step 5: Document the honest caveat**

In the option's JSDoc and in the panel tooltip, state plainly: volatility on a cluster-cascade game is dominated by the payout ladder shape and `maxStack`, not by symbol frequencies. This target therefore mostly steers Package 1's structural search and payout solve. Setting it against Phase 2 alone will move it very little — say so rather than let a developer burn a 150-iteration search discovering it.

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js core/SimulationPanel.js tests/tunefrequencies.test.mjs
git commit -m "feat: volatility as a soft tuning target, with an honest caveat about its lever

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After Package 3

Re-tune Candy Frenzy end to end with everything above enabled and record the result in the design doc: linked reels, validated config, sensitivity-chosen structural settings, payout scale solved, volatility reported. The 74.70% starting point and the 101.48% uniform baseline are the numbers to beat and to compare against.

Then revisit two deferred items, in this order:

1. **The accept/reject candidate-history UI** — deliberately not planned here because there was little to compare candidates *on* until sensitivity and win-shape existed. After Package 3 there is.
2. **Package 4 (search correctness)** — Phase 3 trigger-rate re-solve, cross-reel cluster-structure metric, dead-code cleanup. Specified in the design doc; still deferred; still not to be pulled forward into this plan.

## Self-Review

- **Spec coverage:** Package 0 → Tasks 0.1–0.3. Package 1 → 1.1–1.9 (validation 1.1–1.3, sweep 1.4–1.6, payout scale 1.7–1.8, structural search 1.9). Package 2 → 2.1–2.3. Package 3 → 3.1–3.3. Package 4 → **deliberately unplanned, marked deferred in Scope and again in "After Package 3"**.
- **Type consistency:** `Finding` (1.1) is consumed unchanged by 1.2 and 1.3. `buildLadders`/`summarize` (1.4) are consumed by 1.5 and rendered by 1.6. `roundStats` (3.1) is consumed by 3.2 and 3.3. `activeDims`/`reelIndex: null` (0.1) is consumed by 0.2.
- **Known gap:** Tasks 1.7, 1.8, 1.9, 2.1, 2.2, 2.3, 3.2 and 3.3 give test intent and implementation shape rather than complete literal test bodies, because several depend on fixtures established by the task immediately before them. Each one's first step is still "write the failing test" and must not be skipped — write the body against the fixture that exists at that point.
- **Risk:** Task 2.1 changes what every existing weight means. The `'raw'` default plus dual reporting is the mitigation, but every game's `tuneConfig` needs a deliberate pass before that default flips, and no task here flips it.
