# Frequency Bounds and Live Tuning View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the per-symbol `min`/`max` soft frequency bounds to `minFrequency`/`maxFrequency`
and give them a reel-level `defaults` fallback (matching `minGap`/`maxStack`'s existing pattern),
add a new `minStack` constraint (minimum consecutive run length, with `minGap` becoming
cluster-aware once `minStack > 1`), and add a live, in-place per-symbol table to the TUNE
FREQUENCIES panel showing each symbol's current frequency and resolved bounds as the search runs.

**Architecture:** A new exported `resolveFrequencyBounds(reelTable, symbol)` helper in
`core/SlotMath.js` centralizes the symbol-override -> reel-defaults -> unconstrained resolution
for `minFrequency`/`maxFrequency`, used by both `tuneFrequencies` (Phase 2's dims-building) and
`SimulationPanel.js`'s new live table. `generateReel` gains `minStack` via a "cluster placeholder"
technique: a clustered symbol's occurrences are represented as one placeholder per cluster (not
one per occurrence) during the shuffle and existing `minGap`/`maxStack` passes - which then run
completely unmodified, since a placeholder is just another position to them - and are expanded
into their full consecutive run only at the very end. `SimulationPanel.js`'s live table reads
Phase 2's existing `onProgress` callback (`result.trial` already carries the full live candidate
reel tables) - no change to `tuneFrequencies`' return contract.

**Tech Stack:** Plain ES modules, `node --test` for the test suite. No new dependencies.

## Global Constraints

- `npm test` (`node --test tests/*.mjs`) must stay green after every task.
- Design doc: `docs/superpowers/specs/2026-07-25-frequency-bounds-and-live-tuning-design.md`.
- `minStack: 1` (the default, and every reel that doesn't opt in) must produce byte-identical
  `generateReel` output to today - verified by a dedicated regression test in Task 3.
- No new UI inputs for configuring `minFrequency`/`maxFrequency`/`minStack` - per the design's
  explicit non-goal, these stay a game.js edit. Only the live *readout* is new UI.
- Windows/PowerShell environment. Use `node --test tests/*.mjs` (via the Bash tool, which is
  Git Bash, or PowerShell) to run tests.

---

## File Structure

- Modify: `core/SlotMath.js` - new exported `resolveFrequencyBounds` (Task 1); `generateReel`
  gains `minStack` support (Task 3).
- Modify: `core/SpinSimulator.js` - Phase 2's dims-building reads bounds through
  `resolveFrequencyBounds` instead of the bare `.min`/`.max` fields (Task 2).
- Modify: `games/fruitmachine/game.js` - the only two existing `min`/`max` usages, renamed
  (Task 2).
- Modify: `core/SimulationPanel.js` - `formatReelFrequencyTablesForCopy` renamed fields +
  `minStack` support, and the new live per-symbol table (Task 4).
- Modify: `tests/slotmath.test.mjs`, `tests/tunefrequencies.test.mjs`,
  `tests/simulationpanel.test.mjs` - new/renamed tests throughout.

---

## Task 1: Export `resolveFrequencyBounds` from `core/SlotMath.js`

Small, self-contained groundwork - a pure function with no callers wired up yet. Established and
tested in isolation before Task 2 wires it into `tuneFrequencies` and Task 4 wires it into the
live table, so both consumers build on an already-verified resolver.

**Files:**
- Modify: `core/SlotMath.js`
- Test: `tests/slotmath.test.mjs`

**Interfaces:**
- Produces: `resolveFrequencyBounds(reelTable, symbol) -> { minFrequency: number|null,
  maxFrequency: number|null }`, consumed by Task 2 (`core/SpinSimulator.js`) and Task 4
  (`core/SimulationPanel.js`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/slotmath.test.mjs`, after the existing `generateReel` tests (before the `checkWins`
tests begin):

```js
test('resolveFrequencyBounds returns null for both when neither symbol nor reel defaults set them', () => {
  const reelTable = { defaults: {}, symbols: { bar: { frequency: 10 } } };
  const bounds = resolveFrequencyBounds(reelTable, 'bar');
  assert.deepEqual(bounds, { minFrequency: null, maxFrequency: null });
});

test('resolveFrequencyBounds reads a per-symbol override', () => {
  const reelTable = { defaults: {}, symbols: { bar: { frequency: 10, minFrequency: 2, maxFrequency: 20 } } };
  const bounds = resolveFrequencyBounds(reelTable, 'bar');
  assert.deepEqual(bounds, { minFrequency: 2, maxFrequency: 20 });
});

test('resolveFrequencyBounds falls back to the reel-level default when the symbol has no override', () => {
  const reelTable = { defaults: { minFrequency: 1, maxFrequency: 50 }, symbols: { bar: { frequency: 10 } } };
  const bounds = resolveFrequencyBounds(reelTable, 'bar');
  assert.deepEqual(bounds, { minFrequency: 1, maxFrequency: 50 });
});

test('resolveFrequencyBounds lets a per-symbol override win over the reel default, independently per bound', () => {
  const reelTable = {
    defaults: { minFrequency: 1, maxFrequency: 50 },
    symbols: { bar: { frequency: 10, maxFrequency: 20 } }, // only overrides max, not min
  };
  const bounds = resolveFrequencyBounds(reelTable, 'bar');
  assert.deepEqual(bounds, { minFrequency: 1, maxFrequency: 20 });
});

test('resolveFrequencyBounds treats a table with no .symbols key as a flat legacy symbol map', () => {
  const flat = { bar: { frequency: 10, minFrequency: 3 } };
  const bounds = resolveFrequencyBounds(flat, 'bar');
  assert.deepEqual(bounds, { minFrequency: 3, maxFrequency: null });
});
```

Update the file's import line to include the new export:

```js
import { checkWins, checkExpandingWins, checkWildLineWins, generateReel, resolveFrequencyBounds } from '../core/SlotMath.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/slotmath.test.mjs`
Expected: FAIL - `resolveFrequencyBounds` doesn't exist yet (`TypeError: resolveFrequencyBounds is not a function`).

- [ ] **Step 3: Implement**

In `core/SlotMath.js`, add immediately after `generateReel`'s closing brace (before the
`checkWins` section):

```js
/**
 * Resolves a symbol's soft frequency bounds on one reel: symbol-level override -> reel
 * `defaults` -> unconstrained (`null`). Each bound resolves independently - a symbol can
 * override only `maxFrequency` while still inheriting the reel's default `minFrequency`, for
 * example. Used by both `tuneFrequencies` (Phase 2's per-dimension search bounds) and the TUNE
 * FREQUENCIES panel's live view (showing each symbol's configured range next to its
 * live-updating current value) - `generateReel` itself never needs this, since these bounds
 * guide the search, they don't affect how a reel strip is built.
 *
 * @param {Object} reelTable - One reel's `{ defaults?, symbols }` table, or a flat legacy
 *   `{ symbol: {...} }` map (auto-detected by the presence of `.symbols`, same as `generateReel`).
 * @param {string} symbol
 * @returns {{ minFrequency: number|null, maxFrequency: number|null }}
 */
export function resolveFrequencyBounds(reelTable, symbol) {
  const symbolsTable = reelTable.symbols || reelTable;
  const defaults = reelTable.defaults || {};
  const entry = symbolsTable[symbol] || {};
  const minFrequency = entry.minFrequency ?? defaults.minFrequency ?? null;
  const maxFrequency = entry.maxFrequency ?? defaults.maxFrequency ?? null;
  return { minFrequency, maxFrequency };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/slotmath.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/SlotMath.js tests/slotmath.test.mjs
git commit -m "feat: add resolveFrequencyBounds, a shared min/maxFrequency resolver with reel defaults"
```

---

## Task 2: Rename `min`/`max` to `minFrequency`/`maxFrequency`, wire reel-defaults into `tuneFrequencies`

**Files:**
- Modify: `core/SpinSimulator.js`
- Modify: `games/fruitmachine/game.js`
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: `resolveFrequencyBounds` (Task 1).
- Produces: Phase 2's dims now resolve `min`/`max` (the `dims` array's own internal field names,
  unchanged) through `resolveFrequencyBounds`, so a reel-level `defaults.minFrequency`/
  `.maxFrequency` now actually takes effect.

- [ ] **Step 1: Update the field names in existing tests**

In `tests/tunefrequencies.test.mjs`, find (the `limitPenaltyWeight` test):

```js
  const cappedTables = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, max: cap } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
```

Replace with:

```js
  const cappedTables = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, maxFrequency: cap } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
```

Find (the converged-with-violations test, in the Task 2 stall-robustness suite added earlier):

```js
  const conflictedTables = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, min: FREQUENCY_REEL1.symbols.cherries.frequency * 5 } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
```

Replace with:

```js
  const conflictedTables = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, minFrequency: FREQUENCY_REEL1.symbols.cherries.frequency * 5 } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
```

- [ ] **Step 2: Write a new failing test for reel-level defaults**

Add to `tests/tunefrequencies.test.mjs`, right after the (now-renamed) `limitPenaltyWeight` test:

```js
test('tuneFrequencies applies a reel-level default maxFrequency to a symbol without its own override', async () => {
  const cap = FREQUENCY_REEL1.symbols.bar.frequency / 2;
  const cappedByDefault = [
    { ...FREQUENCY_REEL1, defaults: { ...FREQUENCY_REEL1.defaults, maxFrequency: cap } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
  const { reelFrequencyTables, diagnostics } = await tuneFrequencies(PAYTABLE, cappedByDefault, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 80,
    limitPenaltyWeight: 10,
  });
  // bar has no per-symbol maxFrequency of its own here - only the reel-level default should
  // constrain it, exactly as if it had been set directly on bar (mirrors the existing
  // per-symbol-override test's own tolerance).
  assert.ok(reelFrequencyTables[0].symbols.bar.frequency <= cap + 2,
    `expected bar's frequency to stay close to the reel-default cap of ${cap} (no per-symbol override), got ${reelFrequencyTables[0].symbols.bar.frequency}`);
  assert.ok(Array.isArray(diagnostics.rtpPhase.limitViolations), 'limitViolations must be reported (possibly empty), never omitted');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: the new reel-default test FAILS (the dims-building loop doesn't read reel defaults yet
- `bar`'s frequency won't be constrained at all, likely well above `cap + 2`). The two renamed
tests continue to PASS unchanged (they're pure renames of already-correct behavior) - that's
expected, not a problem; only the new test needs the implementation step below.

- [ ] **Step 4: Implement**

In `core/SpinSimulator.js`, add `resolveFrequencyBounds` to the existing import:

```js
import { checkWins, checkExpandingWins, generateReel, generateTargetGrid, createSeededRng, resolveFrequencyBounds } from './SlotMath.js';
```

Find the dims-building loop's final line:

```js
    if (valueSymbols.length > 0 && valueBudget > 0) {
      valueSymbols.forEach(s => dims.push({ reelIndex: r, symbol: s, min: symbolsTable[s].min, max: symbolsTable[s].max }));
    }
```

Replace with:

```js
    if (valueSymbols.length > 0 && valueBudget > 0) {
      valueSymbols.forEach(s => {
        const bounds = resolveFrequencyBounds(reelTable, s);
        dims.push({ reelIndex: r, symbol: s, min: bounds.minFrequency, max: bounds.maxFrequency });
      });
    }
```

(`dims`' own entries keep the short internal names `min`/`max` - purely internal state, never
exposed to a caller or test directly; only where the values come from changes.)

Update the JSDoc above `tuneFrequencies`. Find:

```js
 * @param {Object[]} reelFrequencyTables - One table per reel, each
 *   `{ defaults?: { minGap?, maxStack? }, symbols: { symbol: { frequency, fixed?, min?, max?,
 *   minGap?, maxStack? } } }` (see generateReel's own doc in core/SlotMath.js for the shape
 *   and its `minGap`/`maxStack` fields - `tuneFrequencies` itself only reads/writes
 *   `.symbols[symbol].frequency`, `.fixed`, `.min`, `.max`; `.defaults` and any
 *   `.symbols[symbol].minGap`/`.maxStack` pass through untouched). `fixed: true` is optional
```

Replace with:

```js
 * @param {Object[]} reelFrequencyTables - One table per reel, each
 *   `{ defaults?: { minGap?, maxStack?, minStack?, minFrequency?, maxFrequency? }, symbols: {
 *   symbol: { frequency, fixed?, minFrequency?, maxFrequency?, minGap?, maxStack?, minStack? } } }`
 *   (see generateReel's own doc in core/SlotMath.js for the shape and its `minGap`/`maxStack`/
 *   `minStack` fields - `tuneFrequencies` itself only reads/writes `.symbols[symbol].frequency`,
 *   `.fixed`, `.minFrequency`, `.maxFrequency` (both resolved via `resolveFrequencyBounds`, so a
 *   reel-level `defaults.minFrequency`/`.maxFrequency` applies to any symbol that doesn't
 *   override it); `.defaults` and any `.symbols[symbol].minGap`/`.maxStack`/`.minStack` pass
 *   through untouched). `fixed: true` is optional
```

In `games/fruitmachine/game.js`, find:

```js
    star:       { frequency: 28.3, min: 20, max: 30 },
    strawberry: { frequency: 6.3, min: 2, max: 6 },
```

Replace with:

```js
    star:       { frequency: 28.3, minFrequency: 20, maxFrequency: 30 },
    strawberry: { frequency: 6.3, minFrequency: 2, maxFrequency: 6 },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `node --test tests/*.mjs`
Expected: All tests PASS (the `fruitmachine`-scoped rename doesn't change any value, only field
names, so any test measuring RTP/behavior off that game's data should be unaffected).

- [ ] **Step 7: Commit**

```bash
git add core/SpinSimulator.js games/fruitmachine/game.js tests/tunefrequencies.test.mjs
git commit -m "refactor: rename min/max to minFrequency/maxFrequency, resolve reel-level defaults"
```

---

## Task 3: `minStack` support in `generateReel`

The core of this plan: a symbol can now require a minimum consecutive run length whenever it
appears, with `minGap` automatically becoming cluster-aware (spacing whole clusters apart, not
individual stops within one) once `minStack > 1` for that symbol.

**Files:**
- Modify: `core/SlotMath.js`
- Test: `tests/slotmath.test.mjs`

**Interfaces:**
- Produces: `generateReel` accepts `minStack` per-symbol and via `defaults.minStack` (resolved
  symbol override -> reel default -> fallback `1`, i.e. no minimum).

- [ ] **Step 1: Write the failing tests**

Add to `tests/slotmath.test.mjs`, after the existing `maxStack` test (`'generateReel caps
consecutive runs of a symbol via maxStack'`) and before the flat-legacy-shape test:

```js
test('generateReel forms runs of at least minStack whenever a clustered symbol appears', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      stacked: { frequency: 1, minStack: 3 },
      filler:  { frequency: 5 },
    },
  };
  const reel = generateReel(reelWeights, 100, 5);
  assert.ok(reel.includes('stacked'), 'expected "stacked" to actually appear on the built reel');
  const n = reel.length;
  let seam = -1;
  for (let i = 0; i < n; i++) { if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; } }
  assert.notEqual(seam, -1, 'reel should not be a single uniform symbol');
  let i = 0;
  while (i < n) {
    const idx = (seam + i) % n;
    if (reel[idx] === 'stacked') {
      let runLen = 1;
      while (runLen < n && reel[(seam + i + runLen) % n] === 'stacked') runLen++;
      assert.ok(runLen >= 3, `expected every "stacked" run to be at least 3 long, found a run of ${runLen} at position ${idx}`);
      i += runLen;
    } else {
      i++;
    }
  }
});

test('generateReel caps a clustered symbol\'s own run size via maxStack, without merging separate clusters over that cap', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      stacked: { frequency: 1, minStack: 2, maxStack: 4 },
      filler:  { frequency: 3 },
    },
  };
  const reel = generateReel(reelWeights, 150, 9);
  assert.ok(reel.includes('stacked'), 'expected "stacked" to actually appear on the built reel');
  const n = reel.length;
  let seam = -1;
  for (let i = 0; i < n; i++) { if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; } }
  let i = 0;
  while (i < n) {
    const idx = (seam + i) % n;
    if (reel[idx] === 'stacked') {
      let runLen = 1;
      while (runLen < n && reel[(seam + i + runLen) % n] === 'stacked') runLen++;
      assert.ok(runLen <= 4, `expected no "stacked" run longer than 4, found a run of ${runLen} at position ${idx}`);
      i += runLen;
    } else {
      i++;
    }
  }
});

test('generateReel spaces clusters apart (not individual stops within a cluster) once minStack > 1 and minGap is set', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      stacked: { frequency: 1, minStack: 2, minGap: 20 },
      filler:  { frequency: 20 },
    },
  };
  const reel = generateReel(reelWeights, 1000, 3);
  const n = reel.length;
  let seam = -1;
  for (let i = 0; i < n; i++) { if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; } }
  const runs = [];
  let i = 0;
  while (i < n) {
    const idx = (seam + i) % n;
    if (reel[idx] === 'stacked') {
      let runLen = 1;
      while (runLen < n && reel[(seam + i + runLen) % n] === 'stacked') runLen++;
      runs.push({ start: idx, length: runLen });
      i += runLen;
    } else {
      i++;
    }
  }
  assert.ok(runs.length >= 2, `expected at least 2 clusters to compare distances between, got ${runs.length}`);
  const circularDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n - d); };
  for (let a = 0; a < runs.length; a++) {
    for (let b = a + 1; b < runs.length; b++) {
      const dist = circularDist(runs[a].start, runs[b].start);
      assert.ok(dist >= 20, `expected clusters at least 20 apart (by start position), got ${dist} between clusters at ${runs[a].start} and ${runs[b].start}`);
    }
  }
});

test('generateReel with every symbol at minStack: 1 (the default) is byte-identical to before minStack existed', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      common: { frequency: 1, maxStack: 2 },
      filler: { frequency: 1 },
    },
  };
  const withDefaultMinStack = generateReel(reelWeights, 60, 11);
  const explicitlyOne = generateReel(
    { defaults: {}, symbols: { common: { frequency: 1, maxStack: 2, minStack: 1 }, filler: { frequency: 1, minStack: 1 } } },
    60, 11
  );
  assert.deepEqual(withDefaultMinStack, explicitlyOne);
});

test('generateReel degrades gracefully (best effort) when a symbol has fewer occurrences than its own minStack', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      rare:   { frequency: 0.05, minStack: 50 },
      filler: { frequency: 20 },
    },
  };
  const reel = generateReel(reelWeights, 100, 1);
  // Must not throw, hang, or drop the symbol entirely - best effort, same tolerance as
  // minGap/maxStack already have for a reel too dense/sparse to fully satisfy.
  assert.ok(reel.includes('rare'), 'expected "rare" to still appear at least once, even under-clustered');
  assert.equal(reel.length, 100);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/slotmath.test.mjs`
Expected: the 5 new tests FAIL (`minStack` isn't read at all yet, so clusters never form -
`runLen >= 3` assertions fail immediately on the first isolated single-stop "stacked").

- [ ] **Step 3: Implement**

In `core/SlotMath.js`, inside `generateReel`, add a new helper function alongside `_shuffle`/
`_enforceMinGap`/`_enforceMaxStack` (place it after `_enforceMaxStack`'s closing brace):

```js
  // Splits `count` occurrences of a clustered symbol into cluster sizes, each between
  // `minStack` and `maxStack` (best-effort - a remainder that doesn't fill a full cluster is
  // spread across the other clusters rather than dumped into one oversized one; any cluster
  // that would still exceed `maxStack` gets split into maxStack-sized chunks plus a
  // leftover). Not itself responsible for placement - just how many of each size to place.
  function _computeClusterSizes(count, minStack, maxStack) {
    if (count <= 0) return [];
    if (count < minStack) return [count]; // best effort - not enough occurrences for one full cluster
    const cap = Math.min(maxStack, count);
    const numClusters = Math.max(1, Math.floor(count / minStack));
    const base = Math.floor(count / numClusters);
    const remainder = count - base * numClusters;
    const sizes = new Array(numClusters).fill(base);
    for (let i = 0; i < remainder; i++) sizes[i % numClusters] += 1;
    const finalSizes = [];
    sizes.forEach(size => {
      let remaining = size;
      while (remaining > cap) { finalSizes.push(cap); remaining -= cap; }
      finalSizes.push(remaining);
    });
    return finalSizes.filter(s => s > 0);
  }
```

Find Step 1 & 2 / Step 3 (the weight-computation and reel-building block):

```js
  // Step 1 & 2: Compute weights and calculate counts in one pass. An explicit
  // frequency: 0 means "never place this symbol on this reel" - excluded from `weights`
  // entirely, same as `exclude` - not defaulted to 1 (which `freq || 1` did, since 0 is
  // falsy) and not floored to a guaranteed single occurrence below.
  const weights = {};
  for (const symbol in symbolsTable) {
    if (exclude.includes(symbol)) continue;
    const freq = symbolsTable[symbol].frequency ?? 1;
    if (freq > 0) weights[symbol] = freq;
  }

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const reel = [];

  // Step 3: Build reel directly from weights and total weight
  for (const symbol in weights) {
    const count = Math.max(1, Math.round((weights[symbol] / totalWeight) * targetLength));
    for (let i = 0; i < count; i++) reel.push(symbol);
  }

  // Step 4: Shuffle with seed
  const rng = createSeededRng(seed);
  _shuffle(reel, rng);

  // Step 5: Apply each present symbol's own minGap/maxStack - resolved as symbol override ->
  // reel defaults -> built-in fallback. minGap passes run first (the coarser, whole-strip
  // constraint), then maxStack cleans up runs in the result, so a minGap swap can't undo a
  // maxStack fix.
  function resolveMinGap(symbol) {
    const override = symbolsTable[symbol].minGap;
    if (override != null) return override;
    if (reelDefaults.minGap != null) return reelDefaults.minGap;
    const triggersFreeSpins = paytable[symbol] && paytable[symbol].triggerFreeSpins === true;
    return triggersFreeSpins ? defaultTriggerMinGap : 1;
  }
  function resolveMaxStack(symbol) {
    const override = symbolsTable[symbol].maxStack;
    if (override != null) return override;
    if (reelDefaults.maxStack != null) return reelDefaults.maxStack;
    return Infinity;
  }

  for (const symbol in weights) {
    const gap = resolveMinGap(symbol);
    if (gap > 1) _enforceMinGap(reel, symbol, gap, rng);
  }
  for (const symbol in weights) {
    const cap = resolveMaxStack(symbol);
    if (cap < Infinity) _enforceMaxStack(reel, symbol, cap, rng);
  }

  return reel;
```

Replace with:

```js
  // Step 1 & 2: Compute weights and calculate counts in one pass. An explicit
  // frequency: 0 means "never place this symbol on this reel" - excluded from `weights`
  // entirely, same as `exclude` - not defaulted to 1 (which `freq || 1` did, since 0 is
  // falsy) and not floored to a guaranteed single occurrence below.
  const weights = {};
  for (const symbol in symbolsTable) {
    if (exclude.includes(symbol)) continue;
    const freq = symbolsTable[symbol].frequency ?? 1;
    if (freq > 0) weights[symbol] = freq;
  }

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  function resolveMinGap(symbol) {
    const override = symbolsTable[symbol].minGap;
    if (override != null) return override;
    if (reelDefaults.minGap != null) return reelDefaults.minGap;
    const triggersFreeSpins = paytable[symbol] && paytable[symbol].triggerFreeSpins === true;
    return triggersFreeSpins ? defaultTriggerMinGap : 1;
  }
  function resolveMaxStack(symbol) {
    const override = symbolsTable[symbol].maxStack;
    if (override != null) return override;
    if (reelDefaults.maxStack != null) return reelDefaults.maxStack;
    return Infinity;
  }
  function resolveMinStack(symbol) {
    const override = symbolsTable[symbol].minStack;
    if (override != null) return override;
    if (reelDefaults.minStack != null) return reelDefaults.minStack;
    return 1;
  }

  // Step 3: Build a pre-shuffle array. A symbol with minStack > 1 is represented as one
  // placeholder per *cluster*, not one per occurrence - so the shuffle, minGap, and (for
  // clustered symbols) maxStack passes below all treat a whole cluster as a single atomic
  // unit, entirely unmodified from how they already work for a plain single-occurrence
  // symbol. Clusters are only expanded into their real, full-length run of consecutive
  // copies at the very end (Step 6), once every position is finalized. A symbol at
  // minStack: 1 (the default - every reel that doesn't opt in) takes the untouched, original
  // path: one placeholder per occurrence, identical to before minStack existed.
  const preShuffle = [];
  const clusterSizesBySymbol = {}; // symbol -> this symbol's assigned cluster sizes, consumed in order at expansion time
  for (const symbol in weights) {
    const count = Math.max(1, Math.round((weights[symbol] / totalWeight) * targetLength));
    const minStack = resolveMinStack(symbol);
    if (minStack > 1) {
      const cap = resolveMaxStack(symbol); // repurposed as this symbol's per-cluster size cap once clustered
      const sizes = _computeClusterSizes(count, minStack, cap);
      clusterSizesBySymbol[symbol] = sizes;
      for (let i = 0; i < sizes.length; i++) preShuffle.push(symbol);
    } else {
      for (let i = 0; i < count; i++) preShuffle.push(symbol);
    }
  }

  // Step 4: Shuffle with seed
  const rng = createSeededRng(seed);
  _shuffle(preShuffle, rng);

  // Step 5: Apply each present symbol's own minGap/maxStack - resolved as symbol override ->
  // reel defaults -> built-in fallback. minGap passes run first (the coarser, whole-strip
  // constraint), then maxStack cleans up runs in the result, so a minGap swap can't undo a
  // maxStack fix. For a clustered symbol (minStack > 1), maxStack no longer means "run length
  // cap" (that's already handled per-cluster by _computeClusterSizes above) - instead this
  // pass always forbids two of that symbol's own cluster placeholders from landing directly
  // adjacent to each other, regardless of the symbol's own maxStack setting, so two clusters
  // can never silently merge into one combined run bigger than either was meant to be.
  for (const symbol in weights) {
    const gap = resolveMinGap(symbol);
    if (gap > 1) _enforceMinGap(preShuffle, symbol, gap, rng);
  }
  for (const symbol in weights) {
    const minStack = resolveMinStack(symbol);
    if (minStack > 1) {
      _enforceMaxStack(preShuffle, symbol, 1, rng);
    } else {
      const cap = resolveMaxStack(symbol);
      if (cap < Infinity) _enforceMaxStack(preShuffle, symbol, cap, rng);
    }
  }

  // Step 6: Expand cluster placeholders into their real, full-length runs. A non-clustered
  // symbol's entries pass through 1:1, unchanged - so the final reel is exactly what today's
  // code would have produced whenever no symbol on this reel uses minStack > 1.
  const reel = [];
  const clusterCursor = {}; // symbol -> next index into clusterSizesBySymbol[symbol] to consume
  for (const entry of preShuffle) {
    const sizes = clusterSizesBySymbol[entry];
    if (sizes) {
      const cursor = clusterCursor[entry] || 0;
      for (let i = 0; i < sizes[cursor]; i++) reel.push(entry);
      clusterCursor[entry] = cursor + 1;
    } else {
      reel.push(entry);
    }
  }

  return reel;
```

Update the function's JSDoc. Find:

```js
 * `reelWeights` is either the structured shape `{ defaults?: { minGap?, maxStack? },
 * symbols: { symbol: { frequency, minGap?, maxStack?, ... } } }`, or a flat legacy shape
 * (`{ symbol: { frequency, ... } }` directly, no `.symbols` wrapper) - auto-detected by the
 * presence of a `.symbols` key. The flat shape has no way to express reel-level defaults.
 *
 * Two independent spacing constraints, each resolved per symbol as: symbol-level override ->
 * reel `defaults` -> built-in fallback (`minGap: 1` / `maxStack: Infinity`, i.e.
 * unconstrained - except a symbol with `paytable[symbol].triggerFreeSpins === true` falls
 * back to `defaultTriggerMinGap` instead of 1, so a free-spins-triggering symbol is spaced
 * out by default without needing to be configured):
 *   - `minGap`: minimum circular distance enforced between any two occurrences of that
 *     symbol on the built strip (self-spacing only - a symbol's minGap constrains its own
 *     occurrences relative to each other, not to other symbols).
 *   - `maxStack`: maximum run length of consecutive identical occurrences of that symbol
 *     allowed on the built strip (circular - a run can wrap from the end to the start).
 * Both are best-effort: a reel too dense to fully satisfy a constraint just gets as close as
 * it can, it doesn't throw or infinite-loop.
```

Replace with:

```js
 * `reelWeights` is either the structured shape `{ defaults?: { minGap?, maxStack?, minStack? },
 * symbols: { symbol: { frequency, minGap?, maxStack?, minStack?, ... } } }`, or a flat legacy
 * shape (`{ symbol: { frequency, ... } }` directly, no `.symbols` wrapper) - auto-detected by
 * the presence of a `.symbols` key. The flat shape has no way to express reel-level defaults.
 *
 * Three independent spacing constraints, each resolved per symbol as: symbol-level override ->
 * reel `defaults` -> built-in fallback (`minGap: 1` / `maxStack: Infinity` / `minStack: 1`,
 * i.e. unconstrained - except a symbol with `paytable[symbol].triggerFreeSpins === true` falls
 * back to `defaultTriggerMinGap` instead of 1 for `minGap`, so a free-spins-triggering symbol
 * is spaced out by default without needing to be configured):
 *   - `minGap`: minimum circular distance enforced between any two occurrences of that
 *     symbol on the built strip (self-spacing only). Once `minStack > 1` for that symbol,
 *     this instead spaces whole *clusters* apart - two stops inside the same cluster are
 *     meant to be adjacent, only the distance between separate clusters is constrained.
 *   - `maxStack`: maximum run length of consecutive identical occurrences of that symbol
 *     allowed on the built strip (circular - a run can wrap from the end to the start). Once
 *     `minStack > 1` for that symbol, this instead caps the size of any single cluster - two
 *     of that symbol's own clusters are always kept from landing directly adjacent to each
 *     other (so they can never silently merge into one combined run), independent of this
 *     setting.
 *   - `minStack`: minimum run length whenever the symbol appears at all - it's never placed
 *     as a lone isolated stop once this is above 1 (e.g. a stacked-feeling symbol). Forming
 *     clusters and spacing them apart both remain best-effort under `minGap`/`maxStack`
 *     tension (a symbol asked to both spread out its clusters widely and keep them small is
 *     satisfied as well as the reel's density allows, not perfectly).
 * All three are best-effort: a reel too dense/sparse to fully satisfy a constraint just gets
 * as close as it can, it doesn't throw or infinite-loop.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/slotmath.test.mjs`
Expected: PASS. If the cluster-spacing test is flaky (20 clusters can't all reach exactly 1000
apart on a 1000-length reel, but each pairwise distance should still individually clear 20 given
the space available), re-check the reel length vs. cluster count math before assuming a real bug
- this was verified via a standalone prototype script before being written into this plan.

- [ ] **Step 5: Run the full suite**

Run: `node --test tests/*.mjs`
Expected: All tests PASS - this task is purely additive (no existing reel with `minStack` unset
changes behavior).

- [ ] **Step 6: Commit**

```bash
git add core/SlotMath.js tests/slotmath.test.mjs
git commit -m "feat: add minStack to generateReel, with cluster-aware minGap once minStack > 1"
```

---

## Task 4: `SimulationPanel.js` - rename fields in the copy output, add `minStack`, and the live per-symbol table

**Files:**
- Modify: `core/SimulationPanel.js`
- Test: `tests/simulationpanel.test.mjs`

**Interfaces:**
- Consumes: `resolveFrequencyBounds` (Task 1).

- [ ] **Step 1: Update `formatReelFrequencyTablesForCopy`'s existing tests**

In `tests/simulationpanel.test.mjs`, find:

```js
test('formatReelFrequencyTablesForCopy still includes fixed/min/max fields', () => {
  const table = {
    defaults: {},
    symbols: { star: { frequency: 24, fixed: true }, bar: { frequency: 10, min: 2, max: 20 } },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /star:\s*\{ frequency: 24, fixed: true \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, min: 2, max: 20 \}/);
});
```

Replace with:

```js
test('formatReelFrequencyTablesForCopy still includes fixed/minFrequency/maxFrequency fields', () => {
  const table = {
    defaults: {},
    symbols: { star: { frequency: 24, fixed: true }, bar: { frequency: 10, minFrequency: 2, maxFrequency: 20 } },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /star:\s*\{ frequency: 24, fixed: true \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, minFrequency: 2, maxFrequency: 20 \}/);
});
```

- [ ] **Step 2: Write new failing tests for `minStack`**

Add to `tests/simulationpanel.test.mjs`, after the (now-renamed) test above:

```js
test('formatReelFrequencyTablesForCopy includes minStack on a symbol that sets it', () => {
  const table = { defaults: {}, symbols: { stacked: { frequency: 10, minStack: 3 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /stacked:\s*\{ frequency: 10, minStack: 3 \}/);
});

test('formatReelFrequencyTablesForCopy emits minStack/minFrequency/maxFrequency in a non-empty defaults block', () => {
  const table = { defaults: { minStack: 2, minFrequency: 1, maxFrequency: 50 }, symbols: { bar: { frequency: 10 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /defaults:\s*\{ minStack: 2, minFrequency: 1, maxFrequency: 50 \}/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/simulationpanel.test.mjs`
Expected: the renamed test FAILS (still emitting `min:`/`max:`, not `minFrequency:`/
`maxFrequency:`); the two new tests FAIL (`minStack` isn't emitted anywhere yet).

- [ ] **Step 4: Implement the rename and `minStack` support**

In `core/SimulationPanel.js`, find:

```js
    const defaultsParts = [];
    if (defaults.minGap != null) defaultsParts.push(`minGap: ${defaults.minGap}`);
    if (defaults.maxStack != null) defaultsParts.push(`maxStack: ${defaults.maxStack}`);
    const defaultsLine = `  defaults: { ${defaultsParts.join(', ')} },`;

    const keyWidth = Math.max(...symbols.map(s => s.length + 1));
    const lines = symbols.map(symbol => {
      const entry = symbolsTable[symbol];
      const keyPart = `${symbol}:`.padEnd(keyWidth);
      const minGapPart = entry.minGap != null ? `, minGap: ${entry.minGap}` : '';
      const maxStackPart = entry.maxStack != null ? `, maxStack: ${entry.maxStack}` : '';
      const fixedPart = entry.fixed ? ', fixed: true' : '';
      const minPart = entry.min != null ? `, min: ${entry.min}` : '';
      const maxPart = entry.max != null ? `, max: ${entry.max}` : '';
      return `    ${keyPart} { frequency: ${formatFrequencyForCopy(entry.frequency)}${minGapPart}${maxStackPart}${fixedPart}${minPart}${maxPart} },`;
    });
```

Replace with:

```js
    const defaultsParts = [];
    if (defaults.minGap != null) defaultsParts.push(`minGap: ${defaults.minGap}`);
    if (defaults.maxStack != null) defaultsParts.push(`maxStack: ${defaults.maxStack}`);
    if (defaults.minStack != null) defaultsParts.push(`minStack: ${defaults.minStack}`);
    if (defaults.minFrequency != null) defaultsParts.push(`minFrequency: ${defaults.minFrequency}`);
    if (defaults.maxFrequency != null) defaultsParts.push(`maxFrequency: ${defaults.maxFrequency}`);
    const defaultsLine = `  defaults: { ${defaultsParts.join(', ')} },`;

    const keyWidth = Math.max(...symbols.map(s => s.length + 1));
    const lines = symbols.map(symbol => {
      const entry = symbolsTable[symbol];
      const keyPart = `${symbol}:`.padEnd(keyWidth);
      const minGapPart = entry.minGap != null ? `, minGap: ${entry.minGap}` : '';
      const maxStackPart = entry.maxStack != null ? `, maxStack: ${entry.maxStack}` : '';
      const minStackPart = entry.minStack != null ? `, minStack: ${entry.minStack}` : '';
      const fixedPart = entry.fixed ? ', fixed: true' : '';
      const minPart = entry.minFrequency != null ? `, minFrequency: ${entry.minFrequency}` : '';
      const maxPart = entry.maxFrequency != null ? `, maxFrequency: ${entry.maxFrequency}` : '';
      return `    ${keyPart} { frequency: ${formatFrequencyForCopy(entry.frequency)}${minGapPart}${maxStackPart}${minStackPart}${fixedPart}${minPart}${maxPart} },`;
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/simulationpanel.test.mjs`
Expected: PASS.

- [ ] **Step 6: Add the live table container to the panel's HTML**

Find (in `openTuneFrequenciesPanel`'s template):

```js
      <button id="tune-start-btn" class="btn-close-sim">START TUNING</button>
      <div id="tune-progress-log" style="display: none; margin-top: 12px; max-height: 160px; overflow-y: auto; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;"></div>
      <div id="tune-results"></div>
```

Replace with:

```js
      <button id="tune-start-btn" class="btn-close-sim">START TUNING</button>
      <div id="tune-live-table" style="display: none; margin-top: 12px;"></div>
      <div id="tune-progress-log" style="display: none; margin-top: 12px; max-height: 160px; overflow-y: auto; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;"></div>
      <div id="tune-results"></div>
```

- [ ] **Step 7: Add the live table renderer and wire it into `startTuning`**

Add a new import line for `resolveFrequencyBounds`. Find:

```js
import { tuneFrequencies } from './SpinSimulator.js';
```

Replace with:

```js
import { tuneFrequencies } from './SpinSimulator.js';
import { resolveFrequencyBounds } from './SlotMath.js';
```

Add a new function, placed right before `async function startTuning(...)`:

```js
// Renders the TUNE FREQUENCIES panel's live per-reel table: each value symbol's current
// frequency (from the live candidate being evaluated, or the untouched baseline before Phase 2
// starts moving anything) alongside its resolved min/maxFrequency bounds, so it's visible at a
// glance whether the search is currently inside or outside a symbol's configured range. Bounds
// are static for the whole run (only frequency itself moves), so `boundsByReel` is resolved
// once, before tuning starts, not recomputed on every render.
function renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, liveTrial) {
  let html = `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">`;
  reelFrequencyTables.forEach((baseReelTableWrapper, reelIdx) => {
    const baseReelTable = baseReelTableWrapper.symbols || baseReelTableWrapper;
    const liveReelTable = liveTrial ? (liveTrial[reelIdx].symbols || liveTrial[reelIdx]) : null;
    html += `<div><h4 style="margin: 0 0 4px; font-size: 0.75em; color: #aaa; text-transform: uppercase;">Reel ${reelIdx + 1}</h4>`;
    html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.78em;">`;
    html += `<thead><tr style="color: #888; font-size: 0.75em; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.15);">
                <th style="text-align: left; padding: 2px;">Symbol</th>
                <th style="text-align: right; padding: 2px;">Current</th>
                <th style="text-align: right; padding: 2px;">Min</th>
                <th style="text-align: right; padding: 2px;">Max</th>
              </tr></thead><tbody>`;
    Object.keys(baseReelTable).forEach(symbol => {
      const current = liveReelTable ? liveReelTable[symbol].frequency : baseReelTable[symbol].frequency;
      const { minFrequency, maxFrequency } = boundsByReel[reelIdx][symbol];
      const outOfBounds = (minFrequency != null && current < minFrequency) || (maxFrequency != null && current > maxFrequency);
      const currentColor = outOfBounds ? '#e6b800' : '#ddd';
      html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                  <td style="padding: 2px;">${symbol}</td>
                  <td style="text-align: right; padding: 2px; color: ${currentColor};">${current.toFixed(3)}</td>
                  <td style="text-align: right; padding: 2px; color: #888;">${minFrequency != null ? minFrequency.toFixed(3) : '–'}</td>
                  <td style="text-align: right; padding: 2px; color: #888;">${maxFrequency != null ? maxFrequency.toFixed(3) : '–'}</td>
                </tr>`;
    });
    html += `</tbody></table></div>`;
  });
  html += `</div>`;
  return html;
}
```

- [ ] **Step 8: Resolve bounds once and render the initial table before tuning starts**

Find (in `startTuning`):

```js
  const biasSelects = Array.from({ length: tuneConfig.reelsCount }, (_, r) => tuneContainer.querySelector(`#tune-bias-${r}`));
```

Replace with:

```js
  const biasSelects = Array.from({ length: tuneConfig.reelsCount }, (_, r) => tuneContainer.querySelector(`#tune-bias-${r}`));

  // Resolved once, up front - these bounds don't change during the run, only frequency does.
  const boundsByReel = reelFrequencyTables.map(reelTableWrapper => {
    const symbolsTable = reelTableWrapper.symbols || reelTableWrapper;
    const bounds = {};
    Object.keys(symbolsTable).forEach(symbol => { bounds[symbol] = resolveFrequencyBounds(reelTableWrapper, symbol); });
    return bounds;
  });
  const liveTableEl = tuneContainer.querySelector('#tune-live-table');
```

Find (still in `startTuning`, the setup block that shows/clears the log):

```js
  resultsEl.innerHTML = '';
  logEl.style.display = 'block';
  logEl.innerHTML = '';
```

Replace with:

```js
  resultsEl.innerHTML = '';
  logEl.style.display = 'block';
  logEl.innerHTML = '';
  liveTableEl.style.display = 'block';
  liveTableEl.innerHTML = renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, null);
```

- [ ] **Step 9: Update the table on every Phase 2 iteration**

Find:

```js
      onProgress: (phase, i, mult, r, best) => {
        const label = phase === 'scatter' ? `Scatter frequency ${i + 1}` : `Step ${i + 1}`;
        const multLabel = mult == null ? '' : `  mult=${mult.toFixed(3)}`;
        appendLog(`[${label}]${multLabel}  RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  err=${r.error.toFixed(4)}  (best err=${best.error.toFixed(4)})`);
      }
```

Replace with:

```js
      onProgress: (phase, i, mult, r, best) => {
        const label = phase === 'scatter' ? `Scatter frequency ${i + 1}` : `Step ${i + 1}`;
        const multLabel = mult == null ? '' : `  mult=${mult.toFixed(3)}`;
        appendLog(`[${label}]${multLabel}  RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  err=${r.error.toFixed(4)}  (best err=${best.error.toFixed(4)})`);
        // Only Phase 2 ('shape') carries a full live candidate reel table (r.trial) - Phase 1
        // ('scatter') only ever scales trigger symbols, which are excluded from Phase 2's
        // search entirely, so every value symbol's frequency is still exactly its baseline
        // value during Phase 1 anyway; nothing to update yet.
        if (phase === 'shape' && r.trial) {
          liveTableEl.innerHTML = renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, r.trial);
        }
      }
```

- [ ] **Step 10: Syntax-check**

Run: `node --check core/SimulationPanel.js`
Expected: no output (valid syntax).

- [ ] **Step 11: Manual verification in browser**

Start the dev server (`./serve.ps1` or `npx serve .`), open any game (e.g.
`games/barfruits/index.html`), click TUNE FREQUENCIES, lower Trial Spins/Max Iterations for a
quick run, and click START TUNING. Confirm:
- A live per-reel table appears above the step log immediately (baseline values, before any
  iterations run).
- Once Phase 2 starts, the table's Current column updates every iteration - a symbol carrying a
  `minFrequency`/`maxFrequency` (e.g. `star`/`strawberry` in `games/fruitmachine/game.js`) shows
  Min/Max values, and its Current cell changes color if it drifts outside that range.
- The existing step log and final results table (Achieved RTP, per-reel Current/Suggested/Δ,
  copy-paste output) still render correctly and unchanged.
- The copy-paste output textarea includes `minFrequency`/`maxFrequency` (not `min`/`max`) for
  `star`/`strawberry`.

- [ ] **Step 12: Run the full suite**

Run: `node --test tests/*.mjs`
Expected: All tests PASS.

- [ ] **Step 13: Commit**

```bash
git add core/SimulationPanel.js tests/simulationpanel.test.mjs
git commit -m "feat: live per-symbol frequency table in TUNE FREQUENCIES, rename copy output fields, add minStack"
```

---

## Task 5: Full-suite verification

**Files:** None modified - verification only.

- [ ] **Step 1: Run the full test suite**

Run: `node --test tests/*.mjs`
Expected: All tests pass, except the pre-existing, already-known-unrelated
`tests/barfruits.test.mjs` shape failure (caused by the user's own in-progress uncommitted
`games/barfruits/game.js` frequency edits, confirmed unrelated to this plan in an earlier
session) - if any *other* test fails, that's a real regression from this plan and needs
investigating before considering it complete.

- [ ] **Step 2: Report**

If Step 1 passes (modulo the known pre-existing barfruits failure), the plan is complete.
