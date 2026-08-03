# Beach Party — Design

Status: approved 2026-08-03, ready for implementation.

A 5-reel, 5-row, 30-line reel game (`LineMechanic` + `ReelScrollAnimator`, template: barfruits for
winline mechanics, lemonpop for game-init/reel-management scaffolding). New wide 256×128 tile art
(vs. every other game's square tiles) and tall multi-row "stacked" surfer symbols are the two
features that don't exist anywhere else in the codebase yet.

## 1. Core engine changes

Three small, generic, config-driven additions — none hardcode a Beach Party symbol name or
grid size, consistent with "nothing in `core/` imports from `games/`":

1. **Non-square cells** (`core/rendering/GridLayout.js`, `core/engine/CoreSlotEngine.js`).
   `computeGridLayout` currently derives one `cellSize` used for both width and height. Add an
   optional `symbolAspectRatio` param (width ÷ height, default `1`, unchanged for every existing
   game) so a game can request wide cells. `CoreSlotEngine.resize()` reads
   `config.symbolAspectRatio` and sets `this.symbolWidth`/`this.symbolHeight` from the fitted
   width/height instead of assuming they're equal. Beach Party passes `symbolAspectRatio: 2`
   (256÷128).
2. **Free-spins viewport background swap for line-pay games**
   (`core/rendering/SlotRenderer.js`, `_drawLine`). Today only the cascade "pop-rush" phase swaps
   backgrounds (`engine.presentationPhase === 'pop-rush'`), which no `LineMechanic` game uses.
   Add the line-pay equivalent: when `engine.inFreeSpins`, prefer
   `config.freeSpinsViewportBackground` over `config.viewportBackground`. Beach Party sets base →
   `beach_lifeguard_hut_2.png`, bonus → `boards_on_the_beach.png`.
3. **Stacked-symbol renderer.** A new config map, `stackedSymbols: { [baseSymbol]: [variantTile1,
   ..., variantTileN] }`. Wherever `SlotRenderer` resolves which sprite tile to draw for a grid
   cell (landed/idle grid draw, and the win-highlight/clear-overlay paths — NOT the fast-spin
   blur state, which never shows individual tiles), it checks: does `grid[col]` contain
   `variants.length` consecutive cells of `baseSymbol` including this one? If the whole column
   (all `rowsCount` cells) is `baseSymbol`, draw `variants[row]` instead of the plain tile;
   otherwise draw the plain tile as normal. Beach Party's `stackedSymbols` map is 4 entries
   (one per surfer color) each with 5 variants (`surfer_<color>_1..5`), and since
   `rowsCount === 5 === variants.length`, "full stack" always means "the entire column". A future
   game with more rows than variants would see the extra rows fall back to the plain tile, per
   the forward-compat rule in the brief (first N special, the rest plain).

## 2. Symbols & paytable

From `games/beachparty/assets/symbols/symbols.tiles.json` (32 tiles, 256×128 each):

| Symbol | Tier | Friendly name | Seed payout `[1,2,3,4,5]` | Notes |
|---|---|---|---|---|
| `wild` | wild | Wild Surfer | `[0,0,25,100,400]` | Substitutes on every line, base + bonus |
| `surfer_blue` | premium | Big Kahuna | `[0,0,20,60,250]` | Highest-value surfer |
| `surfer_green` | premium | Wave Shredder | `[0,0,15,45,180]` | |
| `surfer_pink` | premium | Coral Rider | `[0,0,10,30,120]` | |
| `surfer_yellow` | premium | Sunny Grom | `[0,0,8,25,100]` | Lowest-value surfer |
| `ace` | regular | Ace | `[0,0,6,20,60]` | |
| `king` | regular | King | `[0,0,5,16,50]` | |
| `queen` | regular | Queen | `[0,0,4,14,40]` | |
| `jack` | regular | Jack | `[0,0,4,12,35]` | |
| `ten` | regular | Ten | `[0,0,3,10,30]` | |
| `bonus` | trigger | Beach Bonus | none (trigger only) | Reels 1/3/5 only (frequency 0 on reels 2/4) |

Payouts are seed values (`payout[i]` = payout for `i+1` matches, same convention as
barfruits/fruitmachine) — tuned for real RTP (~96% target) via the TUNE FREQUENCIES panel once
reels exist, not hand-computed. `scatter` tile in the sheet stays unused (confirmed with the
user — not part of this game).

Each surfer color also has 5-tall stack variant tiles (`surfer_<color>_1..5`) purely for
rendering (see §1.3) — they never appear as their own paytable entries; a stacked run still pays
as N-of-a-kind `surfer_<color>` on whatever paylines it sits on, identical to an unstacked run.

## 3. Reel strips

- `REELS_COUNT = 5`, `ROWS_COUNT = 5`.
- Surfer colors: `minStack: 2, maxStack: 5, stackChance: 0.45` (seed value) on `generateReel` —
  a little under half of a surfer's occurrences become a 2–5-tall cluster, the rest land as lone
  single tiles. This is what produces both "standalone `surfer_yellow`" and "`surfer_yellow`
  stacked 2–5 tall" from the exact same reel-strip symbol, with no separate stacked-symbol
  identity needed anywhere in the math.
- `wild`: `minGap: 4` — "a decent gap in between", matching barfruits' scatter-spacing pattern.
- `bonus`: present only on reels 1, 3, 5 (`frequency: 0` on reels 2 and 4); marked
  `triggerFreeSpins: true` in the paytable purely so `generateReel`'s default `minGap` (3)
  spacing applies — the actual trigger check is custom (§5), not `checkWins`' built-in scatter
  path, since that scans the whole grid rather than three specific reels.

## 4. Paylines (new 5×5 template)

No 5×5 template exists yet (`docs/PAYLINES-TEMPLATES.md` has 3×3, 5×3, 5×4). Adding a 30-line
5×5 template there, and reusing it here — rows are 0 (top) to 4 (bottom), center row 2:

```js
export const PAYLINES = [
  [0,0,0,0,0], [1,1,1,1,1], [2,2,2,2,2], [3,3,3,3,3], [4,4,4,4,4],       // 1-5: straight rows
  [0,1,2,3,4], [4,3,2,1,0],                                              // 6-7: diagonals
  [0,2,4,2,0], [4,2,0,2,4],                                              // 8-9: deep V / inverted-V
  [1,2,3,2,1], [3,2,1,2,3],                                              // 10-11: shallow V / inverted-V
  [0,1,3,1,0], [4,3,1,3,4],                                              // 12-13: wide V / inverted-V (skip row 2)
  [0,0,2,4,4], [4,4,2,0,0],                                              // 14-15: step down / up
  [0,1,1,1,0], [4,3,3,3,4],                                              // 16-17: shallow U top / bottom
  [1,0,0,0,1], [3,4,4,4,3],                                              // 18-19: U top / bottom (rows 0-1 / 3-4)
  [2,1,0,1,2], [2,3,4,3,2],                                              // 20-21: U top / bottom (rows 0-2 / 2-4)
  [0,1,0,1,0], [4,3,4,3,4],                                              // 22-23: zigzag top / bottom
  [1,2,1,2,1], [3,2,3,2,3],                                              // 24-25: zigzag upper-mid / lower-mid
  [0,2,0,2,0], [4,2,4,2,4],                                              // 26-27: W / M wide (rows 0/2, 2/4)
  [0,4,0,4,0], [4,0,4,0,4],                                              // 28-29: extreme W / M (rows 0/4)
  [1,3,1,3,1],                                                           // 30: W mid (rows 1/3)
];
```

## 5. Bonus round — "Beach Bonus"

- **Trigger:** `bonus` landing on all of reels 1, 3, and 5 in the same spin (the only possible
  count, since it can't land elsewhere). Awards 8 free spins; landing it on all three again
  during the bonus retriggers +8 more, uncapped — same shape as barfruits' scatter/retrigger.
  Computed by a custom check (grid columns 0/2/4 each contain `bonus` at least once), packaged
  into the same `{ symbol, count, payout: 0, winningPositions, triggerFreeSpins }` shape
  `checkWins` normally returns, so it flows through `CoreSlotEngine`'s existing
  `onScatterTrigger` unchanged.
- **Stacked wilds (bonus only):** a custom `winEvaluator` (wrapping `checkWins`) checks, only
  while `engine.inFreeSpins`, whether any reel is a full 5-tall stack of one surfer color; if so,
  it evaluates that reel as `wild` for line-matching purposes (grid is copied for this check —
  the original grid used for rendering is untouched, so the surfer art still displays, not a
  wild icon).
- **Mini jackpot — "Reef Royale":** if, on one spin, full 5-tall stacks of all 4 distinct surfer
  colors are on the board at once (needs ≥4 of the 5 reels fully stacked, one of each color), pay
  a flat 250× total bet on top of the normal (already wild-heavy) line win, with its own
  "JACKPOT!" celebration — not folded into the paytable math, since the normal wild-substituted
  evaluation already produces a very large line win on its own in this scenario.

## 6. Presentation & scaffolding

- `game.js` structured like lemonpop's (`REEL_SEEDS`, `FREQUENCY_REELS`, `GAME_ASSET_MANIFEST`,
  dev panel wiring — RUN SIMULATION / TUNE FREQUENCIES / SPIN LOG — `initGame`), but plugging in
  `LineMechanic` + `ReelScrollAnimator`, and barfruits' free-spins intro/summary modal pattern
  (`enterFreeSpinsIntro` → `enterFreeSpins` → `retriggerFreeSpins` → `game_over` summary) for the
  Beach Bonus lifecycle.
- Backgrounds: base `beach_lifeguard_hut_2.png`, bonus `boards_on_the_beach.png` (both already
  committed under `games/beachparty/assets/backgrounds/`). `driving_on_the_coast.png` and
  `vanlife_on_the_coast.png` are unused by this design (available for a future theme screen or
  promo art, not wired into the live game).
- Music: `pacific_drift_theme.mp3` for both base and bonus (only track available).
- Tile sheet: `games/beachparty/assets/symbols/symbols.png` +
  `games/beachparty/assets/symbols/symbols.tiles.json` (already committed), 256×128 tiles.
