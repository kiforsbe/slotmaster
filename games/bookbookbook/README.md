# Book of Book Book (bookbookbook)

A classic Book of Ra/Book of Dead-style 5-reel, 3-row machine with 10 paylines and a free
spins bonus.

See the top-level [README](../../README.md) for how reel frequency tables, `minGap`/
`maxStack`, and `tuneFrequencies` work in general; this file only covers what's specific to
this game.

## Symbols

`book` is the scatter: `type: 'scatter'`, `paymode: 'any'` (pays regardless of payline, not
per-line), and `triggerFreeSpins: true` — landing enough `book`s triggers the free spins
bonus. Because `paymode: 'any'` matches this symbol's `type: 'scatter'` default (see the
top-level README), it's written here explicitly for clarity rather than relying on the
default, but removing it would change nothing.

`explorer` through `ten` are the regular line-pay symbols (`paymode: 'line'`, also written
explicitly even though it's the default for a non-scatter symbol).

All five reels currently carry identical frequencies (a straight port of the game's original
single shared frequency table) — differentiating them is what TUNE FREQUENCIES is for.
`book`'s frequency is intentionally left untouched by tuning: see the comment above
`FREQUENCY_REEL1` in `game.js`.

## Free spins / expanding symbol

Landing a free-spins trigger picks one random non-scatter symbol (`EXPANDING_CANDIDATES` —
every paytable symbol except `book`) as that free spins round's **expanding symbol**: any
landing of it fills its entire reel for that spin. 10 free spins are awarded per trigger, and
retriggering during free spins adds more.

## Tuning this game

Open the game, click **TUNE FREQUENCIES**. Phase 1 scales `book`'s frequency (identically
across all 5 reels) to hit the target trigger rate; Phase 2 tunes every other symbol's
per-reel frequency to hit target RTP. If Phase 1 reports doing nothing, that's expected when
`book`'s baseline trigger rate already sits inside the target band — see the comment above
`FREQUENCY_REEL1` in `game.js`.
