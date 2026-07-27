# Candy Frenzy

![Candy Frenzy screenshot](screenshot.png)

7×7 cluster-pays cascading slot, inspired by Sugar Rush-style games. Uses the shared
`core/` engine's cascade mechanic (`core/CascadeEngine.js` + `core/CascadeMath.js`) with
this game's own cluster win evaluator (`core/ClusterMath.js`) and free-spins payout mode
(`core/FreeSpinsModes.js`).

## Rules

- **No paylines.** 5 or more of the same symbol, connected orthogonally (up/down/left/right,
  not diagonally), anywhere on the 7×7 grid pays as one cluster. A grid can have several
  clusters at once; each pays independently.
- **Cascading.** A winning cluster is removed; the symbols above it fall down to fill the
  gap, and new symbols drop in from the top to refill the grid. The grid is then
  re-evaluated — this can repeat several times within what is still one spin (same seed).
  The spin only ends, and payout is made, once a cascade step produces no new cluster.
- **Bonus / free spins.** 3+ `bonus` symbols anywhere on the final settled grid trigger
  10 free spins (no bet deducted). Landing 3+ again during free spins adds another 10 spins,
  without resetting the ones already remaining. `bonus` has no direct cash payout of its own.
- **Multiplier tiles (free spins only).** Every tile a winning cluster occupies gets (or
  doubles) a persistent per-tile multiplier: untouched tiles start at 1x (shown as nothing),
  a tile's first win sets it to 2x, and each subsequent win there doubles it again (2x → 4x →
  8x → ...). A later cluster that overlaps one or more of these tiles has their multiplier
  values summed and applied to its own payout. The multiplier grid is reset at the start of
  each free-spins bonus and cleared again the moment it ends — it never carries into the base
  game.

  This is `createMultiplierTilesMode()` (`core/FreeSpinsModes.js`), passed as Candy Frenzy's
  `freeSpinsMode` config when constructing its `CascadeEngine` (`game.js`). Free-spins payout
  modes are pluggable there — `core/FreeSpinsModes.js` also exports `createFlatMultiplierMode()`
  (the flat "every free-spin win pays double" rule, `CascadeEngine`'s own default for any
  cascade game that doesn't opt into something else) — and `createMultiplierTilesMode` itself
  takes a `badgeStyle` (`'background'` or `'corner'`) and `renderOrder` (`'front'` or
  `'behind'`) option controlling how/when its tile badges draw; Candy Frenzy currently uses
  `renderOrder: 'behind'`, so a tile's badge is only visible while that cell hasn't yet had a
  new symbol land on it (candy sprite art is opaque, so a landed tile hides a `'behind'`
  badge underneath it).
- **Symbols** — Premium: Cotton Candy, Bubble Gum, Cake Slice. Regular: Mint, Gummy Bear,
  Jelly Bean, Chocolate. Plus the `bonus` scatter. No wild in this version — the spritesheet
  carries more art than that (chest, clover, wild), and `game.js` excludes it explicitly so it
  never reaches a reel.
- **Payouts.** Every symbol has its own `clusterPayout` ladder, 11 breakpoints from a cluster of
  5 up to `15+` — which covers everything from 15 cells to all 49, so the ladder needs no tier
  per size. That makes the seven strictly ranked, Cotton Candy at 300x down to Chocolate at 40x,
  and symbol ranking is what the tuner's ordering preference reads (`checkPayoutLadders` in
  `core/TuningValidation.js`, which ranks on the last tier only). The in-game paytable renders
  them as one matrix — cluster size down the side, symbol across the top — built from `PAYTABLE`
  rather than hand-written, so a moved breakpoint changes the table without anyone editing it.

## Dev tooling

SPIN LOG, RUN SIMULATION, and TUNE FREQUENCIES are all available, same as every other game —
built on `core/CascadeSpinMechanic.js`, the cascade sibling of the line-pay games'
`core/LineMechanic.js` (see `docs/ARCHITECTURE.md`'s "pluggable gameplay mechanics" section).
RUN SIMULATION reuses the live engine's own `createMultiplierTilesMode()` instance, so a
simulated free-spins round measures the real persistent-multiplier-tile economics, not a flat
approximation. TUNE FREQUENCIES runs the same two-phase search (scatter-rate scaling, then a
joint frequency search) every other game's tuner does, ranking symbols by their highest
`clusterPayout` tier instead of a line-pay N-of-a-kind array. The frequencies in `game.js` were
tuned against the ladders above and against `REEL_LENGTH` — change either and they no longer
mean what their header says they achieved.

## Debug cheat

The **Bonus Trigger** button (visible when `DEBUG_MODE = true` in `game.js`) forces the
next spin's final grid to contain 3 `bonus` symbols, for testing the free-spins trigger and
retrigger without waiting for a natural hit.

---
_Docs last synced with the codebase: 2026-07-27, commit `281f9ea`._
