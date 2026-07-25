# Per-Symbol Reel Spacing Constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize `generateReel`'s scatter-only min-gap enforcement into two independent,
per-symbol spacing constraints (`minGap`, and new `maxStack`), each settable as a reel-level
default with per-symbol overrides - plus switch free-spin-trigger detection from
`type === 'scatter'` to the paytable's own `triggerFreeSpins` attribute, and give `paymode`
a type-driven default so it no longer has to be written explicitly on every symbol.

**Architecture:** `FREQUENCY_REELn` tables move from a flat `{ symbol: {...} }` map to
`{ defaults: {...}, symbols: { symbol: {...} } }`, with `generateReel` auto-detecting the
shape (a `.symbols` key present vs. absent) so flat legacy callers keep working unchanged.
Per-symbol `minGap`/`maxStack` resolve as symbol override → reel `defaults` → built-in
fallback, with `triggerFreeSpins` supplying `minGap`'s fallback for triggering symbols
specifically. `tuneFrequencies` and `formatReelFrequencyTablesForCopy` read/write through the
new `.symbols` key; `.defaults` passes through untouched.

**Tech Stack:** Plain ES modules, no build step, no new dependency.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-25-reel-spacing-constraints-design.md`
- Backward compatible: a flat (non-`.symbols`-wrapped) table passed to `generateReel` keeps
  working exactly as today (auto-detected, treated as `{ defaults: {}, symbols: table }`).
- `fixed`/`min`/`max` (existing per-symbol tuning fields) are unaffected in meaning - only
  their location moves, from directly under the symbol key to under `symbols[symbol]`.

---

### Task 1: Generalize `generateReel`'s spacing constraints (minGap + new maxStack)

**Files:**
- Modify: `core/SlotMath.js`
- Test: `tests/slotmath.test.mjs`

**Interfaces:**
- Produces: `generateReel(reelWeights, targetLength, seed, exclude = [], defaultTriggerMinGap = 3, paytable = reelWeights)` -
  `reelWeights` is `{ defaults?: { minGap?, maxStack? }, symbols: { symbol: { frequency, minGap?, maxStack?, fixed?, min?, max? } } }`
  or a flat legacy `{ symbol: { frequency, ... } }` (auto-detected by presence of `.symbols`).
  Renamed 5th param (was `minScatterGap`) - now only the fallback gap for a
  `triggerFreeSpins` symbol specifically, not a blanket scatter gap.

- [ ] **Step 1: Write the failing tests**

Replace the two existing "reads scatter type from a separate paytable param" /
"defaults its paytable param" tests in `tests/slotmath.test.mjs` (both currently use
`type: 'scatter'` to trigger spacing - that mechanism is being replaced) and add new ones.
Find this block:

```js
test('generateReel reads scatter type from a separate paytable param, not the weights table', () => {
  // Per-reel frequency tables (games/*/game.js's FREQUENCY_REELn) carry only `.frequency` -
  // no `.type` - so generateReel's scatter min-gap spacing must come from the real paytable
  // passed as the 6th arg, not from the weights table itself.
  const reelWeights = {
    scatter: { frequency: 1 },
    filler:  { frequency: 30 },
  };
  const paytable = {
    scatter: { type: 'scatter' },
    filler:  { type: 'regular' },
  };
  const reel = generateReel(reelWeights, 60, 7, [], 3, paytable);
  // With no `type` info in reelWeights itself, min-gap spacing only takes effect because
  // `paytable` supplies it - verify no two scatters land within the 3-wide gap.
  const positions = reel.reduce((acc, s, i) => { if (s === 'scatter') acc.push(i); return acc; }, []);
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 3, `expected scatter symbols at least 3 apart, got positions ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel defaults its paytable param to the weights table itself (backward compatible)', () => {
  // A caller passing one combined frequency+type table (the old, pre-per-reel-model style)
  // must keep working unchanged - paytable defaults to reelWeights when omitted.
  const combined = {
    scatter: { frequency: 1, type: 'scatter' },
    filler:  { frequency: 30, type: 'regular' },
  };
  const reel = generateReel(combined, 60, 7);
  const positions = reel.reduce((acc, s, i) => { if (s === 'scatter') acc.push(i); return acc; }, []);
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 3, `expected scatter symbols at least 3 apart, got positions ${positions[a]} and ${positions[b]}`);
    }
  }
});
```

Replace it with:

```js
test('generateReel spaces a triggerFreeSpins symbol by its default gap, reading paytable separately', () => {
  // Per-reel frequency tables (games/*/game.js's FREQUENCY_REELn) carry only `.frequency` -
  // spacing for a free-spins-triggering symbol comes from the real paytable's
  // triggerFreeSpins flag, passed as the 6th arg, not from anything on the weights table.
  const reelWeights = {
    scatter: { frequency: 1 },
    filler:  { frequency: 30 },
  };
  const paytable = {
    scatter: { triggerFreeSpins: true },
    filler:  { triggerFreeSpins: false },
  };
  const reel = generateReel(reelWeights, 60, 7, [], 3, paytable);
  const positions = reel.reduce((acc, s, i) => { if (s === 'scatter') acc.push(i); return acc; }, []);
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 3, `expected scatter symbols at least 3 apart, got positions ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel defaults its paytable param to the weights table itself (backward compatible)', () => {
  // A caller passing one combined frequency+triggerFreeSpins table (the old, pre-per-reel
  // model style) must keep working unchanged - paytable defaults to reelWeights when omitted.
  const combined = {
    scatter: { frequency: 1, triggerFreeSpins: true },
    filler:  { frequency: 30, triggerFreeSpins: false },
  };
  const reel = generateReel(combined, 60, 7);
  const positions = reel.reduce((acc, s, i) => { if (s === 'scatter') acc.push(i); return acc; }, []);
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 3, `expected scatter symbols at least 3 apart, got positions ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel applies an explicit per-symbol minGap, structured shape', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      rare:   { frequency: 1, minGap: 6 },
      filler: { frequency: 30 },
    },
  };
  const reel = generateReel(reelWeights, 60, 3);
  const positions = reel.reduce((acc, s, i) => { if (s === 'rare') acc.push(i); return acc; }, []);
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 6, `expected rare at least 6 apart, got ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel applies a reel-level default minGap when a symbol does not override it', () => {
  const reelWeights = {
    defaults: { minGap: 5 },
    symbols: {
      rare:   { frequency: 1 },
      filler: { frequency: 30 },
    },
  };
  const reel = generateReel(reelWeights, 60, 3);
  const positions = reel.reduce((acc, s, i) => { if (s === 'rare') acc.push(i); return acc; }, []);
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 5, `expected rare at least 5 apart (reel default), got ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel lets a per-symbol minGap override the reel default', () => {
  const reelWeights = {
    defaults: { minGap: 2 },
    symbols: {
      rare:   { frequency: 1, minGap: 6 },
      filler: { frequency: 30 },
    },
  };
  const reel = generateReel(reelWeights, 60, 3);
  const positions = reel.reduce((acc, s, i) => { if (s === 'rare') acc.push(i); return acc; }, []);
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 6, `expected rare at least 6 apart (symbol override beats reel default of 2), got ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel caps consecutive runs of a symbol via maxStack', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      common: { frequency: 1, maxStack: 2 },
      filler: { frequency: 1 },
    },
  };
  const reel = generateReel(reelWeights, 60, 11);
  let runLen = 0;
  for (let i = 0; i < reel.length; i++) {
    const idx = i % reel.length;
    const prevIdx = (i - 1 + reel.length) % reel.length;
    runLen = (reel[idx] === 'common' && reel[prevIdx] === 'common') ? runLen + 1 : (reel[idx] === 'common' ? 1 : 0);
    assert.ok(runLen <= 2, `expected no run of "common" longer than 2, found a run at position ${idx}`);
  }
});

test('generateReel treats a table with no .symbols key as a flat legacy symbol map', () => {
  const flat = { a: { frequency: 10 }, b: { frequency: 1 } };
  const reel = generateReel(flat, 50, 5);
  assert.ok(reel.includes('a'));
  assert.ok(reel.includes('b'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/slotmath.test.mjs`
Expected: the new/changed tests FAIL (structured `{ defaults, symbols }` shape and
`maxStack` don't exist yet; `triggerFreeSpins`-based spacing isn't implemented).

- [ ] **Step 3: Rewrite `generateReel`**

Replace the entire current `generateReel` function (from `export function generateReel(...)`
through its closing brace, including the nested `_shuffle` and `_enforceMinScatterGap`
helpers) with:

```js
/**
 * Builds one weighted reel strip, with optional per-symbol spacing constraints.
 *
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
 *
 * @param {Object} reelWeights - This reel's own weights (see shape above).
 * @param {number} targetLength - Desired reel strip length.
 * @param {number} seed - RNG seed for the shuffle and constraint repairs (deterministic).
 * @param {string[]} [exclude=[]] - Symbols to omit from this reel entirely.
 * @param {number} [defaultTriggerMinGap=3] - Fallback `minGap` for a symbol with
 *   `paytable[symbol].triggerFreeSpins === true`, when neither the symbol nor the reel's
 *   `defaults` specify one.
 * @param {Object} [paytable=reelWeights] - Rules table read only for `.triggerFreeSpins` -
 *   defaults to `reelWeights` itself so a caller passing one flat combined table (frequency +
 *   triggerFreeSpins together) keeps working unchanged. A per-reel weights table (which
 *   carries neither) needs the real canonical paytable passed here explicitly instead.
 * @returns {string[]} The built reel strip (symbol names, length ~targetLength).
 */
export function generateReel(reelWeights, targetLength, seed, exclude=[], defaultTriggerMinGap=3, paytable=reelWeights) {
  const symbolsTable = reelWeights.symbols || reelWeights;
  const reelDefaults = reelWeights.defaults || {};

  function _shuffle(array, rng) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // A plain weighted shuffle can, by chance, place two occurrences of the same
  // minGap-constrained symbol within `minGap` positions of each other. Spread them out so no
  // two ever land within that circular distance.
  function _enforceMinGap(reel, symbol, minGap, rng) {
    const n = reel.length;
    if (n === 0 || minGap <= 1) return reel;
    const circularDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n - d); };

    for (let pass = 0; pass < n; pass++) {
      const positions = [];
      for (let i = 0; i < n; i++) if (reel[i] === symbol) positions.push(i);
      if (positions.length <= 1) return reel;

      let violation = null;
      for (let a = 0; a < positions.length && !violation; a++) {
        for (let b = a + 1; b < positions.length; b++) {
          if (circularDist(positions[a], positions[b]) < minGap) {
            violation = { moveFrom: positions[b], keep: positions.filter((_, idx) => idx !== b) };
            break;
          }
        }
      }
      if (!violation) return reel;

      const candidates = [];
      for (let k = 0; k < n; k++) {
        if (reel[k] === symbol) continue;
        if (violation.keep.every(p => circularDist(k, p) >= minGap)) candidates.push(k);
      }
      if (candidates.length === 0) return reel; // reel too dense to fully space out; best effort

      const swapIdx = candidates[Math.floor(rng() * candidates.length)];
      [reel[violation.moveFrom], reel[swapIdx]] = [reel[swapIdx], reel[violation.moveFrom]];
    }
    return reel;
  }

  // Caps how many times `symbol` can appear consecutively (circularly) in a row. Finds a
  // "seam" (a position where the run breaks) to scan linearly from, since the strip wraps -
  // if the whole reel is one symbol, there's no seam and nothing to do (best effort).
  function _enforceMaxStack(reel, symbol, maxStack, rng) {
    const n = reel.length;
    if (n === 0 || maxStack >= n) return reel;

    for (let pass = 0; pass < n; pass++) {
      let seam = -1;
      for (let i = 0; i < n; i++) {
        if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; }
      }
      if (seam === -1) return reel; // entire reel is one symbol - best effort, give up

      let violation = null;
      let i = 0;
      while (i < n) {
        const idx = (seam + i) % n;
        if (reel[idx] === symbol) {
          let runLen = 1;
          while (runLen < n && reel[(seam + i + runLen) % n] === symbol) runLen++;
          if (runLen > maxStack) { violation = { start: i }; break; }
          i += runLen;
        } else {
          i++;
        }
      }
      if (!violation) return reel;

      const excessIdx = (seam + violation.start + maxStack) % n;
      const candidates = [];
      for (let k = 0; k < n; k++) { if (reel[k] !== symbol) candidates.push(k); }
      if (candidates.length === 0) return reel; // nothing to swap with - best effort

      const swapIdx = candidates[Math.floor(rng() * candidates.length)];
      [reel[excessIdx], reel[swapIdx]] = [reel[swapIdx], reel[excessIdx]];
    }
    return reel;
  }

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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/slotmath.test.mjs`
Expected: PASS. If the maxStack test is flaky (a specific seed happening not to produce any
initial violation, making the test trivially pass without exercising the enforcement code),
try a different seed or lower `filler`'s relative weight until it reliably starts with at
least one run longer than 2 pre-enforcement.

- [ ] **Step 5: Commit**

```bash
git add core/SlotMath.js tests/slotmath.test.mjs
git commit -m "feat: generalize generateReel's spacing to per-symbol minGap and maxStack"
```

---

### Task 2: `paymode` defaults to 'any' for scatter-typed symbols, 'line' otherwise

**Files:**
- Modify: `core/SlotMath.js`
- Test: `tests/slotmath.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `checkWins`'s line-win gating now tolerates an omitted `paymode` field.

- [ ] **Step 1: Write the failing tests**

Add to `tests/slotmath.test.mjs`, near the existing `checkWins` tests:

```js
test('checkWins pays a line win when paymode is omitted (defaults to line)', () => {
  const grid3x3 = [
    ['a', 'a', 'a'],
    ['a', 'a', 'a'],
    ['a', 'a', 'a'],
  ];
  const paylines3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
  const paytable3 = { a: { payout: [0, 0, 5] } }; // no paymode field at all
  const result = checkWins(grid3x3, paytable3, paylines3, 3, null, null);
  assert.equal(result.lineWins.length, 3);
  assert.equal(result.totalLinePayoutMultiplier, 15);
});

test('checkWins does not pay a scatter-typed symbol as a line win when paymode is omitted (defaults to any)', () => {
  const grid3x3 = [
    ['s', 's', 's'],
    ['s', 's', 's'],
    ['s', 's', 's'],
  ];
  const paylines3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
  const paytable3 = { s: { payout: [0, 0, 10, 0, 0], type: 'scatter' } }; // no paymode field
  const result = checkWins(grid3x3, paytable3, paylines3, 3, null, 's');
  assert.equal(result.lineWins.length, 0, 'a scatter-typed symbol with implicit paymode "any" must not be paid as a line win');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/slotmath.test.mjs`
Expected: the first new test FAILS (currently `paymode` has no default at all, so an omitted
`paymode` never gates as `'line'`, and `lineWins.length` would be `0` instead of `3`); the
second currently passes by coincidence (no `paymode` also means it's not `'line'` today) but
is added now as a lock-in guard against a naive fix that makes everything default to `'line'`.

- [ ] **Step 3: Implement the default**

In `checkWins`, find:

```js
    const targetMeta = targetSymbol && paytable[targetSymbol];
    if (targetSymbol && targetSymbol !== wildSymbol && targetMeta && targetMeta.paymode === 'line') {
```

Replace with:

```js
    const targetMeta = targetSymbol && paytable[targetSymbol];
    // paymode defaults to 'any' for a scatter-typed symbol (it's paid separately below, not
    // per-line) and 'line' otherwise - only needs to be written explicitly to override that.
    const paymode = targetMeta && (targetMeta.paymode ?? (targetMeta.type === 'scatter' ? 'any' : 'line'));
    if (targetSymbol && targetSymbol !== wildSymbol && targetMeta && paymode === 'line') {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/slotmath.test.mjs`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add core/SlotMath.js tests/slotmath.test.mjs
git commit -m "feat: default paymode to 'any' for scatter-typed symbols, 'line' otherwise"
```

---

### Task 3: Update `tuneFrequencies` for the new reel struct + `triggerFreeSpins`-based Phase 1

**Files:**
- Modify: `core/SpinSimulator.js`
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: `generateReel` (Task 1's new signature/shape-handling).
- Produces: `tuneFrequencies`'s `reelFrequencyTables` param/return now uses the
  `{ defaults, symbols }` shape; `.defaults` passes through untouched (Phase 1/2 only ever
  write into `.symbols`). Phase 1's free-spin symbol detection now reads
  `paytable[s].triggerFreeSpins === true` instead of `paytable[s].type === 'scatter'`.

- [ ] **Step 1: Update the reel-table literals in every existing test**

In `tests/tunefrequencies.test.mjs`, every test currently imports and uses
`FREQUENCY_REEL1/2/3` from `games/fruitmachine/game.js` directly (`REEL_TABLES = [...]`) -
once Task 5 migrates those exports to the new `{ defaults, symbols }` shape, these tests
automatically pick it up with no changes needed *except* the two tests that build their own
ad-hoc reel table literals inline:

Find (the `fixed: true` test):
```js
  const reelTablesWithFixedBar = [
    { ...FREQUENCY_REEL1, bar: { ...FREQUENCY_REEL1.bar, fixed: true } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
```
Replace with:
```js
  const reelTablesWithFixedBar = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, fixed: true } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
```
And later in that same test:
```js
  assert.equal(reelFrequencyTables[0].bar.frequency, FREQUENCY_REEL1.bar.frequency,
```
Replace with:
```js
  assert.equal(reelFrequencyTables[0].symbols.bar.frequency, FREQUENCY_REEL1.symbols.bar.frequency,
```

Find (the `limitPenaltyWeight` test):
```js
  const cap = FREQUENCY_REEL1.bar.frequency / 2;
  const cappedTables = [
    { ...FREQUENCY_REEL1, bar: { ...FREQUENCY_REEL1.bar, max: cap } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
```
Replace with:
```js
  const cap = FREQUENCY_REEL1.symbols.bar.frequency / 2;
  const cappedTables = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, max: cap } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
```
And:
```js
  assert.ok(reelFrequencyTables[0].bar.frequency <= cap + 2,
    `expected bar's frequency to stay close to its soft cap of ${cap}, got ${reelFrequencyTables[0].bar.frequency}`);
```
Replace with:
```js
  assert.ok(reelFrequencyTables[0].symbols.bar.frequency <= cap + 2,
    `expected bar's frequency to stay close to its soft cap of ${cap}, got ${reelFrequencyTables[0].symbols.bar.frequency}`);
```

Find (zero-frequency test):
```js
  assert.equal(reelFrequencyTables[0].star.frequency, 0);
  assert.equal(reelFrequencyTables[0].strawberry.frequency, 0);
  assert.equal(reelFrequencyTables[1].star.frequency, 0);
  assert.equal(reelFrequencyTables[1].strawberry.frequency, 0);
```
Replace with:
```js
  assert.equal(reelFrequencyTables[0].symbols.star.frequency, 0);
  assert.equal(reelFrequencyTables[0].symbols.strawberry.frequency, 0);
  assert.equal(reelFrequencyTables[1].symbols.star.frequency, 0);
  assert.equal(reelFrequencyTables[1].symbols.strawberry.frequency, 0);
```

Find (bias-reversed test):
```js
  const reversedReel = reelFrequencyTables[1];
  assert.ok(reversedReel.bar.frequency >= reversedReel.cherries.frequency,
    `expected bar (highest pay) >= cherries (lowest tier) on the bias-reversed reel, got bar=${reversedReel.bar.frequency} cherries=${reversedReel.cherries.frequency}`);
```
Replace with:
```js
  const reversedReel = reelFrequencyTables[1].symbols;
  assert.ok(reversedReel.bar.frequency >= reversedReel.cherries.frequency,
    `expected bar (highest pay) >= cherries (lowest tier) on the bias-reversed reel, got bar=${reversedReel.bar.frequency} cherries=${reversedReel.cherries.frequency}`);
```

- [ ] **Step 2: Add a `triggerFreeSpins`-based Phase 1 test**

Add a new test confirming the detection switch (uses `PAYTABLE`/`REEL_TABLES` fixtures
already imported at the top of the file):

```js
test('tuneFrequencies\' scatter phase keys off triggerFreeSpins, not type', async () => {
  // A type: 'scatter' symbol with triggerFreeSpins: false must NOT be scaled by Phase 1;
  // conversely (not tested here, since fruitmachine/bookbookbook always agree on the two),
  // this only proves the filter reads triggerFreeSpins rather than type.
  const paytableWithMismatch = {
    ...PAYTABLE,
    bar: { ...PAYTABLE.bar, type: 'scatter', triggerFreeSpins: false },
  };
  const { diagnostics } = await tuneFrequencies(paytableWithMismatch, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 3,
  });
  // No symbol in this paytable actually has triggerFreeSpins: true, so Phase 1 must be a
  // no-op (scatterPhase null) even though `bar` is type: 'scatter'.
  assert.equal(diagnostics.scatterPhase, null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: FAIL (reel tables are still flat in `games/fruitmachine/game.js` at this point in
the plan - Task 5 hasn't run yet - and `tuneFrequencies` itself hasn't been updated yet
either). This is expected; proceed to Step 4.

- [ ] **Step 4: Update `tuneFrequencies`**

In `core/SpinSimulator.js`, rename `scatterSymbols` to `triggerSymbols` throughout and switch
its filter. Find:

```js
  const scatterSymbols = Object.keys(paytable).filter(s => paytable[s].type === 'scatter');
```
Replace with:
```js
  const triggerSymbols = Object.keys(paytable).filter(s => paytable[s].triggerFreeSpins === true);
```

Find (Phase 1's `if` and `buildTrial`):
```js
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
```
Replace with:
```js
  if (triggerSymbols.length > 0) {
    scatterPhase = await gradientDescent1D({
      initialParam: 1,
      minParam: 0.05,
      maxParam: 8,
      target: targetTriggerRatePct,
      tolerance: triggerRateTolerancePct,
      buildTrial: (mult) => baseReelTables.map(rt => {
        const trial = JSON.parse(JSON.stringify(rt));
        triggerSymbols.forEach(s => { if (trial.symbols[s]) trial.symbols[s].frequency = rt.symbols[s].frequency * mult; });
        return trial;
      }),
```

Find (Phase 2 dims-building):
```js
  const isFixed = (reelTable, s) => reelTable[s].fixed === true;
  currentReelTables.forEach((reelTable, r) => {
    const nonScatterSymbols = Object.keys(reelTable).filter(s => !scatterSymbols.includes(s) && reelTable[s].frequency > 0);
    const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);
    const fixedShapeSymbols = nonScatterSymbols.filter(s => isFixed(reelTable, s));
    const valueSymbols = nonScatterSymbols.filter(s => !isFixed(reelTable, s));
    const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + reelTable[s].frequency, 0);
    const valueBudget = nonScatterTotal - fixedShapeTotal;
    valueBudgetByReel[r] = valueBudget;
    tierOfByReel[r] = computeValueRanks(paytable, valueSymbols);
    if (valueSymbols.length > 0 && valueBudget > 0) {
      valueSymbols.forEach(s => dims.push({ reelIndex: r, symbol: s, min: reelTable[s].min, max: reelTable[s].max }));
    }
  });
```
Replace with:
```js
  const isFixed = (symbolsTable, s) => symbolsTable[s].fixed === true;
  currentReelTables.forEach((reelTable, r) => {
    const symbolsTable = reelTable.symbols;
    const nonScatterSymbols = Object.keys(symbolsTable).filter(s => !triggerSymbols.includes(s) && symbolsTable[s].frequency > 0);
    const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
    const fixedShapeSymbols = nonScatterSymbols.filter(s => isFixed(symbolsTable, s));
    const valueSymbols = nonScatterSymbols.filter(s => !isFixed(symbolsTable, s));
    const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
    const valueBudget = nonScatterTotal - fixedShapeTotal;
    valueBudgetByReel[r] = valueBudget;
    tierOfByReel[r] = computeValueRanks(paytable, valueSymbols);
    if (valueSymbols.length > 0 && valueBudget > 0) {
      valueSymbols.forEach(s => dims.push({ reelIndex: r, symbol: s, min: symbolsTable[s].min, max: symbolsTable[s].max }));
    }
  });
```

Find (`initialPoint`/`dimBounds`):
```js
    const initialPoint = dims.map(d => Math.log(currentReelTables[d.reelIndex][d.symbol].frequency));
    // Generous per-dimension bounds (relative to that dimension's own starting frequency,
    // not a shared absolute range) - wide enough to not artificially constrain the search,
    // just enough to keep the simplex from drifting to a degenerate near-zero or runaway
    // value on a reel whose other symbols have a very different scale.
    const dimBounds = dims.map(d => {
      const base = currentReelTables[d.reelIndex][d.symbol].frequency;
      return { minX: Math.log(base * 0.001), maxX: Math.log(base * 1000) };
    });
```
Replace with:
```js
    const initialPoint = dims.map(d => Math.log(currentReelTables[d.reelIndex].symbols[d.symbol].frequency));
    // Generous per-dimension bounds (relative to that dimension's own starting frequency,
    // not a shared absolute range) - wide enough to not artificially constrain the search,
    // just enough to keep the simplex from drifting to a degenerate near-zero or runaway
    // value on a reel whose other symbols have a very different scale.
    const dimBounds = dims.map(d => {
      const base = currentReelTables[d.reelIndex].symbols[d.symbol].frequency;
      return { minX: Math.log(base * 0.001), maxX: Math.log(base * 1000) };
    });
```

Find (`projectPoint`'s write-back):
```js
      Object.keys(rawByReel).forEach(rIdxStr => {
        const rIdx = Number(rIdxStr);
        const renormalized = renormalizeWeights(rawByReel[rIdx], valueBudgetByReel[rIdx]);
        Object.keys(renormalized).forEach(s => { reelTables[rIdx][s].frequency = renormalized[s]; });
      });
```
Replace with:
```js
      Object.keys(rawByReel).forEach(rIdxStr => {
        const rIdx = Number(rIdxStr);
        const renormalized = renormalizeWeights(rawByReel[rIdx], valueBudgetByReel[rIdx]);
        Object.keys(renormalized).forEach(s => { reelTables[rIdx].symbols[s].frequency = renormalized[s]; });
      });
```

Find (`orderingPenaltyOf`):
```js
          const diff = bias * (reelTables[r][b].frequency - reelTables[r][a].frequency);
```
Replace with:
```js
          const diff = bias * (reelTables[r].symbols[b].frequency - reelTables[r].symbols[a].frequency);
```

Find (`limitPenaltyOf`):
```js
      dims.forEach(({ reelIndex: r, symbol: s, min, max }) => {
        const freq = reelTables[r][s].frequency;
```
Replace with:
```js
      dims.forEach(({ reelIndex: r, symbol: s, min, max }) => {
        const freq = reelTables[r].symbols[s].frequency;
```

Finally, update `reelFrequencyTables`'s JSDoc (the `@param {Object[]} reelFrequencyTables`
block) to describe the new `{ defaults, symbols }` shape instead of the flat one, and update
the doc comment mentioning "`scatterSymbols`"/`type === 'scatter'` wherever it appears in this
function's surrounding comments (Phase 1's block comment, and the strategy bullet list in the
main JSDoc above `tuneFrequencies`) to say `triggerFreeSpins` instead.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: still FAIL at this point, because `games/fruitmachine/game.js`'s
`FREQUENCY_REEL1/2/3` (which most of these tests import directly) are still in the old flat
shape - Task 5 migrates them. That's fine; proceed to Task 4, then Task 5, then return here
to confirm.

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "refactor: read tuneFrequencies' reel tables through .symbols, trigger phase by triggerFreeSpins"
```

---

### Task 4: Update `core/SimulationPanel.js` for the new reel struct

**Files:**
- Modify: `core/SimulationPanel.js`
- Test: `tests/simulationpanel.test.mjs`

**Interfaces:**
- Consumes: `formatReelFrequencyTablesForCopy`'s input/output shape.

- [ ] **Step 1: Update `formatReelFrequencyTablesForCopy`'s existing tests**

In `tests/simulationpanel.test.mjs`, every test currently builds a flat `{ symbol: {...} }`
table literal. Wrap each in `{ defaults: {...}, symbols: {...} }`. Find:

```js
test('formatReelFrequencyTablesForCopy preserves distinct small frequencies instead of collapsing them', () => {
  // Reproduces the bookbookbook bug: several genuinely distinct tuned frequencies under 1
  // all rounded to the same fixed-1-decimal-place value ("0.1" or "0.2"), silently
  // corrupting the tuned result once pasted back into game.js - book (0.051) and explorer
  // (0.079) both became "0.1", a symbol nearly 2x rarer than another reading back as
  // identical. That collapse of book's frequency alone was enough to blow RTP up to ~390%.
  const table = {
    book:     { frequency: 0.051 },
    explorer: { frequency: 0.079 },
    tut:      { frequency: 0.157 },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /book:\s*\{ frequency: 0\.051 \}/);
  assert.match(output, /explorer:\s*\{ frequency: 0\.079 \}/);
  assert.match(output, /tut:\s*\{ frequency: 0\.157 \}/);
});

test('formatReelFrequencyTablesForCopy still reads cleanly for larger fruitmachine-scale frequencies', () => {
  const table = { bar: { frequency: 25.3 }, clover: { frequency: 8 } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /bar:\s*\{ frequency: 25\.3 \}/);
  assert.match(output, /clover:\s*\{ frequency: 8 \}/);
});

test('formatReelFrequencyTablesForCopy still includes fixed/min/max fields', () => {
  const table = { star: { frequency: 24, fixed: true }, bar: { frequency: 10, min: 2, max: 20 } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /star:\s*\{ frequency: 24, fixed: true \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, min: 2, max: 20 \}/);
});
```

Replace with:

```js
test('formatReelFrequencyTablesForCopy preserves distinct small frequencies instead of collapsing them', () => {
  // Reproduces the bookbookbook bug: several genuinely distinct tuned frequencies under 1
  // all rounded to the same fixed-1-decimal-place value ("0.1" or "0.2"), silently
  // corrupting the tuned result once pasted back into game.js - book (0.051) and explorer
  // (0.079) both became "0.1", a symbol nearly 2x rarer than another reading back as
  // identical. That collapse of book's frequency alone was enough to blow RTP up to ~390%.
  const table = {
    defaults: {},
    symbols: {
      book:     { frequency: 0.051 },
      explorer: { frequency: 0.079 },
      tut:      { frequency: 0.157 },
    },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /book:\s*\{ frequency: 0\.051 \}/);
  assert.match(output, /explorer:\s*\{ frequency: 0\.079 \}/);
  assert.match(output, /tut:\s*\{ frequency: 0\.157 \}/);
});

test('formatReelFrequencyTablesForCopy still reads cleanly for larger fruitmachine-scale frequencies', () => {
  const table = { defaults: {}, symbols: { bar: { frequency: 25.3 }, clover: { frequency: 8 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /bar:\s*\{ frequency: 25\.3 \}/);
  assert.match(output, /clover:\s*\{ frequency: 8 \}/);
});

test('formatReelFrequencyTablesForCopy still includes fixed/min/max fields', () => {
  const table = {
    defaults: {},
    symbols: { star: { frequency: 24, fixed: true }, bar: { frequency: 10, min: 2, max: 20 } },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /star:\s*\{ frequency: 24, fixed: true \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, min: 2, max: 20 \}/);
});

test('formatReelFrequencyTablesForCopy emits a non-empty defaults block', () => {
  const table = { defaults: { minGap: 4, maxStack: 2 }, symbols: { bar: { frequency: 10 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /defaults:\s*\{ minGap: 4, maxStack: 2 \}/);
});

test('formatReelFrequencyTablesForCopy includes minGap/maxStack on a symbol that overrides them', () => {
  const table = { defaults: {}, symbols: { book: { frequency: 0.051, minGap: 5 }, bar: { frequency: 10, maxStack: 1 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /book:\s*\{ frequency: 0\.051, minGap: 5 \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, maxStack: 1 \}/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/simulationpanel.test.mjs`
Expected: FAIL (`formatReelFrequencyTablesForCopy` doesn't understand the new shape yet).

- [ ] **Step 3: Rewrite `formatReelFrequencyTablesForCopy`**

Replace:

```js
export function formatReelFrequencyTablesForCopy(reelFrequencyTables) {
  return reelFrequencyTables.map((table, i) => {
    const symbols = Object.keys(table);
    if (symbols.length === 0) return `export const FREQUENCY_REEL${i + 1} = {};`;

    const keyWidth = Math.max(...symbols.map(s => s.length + 1));
    const lines = symbols.map(symbol => {
      const keyPart = `${symbol}:`.padEnd(keyWidth);
      const fixedPart = table[symbol].fixed ? ', fixed: true' : '';
      const minPart = table[symbol].min != null ? `, min: ${table[symbol].min}` : '';
      const maxPart = table[symbol].max != null ? `, max: ${table[symbol].max}` : '';
      return `  ${keyPart} { frequency: ${formatFrequencyForCopy(table[symbol].frequency)}${fixedPart}${minPart}${maxPart} },`;
    });
    return `export const FREQUENCY_REEL${i + 1} = {\n${lines.join('\n')}\n};`;
  }).join('\n\n');
}
```

With:

```js
export function formatReelFrequencyTablesForCopy(reelFrequencyTables) {
  return reelFrequencyTables.map((table, i) => {
    const defaults = table.defaults || {};
    const symbolsTable = table.symbols || table;
    const symbols = Object.keys(symbolsTable);
    if (symbols.length === 0) return `export const FREQUENCY_REEL${i + 1} = {\n  defaults: {},\n  symbols: {},\n};`;

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
    return `export const FREQUENCY_REEL${i + 1} = {\n${defaultsLine}\n  symbols: {\n${lines.join('\n')}\n  },\n};`;
  }).join('\n\n');
}
```

(Note the `defaults: {}` empty-object case: `defaultsParts.join(', ')` on an empty array
gives `''`, so `{ ${''} }` renders as `{  }` - acceptably readable, matches the pattern used
elsewhere in this function for omitted optional fields.)

- [ ] **Step 4: Run the copy-format tests to verify they pass**

Run: `node --test tests/simulationpanel.test.mjs`
Expected: PASS.

- [ ] **Step 5: Update the results-table rendering in `startTuning`**

In `core/SimulationPanel.js`, find:

```js
    reelFrequencyTables.forEach((baseReelTable, reelIdx) => {
      const tunedReelTable = tunedReelTables[reelIdx];
```

Replace with:

```js
    reelFrequencyTables.forEach((baseReelTableWrapper, reelIdx) => {
      const baseReelTable = baseReelTableWrapper.symbols || baseReelTableWrapper;
      const tunedReelTable = (tunedReelTables[reelIdx].symbols || tunedReelTables[reelIdx]);
```

(Tolerates either shape defensively, matching `formatReelFrequencyTablesForCopy`'s own
auto-detection, since `reelFrequencyTables` here is whatever the caller's `game.js` passed in
and `tunedReelTables` is `tuneFrequencies`' own return value - both should always be the
structured shape after Task 5, but this keeps the panel from hard-crashing if a caller still
passes something flat.)

- [ ] **Step 6: Syntax-check**

Run: `node --check core/SimulationPanel.js`
Expected: no output (valid syntax).

- [ ] **Step 7: Commit**

```bash
git add core/SimulationPanel.js tests/simulationpanel.test.mjs
git commit -m "refactor: read/write the tuner UI's reel tables through the new defaults/symbols shape"
```

---

### Task 5: Migrate both games' `FREQUENCY_REELn` exports to the new shape

**Files:**
- Modify: `games/fruitmachine/game.js`
- Modify: `games/bookbookbook/game.js`

**Interfaces:**
- Consumes: `generateReel` (Task 1), `tuneFrequencies`/`openTuneFrequenciesPanel` (Tasks 3-4).

- [ ] **Step 1: Migrate `games/fruitmachine/game.js`**

Replace the `FREQUENCY_REEL1`/`FREQUENCY_REEL2`/`FREQUENCY_REEL3` block (current exact
values - preserve every number and every existing `fixed`/`min`/`max` exactly, only adding
the `defaults`/`symbols` wrapper) with:

```js
// Frequency tables for each reel. These are based on the actual symbol weights used in the
// original machines. `fixed: true` marks a symbol as excluded from TUNE FREQUENCIES' Phase 2
// search on that specific reel (its frequency there is never touched) - star and strawberry
// are wild symbols and are always meant to stay fixed, independent of payout ordering.
// `defaults` holds this reel's fallback minGap/maxStack (empty here - fruitmachine has no
// symbol that needs spacing/stacking constraints); a symbol can override either under its
// own entry in `symbols`. Note that REEL_1 does not contain the star or strawberry symbols.
export const FREQUENCY_REEL1 = {
  defaults: {},
  symbols: {
    bar:        { frequency: 24.5 },
    clover:     { frequency: 20.1 },
    pear:       { frequency: 13.2 },
    melon:      { frequency: 17.6 },
    grapes:     { frequency: 3.5 },
    plum:       { frequency: 10.1 },
    orange:     { frequency: 3.5 },
    cherries:   { frequency: 3.5 },
    star:       { frequency: 0.0, fixed: true },
    strawberry: { frequency: 0.0, fixed: true },
  },
};

export const FREQUENCY_REEL2 = {
  defaults: {},
  symbols: {
    bar:        { frequency: 8.9 },
    clover:     { frequency: 10.5 },
    pear:       { frequency: 10.5 },
    melon:      { frequency: 11.7 },
    grapes:     { frequency: 12.3 },
    plum:       { frequency: 13.0 },
    orange:     { frequency: 13.6 },
    cherries:   { frequency: 15.5 },
    star:       { frequency: 0.0, fixed: true },
    strawberry: { frequency: 0.0, fixed: true },
  },
};

export const FREQUENCY_REEL3 = {
  defaults: {},
  symbols: {
    bar:        { frequency: 22.8 },
    clover:     { frequency: 14.3 },
    pear:       { frequency: 6.2 },
    melon:      { frequency: 18.0 },
    grapes:     { frequency: 3.3 },
    plum:       { frequency: 9.7 },
    orange:     { frequency: 3.8 },
    cherries:   { frequency: 3.3 },
    star:       { frequency: 28.3, min: 20, max: 30 },
    strawberry: { frequency: 6.3, min: 2, max: 6 },
  },
};
```

`REEL_STRIPS`'s construction (`generateReel(FREQUENCY_REEL1, REEL_LENGTH, REEL_SEEDS[0])`,
etc.) does not need to change - `generateReel` auto-detects the new `.symbols`-bearing shape.

- [ ] **Step 2: Migrate `games/bookbookbook/game.js`**

Replace the `FREQUENCY_REEL1`...`FREQUENCY_REEL5` block (current exact values) with:

```js
// Frequency tables for each reel. Every reel starts out identical (same numbers the flat
// PAYTABLE.frequency used to carry) so this migration doesn't change RTP/trigger-rate by
// itself - a pure data-model refactor. Differentiate them per reel via TUNE FREQUENCIES
// (per-reel ordering preference, fixed, min/max, minGap, maxStack) same as fruitmachine.
// `defaults` is empty on every reel here - `book`'s spacing comes entirely from
// generateReel's own triggerFreeSpins-based fallback (see its doc in core/SlotMath.js),
// reading PAYTABLE.book.triggerFreeSpins (passed as the 6th arg to generateReel below), not
// from anything in these tables. Don't be surprised if TUNE FREQUENCIES leaves `book`'s
// frequency completely unchanged on every reel - that's expected here, not a bug: see the
// Phase 1 comment above tuneFrequencies() in core/SpinSimulator.js. In short, book's baseline
// trigger rate (~0.57%) already sits inside the tuner's default target band (0.6% +/- 0.15),
// so there's nothing for that phase to correct.
const FREQUENCY_REEL1 = {
  defaults: {},
  symbols: {
    book:     { frequency: 0.051 },
    explorer: { frequency: 0.079 },
    tut:      { frequency: 0.157 },
    anubis:   { frequency: 0.234 },
    scarab:   { frequency: 0.234 },
    ace:      { frequency: 0.201 },
    king:     { frequency: 0.201 },
    queen:    { frequency: 0.201 },
    jack:     { frequency: 0.201 },
    ten:      { frequency: 0.201 },
  },
};
const FREQUENCY_REEL2 = {
  defaults: {},
  symbols: {
    book:     { frequency: 0.051 },
    explorer: { frequency: 0.079 },
    tut:      { frequency: 0.157 },
    anubis:   { frequency: 0.234 },
    scarab:   { frequency: 0.234 },
    ace:      { frequency: 0.201 },
    king:     { frequency: 0.201 },
    queen:    { frequency: 0.201 },
    jack:     { frequency: 0.201 },
    ten:      { frequency: 0.201 },
  },
};
const FREQUENCY_REEL3 = {
  defaults: {},
  symbols: {
    book:     { frequency: 0.051 },
    explorer: { frequency: 0.079 },
    tut:      { frequency: 0.157 },
    anubis:   { frequency: 0.234 },
    scarab:   { frequency: 0.234 },
    ace:      { frequency: 0.201 },
    king:     { frequency: 0.201 },
    queen:    { frequency: 0.201 },
    jack:     { frequency: 0.201 },
    ten:      { frequency: 0.201 },
  },
};
const FREQUENCY_REEL4 = {
  defaults: {},
  symbols: {
    book:     { frequency: 0.051 },
    explorer: { frequency: 0.079 },
    tut:      { frequency: 0.157 },
    anubis:   { frequency: 0.234 },
    scarab:   { frequency: 0.234 },
    ace:      { frequency: 0.201 },
    king:     { frequency: 0.201 },
    queen:    { frequency: 0.201 },
    jack:     { frequency: 0.201 },
    ten:      { frequency: 0.201 },
  },
};
const FREQUENCY_REEL5 = {
  defaults: {},
  symbols: {
    book:     { frequency: 0.051 },
    explorer: { frequency: 0.079 },
    tut:      { frequency: 0.157 },
    anubis:   { frequency: 0.234 },
    scarab:   { frequency: 0.234 },
    ace:      { frequency: 0.201 },
    king:     { frequency: 0.201 },
    queen:    { frequency: 0.201 },
    jack:     { frequency: 0.201 },
    ten:      { frequency: 0.201 },
  },
};
const FREQUENCY_REELS = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3, FREQUENCY_REEL4, FREQUENCY_REEL5];
```

`REEL_STRIPS`'s construction line already passes `PAYTABLE` as the 6th arg
(`generateReel(freqTable, REEL_LENGTH, REEL_SEEDS[i], [], 3, PAYTABLE)`) - unchanged, still
correct (that 5th positional `3` is now `defaultTriggerMinGap`, same value, same effect for
`book` since `PAYTABLE.book.triggerFreeSpins === true`).

- [ ] **Step 3: Syntax-check both files**

Run: `node --check games/fruitmachine/game.js && node --check games/bookbookbook/game.js`
Expected: no output (valid syntax).

- [ ] **Step 4: Write and run a behavior-preservation verification script**

Create `verify-reel-migration.mjs` at the repo root (throwaway - delete in Step 5):

```js
import { generateReel } from './core/SlotMath.js';

// Old flat shape (pre-migration) vs new structured shape (post-migration) for one
// representative symbol set per game, confirming the migration didn't change output.
const REEL_LENGTH = 500;

const oldFruit1 = {
  bar: { frequency: 24.5 }, clover: { frequency: 20.1 }, pear: { frequency: 13.2 },
  melon: { frequency: 17.6 }, grapes: { frequency: 3.5 }, plum: { frequency: 10.1 },
  orange: { frequency: 3.5 }, cherries: { frequency: 3.5 },
  star: { frequency: 0.0, fixed: true }, strawberry: { frequency: 0.0, fixed: true },
};
const newFruit1 = { defaults: {}, symbols: oldFruit1 };
const a = generateReel(oldFruit1, REEL_LENGTH, 123);
const b = generateReel(newFruit1, REEL_LENGTH, 123);
console.log('fruitmachine reel1 identical:', JSON.stringify(a) === JSON.stringify(b));

const oldBook1 = {
  book: { frequency: 0.051 }, explorer: { frequency: 0.079 }, tut: { frequency: 0.157 },
  anubis: { frequency: 0.234 }, scarab: { frequency: 0.234 }, ace: { frequency: 0.201 },
  king: { frequency: 0.201 }, queen: { frequency: 0.201 }, jack: { frequency: 0.201 }, ten: { frequency: 0.201 },
};
const newBook1 = { defaults: {}, symbols: oldBook1 };
const paytable = { book: { triggerFreeSpins: true } };
const c = generateReel(oldBook1, REEL_LENGTH, 1234, [], 3, paytable);
const d = generateReel(newBook1, REEL_LENGTH, 1234, [], 3, paytable);
console.log('bookbookbook reel1 identical:', JSON.stringify(c) === JSON.stringify(d));
```

Run: `node verify-reel-migration.mjs`
Expected: both lines print `true`. If either prints `false`, stop and investigate before
continuing - the migration must not change reel output for unrelated reasons (only the shape
should differ, not the algorithm's behavior for equivalent input).

- [ ] **Step 5: Delete the throwaway script**

```bash
rm verify-reel-migration.mjs
```

- [ ] **Step 6: Commit**

```bash
git add games/fruitmachine/game.js games/bookbookbook/game.js
git commit -m "refactor: migrate both games' FREQUENCY_REELn to the defaults/symbols shape"
```

---

### Task 6: Full-suite verification

**Files:** None modified - verification only.

- [ ] **Step 1: Run the full test suite**

Run: `node --test tests/*.mjs`
Expected: all tests pass except the pre-existing, known-flaky/known-unrelated failures
already established earlier in this project (`fruitmachine-rtp.test.mjs` if the committed
`FREQUENCY_REEL` values aren't currently converged to 96%, and `book-rtp-regression.test.mjs`
if it happens to hit its unseeded-RNG flakiness on this run). Any *other* failure means a
step above needs revisiting - go back to Task 3, Step 5 if `tunefrequencies.test.mjs` is
still failing (that step was deliberately left unresolved pending Task 5's migration).

- [ ] **Step 2: Manual sanity check in the browser (optional but recommended)**

Since this touches reel generation for both live games, if you have the opportunity: open
each game, spin a few times, and open TUNE FREQUENCIES for each to confirm the panel renders
correctly (per-reel tables show current/suggested values, COPY button produces valid-looking
`{ defaults, symbols }` output) without console errors. Not required to consider the plan
complete, but worth flagging if you skip it.
