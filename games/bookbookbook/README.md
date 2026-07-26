# Book of Book Book (bookbookbook)

![Book of Book Book screenshot](screenshot.png)

A classic Book of Ra/Book of Dead-style 5-reel, 3-row machine, adjustable 1-10 paylines, with
a book-scatter-triggered free spins bonus and an expanding symbol.

See the top-level [README](../../README.md) for how reel frequency tables, `minGap`/
`maxStack`, and `tuneFrequencies` work in general; this file only covers what's specific to
this game.

## Paylines

10 fixed lines across the 5x3 grid (`PAYLINES` in `game.js`), selectable 1-10 via the LINES
control (see Betting below) — only the first N lines are active for a given spin:

1. Horizontal middle row
2. Horizontal top row
3. Horizontal bottom row
4. V-shape
5. Inverted V-shape
6. Step down-up
7. Step up-down
8. U-shape bottom
9. U-shape top
10. Zigzag

## Symbols and paytable

Payouts are multipliers of the total line bet, for N-of-a-kind left-to-right on a payline
(except `book`, see Scatter below):

| Symbol | Type | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Book of Books | scatter | — | 2x | 20x | 200x |
| The Explorer | premium | 10x | 100x | 1000x | 5000x |
| Tutankhamun | premium | 5x | 40x | 400x | 2000x |
| Anubis Guard | premium | 5x | 30x | 100x | 750x |
| Scarab Beetle | premium | 5x | 30x | 100x | 750x |
| Golden Ace | regular | — | 5x | 40x | 150x |
| Pharaoh King | regular | — | 5x | 40x | 150x |
| Royal Queen | regular | — | 5x | 30x | 100x |
| Desert Jack | regular | — | 5x | 30x | 100x |
| Lucky Ten | regular | — | 5x | 30x | 100x |

## Scatter and free spins

`book` is `type: 'scatter'`, `paymode: 'any'` (pays on any grid position, not tied to a
payline — evaluated separately from line wins), and `triggerFreeSpins: true`. 3+ `book`s
anywhere on the grid both pays the scatter amount above *and* triggers the bonus: an
"open book" animation reveals one randomly-chosen non-scatter symbol as that round's
**expanding symbol**, then awards **10 free spins**.

During free spins, any landing of the expanding symbol expands to fill its *entire* reel for
that spin before wins are evaluated — the main way big wins happen in this game. Landing 2+
more `book`s during free spins retriggers extra spins instead of restarting the bonus:
2 → +5, 3 → +10, 4 → +15, 5 → +20 (`handleScatterRetrigger` in `game.js`).

All five reels currently carry identical frequencies (a straight port of the game's original
single shared frequency table) — differentiating them per reel is what TUNE FREQUENCIES is
for. `book`'s frequency is intentionally left untouched by tuning on every reel: see the
comment above `FREQUENCY_REEL1` in `game.js` for why (its baseline trigger rate already sits
inside the tuner's default target band).

## Betting

Per-line bet: `$0.10` default, step, and minimum, up to `$100` max (`BET_PER_LINE`/`_STEP`/
`_MAX` in `game.js`). Lines: 1-10, adjustable independently of bet size (same pattern as
fruitmachine/barfruits); total bet (`betPerLine × linesCount`) is shown in its own dashboard
panel. Note: `BET_PER_LINE`/`LINES_COUNT` must be passed explicitly into the `new
SlotEngine(...)` config — they aren't picked up automatically just by being defined, since
`SlotEngine` falls back to its own defaults (`$1`, 10 lines) otherwise.

## Controls

SPIN / STOP, AUTO, TURBO, mute, a theme switcher (swaps the sprite sheet/tile config live via
`loadThemeAssets`), and a PAYTABLE modal rendering payouts and payline previews straight from
`PAYTABLE`/`PAYLINES`. A dedicated free spins panel shows spins remaining/total and the
current expanding symbol during the bonus.

## Debug tools

**RUN SIMULATION** and **TUNE FREQUENCIES** work the same as in fruitmachine (see the
top-level README), against this game's `PAYTABLE` and five `FREQUENCY_REELn` tables — both are
configured with `hasExpandingWild: true` (see `docs/ARCHITECTURE.md`'s `simulateSpins` entry),
since this game's free spins really do include one; omitting it would silently under-measure
RTP. **SPIN LOG** opens a live table of recent real spins with a CSV export button (see the
top-level README's "Spin logging" section). `game.js` also has a `DEBUG_MODE` flag (on by
default) that enables three cheat buttons for manually forcing a scatter trigger, an
expanding-symbol win, or a big win, for testing the bonus flow without waiting on real spins.

---
_Last updated: 2026-07-25, commit `a674e00`._
