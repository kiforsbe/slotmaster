# Mayan Tumble

![Mayan Tumble screenshot](screenshot.png)

Mayan Tumble is a 5×3 cascading slot game with paylines instead of clusters, set in a mysterious ancient Mayan temple. It uses the shared `core/` engine's cascade mechanic (`core/CascadeEngine.js` + `core/CascadeMath.js`) coupled with payline-based evaluation (`core/SlotMath.js`'s `checkWins`) mapped to cascading tiles.

It is the first game to pair `CascadeEngine` with a **line** evaluator rather than a cluster one —
which `CascadeSpinMechanic`'s own doc had long claimed was possible ("a future line-win-based
cascade game reuses this mechanic unmodified, just with its own evaluator/`payoutOf`") but nothing
had actually exercised. The claim held: no engine or mechanic change was needed. What did need
changing was everything *around* it that had quietly started using "cascade" and "cluster" as the
same word — see [Payline indicators](#payline-indicators) and [Playfield](#playfield) below.

`checkLineCascadeWins` (in `game.js`) is that evaluator: it runs `SlotMath.js`'s `checkWins` and
maps its `lineWins` into the `clusterWins` shape `resolveCascadeSequence` expects, dividing each
line payout by the line count so payouts stay relative to the total bet.

## Rules

- **10 Paylines.** Win combinations are evaluated on 10 standard paylines (left-to-right from reel 1). Each win draws the line that paid it — see below.
- **Cascading / Tumbling.** Winning payline symbols are removed from the grid. Remaining symbols fall down to close the gaps, and new symbols tumble down from the top to refill the vacated positions. The new grid is then re-evaluated for any new payline wins, cascading repeatedly within the same spin until no new payline wins are formed.
- **Bonus / Free Spins.** 3+ `gold` scatter symbols anywhere on the grid (even across multiple cascade steps) trigger **10 Free Spins**. Retriggers during free spins add 10 additional spins to the remaining total.
- **Multiplier Tiles (Free Spins only).** During Free Spins, winning tiles leave behind a persistent multiplier. The multiplier doubles each time a win occurs on that tile (1x → 2x → 4x → 8x → 16x → ...). When a new winning combination lands on those tiles, the multipliers are summed and applied to the payout. Multipliers reset at the end of the bonus round.
- **Regular Symbols:** Ten, Jack, Queen, King, Ace.
- **Premium Symbols:** Llama, Mayan Face, Maize, Mayan Head, Jaguar.
- **Scatter Symbol:** Gold. (Triggers 10 Free Spins for 3+ scatters, and pays anywhere on the grid like in `bookbookbook`).

## Payline indicators

Each win draws its own line across the grid, numbered at both ends, while that win is being paid —
one at a time, in the same sequence the engine already uses for glow, particles, popup and ding.
Ten lines at once would be an unreadable tangle *and* a different presentation from the one the
rest of the spin uses.

This matters more here than on a cluster game. A cluster is a set of cells and that is the whole
story; three matching symbols on a 5×3 grid sit on several paylines at once, so the highlighted
cells alone cannot tell you which line you were paid for, and the payout differs per line.

`checkLineCascadeWins` therefore carries `lineIndex` through from `checkWins`, and `CascadeEngine`
draws a path for any win that has one. A cluster win carries none, so Candy Frenzy is unaffected.
The scatter deliberately carries none either — it pays anywhere, so `lineIndex: 0` would draw
payline 1 across a win that has nothing to do with it.

The line runs from one numbered tag's centre to the other, through every cell between: the tags
are where a line begins and ends, not decorations parked beside it. `SlotEngine` draws the same
way, and got the same fix.

## Playfield

`CascadeEngine` draws everything behind and around the symbols, and it used to draw it in Candy
Frenzy's pink-on-purple — one engine, two games, one hardcoded palette — which is why this game's
stone-and-jade art sat on a synthwave cabinet. The playfield is now themed per game via the
engine's `playfield` config, whose defaults *are* the Candy Frenzy look, so a game that passes
nothing is unchanged.

Mayan Tumble passes a stone-and-jungle theme: a dark green backdrop, a weathered gold outline with
only a soft halo instead of a neon glow, **no ruled cells**, and a fixed grain across the surface
in their place. Dropping the grid is a real choice, not a colour one — a cluster game wants its
cells ruled, because a cluster *is* a set of cells and the ruling is what makes its shape legible,
but a payline win is a path across the grid and the lines only made the playfield look like a
spreadsheet with art in it.

The grain is generated once into an offscreen canvas and blitted, not regenerated per frame — a
crawling backdrop reads as a rendering fault rather than as texture. It is seeded too, so it is
identical on every load.

## Dev Tooling

**SPIN LOG, RUN SIMULATION, and TUNE FREQUENCIES** all work, using the custom line-cascade
evaluator. The reels are **not tuned yet** — short runs land anywhere from 89% to 103% against a
~96% target, so run the tuner in-browser before treating the shipped frequencies as final.

Tuning trials run in Worker threads, and a closure cannot cross `postMessage`, so the worker
rebuilds this game's evaluator from `winEvaluatorName` plus the primitives in `tuneConfig`
(`core/mechanicRegistry.js`). **Anything the evaluator closes over has to be listed there.**
`paylines` was not, which is why START TUNING died on the first trial with `Cannot read properties
of undefined (reading 'length')`, reported from a stack pointing at the worker pool's own settle
function — naming neither the game, the evaluator, nor the field. A builder now declares what it
cannot be rebuilt without and fails by name instead.

`tests/mayantumble.test.mjs` asserts the rebuilt evaluator is **field-for-field** identical to the
one the game plays with, not merely payout-equivalent. That is what catches a dropped field like
`lineIndex`; RTP alone would not notice.

## Debug cheat

The **Bonus Trigger** button (visible when `DEBUG_MODE = true` in `game.js`) forces the next
spin's final grid to contain 3 `gold` symbols, for testing the free-spins trigger and retrigger
without waiting for a natural hit.

---
_Docs last synced with the codebase: 2026-07-27, commit `66218c8`._
