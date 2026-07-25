# Candy Frenzy — Cluster-Pays Cascade Game — Design

## Context

Every existing game (`bookbookbook`, `fruitmachine`, `barfruits`) is built on
`core/SlotEngine.js` + `core/SlotMath.js`, which assume: a fixed-length reel
strip scrolled to a stop, paylines, and a single "spin → land → evaluate →
done" cycle. Candy Frenzy (art already in `games/candyfrenzy/candies_1/`,
inspired by Sugar Rush) needs a fundamentally different mechanic that doesn't
fit that model at all:

- A 7×7 grid (not 5×3/3×3).
- No paylines — wins are **clusters**: 5+ orthogonally-connected same symbols
  anywhere on the grid.
- A single spin is not one evaluation — winning clusters are removed, the
  symbols above fall down, new symbols drop in from the top to refill, and
  the grid is re-evaluated. This repeats until a pass produces no winning
  cluster, at which point the (accumulated, across every cascade step) payout
  is made and the spin truly ends.
- A free-spins mode triggered by 3+ `bonus` symbols anywhere on the settled
  grid, after the cascade sequence ends. For v1 this is scoped down to "same
  cascade rules, 2× payout per spin" — no expanding wilds, no multiplier
  trail (that's explicitly future work, once this base mechanic is proven).

This is also the first of what will be more than one cascade-style game — a
future game reuses the same falling/cascading grid mechanic but with
*payline* wins instead of cluster wins. That means the falling/cascading
mechanic itself and the cluster-specific win evaluation must be two separate,
independently swappable pieces, not one another's concern.

## Goals

- A new `games/candyfrenzy` game: 7×7 grid, cluster pays (min. 5, orthogonal
  adjacency), cascading spins, `bonus` scatter → free spins (2× payout, no
  bet deducted, same trigger rule retriggers), no wild in v1.
- A new, generic cascade engine (`core/CascadeEngine.js` +
  `core/CascadeMath.js`) that knows nothing about clusters or paylines —
  its win logic is a single pluggable evaluator closure, the same way
  `SlotEngine.config.winEvaluator` is pluggable today. This is what makes it
  reusable by a future payline-cascade game without touching this code again.
- A new cluster-specific win evaluator (`core/ClusterMath.js`), sitting
  alongside `SlotMath.js`'s existing evaluators as a sibling, not a
  replacement.
- Three narrow, low-risk shared rendering extractions
  (`core/GridLayout.js`, `core/SpriteDrawer.js`, `core/ParticleSystem.js`)
  pulled out of `SlotEngine.js`'s existing code, used by both `SlotEngine`
  and `CascadeEngine`. `SlotEngine`'s state machine/control flow is
  otherwise untouched.
- Reel strips for Candy Frenzy are built with the existing, unmodified
  `generateReel` (same `FREQUENCY_REELn` authoring convention as every other
  game) — cascading reads further into the same strip via a per-column
  cursor, it does not re-roll a fresh random symbol per dropped cell.
- SPIN LOG wired up for this game (per-spin summary, cascade-aware).

## Non-goals (v1)

- No wild symbol (the `wild` tile in the sheet is unused for now).
- No `chest`/`clover` symbols (art exists, unused for now — plausibly future
  bonus-feature symbols).
- No RUN SIMULATION / TUNE FREQUENCIES for this game — `SpinSimulator.js`'s
  `simulateSpins`/`tuneFrequencies` are built around line/scatter evaluation
  and fixed strips; a cascade-aware equivalent is a substantial follow-up
  project of its own, not part of this one. The paytable numbers below are a
  reasonable starting point, not a tuned RTP.
- No retrigger multiplier trail / expanding mechanic during free spins —
  free spins are "the same base game, 2× payout" only.
- No refactor of `SlotEngine.js`'s state machine, spin timing, or win
  evaluators — only the three rendering pieces listed above move out of it.
- Not building the future payline-cascade game — only making sure
  `CascadeEngine`/`CascadeMath` don't preclude it.

## Design

### 1. Module layout

```
core/CascadeMath.js     <- pure, generic: cursor-based strip reads, gravity+refill, scatter-anywhere count
core/ClusterMath.js     <- pure, cluster-specific: flood-fill clustering + cluster payout lookup
core/CascadeEngine.js   <- stateful: cascade state machine + rendering, pluggable winEvaluator
core/GridLayout.js      <- pure: canvas/grid layout math (extracted from SlotEngine.resize())
core/SpriteDrawer.js    <- pure: sprite-atlas blit + motion blur (extracted from SlotEngine.drawSymbol())
core/ParticleSystem.js  <- small class: win-celebration particles (extracted from SlotEngine's particle code)

games/candyfrenzy/game.js       <- PAYTABLE, FREQUENCY_REELn (x7), REEL_STRIPS, winEvaluator closure, wiring
games/candyfrenzy/index.html    <- DOM contract (canvas, spin/auto/turbo/mute, paytable modal, fs modals, spin log button — no sim/tune buttons)
games/candyfrenzy/game.css
games/candyfrenzy/README.md
games/candyfrenzy/assets/candies_1/{candies_1.png, candies_1.tiles.json}  <- moved from games/candyfrenzy/candies_1/
```

Nothing in `SlotMath.js`, `SpinSimulator.js`, or the games importing
`SlotEngine.js` changes, except `SlotEngine.js` itself delegating three
pieces to the new shared modules (§6).

### 2. `core/CascadeMath.js` — generic cascade mechanics

```js
export function nextStripSymbol(strip, cursorState)
export function applyCascade(grid, cursorStateByColumn, strips, clearedPositions)
export function checkScatterCount(grid, scatterSymbol, triggerCount)
```

- **`nextStripSymbol(strip, cursorState)`** — `cursorState` is `{ index }`,
  mutated in place. Returns `strip[cursorState.index]`, then advances
  `cursorState.index = (cursorState.index + 1) % strip.length`. Trivial, but
  centralizes the "read forward, wrap circularly" rule in one place instead
  of scattering `% strip.length` arithmetic around the engine.
- **`applyCascade(grid, cursorStateByColumn, strips, clearedPositions)`** —
  pure function: given the current grid, the set of `[col,row]` positions to
  clear, each column's strip, and each column's live cursor state, returns a
  new grid where: cleared cells are removed, the remaining symbols in each
  affected column compact downward (gravity — first-fit, order-preserving),
  and the vacated cells at the top of each column are filled by repeatedly
  calling `nextStripSymbol` for that column. Does not know or care *why*
  positions were cleared (cluster removal, or — for the future payline
  game — a matched line) — that's the caller's concern.
- **`checkScatterCount(grid, scatterSymbol, triggerCount)`** — counts
  `scatterSymbol` anywhere in the grid; returns
  `{ count, positions, triggerFreeSpins }`. Independent of win type (a future
  payline-cascade game needs the exact same "is there a scatter anywhere"
  check), so it lives here rather than in `ClusterMath.js`.

Initial grid fill (the very first `dropping_in` of a spin) is really just
`applyCascade` called against an all-empty starting grid with every position
"cleared" — same function, no special case.

### 3. `core/ClusterMath.js` — cluster-specific win evaluation

```js
export function findClusters(grid, paytable, minClusterSize = 5)
export function checkClusterWins(grid, paytable, minClusterSize, scatterSymbol, scatterTriggerCount)
```

- **`findClusters`** — orthogonal (4-directional, no diagonals) flood-fill
  over the grid. Skips cells whose symbol is the scatter symbol or has no
  `clusterPayout` entry in the paytable (defensive — nothing in this game's
  paytable should lack one besides `bonus`, but the function doesn't assume
  that). Returns one entry per connected component:
  `{ symbol, positions: [[col,row], ...], size }`.
- **`checkClusterWins`** — calls `findClusters`, keeps only clusters with
  `size >= minClusterSize`, looks up each one's payout tier (§4), and
  combines that with `checkScatterCount` (from `CascadeMath.js`) into one
  result shape mirroring `checkWins`'s convention:
  ```js
  { clusterWins: [{ symbol, count, payout, winningPositions }], totalPayoutMultiplier, scatterWin }
  ```

A cluster's payout tier lookup — since cluster size ranges 5..49, not a
small fixed count like line wins — reads a new paytable field,
`clusterPayout: [{ min, multiplier }, ...]` (ascending by `min`), and finds
the last entry whose `min <= size`. This is a new paytable field (not an
overload of the existing `payout: [...]` per-count-index convention used by
line/scatter games, which doesn't fit a 5–49 range).

### 4. Symbols & paytable

| Tier | Symbols |
|---|---|
| Premium | cottoncandy, gum, crystal, rocket, crown, cake |
| Regular | mint, gummy, bean, chocolate, chewy, cherry |
| Scatter | bonus |

Not used in v1: `chest`, `clover`, `wild` (art present in
`candies_1.png`/`candies_1.tiles.json`, simply excluded from `PAYTABLE` and
every reel's frequency table).

Cluster size breakpoints: **5-6, 7-9, 10-14, 15-24, 25+**. Starting-point
multipliers (of total bet, paid per qualifying cluster, summed across
however many clusters land in one cascade step):

| Tier | 5-6 | 7-9 | 10-14 | 15-24 | 25+ |
|---|---|---|---|---|---|
| Regular | 0.10 | 0.20 | 0.40 | 1.0 | 3.0 |
| Premium | 0.25 | 0.50 | 1.0 | 2.5 | 7.5 |

```js
export const PAYTABLE = {
  cottoncandy: { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Cotton Candy' },
  gum:         { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Bubble Gum' },
  crystal:     { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Sugar Crystal' },
  rocket:      { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Candy Rocket' },
  crown:       { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Candy Crown' },
  cake:        { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Cake Slice' },
  mint:        { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Mint' },
  gummy:       { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Gummy Bear' },
  bean:        { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Jelly Bean' },
  chocolate:   { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Chocolate' },
  chewy:       { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Chewy Candy' },
  cherry:      { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Cherry Candy' },
  bonus:       { type: 'scatter', paymode: 'any', triggerFreeSpins: true, friendlyName: 'Bonus' },
};
```
where `PREMIUM_PAYOUT`/`REGULAR_PAYOUT` are each
`[{min:5,multiplier:...}, {min:7,...}, {min:10,...}, {min:15,...}, {min:25,...}]`
per the table above. `bonus` has no `clusterPayout` (never clusters, never
pays directly — pure trigger) and no direct cash payout in v1. `type` follows
the same convention every other game's paytable already uses (grouping in
the paytable modal / dev tooling) — no effect on `checkClusterWins` itself.

### 5. Reel strips — strip + per-column cursor, not per-cell random draws

Each of the 7 columns gets its own `FREQUENCY_REELn` (same authoring shape
documented in the top-level README) and its own strip via the existing,
**unmodified** `generateReel(freqTable, REEL_LENGTH, seed, [], 3, PAYTABLE)`
— `bonus`'s `triggerFreeSpins: true` gets its usual automatic `minGap`
spacing for free, same as every other game's scatter symbol.

Per spin:
1. Seed a spin-local rng from the spin's seed (`createSeededRng`, same as
   every other game).
2. For each column, pick a random stop index into that column's strip —
   this becomes `cursorStateByColumn[col] = { index: stopIndex }`.
3. `applyCascade` is called against an empty 7×7 grid with every position
   "cleared" — this performs the *initial* fill, reading the first 7 symbols
   forward from each column's cursor (identical in effect to
   `generateTargetGrid`'s per-column window read).
4. Every subsequent cascade step's refill reads further forward from the
   *same* `cursorStateByColumn` entries (not re-rolled) — so the entire
   spin, initial fill through every cascade, is one continuous walk along
   each column's strip starting from a single seeded point. Replaying
   `engine.spin(engine.lastSpinSeed)` reproduces the exact same sequence of
   grids, same as every other game's replay guarantee.

### 6. `core/CascadeEngine.js` — state machine

States: `idle → dropping_in → evaluating → (clearing → falling → evaluating)* → showing_wins → idle`,
plus `free_spins_intro` / `game_over`, matching `SlotEngine`'s naming so
`game.js`'s `onStateChange` handling feels familiar.

- **`spin(seed?)`** — captures/replays the seed, sets up
  `cursorStateByColumn` (§5), transitions to `dropping_in`.
- **`dropping_in`** — animates the initial fill (columns staggered, symbols
  falling from above the grid into place), then `evaluating`.
- **`evaluating`** — calls `config.winEvaluator(grid)` (a single-argument
  closure the game supplies — see below). Instant, no animation.
  - If `totalPayoutMultiplier > 0`: add to this spin's running total,
    `clearing` (winning cells pop/fade), then `falling` (gravity + refill via
    `applyCascade`, animated), then back to `evaluating`.
  - Else: loop ends. If running total > 0 → `showing_wins`, else → check
    scatter trigger, then `idle`.
- **Scatter trigger** — checked once, against the final settled grid, via
  `results.scatterWin` from the last `evaluating` call (reusing
  `checkClusterWins`'s bundled scatter check, no separate pass needed).
  Same `onScatterTrigger(count, isInFreeSpins)` callback convention as
  `SlotEngine`, so `game.js` decides free-spins entry/retrigger exactly like
  `barfruits/game.js` already does.
- **Payout**: total across every cascade step in the spin, × 2 if
  `engine.inFreeSpins`, matching the "still one spin, same seed" framing in
  the requirements — free spins don't charge `totalBet`.

`config.winEvaluator` for Candy Frenzy, built in `game.js`:
```js
const winEvaluator = (grid) => checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3);
```
`CascadeEngine` never sees `minClusterSize`/paylines/anything win-strategy
shaped — only this closure and its `{ totalPayoutMultiplier, scatterWin,
winningPositions }`-shaped result. A future payline-cascade game supplies a
closure around a line evaluator instead; `CascadeEngine`/`CascadeMath` don't
change.

Free spins: 3+ `bonus` on the settled grid → **10 free spins**; 3+ again
during free spins **retriggers** (+10, identical rule, no special-casing,
same pattern as `barfruits`'s `FREE_SPINS_AWARD` table). 2× payout per free
spin, no bet deducted. No expanding symbol, no multiplier trail (non-goal,
future work).

### 7. Shared rendering extraction

- **`core/GridLayout.js`** — `computeGridLayout(parentRect, dpr, reelsCount, rowsCount, marginXFrac, marginYFrac)`,
  the pure math currently inline in `SlotEngine.resize()`, extracted
  verbatim (same formula, same return shape:
  `{ cssWidth, cssHeight, canvasWidth, canvasHeight, cellSize, reelsX, reelsY, reelsWidth, reelsHeight }`).
  `SlotEngine.resize()` becomes: call this, assign results to its existing
  `this.symbolWidth`/`this.reelsX`/etc. fields — every other place in
  `SlotEngine.js` that reads those fields is unchanged. `CascadeEngine`
  calls the same function for its own 7×7 layout.
- **`core/SpriteDrawer.js`** — `drawSpriteSymbol(ctx, spritesheet, tile, x, y, w, h, blurSpeed)`,
  extracted verbatim from `SlotEngine.drawSymbol()`'s body (motion-blur
  branch included). `SlotEngine.drawSymbol()` becomes a thin wrapper
  resolving `tile` from `this.symbolsConfig` and calling this.
- **`core/ParticleSystem.js`** — a small class replacing `SlotEngine`'s
  inline `this.particles` array + update loop + `spawnWinParticles`/
  `renderParticles`: `spawn(points, options?)`, `update()`, `render(ctx)`,
  `clear()`. `SlotEngine` holds `this.particleSystem = new ParticleSystem()`
  and delegates; `CascadeEngine` does the same.

Cabinet chrome, grid borders, and the loading-screen text stay per-engine —
thematic, not mechanical, and Candy Frenzy wants its own candy-shop look
rather than the gold/obsidian cabinet.

### 8. Dev tooling

- **SPIN LOG**: wired via `core/SpinLog.js`/`core/SpinLogPanel.js`, same
  button/modal convention as the other three games. `createSpinLogEntry`'s
  `winData` shape assumption (line/scatter wins) doesn't fit cluster wins
  directly — a small cascade-aware summary path is needed (e.g. total
  cascade steps, total clusters, symbols involved), detailed at
  implementation/plan time rather than prescribed here field-by-field.
- **RUN SIMULATION / TUNE FREQUENCIES**: not included in this game's
  `index.html` at all (buttons omitted, not just hidden) — no cascade-aware
  simulator exists yet (non-goal, §"Non-goals").

### 9. Portal & docs

- `games/candyfrenzy/{game.js, index.html, game.css, README.md}` following
  the shape of `games/barfruits/`.
- `games/candyfrenzy/candies_1/` moves to
  `games/candyfrenzy/assets/candies_1/`, matching every other game's
  `assets/<theme>/<theme>.{png,tiles.json}` convention (`game.js` fetches
  `./assets/candies_1/candies_1.tiles.json`).
- Add a portal card (`index.html`) and a README table row, same as the other
  three games.

## Data flow summary

```
games/candyfrenzy/game.js
  PAYTABLE, FREQUENCY_REEL1..7, REEL_STRIPS = FREQUENCY_REELS.map((f,i) => generateReel(f, REEL_LENGTH, REEL_SEEDS[i], [], 3, PAYTABLE))
  winEvaluator = (grid) => checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3)   [ClusterMath.js]

  new CascadeEngine(canvas, {
    reelsCount: 7, rowsCount: 7, paytable: PAYTABLE, reelStrips: REEL_STRIPS,
    winEvaluator, scatterSymbol: 'bonus', ...
  })

CascadeEngine.evaluate step
  → config.winEvaluator(grid) → checkClusterWins → findClusters (this file) + checkScatterCount [CascadeMath.js]
  → if wins: applyCascade(grid, cursorStateByColumn, strips, clearedPositions) [CascadeMath.js] → animate → loop
  → else: pay accumulated total, check scatterWin.triggerFreeSpins → onScatterTrigger callback (game.js decides free spins, same convention as SlotEngine)
```

## Testing / verification

No test framework is configured for browser-side rendering in this repo, but
`core/*Math.js` files are plain functions under `node --test` like
`SlotMath.js` already is:

- `tests/clustermath.mjs` (or similar): `findClusters` on hand-built small
  grids (an L-shape, two separate same-symbol clusters that shouldn't merge,
  a diagonal-only touch that should *not* count as connected, exactly 5 vs.
  exactly 4 — the min-size boundary), `checkClusterWins`'s tier boundaries
  (5 vs 6 vs 7, 24 vs 25), and the scatter bundling.
- `tests/cascademath.mjs`: `applyCascade`'s gravity (symbols compact down,
  order preserved) and refill (new symbols come from the right cursor
  position, cursor advances correctly, wraps at strip end), `nextStripSymbol`
  wraparound, `checkScatterCount`'s trigger boundary.
- Determinism check: same seed replayed through the full spin (initial fill
  + every cascade) produces byte-identical grids at every step — proves the
  cursor-based approach is actually reproducing "same spin, same seed."
- Manual in-browser verification (via the `run` skill): spin, watch multiple
  cascades resolve in one spin, confirm payout accumulates correctly across
  them, force a 3-bonus grid (a debug cheat analogous to
  `forceWinResult('scatter')`) to verify free-spins entry/retrigger/2×
  payout, confirm SPIN LOG records cascade-aware entries.
- After extracting `GridLayout`/`SpriteDrawer`/`ParticleSystem`: manually
  re-verify all three existing games (`bookbookbook`, `fruitmachine`,
  `barfruits`) still render, resize, and show win particles identically to
  before the extraction — this is a behavior-preserving refactor of
  `SlotEngine.js`, not a feature change, and needs to be confirmed as such.

## Migration notes

- `games/candyfrenzy/candies_1/` → `games/candyfrenzy/assets/candies_1/`
  (file move, no content change).
- `core/SlotEngine.js`: `resize()`, `drawSymbol()`, and the particle-related
  methods (`spawnWinParticles`, `renderParticles`, the particle-update block
  in `update()`) are rewritten to delegate to the three new shared modules —
  same externally-visible behavior/fields, no config or call-site changes
  for `bookbookbook`/`fruitmachine`/`barfruits`.
- No changes to `core/SlotMath.js`, `core/SpinSimulator.js`,
  `core/SimulationPanel.js`, `core/SpinLog.js`'s existing exports (a
  cascade-aware addition to `SpinLog.js` is additive, not a change to what's
  there).
