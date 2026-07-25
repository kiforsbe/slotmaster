# Frequency Bounds and Live Tuning View Design

## Problem

TUNE FREQUENCIES' live progress log shows only one aggregate line per iteration (RTP, trigger
rate, error) - there's no way to watch what any individual symbol's frequency is actually doing
during the search, or to see at a glance whether it's within the soft bounds you've configured
for it. Relatedly, those soft bounds (`min`/`max` on a per-reel symbol entry, read by
`limitPenaltyOf` in `core/SpinSimulator.js`) are per-symbol-only today - unlike `minGap` and
`maxStack`, which already support a reel-level `defaults` fallback, there's no way to set a
reel-wide default `min`/`max` without repeating it on every symbol. There's also no way to force
a symbol to appear in clusters (e.g. a stacked-feeling symbol that should never land as a single
isolated stop) - only `maxStack` (a ceiling on run length) exists, no minimum.

## Goals

- Show a live, in-place (not appended-log) per-reel table during a TUNE FREQUENCIES run: each
  symbol's current frequency (updating every iteration), alongside its resolved min/max bounds,
  so it's visible at a glance whether the search is inside or outside its configured bounds.
- Give `min`/`max` the same reel-level `defaults` fallback that `minGap`/`maxStack` already have,
  with the same resolution order (symbol override -> reel `defaults` -> unconstrained), for
  consistency across all four constraints.
- Add a new `minStack` constraint (minimum run length whenever a symbol appears, mirroring
  `maxStack`'s maximum), with the same defaults-resolution pattern.
- Rename `min`/`max` to `minFrequency`/`maxFrequency` throughout, so every constraint on a
  symbol/reel entry shares one consistent naming scheme (`minGap`, `maxStack`, `minFrequency`,
  `maxFrequency`, `minStack`).

## Non-goals

- No new UI inputs for configuring `minFrequency`/`maxFrequency`/`minStack` - these stay a
  game.js edit, the same as `minGap`/`maxStack` today. Only the live *readout* is new UI.
- No redefinition of what `frequency` itself means or how it's stored - it stays the existing
  arbitrary relative weight, unchanged. (Explored and explicitly rejected during brainstorming -
  every alternative unit considered turns out to be a relabeling of the same underlying
  proportional math, and the practical ask - reel-level defaults, a clearer live view - doesn't
  require changing the stored unit at all.)
- No automated attempt to reconcile a symbol carrying both `minGap > 1` and `minStack > 1` beyond
  the cluster-aware behavior described below - genuinely conflicting configurations (e.g.
  `minStack` larger than the reel can support) degrade best-effort, same as every other spacing
  constraint in `generateReel` today.

## Design

### Field renaming and defaults resolution

`min`/`max` (on a per-symbol reel entry) become `minFrequency`/`maxFrequency`, and gain the same
`defaults`-based fallback `minGap`/`maxStack` already use:

```js
star: { frequency: 29.17, minGap: 3, maxStack: 1, minFrequency: 20, maxFrequency: 30, minStack: 2 }
```

```js
defaults: { minGap: 3, maxStack: 1, minFrequency: 5, maxFrequency: 50, minStack: 1 }
```

All five constraints resolve identically: **symbol-level override -> reel `defaults` -> built-in
fallback** (`minFrequency`/`maxFrequency` fall back to unconstrained/unset, exactly like today's
behavior when neither is present; `minStack` falls back to `1`, meaning "no minimum" - a symbol
can still appear as a lone stop, matching how `minGap`'s own fallback of `1` is a no-op).

This is a rename, not a new concept, for the frequency bounds - `limitPenaltyOf` in
`core/SpinSimulator.js` already treats them as soft preferences; only where the bound values come
from changes (a shared resolution helper instead of reading the bare per-symbol field).

Blast radius of the rename: `games/fruitmachine/game.js`'s `star`/`strawberry` entries (the only
two places any game currently sets `min`/`max`), plus the handful of test fixtures in
`tests/tunefrequencies.test.mjs` that reference `.min`/`.max` directly.

### `minStack`, and why `minGap` becomes cluster-aware

`minStack` mirrors `maxStack`: whenever the symbol appears on the built strip, it must occur at
least `minStack` times in a row (best-effort, same tolerance every other spacing constraint in
`generateReel` has - a reel too sparse in that symbol to form full-length groups just gets as
close as it can).

The subtlety: `minGap` today enforces a minimum circular distance between *every* pair of
occurrences of a symbol. Once `minStack > 1`, that's wrong - two stops inside the same cluster are
*meant* to be adjacent (distance 0), and only the distance *between clusters* should be
constrained. So:

- **`minStack: 1` (the default - every existing reel, unchanged):** each occurrence is its own
  cluster of size 1. `minGap` behaves exactly as it does today - zero behavior change for any
  reel that doesn't opt into `minStack`.
- **`minStack > 1`:** the symbol's occurrences are grouped into clusters sized between
  `minStack` and `maxStack` (best-effort - a leftover remainder that can't fill a full cluster
  gets folded into the nearest cluster up to `maxStack`, or placed as a smaller cluster if even
  that isn't possible). `minGap` is then enforced as the circular distance from the end of one
  cluster to the start of the next, treating each cluster as one atomic block - clustering has to
  happen before gap-spacing for that symbol, and the gap pass moves whole clusters rather than
  individual stops when `minStack > 1`.

Implementation-level detail (exact swap/repair algorithm for cluster formation and cluster-aware
gap spacing) is left to the implementation plan - the constraint above is the contract; the
existing `_enforceMinGap`/`_enforceMaxStack` structure (seam-scan, best-effort, deterministic via
the passed-in seeded `rng`) is the pattern to extend, not replace.

### Live per-reel table in `core/SimulationPanel.js`

Before a tune starts, the panel resolves each symbol's `{minFrequency, maxFrequency}` once from
the input `reelFrequencyTables` (the same resolution helper `generateReel`/`tuneFrequencies` use)
- these bounds are static for the whole run, only `frequency` itself moves. A new table block (one
per reel, laid out like the existing post-tune results table: Symbol | Current | Min | Max) sits
above the existing step-by-step log and updates in place every iteration, reading
`result.trial[reelIdx].symbols[symbol].frequency` from the existing `onProgress` callback -
`result.trial` already carries the full live candidate reel tables, so no change to
`tuneFrequencies`' return contract is needed for this. The existing appended step log is
unchanged.

### `tuneFrequencies` defaults resolution

The Phase 2 dims-building loop in `core/SpinSimulator.js` currently reads the bare per-symbol
field directly (`min: symbolsTable[s].min, max: symbolsTable[s].max`). It switches to the shared
resolution helper (symbol override -> reel `defaults.minFrequency`/`.maxFrequency` -> unset), so a
reel-wide default now actually takes effect for every value symbol on that reel unless a specific
symbol overrides it. No change to the optimization mechanics themselves - `limitPenaltyOf` already
treats these as soft bounds; only where the bound values come from changes.

## Testing

- `core/SlotMath.js`: new tests for `minStack` cluster formation (a symbol with `minStack: 2`
  never appears as an isolated single stop), the cluster-aware `minGap` interaction once
  `minStack > 1` (clusters spaced apart, not individual stops within a cluster), and a regression
  check that `minStack: 1` (the default) leaves every existing `minGap`/`maxStack` test passing
  unchanged.
- `core/SpinSimulator.js`: rename the existing `min`/`max` tests to `minFrequency`/`maxFrequency`,
  add a test that a reel-level `defaults.minFrequency`/`.maxFrequency` applies to a symbol that
  doesn't override it, and that a symbol-level override still wins over the reel default.
- `core/SimulationPanel.js`: no existing automated coverage for this file's UI rendering
  (consistent with the rest of the project) - manual browser verification via Playwright.
