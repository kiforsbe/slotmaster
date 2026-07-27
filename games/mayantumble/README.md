# Mayan Tumble

Mayan Tumble is a 5×3 cascading slot game with paylines instead of clusters, set in a mysterious ancient Mayan temple. It uses the shared `core/` engine's cascade mechanic (`core/CascadeEngine.js` + `core/CascadeMath.js`) coupled with payline-based evaluation (`core/SlotMath.js`'s checkWins) mapped to cascading tiles.

## Rules

- **10 Paylines.** Win combinations are evaluated on 10 standard paylines (left-to-right from reel 1).
- **Cascading / Tumbling.** Winning payline symbols are removed from the grid. Remaining symbols fall down to close the gaps, and new symbols tumble down from the top to refill the vacated positions. The new grid is then re-evaluated for any new payline wins, cascading repeatedly within the same spin until no new payline wins are formed.
- **Bonus / Free Spins.** 3+ `gold` scatter symbols anywhere on the grid (even across multiple cascade steps) trigger **10 Free Spins**. Retriggers during free spins add 10 additional spins to the remaining total.
- **Multiplier Tiles (Free Spins only).** During Free Spins, winning tiles leave behind a persistent multiplier. The multiplier doubles each time a win occurs on that tile (1x → 2x → 4x → 8x → 16x → ...). When a new winning combination lands on those tiles, the multipliers are summed and applied to the payout. Multipliers reset at the end of the bonus round.
- **Regular Symbols:** Ten, Jack, Queen, King, Ace.
- **Premium Symbols:** Llama, Mayan Face, Maize, Mayan Head, Jaguar.
- **Scatter Symbol:** Gold. (Triggers 10 Free Spins for 3+ scatters, and pays anywhere on the grid like in `bookbookbook`).

## Dev Tooling

- **SPIN LOG, RUN SIMULATION, and TUNE FREQUENCIES** are supported using the custom line-cascade win evaluator. Run the tuner in-browser to calibrate reel weights and achieve the targeted RTP of ~96%.
