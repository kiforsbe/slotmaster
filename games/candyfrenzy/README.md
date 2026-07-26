# Candy Frenzy

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
- **Symbols** — Premium: Cotton Candy, Bubble Gum, Sugar Crystal, Candy Rocket, Candy Crown,
  Cake Slice. Regular: Mint, Gummy Bear, Jelly Bean, Chocolate, Chewy Candy, Cherry Candy.
  No wild in this version.

## Dev tooling

SPIN LOG is available (per-spin history + CSV export, same as every other game). RUN
SIMULATION / TUNE FREQUENCIES are **not** included — those tools are built around
line/scatter win evaluation and fixed-length reel-strip scrolling, neither of which this
game's cascading cluster mechanic uses; a cascade-aware equivalent is a separate future
project. The paytable multipliers here are a starting point, not a tuned RTP.

## Debug cheat

The **Bonus Trigger** button (visible when `DEBUG_MODE = true` in `game.js`) forces the
next spin's final grid to contain 3 `bonus` symbols, for testing the free-spins trigger and
retrigger without waiting for a natural hit.
