# Architecture

How `core/` is put together, the API each module exposes, and how a game in `games/<name>/`
plugs into it. See the top-level [README](../README.md) for how to run things and for the
reel-frequency-table data model specifically.

## Layering

```
games/<name>/game.js        <- per-game glue: data (paytable, paylines, reels) + DOM wiring
        |  constructs and configures
        v
core/SlotEngine.js          <- rendering, animation, state machine, live gameplay
        |  calls into (pure functions, no DOM/state)
        v
core/SlotMath.js            <- win evaluation, reel building, seeded RNG

core/SpinSimulator.js       <- headless simulation + auto-tuning, built on SlotMath.js
core/SimulationPanel.js     <- browser UI for SpinSimulator.js, used by game.js's debug buttons
core/SlotAudio.js           <- synthesized sound effects, used by SlotEngine.js
```

Nothing in `core/` imports from `games/`. A game only ever flows data *into* `core/` (its own
paytable, paylines, reel strips, DOM element references) — `core/` never hardcodes a symbol
name, payout shape, or grid size. This is what lets `SlotMath.js` and `SpinSimulator.js` run
identically inside the live browser game, inside the in-browser debug tools, and inside
`node --test` with no DOM at all.

## `core/SlotMath.js` — pure math, no side effects

Every export is a pure function: same inputs always produce the same output, nothing touches
the DOM, nothing holds state between calls. This is deliberate — it's what makes the module
usable from all three contexts above (game engine, simulator, tests) without adapters.

- **`checkWins(grid, paytable, paylines, activeLinesCount, wildSymbol, scatterSymbol,
  scatterTriggerCount)`** — the default win evaluator (`SlotEngine`'s `winEvaluator` default).
  Evaluates left-to-right line matches (with generic wild substitution via `wildSymbol`) and,
  separately, scatter wins (any symbol equal to `scatterSymbol`, anywhere on the grid, count
  ≥ `scatterTriggerCount`). Returns `{ lineWins, scatterWin, totalLinePayoutMultiplier,
  totalScatterPayoutMultiplier }`. `scatterWin.triggerFreeSpins` is set once enough scatters
  land, regardless of whether a payout is defined for that count.
- **`checkWildLineWins(grid, paytable, paylines, activeLinesCount)`** — an alternate line-win
  evaluator for wilds that only ever substitute in the *last* grid position of a line (e.g. a
  classic 3-reel fruit machine's reel-3 wild). Reads `wild`, `wildOnly`/`wildExcludes`,
  `wildPenalty`, and `aloneBonus` directly off each paytable entry — nothing hardcoded, so it's
  reusable by any game with this specific wild shape. Has no scatter handling at all.
- **`checkExpandingWins(grid, expandingSymbol, paytable, paylines, activeLinesCount,
  expandingPaytable)`** — Book-of-Dead-style expanding-symbol evaluator, called by
  `SlotEngine` itself (not chosen via `winEvaluator`) whenever `engine.inFreeSpins &&
  engine.expandingSymbol` is set after the normal win evaluation. Any reel containing the
  symbol counts as fully covered by it on every active payline.
- **`generateReel(reelWeights, targetLength, seed, exclude, defaultTriggerMinGap, paytable)`**
  — builds one weighted, seeded reel strip from a frequency table, with optional per-symbol
  `minGap`/`maxStack` spacing constraints. See the top-level README's "Reel frequency tables"
  section for the full shape and default-resolution rules.
- **`createSeededRng(seed)`** — deterministic PRNG (mulberry32); returns a `() => number`
  function yielding the same float sequence for a given seed every time. This is the seedable
  RNG threaded through everywhere an outcome needs to be reproducible: a live spin
  (`SlotEngine.spin(seed)`, so `engine.spin(engine.lastSpinSeed)` replays exactly), reel
  building, and the tuner's common-random-numbers search.
- **`generateTargetGrid(reelStrips, rowsCount, rng)`** — picks one random stop position per
  reel strip and reads off the visible window; this is what a spin outcome *is*, independent
  of animation. `SlotEngine.spin()` calls this once per spin with a fresh (or replayed) seeded
  rng to get `this.targetGrid`, which every reel's landing animation then just visually
  catches up to.

## `core/SlotEngine.js` — the live game: state machine + canvas renderer

A class, one instance per running game (`new SlotEngine(canvas, config)`). Owns balance,
bet, reel physics/animation, and win presentation; delegates all win logic to whichever
`winEvaluator` function the config supplies.

**Construction config** (all optional except `reelStrips`, which must have one entry per
`reelsCount`):

| Field | Default | Purpose |
|---|---|---|
| `reelsCount`, `rowsCount` | `5`, `3` | Grid shape |
| `paytable` | `{}` | Passed straight through to `winEvaluator` |
| `reelStrips` | `[]` | One strip per reel, from `generateReel` |
| `paylines` | *(required, no default)* | One row-index-per-reel array per line |
| `wildSymbol`, `scatterSymbol` | `null` | Passed positionally to `winEvaluator` — only meaningful to evaluators that read them (`checkWins` does; `checkWildLineWins` ignores them, reading wild rules off `paytable` instead) |
| `winEvaluator` | `checkWins` | `(grid, paytable, paylines, activeLinesCount, wildSymbol, scatterSymbol) => results` |
| `betPerLine`, `linesCount` | `1`, `10` | Starting bet |
| `symbolsConfig`, `spritesheetUrl` | — | Sprite atlas: `{ [symbolName]: {x,y,w,h} }` + image URL |
| `onStateChange(state)` | no-op | Fired on every state transition (see State machine below) |
| `onScatterTrigger(scatterCount, isInFreeSpins)` | no-op | Fired instead of auto-advancing when `scatterWin.triggerFreeSpins` — the game decides what a trigger/retrigger means |
| `onWin({amount, isExpanding})` | no-op | Fired whenever a spin pays out |

**State machine** (`engine.state`, reported via `onStateChange`): `idle` → `spinning` →
`stopping` → `evaluating` → (`free_spins_intro` | `expanding` | `showing_wins` | `idle`) →
... → `game_over` (free spins summary). Every transition is an explicit assignment inside
`SlotEngine`, not inferred from animation progress — e.g. a reel's landing tween is scheduled
to finish at a precomputed timestamp (`landStartTime`), so "did it land" is never a question
answered by polling physics.

**Public methods a game calls:**
- `requestSpin()` — the one entry point for a UI's spin/stop button; safe to call in any
  state (queues itself if the engine is mid-animation, e.g. during an expansion).
- `spin(seed?)` / `stopSpin()` — start a spin (optionally replaying a specific seed) / cut the
  current spin short.
- `forceWinResult('scatter' | 'expanding' | 'bigwin')` — debug/cheat helper; forces the next
  spin's grid to contain a given outcome (see each game's README for its cheat buttons).
- `enterFreeSpinsIntro()` / `enterFreeSpins(spinsCount, expandingSymbol)` /
  `retriggerFreeSpins(spinsCount)` / `returnToIdle()` / `exitFreeSpins()` — free-spins
  lifecycle, entirely game-driven (see "Adding free spins" below) — `SlotEngine` never enters
  or exits free spins on its own.
- `updateBet()` — recompute `totalBet` after changing `betPerLine`/`linesCount`.
- `loadAssets(spritesheetUrl?, symbolsConfig?)` — (re)load the sprite atlas, e.g. for a theme
  switcher.
- `runSimulation(numBaseSpins?, betPerLine?, linesCount?)` — thin wrapper around
  `SpinSimulator.simulateSpins` using this engine's own live `config`, so a simulation always
  measures exactly what the running game would actually pay.

Rendering (`render()` and everything below it) is internal — a game never calls into it
directly, only supplies the sprite atlas and reacts to `onStateChange`/`onWin` to update its
own DOM (balance display, spin button label, etc.).

## `core/SpinSimulator.js` — headless simulation and auto-tuning

Also pure/side-effect-free (no DOM), built on top of `SlotMath.js`'s same evaluators — a
simulated RTP is never a separate model of the game, it's the same `checkWins`/
`checkWildLineWins`/`generateReel` a live spin uses, just run in a loop.

- **`simulateSpins(config, numBaseSpins, betPerLine, linesCount, rng)`** — runs
  `numBaseSpins` spins (plus any triggered free-spin rounds) through `config.winEvaluator`
  (defaulting to `checkWins`) and returns aggregate stats: `rtp`, `maxWin`, win/hit
  distributions, `freeSpinsTriggered`, etc. `config` is shaped like `SlotEngine`'s own config
  (`reelStrips`, `paytable`, `paylines`, `winEvaluator`, ...) — in fact `SlotEngine.
  runSimulation()` passes its own `this.config` straight through.
- **`tuneFrequencies(paytable, reelFrequencyTables, options)`** — the RUN SIMULATION/TUNE
  FREQUENCIES panel's auto-balancer. Given a paytable and one frequency table per reel,
  searches for reel frequencies that hit a target RTP and free-spins trigger rate, returning a
  tuned clone (never mutates its input). See its own extensive JSDoc in the file for the full
  two-phase strategy (trigger-rate scaling, then a joint Nelder-Mead search over per-symbol
  weights) and every tuning knob (`orderingBiasByReel`, `limitPenaltyWeight`, `min`/`max`,
  `fixed`, ...) — that doc is deliberately the canonical reference, not duplicated here.
- **`gradientDescent1D`**, **`nelderMead`** — generic numerical optimizers `tuneFrequencies`
  is built from (log-space 1D search and an N-dimensional simplex search, respectively). Not
  slot-specific; exported mainly because `tuneFrequencies`' own tests exercise them directly.

## `core/SimulationPanel.js` — browser UI for the simulator

The DOM/rendering glue between a game's RUN SIMULATION / TUNE FREQUENCIES buttons and
`SpinSimulator.js`'s pure functions. A game never talks to `SpinSimulator.js` directly for its
UI — it calls these instead:

- **`runSimulationAndRender({ engine, paytable, betPerLine, linesCount, numSpins, domRefs
  })`** — runs `engine.runSimulation(...)` and renders RTP/win-distribution/per-symbol
  breakdown tables into the given modal DOM elements.
- **`openTuneFrequenciesPanel({ paytable, reelFrequencyTables, tuneConfig, domRefs })`** —
  opens the tuner UI (target RTP/trigger-rate inputs, per-reel ordering-bias dropdowns,
  live iteration progress), runs `tuneFrequencies`, and renders a diff plus a
  copy-pasteable result via `formatReelFrequencyTablesForCopy`. Never mutates the game's
  live reel tables itself — applying a tuned result means pasting it back into `game.js` and
  reloading, a deliberate, explicit source change rather than a silent runtime patch.
- **`formatReelFrequencyTablesForCopy(reelFrequencyTables)`** — renders an array of
  `{ defaults, symbols }` tables back into pasteable `export const FREQUENCY_REELn = {...}`
  source text (4-significant-figure frequencies, so values under 1 don't collapse into each
  other — see the top-level README).

## `core/SlotAudio.js` — synthesized sound effects

A singleton (`export const audio = new SlotAudio()`), imported and used directly by
`SlotEngine.js` — a game doesn't call it for gameplay sounds, only for `toggleMute()`/UI wiring
(mute button) and, in bookbookbook's case, `playScatterTrigger()` at custom points in its own
free-spins-intro flow. Every sound is a small Web Audio oscillator patch built at call time
(no audio asset files) — `playSpin`, `playReelStop(reelIndex)`, `playWin(payoutMultiplier)`,
`playScatterTrigger`, `playExpand`, `startBGM`/`stopBGM` (free-spins background loop),
`toggleMute`/`setMute`.

## Hooking up a new game

A game is a folder `games/<name>/` with three files, wired together by convention rather than
a plugin registry — there's no central list of games to update.

### 1. `game.js` — data + engine instantiation

1. Define the shared constants every other piece needs (`REELS_COUNT`, `ROWS_COUNT`,
   `REEL_LENGTH`, `REEL_SEEDS`, `BET_PER_LINE`, `LINES_COUNT`) — export them so `PAYLINES`
   sizing and later `tuneConfig` can't drift from what the live engine actually uses.
2. Define `PAYLINES` (see `SlotMath.js`'s payline shape above) and `PAYTABLE` (see the
   top-level README for the full field list: `payout`, `type`, `paymode`, `wild`,
   `wildOnly`/`wildExcludes`, `wildPenalty`, `aloneBonus`, `triggerFreeSpins`,
   `friendlyName`).
3. Define one `FREQUENCY_REELn` per reel and build `REEL_STRIPS` by mapping each through
   `generateReel(freqTable, REEL_LENGTH, seed, exclude, defaultTriggerMinGap, PAYTABLE)` — pass
   `PAYTABLE` explicitly as the 6th argument (per-reel tables don't carry `triggerFreeSpins`
   themselves).
4. Pick a `winEvaluator`: `checkWins` (the default — supports a positional `wildSymbol` and
   `scatterSymbol`) or `checkWildLineWins` (last-position-only wilds, all wild behavior read
   from `paytable`) from `SlotMath.js`, or a game-specific one with the same
   `(grid, paytable, paylines, activeLinesCount, ...)` shape.
5. On `window load`, build `symbolsConfig`/`spritesheetUrl` (see Asset loading below), then
   `new SlotEngine(canvas, { reelsCount, rowsCount, paytable, reelStrips, paylines,
   winEvaluator, wildSymbol, scatterSymbol, betPerLine, linesCount, symbolsConfig,
   spritesheetUrl, onStateChange, onScatterTrigger, onWin })`.
6. Wire the rest of the page's DOM controls (spin/auto/turbo/mute/bet/lines buttons) to the
   engine's public methods, and the RUN SIMULATION / TUNE FREQUENCIES buttons to
   `runSimulationAndRender`/`openTuneFrequenciesPanel` from `SimulationPanel.js`, passing the
   same `PAYTABLE`/`FREQUENCY_REELn`/`PAYLINES` the live engine uses.

### 2. `index.html` — the DOM contract `game.js` expects

There's no framework here — `game.js` looks up elements by hardcoded `id`, so the HTML has to
supply them. At minimum: `#game-canvas` (the render target), `#btn-spin`, `#btn-auto`,
`#btn-turbo`, `#btn-mute`, bet/lines adjuster buttons and value spans, `#game-ticker`, a
`#modal-paytable` with a `#paytable-grid-content` container `game.js` fills in dynamically
(never hand-author paytable text — it drifts), and a `#sim-modal` with the stat elements
`runSimulationAndRender`/`openTuneFrequenciesPanel` render into (`#sim-stats`, `#sim-rtp`,
`#sim-total-spins`, `#sim-max-win`, `#sim-free-spins`, plus `#btn-sim`/`#btn-tune`/
`#btn-close-sim`). Copy an existing game's `index.html` as the starting point rather than
writing this from scratch — the exact id set is easiest to get right by example.

### 3. Asset loading

`game.js` fetches `./assets/<themeName>/<themeName>.tiles.json` (a `{ sheet, tiles: [{name,
x, y, w, h}] }` sprite atlas manifest) and builds `symbolsConfig`/`spritesheetUrl` from it —
one sprite sheet, one JSON manifest per theme, symbol names in the manifest must match the
paytable's own symbol keys.

### Optional: free spins / expanding symbol

`SlotEngine` provides the mechanism but not the policy — it never decides on its own what a
scatter trigger means. To add a free-spins bonus (as bookbookbook does):

1. Set `scatterSymbol` in the engine config and mark the trigger symbol
   `triggerFreeSpins: true` in `PAYTABLE` (drives both `checkWins`'s `scatterWin.
   triggerFreeSpins` and `generateReel`'s default spacing — see the top-level README).
2. Handle `onScatterTrigger(scatterCount, isInFreeSpins)`: decide what counts as an initial
   trigger vs. a retrigger (bookbookbook: 3+ to start, 2+ during free spins to add spins), and
   call `engine.enterFreeSpinsIntro()` for the intro animation state.
3. Once the player/animation is ready, call `engine.enterFreeSpins(spinsCount,
   expandingSymbol)` — this sets `engine.inFreeSpins`/`expandingSymbol` and starts the bonus
   spins loop. A retrigger just calls `engine.retriggerFreeSpins(spinsCount)`.
4. While `engine.inFreeSpins && engine.expandingSymbol` is set, every spin's normal win
   evaluation is automatically followed by `checkExpandingWins` inside `evaluateSpinResult()`
   — nothing extra to call for that part.
5. On the bonus's last spin, the engine transitions to `game_over`; handle that in
   `onStateChange` to show a summary and eventually call `engine.exitFreeSpins()` /
   `engine.returnToIdle()` to resume normal play.

## Design principles

- **Pure math, stateful engine, no DOM in between.** `SlotMath.js` has zero dependencies —
  not even on `SlotEngine.js`. This is why `SpinSimulator.js` can run a million spins in
  Node with no browser, and why `tests/*.mjs` can test win logic and reel building directly
  without ever constructing a `SlotEngine` or touching a canvas.
- **One source of truth per game, shared by three consumers.** A game's `PAYTABLE`,
  `PAYLINES`, and `FREQUENCY_REELn` tables are defined once in `game.js` and passed
  unchanged into the live `SlotEngine`, into `RUN SIMULATION` (`simulateSpins`), and into
  `TUNE FREQUENCIES` (`tuneFrequencies`). There is no separate "simulation config" to keep in
  sync — the debug tools can't silently drift from what the live game actually pays out
  because they're never given the chance to hold their own copy.
- **Nothing in `core/` hardcodes a symbol name, grid size, or paytable shape.** Every
  behavior (wild rules, scatter/trigger detection, expanding symbol, ordering preferences) is
  read from the `paytable`/config a game supplies. `checkWildLineWins`, for instance, works
  for any wild-in-last-position paytable, not just fruitmachine's specific one.
  `generateReel`'s `minGap`/`maxStack`/`triggerFreeSpins` logic is entirely data-driven off
  the reel table and paytable passed in.
- **Deterministic, seedable randomness everywhere an outcome matters.** `createSeededRng`
  is the one RNG primitive threaded through reel building, live spins (so
  `engine.spin(engine.lastSpinSeed)` replays exactly), and the tuner's optimization search
  (common random numbers, so consecutive candidate evaluations are comparable instead of
  independently noisy). Only cosmetic randomness (which decorative symbol flickers past while
  spinning, particle effect angles) uses plain `Math.random()`.
- **A state machine, not ad hoc flags.** `SlotEngine.state` is a single explicit field with a
  fixed set of values and every transition assigned at a specific point in the code (see the
  State machine table above) — not inferred from polling animation progress. Animation tweens
  are scheduled against precomputed timestamps instead, so "is it done" is answered by
  arithmetic, never by a race between rendering and game logic.
- **Best-effort, never-throw constraint solving.** `generateReel`'s `minGap`/`maxStack`
  repair passes and `tuneFrequencies`' soft ordering/min/max penalties all degrade gracefully
  when a constraint can't be fully satisfied (a too-dense reel, a genuinely conflicting
  target) rather than throwing or looping forever — a bad frequency table produces a
  best-effort reel or a logged violation, not a crash.
- **Debug tooling calls the same code path as the live game, not a re-implementation.**
  `RUN SIMULATION` runs through `engine.runSimulation()` → `simulateSpins(this.config, ...)`
  — literally the running engine's own config object. `TUNE FREQUENCIES` builds trial reels
  with the same `generateReel` and scores them with the same `winEvaluator` the live game
  uses. A simulated RTP is only ever trustworthy because of this — see the earlier
  `.toFixed(1)` frequency-rounding bug (documented in git history) for what happens when a
  *presentation-layer* formatter, not the math itself, silently diverges from the real values.
