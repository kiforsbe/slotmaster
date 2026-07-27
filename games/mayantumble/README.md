# Mayan Tumble

Mayan Tumble is a 5×3 cascading slot game with paylines instead of clusters, set in a mysterious ancient Mayan temple. It uses the shared `core/` engine's cascade mechanic (`core/CascadeEngine.js` + `core/CascadeMath.js`) coupled with payline-based evaluation (`core/SlotMath.js`'s checkWins) mapped to cascading tiles.

## Rules

- **10 Paylines.** Win combinations are evaluated on 10 standard paylines (left-to-right from reel 1).
  Each win draws its own line across the grid, numbered at both ends, while that win is being
  paid — one at a time, in the same sequence the engine already uses for glow, particles and the
  win popup. This matters more here than on a cluster game: three matching symbols on a 5×3 grid
  sit on several paylines at once, so the highlighted cells alone cannot tell you which line you
  were paid for, and the payout differs per line. `CascadeEngine` draws a path for any win
  carrying a `lineIndex`; a cluster win carries none, so Candy Frenzy is unaffected.
- **Cascading / Tumbling.** Winning payline symbols are removed from the grid. Remaining symbols fall down to close the gaps, and new symbols tumble down from the top to refill the vacated positions. The new grid is then re-evaluated for any new payline wins, cascading repeatedly within the same spin until no new payline wins are formed.
- **Bonus / Free Spins.** 3+ `gold` scatter symbols anywhere on the grid (even across multiple cascade steps) trigger **10 Free Spins**. Retriggers during free spins add 10 additional spins to the remaining total.
- **Multiplier Tiles (Free Spins only).** During Free Spins, winning tiles leave behind a persistent multiplier. The multiplier doubles each time a win occurs on that tile (1x → 2x → 4x → 8x → 16x → ...). When a new winning combination lands on those tiles, the multipliers are summed and applied to the payout. Multipliers reset at the end of the bonus round.
- **Regular Symbols:** Ten, Jack, Queen, King, Ace.
- **Premium Symbols:** Llama, Mayan Face, Maize, Mayan Head, Jaguar.
- **Scatter Symbol:** Gold. (Triggers 10 Free Spins for 3+ scatters, and pays anywhere on the grid like in `bookbookbook`).

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

- **SPIN LOG, RUN SIMULATION, and TUNE FREQUENCIES** are supported using the custom line-cascade win evaluator. Run the tuner in-browser to calibrate reel weights and achieve the targeted RTP of ~96%. The reels are **not tuned yet** — short runs land anywhere from 89% to 103%.
- Tuning trials run in Worker threads, and a closure cannot cross `postMessage`, so the worker rebuilds this game's evaluator from `winEvaluatorName` plus the primitives in `tuneConfig` (`core/mechanicRegistry.js`). Anything the evaluator closes over — `paylines` above all — has to be listed there or the rebuild has nothing to evaluate against.

---
_Docs last synced with the codebase: 2026-07-27, commit `5d3cba7`._
