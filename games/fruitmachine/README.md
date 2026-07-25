# Lucky Fruits (fruitmachine)

A classic 3-reel, 3-row fruit machine. 5 paylines (three horizontal rows plus the two true
diagonals). No free spins or bonus round — a straightforward line-pay machine.

See the top-level [README](../../README.md) for how reel frequency tables, `minGap`/
`maxStack`, and `tuneFrequencies` work in general; this file only covers what's specific to
this game.

## Symbols

`bar` is the sole `type: 'premium'` symbol — the one TUNE FREQUENCIES' premium/other
reallocation phase acts on. `star` and `strawberry` are wilds (`star` excludes `cherries` and
`bar` from substitution via `wildExcludes`; `strawberry` pays an `aloneBonus` when it lands
without contributing to any other win). Both wilds are `fixed: true` on every reel — their
frequency is deliberately never touched by auto-tuning.

Reels 1 and 2 exclude `star`/`strawberry` entirely (`frequency: 0.0`); only reel 3 carries
them, with `maxStack: 1` and `minGap: 3` so a wild can't stack with itself or cluster tightly
on that reel.

## Bet model

Paytable payouts are multipliers of `BET_PER_LINE` (20 cents), calibrated against the
original cents-based paytable (e.g. 3 bars = $10 at a 20-cent line bet) — not multipliers of
total bet.

## Tuning this game

Open the game, click **TUNE FREQUENCIES**. Since there's no scatter/free-spins symbol here,
the trigger-rate phase (Phase 1) is a no-op — only the RTP/ordering phase (Phase 2) runs.
