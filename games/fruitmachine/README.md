# Lucky Fruits (fruitmachine)

![Lucky Fruits screenshot](screenshot.png)

A classic 3-reel, 3-row fruit machine, adjustable 1-5 paylines. No free spins or bonus
round — a straightforward line-pay machine, wilds and all.

See the top-level [README](../../README.md) for how reel frequency tables, `minGap`/
`maxStack`, and `tuneFrequencies` work in general; this file only covers what's specific to
this game.

## Paylines

5 fixed lines across the 3x3 grid (`PAYLINES` in `game.js`), selectable 1-5 via the LINES
control — only the first N lines are active for a given spin:

1. Middle row
2. Bottom row
3. Top row
4. Diagonal, bottom-left to upper-right
5. Diagonal, upper-left to bottom-right

## Symbols and paytable

| Symbol | Type | Payout (3 of a kind) | Notes |
|---|---|---|---|
| Bar | premium | 50x | Highest regular payout |
| Clover | regular | 20x | -1 tier penalty when the line is completed via wild |
| Pear | regular | 15x | Wild penalty |
| Watermelon | regular | 15x | Wild penalty |
| Grapes | regular | 10x | Wild penalty |
| Plum | regular | 10x | |
| Orange | regular | 8x | |
| Cherries | regular | 2x / 4x / 8x for 1 / 2 / 3 | Only symbol that pays on 1 or 2 of a kind |
| Star | wild | — | See Wilds below |
| Strawberry | wild | — | See Wilds below |

Payouts are multipliers of `BET_PER_LINE` ($0.20, the game's original per-line unit — total
bet is `betPerLine × linesCount`).

`bar` is the sole `type: 'premium'` symbol — the one TUNE FREQUENCIES' premium/other
reallocation phase actually differentiates from the `type: 'regular'` symbols.

## Wilds

Both wilds only ever appear on **reel 3** (`FREQUENCY_REEL1`/`REEL2` set their frequency to
`0`) — a wild can only complete a line, never start one — and both are `fixed: true` on every
reel, so TUNE FREQUENCIES never adjusts their frequency. On reel 3 they're additionally capped
to `maxStack: 1` and spaced `minGap: 3` apart, and softly bounded to a target frequency range
via `min`/`max`.

- **Star** — substitutes for any symbol in the last (reel-3) position of a line *except*
  `cherries` and `bar` (`wildExcludes`).
- **Strawberry** — substitutes the same way, but also pays a flat `aloneBonus` (4x) whenever
  it lands in the last position without contributing to any line win — a small consolation
  payout independent of the other two reels.

## Betting

- Per-line bet: `$0.20` default and step, up to `$20` max (`BET_PER_LINE`/`_STEP`/`_MAX`).
- Lines: 1-5, adjustable independently of bet size; total bet is always `betPerLine ×
  linesCount`.

## Controls

SPIN / STOP, AUTO (auto-spin until toggled off), TURBO (faster spin animation), mute, and a
PAYTABLE modal that renders payouts and a preview of each of the 5 paylines directly from
`PAYTABLE`/`PAYLINES` (so it can't drift out of sync with the actual math).

## Debug tools

**RUN SIMULATION** runs 1,000,000 spins headlessly through the same win evaluator
(`checkWildLineWins`) the live game uses and reports measured RTP/max win, seeding the run and
offering a per-spin CSV export (see the top-level README's "Spin logging" section). **TUNE
FREQUENCIES** opens the auto-tuner (`core/SpinSimulator.js`/`core/ui/dev/SimulationPanel.js`) against this
game's own paytable and reel tables (`core/ui/dev/TuningPanel.js`) — since there's no scatter/free-spins symbol here, its
trigger-rate phase is a no-op and only the RTP/ordering phase runs. **SPIN LOG** opens a live
table of recent real spins (seed, bet, win, win breakdown), also exportable as CSV.

---
_Last updated: 2026-07-25, commit `a674e00`._
