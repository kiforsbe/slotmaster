# Per-Symbol Reel Spacing Constraints (minGap/maxStack) — Design

## Context

`generateReel` (`core/SlotMath.js`) currently has exactly one built-in spacing rule: a
hardcoded "scatter min-gap" pass (`_enforceMinScatterGap`) that spreads out every
`type: 'scatter'`-typed symbol so no two land within `minScatterGap` (default 3) positions
of each other on the built strip - this exists purely to stop a free-spins-triggering
symbol from clustering and silently inflating the trigger rate.

Two problems with that:
1. It's the only spacing rule available, it only applies to one hardcoded symbol category
   (scatter), and there's no way to express "no more than N of this symbol back to back"
   (stacking) at all.
2. It's keyed off `type === 'scatter'`, conflating "this symbol is visually/thematically a
   scatter" with "this symbol triggers free spins" and "this symbol should be spaced out on
   the reel" - three different concerns that don't need to be the same thing. The paytable
   already has a purpose-built `triggerFreeSpins` boolean for the second concern.

Related: `paymode` (read by `checkWins`, gates whether a symbol pays as a line win) currently
has no default at all - every symbol's paytable entry must explicitly write
`paymode: 'line'` or `paymode: 'any'`, even though `'line'` is the overwhelmingly common case
and `'any'` is only ever used for scatter-type symbols in practice.

## Decision

### 1. Reel struct

`FREQUENCY_REELn` gains a `defaults`/`symbols` split:

```js
const FREQUENCY_REEL1 = {
  defaults: { minGap: 1, maxStack: 3 },
  symbols: {
    book:     { frequency: 0.051, minGap: 5 },
    explorer: { frequency: 0.079 },
    tut:      { frequency: 0.157, maxStack: 1 },
    // ...
  },
};
```

Resolution order per symbol per property: **symbol override → reel `defaults` → built-in
fallback**. Built-in fallbacks are `minGap: 1` (no constraint) and `maxStack: Infinity` (no
constraint), **except** `minGap` for a symbol with `paytable[symbol].triggerFreeSpins ===
true`, whose built-in fallback is `3` instead of `1` - this is what preserves today's
free-spin-trigger spacing automatically, without every game having to configure it by hand.
`defaults` and every property within it are optional; an entirely absent `defaults` behaves
as `{}`.

This is a breaking shape change. Everything that currently reads a `FREQUENCY_REELn` table
as a flat symbol map needs updating to read through `.symbols`, and to preserve `.defaults`
where it round-trips data (the tuner's copy-paste output):
- `generateReel` (its own weights/exclude loop, and the new spacing passes)
- `tuneFrequencies` (`buildReelStrips`, Phase 2's dims-building/`projectPoint`/diagnostics)
- `formatReelFrequencyTablesForCopy` (`core/SimulationPanel.js`)
- `games/fruitmachine/game.js` and `games/bookbookbook/game.js`'s `FREQUENCY_REELn` exports
  and every place that reads them directly (`REEL_STRIPS` construction)

### 2. Enforcement algorithm

- **minGap** generalizes `_enforceMinScatterGap`: instead of one shared gap value for one
  hardcoded scatter set, it runs once per symbol that resolves to `minGap > 1`, each with its
  own gap requirement, reusing the existing swap-based circular-distance repair per symbol.
- **maxStack** (new): after minGap spacing, scan the built strip for any run of a symbol
  longer than its resolved `maxStack` and break it up by swapping the excess position(s) with
  a different, non-violating position elsewhere on the strip. Same best-effort philosophy as
  minGap's existing behavior: a reel too dense to fully satisfy just does its best, it doesn't
  throw or infinite-loop.
- Order: minGap runs first (the coarser, whole-strip constraint), then maxStack cleans up
  runs in the result - running it last means a minGap swap can't undo a maxStack fix.

### 3. `triggerFreeSpins` replaces `type === 'scatter'` for spacing/trigger-rate purposes

- `generateReel`'s old scatter-only Step 5 is deleted entirely, replaced by the general
  minGap mechanism above (with the `triggerFreeSpins`-based fallback of `3` built into the
  resolution order) - `generateReel` still needs a `paytable` reference to read
  `triggerFreeSpins`/`type` from (same `paytable` param added in the prior
  generateReel-scatter-type-param change), not from the per-reel table.
- `tuneFrequencies`'s Phase 1 (`scatterSymbols`, used for the free-spin-trigger-rate search)
  switches its filter from `paytable[s].type === 'scatter'` to
  `paytable[s].triggerFreeSpins === true`. bookbookbook's paytable already sets
  `triggerFreeSpins` correctly on every symbol, so this needs zero data migration there.

### 4. `paymode` default

`checkWins` (the only current `paymode` consumer - `checkWildLineWins` doesn't read it at
all) resolves a missing `paymode` as `'any'` when `type === 'scatter'`, `'line'` otherwise:

```js
const paymode = targetMeta.paymode ?? (targetMeta.type === 'scatter' ? 'any' : 'line');
```

`type: 'scatter'` keeps meaning something after this change - it drives this `paymode`
default, and `SimulationPanel.js`'s cosmetic win-breakdown section grouping (`isScatter`) -
it's just fully decoupled from free-spin-triggering and reel-generation spacing now, both of
which move to `triggerFreeSpins`.

## Scope / what's explicitly unchanged

- `scatterSymbol` (the single symbol name passed into `checkWins`/`simulateSpins` config for
  grid-scanning scatter counts) stays exactly as-is - it's already parameterized
  independently of `type`, no change needed.
- Existing `min`/`max` (soft frequency-value bounds, from the earlier ordering-limits work)
  and `fixed` stay exactly as-is, just relocated under `symbols[symbol]` instead of directly
  under the symbol key.
- `orderingBiasByReel`, `orderingPenaltyWeight`, `limitPenaltyWeight` (tuneFrequencies
  options) are unaffected by the reel struct change - they're passed as run options, not
  read from the reel tables' own shape.

## Testing

- `tests/slotmath.test.mjs`: update `generateReel`'s existing tests for the new
  `{ defaults, symbols }` shape; add tests for per-symbol minGap (distinct gaps for two
  different symbols on the same reel), maxStack (a run longer than the limit gets broken
  up), the `triggerFreeSpins`-based default gap (a symbol with `triggerFreeSpins: true` and
  no explicit minGap still gets spaced by 3), and reel-level `defaults` being used when a
  symbol doesn't override.
- `tests/tunefrequencies.test.mjs`: update every reel-table literal used across tests for the
  new shape; add/update a test confirming Phase 1's scatter-rate phase now keys off
  `triggerFreeSpins` (a `type: 'scatter'`-but-`triggerFreeSpins: false` symbol should NOT be
  scaled by Phase 1; a `triggerFreeSpins: true`-but-untyped symbol SHOULD).
- `tests/simulationpanel.test.mjs`: update `formatReelFrequencyTablesForCopy` tests for the
  new shape, including round-tripping `defaults`.
- New tests (`tests/slotmath.test.mjs`): with no explicit `paymode` field at all, `checkWins`
  (a) pays a `type: 'regular'` symbol's matching run as a line win (implicit default
  `'line'`), and (b) does NOT double-pay a `type: 'scatter'` symbol's matching run as a line
  win on top of its scatter payout (implicit default `'any'`, matching today's explicit
  `paymode: 'any'` behavior).
