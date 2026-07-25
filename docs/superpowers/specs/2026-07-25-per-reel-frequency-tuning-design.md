# Per-Reel Frequency Tuning — Design

## Context

`games/fruitmachine/game.js`'s `PAYTABLE` no longer carries a `.frequency`
field per symbol. Frequencies now live in three separate per-reel tables
(`FREQUENCY_REEL1/2/3`, shape `{ symbol: { frequency } }` - the same shape
`generateReel` already accepts), each reflecting a deliberately different
per-reel symbol distribution (e.g. `star`/`strawberry` only exist on reel
3). `REEL_STRIPS` builds each reel independently from its own table.

`core/SpinSimulator.js`'s `tuneFrequencies()` still assumes a single flat
frequency per symbol, shared identically across every reel. It has no way
to see or tune the three separate tables, so running it against the
current paytable produces `NaN` (it reads a `.frequency` field that no
longer exists) - this is what's currently blocking frequency tuning for
fruit machine entirely.

Two smaller, related bugs were found and fixed independently while
investigating (both already committed, both pre-date and are unrelated to
this design):
- `generateReel` silently forced every symbol in a frequency table onto
  the reel at least once, even ones explicitly weighted to `0` (`fix:
  generateReel must exclude symbols with explicit frequency: 0`).
- `gradientDescent1D` could stall permanently on a flat quantization
  plateau, or badly overshoot when escaping one (`fix: cap
  gradientDescent1D's step size to the distance actually probed`, plus
  the plateau-escape fix it followed).
- `SlotEngine.setupReels()` had a silent fallback to placeholder card
  symbols (`'jack'`, `'queen'`, ...) that don't exist in any current
  game's paytable, for a reel-strip-count mismatch that should instead
  fail loudly (`fix: remove SlotEngine's silent placeholder-card
  fallback`).

A related bug was also found but is explicitly **out of scope** here (see
Non-goals): `SpinSimulator.js`'s simulated free-spins expanding-symbol
pick uses `Object.keys(paytable)` uniformly, ignoring both reel weighting
and `bookbookbook`'s actual curated `EXPANDING_CANDIDATES` list. This
doesn't affect fruit machine (it has no scatter symbol, so this code path
never runs for it) and touches a different game entirely - tracked as a
separate follow-up.

## Goals

- `tuneFrequencies` tunes the three per-reel frequency tables directly -
  not a paytable `.frequency` field, which no longer exists anywhere in
  the data model. `PAYTABLE` stays rules-only (`payout`, `type`,
  `friendlyName`, `wildPenalty`, `wild`, `wildExcludes`, `aloneBonus`)
  and this principle applies codebase-wide going forward: frequency data
  belongs to reel definitions, never to the paytable.
- Each reel gets its own independently-tuned tilt parameter (not one
  shared tilt applied uniformly to all three, which would fight the
  reels' intentionally different base shapes).
- The "higher-paying symbol is never more frequent than a lower-paying
  one" guarantee still holds, applied **per reel**: within any single
  reel's own tuned table, a higher-paying symbol present on that reel can
  never end up more frequent than a lower-paying symbol also present on
  that reel. Symbols absent from a reel (frequency 0) are unaffected.
- `premiumSplit` and `randomSearch` frequency modes are removed entirely,
  along with the mode dropdown - only the per-reel rank-tilt mechanism
  remains.
- Document the `reel.strip` vs `reel.symbols` distinction in
  `SlotEngine.js` (full weighted reel data vs. small rendering window) so
  it doesn't read as accidental duplication to a future reader.

## Non-goals

- No change to the scatter-frequency phase's mechanism: it stays a single
  shared multiplier applied to the scatter symbol's frequency on every
  reel that contains it (not upgraded to independent-per-reel). Fruit
  machine has no scatter symbol today, so this phase is inert for it
  either way.
- No fix to the simulated free-spins expanding-symbol selection bug
  (`SpinSimulator.js`, ignores reel weighting and `EXPANDING_CANDIDATES`)
  - unrelated code path, affects `bookbookbook` not fruit machine, tracked
  separately.
- No true multi-dimensional gradient descent. Per-reel tuning is
  coordinate descent - the existing, unmodified `gradientDescent1D` called
  once per reel per round, cycling through reels - not a new optimizer.
- No change to `bookbookbook`, which keeps its own single-table
  `.frequency` paytable model untouched.

## Design

### 1. Data model

`FREQUENCY_REEL1/2/3` (already on disk) become the sole source of
frequency/weight data. `tuneFrequencies`'s new signature:

```js
tuneFrequencies(paytable, reelFrequencyTables, options)
```

- `paytable` - rules only (payout, type, ...), used for payout-based tier
  ranking. Not mutated, not returned with frequencies baked in.
- `reelFrequencyTables` - array of N tables, one per reel, each
  `{ symbol: { frequency } }`. This is the data actually tuned.
- Returns `{ reelFrequencyTables, rtp, triggerRatePct, diagnostics }` -
  tuned per-reel tables, no paytable in the return value.

### 2. Coordinate descent over reels

Outer loop: `rounds` rounds (default **3**, new `options.rounds`). Each
round visits reel 0, then reel 1, then reel 2, in order:

- For each reel's turn, call the existing `gradientDescent1D` unchanged
  to find that reel's own tilt `t_r`, holding every other reel's table
  fixed at its current value (either the original base value, if not yet
  visited, or whatever the most recent round tuned it to).
- Within one reel's turn, the mechanism is exactly today's rankTilt:
  `weight(s) = baseFreq_r(s) * t_r^tierOf(s)`, using that reel's own base
  frequencies, renormalized to that reel's own value-budget. `tierOf`
  comes from the existing `computeValueRanks(paytable, ...)` - shared
  across reels since payout is a symbol property - but only over the
  symbols actually present (nonzero base frequency) on that specific
  reel.
- A global best (the full 3-table combination + its measured RTP) is
  tracked across every sub-call, exactly like today's "track best across
  steps." The returned result is whichever combination came closest to
  target, with the same `converged` flag semantics `gradientDescent1D`
  already returns.
- Each `measure()` call builds all three reel strips (two held fixed,
  one varying) and runs the real simulator - unchanged from today's
  approach of always measuring against the real `simulateSpins`.
- `options.tiltBounds` (default `[1, 40]`) and `options.valueOrderExcludeTypes`
  (default `['wild']`) are unchanged in meaning and apply identically to
  every reel's own search - one shared bounds/exclusion policy, not
  per-reel overrides. A symbol whose `type` is in `valueOrderExcludeTypes`
  is held fixed at its current per-reel frequency on every reel, same as
  today.
- `type: 'premium'` becomes purely descriptive: with `premiumSplit`
  removed, no code path gives it special tuning behavior anymore - it's
  ranked by payout like any other non-excluded symbol. Not a functional
  change (rank-tilt was already the default), just worth noting so the
  label doesn't imply behavior that no longer exists.

### 3. Scatter phase

Unchanged: if a scatter symbol exists, one shared multiplier scales its
frequency on every reel that contains it. Not part of the coordinate
descent - it runs first, exactly as today, before the per-reel value
phase begins.

### 4. Mode removal

`computePremiumTiers`, the `frequencyMode` option, and the
`topCandidates` mechanism (only ever produced by `randomSearch`) are all
deleted. `tuneFrequencies` always does per-reel rank-tilt - no mode
selection needed.

### 5. UI (`core/SimulationPanel.js`)

- Mode dropdown and its explanatory paragraph removed.
- New "Coordinate Descent Rounds" number input, default 3.
- Progress log identifies which reel and round each step belongs to,
  e.g. `[Reel 1 · round 2 · step 3] mult=1.42 RTP=88.20% err=7.80 (best
  err=6.10)`.
- Results section becomes three side-by-side current→suggested tables
  (one per reel) instead of one.
- Copy-paste output changes from a `PAYTABLE` block to three
  `FREQUENCY_REEL1/2/3` blocks, paste-ready for `game.js`.

### 6. `games/fruitmachine/game.js`

`openTuneFrequenciesPanel(...)` call gains
`reelFrequencyTables: [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3]`.

### 7. `SlotEngine.js` documentation

Add a clarifying comment at the `this.reels.push({...})` object literal
(and/or above `getRandomSymbol`) explaining that `strip` is the full,
static, correctly-weighted virtual reel (canonical probability data,
generated once), while `symbols` is a small rolling rendering window
sampled from `strip` for what's currently drawn on screen - not a second,
independent source of randomness, and not redundant with `strip`.

## Testing

- `tests/tunefrequencies.test.mjs`'s existing integration tests get
  rewritten against fixture per-reel tables (matching fruit machine's
  actual shape) instead of the now-nonexistent flat-frequency paytable
  fixture they currently import.
- New assertions: per-reel ordering guarantee (for every reel
  independently, a higher-paying present-on-that-reel symbol is never
  more frequent than a lower-paying present-on-that-reel symbol); a
  symbol absent from a reel (base frequency 0) stays 0 after tuning;
  `diagnostics` still exposes a numeric `.error` and `.converged` per
  phase; per-step error visibly varies via `onProgress` (reusing the
  existing plateau-escape/step-cap-verified `gradientDescent1D`, so this
  should hold without new optimizer work).
- Full regression suite (`node --test tests/*.mjs`) must pass except the
  one pre-existing, unrelated `fruit machine RTP stays near the 96%
  design target` failure (this design's whole point is to make that
  reachable again, but hitting 96% specifically depends on actually
  running the tuner against the live paytable post-implementation, not
  guaranteed by the code change alone).
- Manual verification: run TUNE FREQUENCIES against the live fruit
  machine paytable via the browser UI, confirm the progress log shows
  distinct reel/round labels and varying per-step error, confirm the
  copy-paste output is valid `FREQUENCY_REEL1/2/3` JS, and confirm
  gameplay/RUN SIMULATION are unaffected (they don't touch
  `tuneFrequencies` at all).
