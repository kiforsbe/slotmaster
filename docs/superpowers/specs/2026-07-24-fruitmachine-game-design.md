# Fruit Machine Game — Design

## Context

`core/SlotMath.js` and `core/SlotEngine.js` currently assume a single grid
shape everywhere: 5 reels × 3 rows, 10 fixed paylines (`PAYLINES`, a
module-level constant), and a book-of-dead-style win model (`checkWins` with
one global wild/scatter symbol, `checkExpandingWins` for free-spins
expansion). This is the only game (`games/bookbookbook`) exercising that
model today.

We're adding a second game, `games/fruitmachine`: a classic 3-reel, 5-line,
no-scatter, no-bonus fruit machine, targeting 96% RTP, using the art already
placed in `games/fruitmachine/assets/fruitmachine_1/` (16 symbols: `bar`,
`bar_double`, `bar_triple`, `clover`, `star`, `pear`, `melon`, `grapes`,
`plum`, `orange`, `cherries`, `strawberry`, `bell`, `diamond`, `luckyseven`,
`lemon`).

Its win rules don't fit `checkWins`'s single-global-wild model: two different
symbols (`star`, `strawberry`) act as wilds, each restricted to reel 3 only,
each valid for a different subset of target symbols, with a per-symbol payout
penalty and a bonus-on-non-win case. Building this means generalizing the
core grid/payline assumptions and adding a second, sibling win-evaluation
function alongside `checkWins`/`checkExpandingWins` — not bolting fruit
machine specifics onto the book game's model.

## Goals

- `core/SlotMath.js` and `core/SlotEngine.js` no longer assume a fixed grid
  shape or a fixed payline set; each game supplies its own `paylines`.
- `bookbookbook` keeps working unchanged (same paylines, same payouts, same
  visuals) after the refactor — verified by re-running its simulation.
- A new `games/fruitmachine` game: 3 reels × 3 rows, 5 paylines (3
  horizontal + 2 diagonals), pure line-pays, no scatter, no free spins, no
  bonus round, using the rules below.
- The fruit machine's symbol frequencies are tuned (via the existing
  `tuneFrequencies`) to land at 96% RTP.
- The RUN SIMULATION / TUNE FREQUENCIES dev tooling is extracted into a
  shared `core/SimulationPanel.js` used by both games, instead of being
  duplicated into the fruit machine's `game.js`.

## Non-goals

- No wild/scatter/bonus mechanics beyond what's specified below (no gamble
  feature, no hold/nudge, no free spins).
- Not reworking reel spin physics/timing (already seeded and time-driven per
  the prior design) — reused as-is.
- Not redesigning `SlotAudio.js` — reused as-is, same synthesized sound
  effects.
- Not removing the unused art (`bar_double`, `bar_triple`, `bell`, `diamond`,
  `luckyseven`) from the spritesheet/tiles.json — they simply aren't
  referenced by the paytable or reel strips.

## Design

### 1. Paylines move out of core

`core/SlotMath.js` stops exporting a `PAYLINES` constant. `checkWins` and
`checkExpandingWins` take `paylines` as an explicit parameter instead of
reading a shared import, and derive expected grid dimensions from the grid
itself (`grid.length` columns, `grid[0].length` rows) rather than hardcoding
5×3.

`games/bookbookbook/game.js` gains its own local `PAYLINES` constant (the
same 10 lines, byte-for-byte), and passes it to `checkWins`/`checkExpandingWins`
and to `SlotEngine`'s config. `games/bookbookbook/game.js`'s
`buildPaytableContent()` (which currently reads the imported `PAYLINES` to
render the mini payline-preview swatches) reads its own local constant
instead.

### 2. `SlotEngine.js` becomes payline-agnostic

- `config.paylines` is a new required config field (no default — every game
  must supply its own).
- `evaluateSpinResult()` passes `this.config.paylines` into the win-evaluator
  it calls (see §4) instead of an imported constant.
- `renderWinEffects()` currently loops `for (let col = 0; col < 5; col++)`
  when drawing the win-line path — a latent bug for any non-5-reel game. This
  becomes `for (let col = 0; col < this.config.reelsCount; col++)`, and reads
  `this.config.paylines[win.lineIndex]` instead of the imported `PAYLINES`.
- `wildSymbol`/`scatterSymbol` become config-driven (`config.wildSymbol`,
  `config.scatterSymbol`, both defaulting to `null`/none) instead of the
  hardcoded `'book'` literal currently in `evaluateSpinResult()`. Fruit
  machine passes neither (see §4 — its wild handling is inside the win
  evaluator, not the engine).

### 3. Grid & paylines for the fruit machine

3 reels × 3 rows. 5 lines, row index per reel (`0`=top, `1`=middle,
`2`=bottom):

```js
const PAYLINES = [
  [0, 0, 0], // top
  [1, 1, 1], // middle
  [2, 2, 2], // bottom
  [0, 1, 2], // diagonal, upper-left to bottom-right
  [2, 1, 0], // diagonal, bottom-left to upper-right
];
```

### 4. New win evaluator: `checkWildLineWins`

A new function exported from `core/SlotMath.js`, alongside `checkWins` and
`checkExpandingWins` — not a modification of `checkWins`. It's fully
data-driven from paytable fields (no hardcoded symbol names), so it's
reusable by any future game with reel-restricted wilds, not just this one:

```js
export function checkWildLineWins(grid, paytable, paylines, activeLinesCount)
```

Paytable fields it reads, all optional except `payout`:

| Field | On | Meaning |
|---|---|---|
| `payout` | every symbol | `[pay-for-1, pay-for-2, pay-for-3]`, left-to-right from reel 1. Non-cherry symbols use `[0, 0, N]`. |
| `wild: true` | wild symbols | This symbol can substitute in the *last* grid position of a line only (matches the fruit machine's reel-3-only wilds; a symbol only ever reaches this check after reels 1–2 already matched each other, since matching always starts at reel 1). |
| `wildExcludes: [...]` | wild symbols | List of target symbols this wild can *not* substitute for (e.g. `star` excludes `cherries`). |
| `wildOnly: [...]` | wild symbols | If present, this wild substitutes *only* for the listed target symbols (e.g. `strawberry`'s `wildOnly: ['cherries']`). |
| `wildPenalty` | target symbols | Amount subtracted from the 3-match payout when the win was completed via a wild rather than a natural match (e.g. `clover.wildPenalty = 1`). |
| `aloneBonus` | wild symbols | Flat amount paid on a line whenever this wild lands in the last position *without* completing a win for that line (e.g. `strawberry.aloneBonus = 0.80`). |

Per-line algorithm (`s0, s1, s2` = the line's three symbols, reel 1→3):

1. Compute the natural run length from `s0`: `run = 1`; if `s1 === s0`,
   `run = 2`; if additionally `s2 === s0`, `run = 3`.
2. If `run === 2` and `s2 !== s0`: check whether `s2` is a wild eligible for
   `s0` (`paytable[s2].wild` and not excluded by `wildExcludes`/`wildOnly`).
   If eligible, treat as `run = 3`, `payout = paytable[s0].payout[2] -
   (paytable[s0].wildPenalty || 0)`, and mark this line's wild as "used".
3. Otherwise, payout is `paytable[s0].payout[run - 1]` (zero for non-cherry
   symbols when `run < 3`).
4. Independently of 1–3: if `s2` has an `aloneBonus` and this line's wild was
   *not* marked "used" in step 2, add `paytable[s2].aloneBonus` to the line's
   total.

This reproduces every confirmed rule:
- `bar,bar,bar` → 10 (natural).
- `grapes,grapes,star` → `2 - 1 = 1` (wild-completed, penalized).
- `pear,pear,star` → `3` (wild-completed, unpenalized — no `wildPenalty` on
  `pear`).
- `cherries,cherries,star` → star excludes cherries, so run stays 2 → `0.80`
  (cherries' own 2-match rate), plus no alone bonus (star has none).
- `cherries,cherries,strawberry` → strawberry's `wildOnly` includes cherries
  → run 3 → `1.60`, wild marked "used" → no alone bonus (would double-pay).
- `bar,bar,strawberry` → strawberry not eligible for `bar` (`wildOnly`
  excludes it) → run stays 2, `payout[1] = 0` for bar → plus alone bonus
  `0.80` (wild not "used") → total `0.80`.
- `cherries,bar,strawberry` → run breaks at reel 2 (`s1 !== s0`) → `run = 1`
  → `0.40` → plus alone bonus (wild not "used", since s0/s1 aren't both
  cherries) → total `1.20`.

Return shape mirrors `checkWins`'s `lineWins` entries (`lineIndex`, `symbol`,
`count`, `payout`, `winningPositions`) so `SlotEngine`'s existing win-cycling,
highlight, and particle rendering work unchanged — plus an extra
`aloneBonus` boolean per win entry so the paytable modal / win ticker can
label it distinctly if desired (not required, but harmless to include for a
future UI polish pass).

### 5. Fruit machine paytable & reel composition

```js
const PAYTABLE = {
  bar:        { payout: [0, 0, 10],   frequency: ..., type: 'regular', friendlyName: 'Bar' },
  clover:     { payout: [0, 0, 4],    frequency: ..., type: 'regular', wildPenalty: 1, friendlyName: 'Clover' },
  pear:       { payout: [0, 0, 3],    frequency: ..., type: 'regular', friendlyName: 'Pear' },
  melon:      { payout: [0, 0, 3],    frequency: ..., type: 'regular', friendlyName: 'Watermelon' },
  grapes:     { payout: [0, 0, 2],    frequency: ..., type: 'regular', wildPenalty: 1, friendlyName: 'Grapes' },
  plum:       { payout: [0, 0, 2],    frequency: ..., type: 'regular', friendlyName: 'Plum' },
  orange:     { payout: [0, 0, 1.60], frequency: ..., type: 'regular', friendlyName: 'Orange' },
  cherries:   { payout: [0.40, 0.80, 1.60], frequency: ..., type: 'regular', friendlyName: 'Cherries' },
  star:       { payout: [0, 0, 0], frequency: ..., type: 'wild', wild: true, wildExcludes: ['cherries'], friendlyName: 'Star' },
  strawberry: { payout: [0, 0, 0], frequency: ..., type: 'wild', wild: true, wildOnly: ['cherries'], aloneBonus: 0.80, friendlyName: 'Strawberry' },
};
```

(`type` here is only used by `core/SimulationPanel.js`, §6, to group the
detailed win breakdown — it has no effect on `checkWildLineWins` itself.)

`bar_double`, `bar_triple`, `bell`, `diamond`, `luckyseven` are not included
— unused art, no reel strip weight, no payout.

Reel strips: `generateReel(PAYTABLE, length, seed, exclude)` is called with
`exclude: ['star', 'strawberry']` for reels 1 and 2, and no exclusion for
reel 3 — reusing the existing `exclude` parameter, no core change needed
here. This guarantees `star`/`strawberry` can only ever appear in the last
grid position of any line, which is what `checkWildLineWins` assumes.

Frequencies (the `...` above) are not hand-picked up front — they're
produced by running `tuneFrequencies` (already generic enough: it groups by
`paytable[symbol].type`/`frequency` and has no book-game-specific logic
beyond its scatter-tuning phase, which already no-ops when there are no
`type: 'scatter'` symbols) against this paytable and reel/grid config, target
RTP 96%, then hand-copied into the source like bookbookbook's `PAYTABLE`
already documents doing.

### 6. Shared dev tooling: `core/SimulationPanel.js`

`bookbookbook/game.js` has ~250 lines of RUN SIMULATION / TUNE FREQUENCIES
modal code (`runSimulation()`, `openTunePanel()`, `startTuning()`,
`formatPaytableForCopy()`) that's almost entirely generic DOM rendering over
`SpinSimulator.js`'s pure `simulateSpins`/`tuneFrequencies` output — it just
hasn't been factored out because there was only one game. Copy-pasting it
into `fruitmachine/game.js` would leave two copies to keep in sync by hand.
Two things in it are currently book-specific and need generalizing along the
way, not duplicating:

- `runSimulation()`'s "Detailed Win Breakdown" hardcodes `const
  premiumSymbols = ['book', ...Object.keys(PAYTABLE).filter(s =>
  PAYTABLE[s].type === 'premium')]`. This becomes purely data-driven: group
  symbols by `paytable[symbol].type` (defaulting to `'other'` if unset),
  in the order each type first appears in the paytable object — no
  hardcoded symbol or type name. (Book's paytable already has `type:
  'scatter'/'premium'/'regular'`; the fruit machine paytable gets a `type:
  'wild'/'regular'` field added for the same grouping to work — a small
  addition to §5's paytable sketch.)
- `formatPaytableForCopy()` hardcodes the exact field list (`frequency`,
  `type`, `paymode`, `wild`, `triggerFreeSpins`, `friendlyName`) to
  column-align. It becomes field-agnostic: format whichever scalar/array/
  boolean fields exist on each symbol (union across all symbols in the
  table), so it works unchanged for the fruit machine's different field set
  (`wildExcludes`, `wildOnly`, `wildPenalty`, `aloneBonus`).

Everything else (the sim-stats display, the win-table renderer, the tune
panel's inputs/progress log/results table, the copy-to-clipboard button)
moves as-is, parameterized by a config object instead of closing over
`bookbookbook/game.js`'s module-level constants:

```js
// core/SimulationPanel.js
export function runSimulationAndRender({ engine, paytable, betPerLine, linesCount, numSpins, domRefs }) { ... }
export function openTuneFrequenciesPanel({ paytable, tuneConfig, domRefs, onApply }) { ... }
export function formatPaytableForCopy(paytable) { ... }
```

`tuneConfig` is `{ reelsCount, rowsCount, paylines, reelSeeds, betPerLine,
linesCount, reelLength, winEvaluator }` — passed straight through to
`tuneFrequencies`'s options, so §7's `SpinSimulator.js` changes
(paylines/winEvaluator options) are exactly what this needs.

`domRefs` is the same set of element IDs both games' `index.html` already
define identically (`sim-modal`, `sim-stats`, `sim-rtp`,
`sim-total-spins`, `sim-max-win`, `sim-free-spins`, `btn-sim`, `btn-tune`,
`btn-close-sim`) — no HTML changes needed in either game beyond the fruit
machine's own copy of that markup.

**Left alone, not extracted:**
- The debug cheat buttons themselves (`forceWinResult('scatter'/'expanding'/'bigwin')`)
  stay in `bookbookbook/game.js` — scatter/expanding are mechanics the fruit
  machine doesn't have. `SlotEngine.forceWinResult()`'s `'bigwin'` branch has
  the same hardcoded-5-reels bug as `renderWinEffects` (§2) and gets the same
  fix (`this.config.reelsCount`), since it's the one mode both games can use;
  `'scatter'`/`'expanding'` stay book-only, gated on whether the game's
  config actually sets a scatter/expanding symbol.
- Basic spin/bet/autoplay/turbo/mute button wiring stays duplicated per
  game — it's small (~30 lines) and already varies slightly per game (bet
  caps, what "showing_wins" transitions to). Not worth abstracting for two
  call sites.

### 7. `SpinSimulator.js` changes

`simulateSpins` and `tuneFrequencies` currently call `checkWins` directly
(hardcoding the book game's win model) and build target grids assuming 5×3.
Both gain a `paylines` option and a `winEvaluator` option (defaulting to
`checkWins`, matching today's behavior exactly for bookbookbook), so the
fruit machine can pass `checkWildLineWins` and its own paylines/grid shape.
Target-grid generation already loops over `config.reelsCount`/`rowsCount`
generically — no change needed there.

### 8. `games/fruitmachine` game — UI scope

Built from `games/bookbookbook`'s `index.html`/`game.js` as a starting point,
trimmed and reworked:

**Kept, reused as-is or near-as-is:** cabinet/canvas layout, bet
adjust ± , spin button, autoplay, turbo, mute, paytable modal (rebuilt to
render this game's 10-entry paytable and 5 paylines instead of 10-symbol/10-line),
RUN SIMULATION and TUNE FREQUENCIES dev modal + buttons — both games now call
into `core/SimulationPanel.js` (§6) instead of each having their own copy.

**Removed:** free-spins panel, book-reveal 3D animation and its canvas, free
spins trigger/summary modals, scatter/expanding debug cheat buttons, theme
switcher (single `fruitmachine_1` theme only — no style_1..4 equivalent
exists yet).

**Theming/copy:** classic fruit-machine visual identity (distinct from
bookbookbook's Egyptian/gold theme) — exact palette/typography decided during
implementation, not prescribed here.

## Data flow summary

```
games/fruitmachine/game.js
  PAYTABLE, PAYLINES (local), REEL_STRIPS = REEL_SEEDS.map(seed =>
    generateReel(PAYTABLE, length, seed, reelIndex < 2 ? ['star','strawberry'] : []))

  new SlotEngine(canvas, {
    reelsCount: 3, rowsCount: 3, paytable: PAYTABLE, paylines: PAYLINES,
    reelStrips: REEL_STRIPS, winEvaluator: checkWildLineWins, ...
  })

SlotEngine.evaluateSpinResult()
  → this.config.winEvaluator(targetGrid, paytable, paylines, linesCount)  [SlotMath.js]
  → same downstream flow as today (winData, payout, particles, UI) — engine
    doesn't care which evaluator produced lineWins, as long as the shape matches
```

## Testing / verification

No test framework is configured in this repo (per the prior design doc);
verification follows the same ad hoc pattern already established:

- A scripted check that `checkWildLineWins` produces exactly the payouts
  worked through in §4's examples, for all the boundary cases (natural
  3-match, wild-completed with/without penalty, cherries 1/2/3, strawberry
  alone with and without an unrelated win on reels 1–2, strawberry completing
  cherries).
- Re-run `bookbookbook`'s existing simulation (`runSimulation` /
  `tuneFrequencies`) after the core refactor and confirm RTP/trigger-rate are
  unchanged from before — proves the paylines-out-of-core change is behavior
  preserving.
- Run the fruit machine's own simulation at high spin counts and confirm RTP
  converges near 96% before/after tuning.
- Manual in-browser verification (via the `run` skill): spin, autoplay, and
  turbo all work; wins highlight the correct lines/cells; paytable modal
  renders correctly; RUN SIMULATION and TUNE FREQUENCIES both work against
  the 3-reel config.
- After extracting `core/SimulationPanel.js`, re-run bookbookbook's RUN
  SIMULATION and TUNE FREQUENCIES from the UI and confirm the rendered
  output (stats, detailed win breakdown grouping, copy-paste paytable
  textarea) is identical to before the extraction — this is a pure
  refactor of that game's dev tooling, not a behavior change.

## Migration notes

- `core/SlotMath.js`: `PAYLINES` export removed. Any other future code
  importing it would break — currently only `bookbookbook/game.js` does, and
  that call site is updated as part of this change.
- `checkWins(grid, paytable, activeLinesCount, wildSymbol, scatterSymbol,
  scatterTriggerCount)` gains a `paylines` parameter. Call-site update needed
  in `SlotEngine.js` and `SpinSimulator.js` (both currently call it without a
  paylines arg, relying on the old default import).
- `checkExpandingWins` similarly gains a `paylines` parameter for the same
  reason (it also reads the module-level `PAYLINES` internally today).
- `bookbookbook/game.js`'s `runSimulation()`, `openTunePanel()`,
  `startTuning()`, and `formatPaytableForCopy()` are deleted from that file
  and replaced with calls into the new `core/SimulationPanel.js` (§6). No
  `index.html` changes needed in `bookbookbook` — the DOM IDs it already
  wires up (`sim-modal`, `sim-rtp`, etc.) are exactly what the shared module
  expects.
