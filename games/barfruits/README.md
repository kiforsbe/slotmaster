# Bar Fruits (barfruits)

A classic bar-and-fruit slot, built as a fresh game on top of fruitmachine's asset pack and
conventions: 5 reels, 3 rows, 10 fixed paylines, no wild, and a star scatter that pays
anywhere and triggers free spins.

See the top-level [README](../../README.md) for how reel frequency tables, `minGap`/
`maxStack`, and `tuneFrequencies` work in general; this file only covers what's specific to
this game.

## Paylines

10 fixed lines across the 5x3 grid (`PAYLINES` in `game.js`) - the standard 10-line template
for this grid size (see `docs/PAYLINES-TEMPLATES.md`'s "5x3 playfield"), the same lines
bookbookbook uses: 3 horizontal rows, V/inverted-V, step down-up/up-down, U-shape top/bottom,
and a zigzag.

## Symbols and paytable

Only 3, 4, or 5 of a kind pay (nothing on 1 or 2), left-to-right from reel 1:

| Symbol | Type | 3 | 4 | 5 |
|---|---|---|---|---|
| Star (scatter) | scatter | 2x | 10x | 50x |
| Triple Bar | premium | 100x | 500x | 2000x |
| Double Bar | premium | 50x | 200x | 750x |
| Single Bar | premium | 30x | 100x | 400x |
| Golden Bell | premium | 20x | 60x | 200x |
| Lucky Clover | premium | 15x | 50x | 150x |
| Strawberry | regular | 10x | 30x | 100x |
| Plum | regular | 8x | 25x | 80x |
| Grapes | regular | 6x | 20x | 60x |
| Orange | regular | 5x | 15x | 50x |
| Watermelon | regular | 4x | 12x | 40x |

No wild symbol - every win is a natural match, evaluated by `checkWins` (`core/SlotMath.js`'s
default `winEvaluator`), same as bookbookbook.

## Scatter and free spins

`star` is `type: 'scatter'`, `paymode: 'any'` (pays anywhere on the grid, not tied to a
payline), and `triggerFreeSpins: true`. Landing 3+ anywhere both pays the scatter amount above
and awards free spins, by count: **3 = 10 spins, 4 = 15 spins (+5), 5 = 20 spins (+10)**
(`FREE_SPINS_AWARD` in `game.js`). The same table applies whether this is the initial trigger
or a retrigger during an active free spins round - there's no separate initial-vs-retrigger
distinction like bookbookbook's.

Unlike bookbookbook, there's **no expanding symbol** - `game.js` calls
`engine.enterFreeSpins(awardedSpins, null)` with no expanding symbol, so free spins just run
the same win math as the base game with no bet deducted per spin. "Plain old free spins," per
spec.

Each reel's `star` entry sets an explicit `minGap: 3` (equal to `ROWS_COUNT`) so two stars can
never land inside the same reel's visible window at once - this happens to equal
`generateReel`'s own triggerFreeSpins-based default (also `3`), so it's redundant today, but
written explicitly so it stays correct if `ROWS_COUNT` ever changes. `maxStack: 1`
additionally guarantees it never repeats back-to-back on the strip.

## Reels

All five `FREQUENCY_REELn` tables start out identical (same pattern as bookbookbook - a plain
baseline, differentiate per reel via TUNE FREQUENCIES), using the same shared
`games/fruitmachine/assets/fruitmachine_1` sprite pack (copied into this game's own
`assets/fruitmachine_1/` folder) - `bar`, `bar_double` ("Double Bar"), `bar_triple` ("Triple
Bar"), `clover`, `bell`, `melon`, `orange`, `plum`, `grapes`, `strawberry`, and `star` are all
already present in that pack's tile atlas.

## Betting

Per-line bet: `$0.10` default and step, up to `$10` max. Lines: 1-10, adjustable
independently of bet size (same pattern as fruitmachine); total bet is always `betPerLine ×
linesCount`.

## Controls

Same as fruitmachine (SPIN/STOP, AUTO, TURBO, mute, PAYTABLE modal), plus a free spins panel
and trigger/summary modals (same pattern as bookbookbook, minus the expanding-symbol pieces).

## Debug tools

**RUN SIMULATION** and **TUNE FREQUENCIES** work the same as the other games. **SPIN LOG**
opens a live table of recent real spins (seed, bet, win, win breakdown) with a CSV export
button (see the top-level README's "Spin logging" section). `game.js` has a `DEBUG_MODE` flag
(on by default) with two cheat buttons: force a scatter trigger, or force a line big win.

## Tuning status

The frequencies in `FREQUENCY_REELn` are a plain, untuned baseline (rarer for premiums, common
for fruits) - they have **not** been through a TUNE FREQUENCIES pass yet, since that requires
the in-browser panel. `tests/barfruits.test.mjs` only checks that the math wiring itself is
sane (consistent shapes, star's spacing constraint, a finite RTP), not that RTP is anywhere
near a target - run TUNE FREQUENCIES in-browser before treating this paytable as final.

---
_Last updated: 2026-07-25, commit `a674e00`._
