# Frequency Tuner: Gradient Descent & Order-Preserving Defaults — Design

## Context

`core/SpinSimulator.js`'s `tuneFrequencies()` auto-balances a paytable's symbol
`frequency` values to hit a target RTP and free-spin trigger rate. Earlier
this session it grew a `frequencyMode` option with three strategies for the
RTP-reallocation phase:

- `premiumSplit` (default, original): bisects a single multiplier moving
  weight between `type: 'premium'` symbols and everything else. No ordering
  guarantee - for a paytable where the premium symbol is the only one with a
  payout meaningfully above the rest, hitting a high target RTP can force that
  symbol to become the *most* frequent one, which is exactly the "highest
  payer, most frequent" outcome the user has repeatedly flagged as wrong for
  this game.
- `rankTilt` / `randomSearch` (added this session): rank symbols by payout and
  reallocate weight so higher-rank (lower-paying) tiers can only ever gain
  weight relative to lower-rank (higher-paying) tiers - guaranteed by
  construction (`weight(s) = baseFreq(s) * t^tier(s)`, `t` clamped `>= 1`).

Two problems surfaced testing those new modes:

1. The tuning progress log prints `best.error` ("best seen so far"), which can
   render as if the algorithm is stuck (unchanging) once a good candidate is
   found early, even while the search is still moving - it's not actually
   showing the current step's own error.
2. The search itself is bisection (or, for `randomSearch`, independent random
   sampling) - no gradient information is used at all, despite this being
   exactly the kind of noisy-but-differentiable optimization problem gradient
   descent is built for.

Separately, the user wants the "higher value = rarer" ordering guarantee to
be the *default*, structural behavior of the tuner - not something you have
to remember to opt into via the mode dropdown - while keeping `premiumSplit`
available as a named option for its coarser, premium-vs-everything-else
character.

## Goals

- Replace bisection with real gradient descent in the RTP-reallocation phase
  and the scatter-frequency phase: finite-difference slope estimate,
  log-space parameterization (these are all multiplicative scale
  parameters), decaying learning rate.
- Reduce simulation noise in the gradient estimate using common random
  numbers (CRN): the two finite-difference measurements in a single step use
  the same seeded RNG sequence, so the estimated slope reflects the parameter
  change, not two independent noisy Monte Carlo draws.
- Generalize the tiered-tilt construction so `rankTilt` and `premiumSplit`
  are the *same* underlying mechanism with different tier-assignment
  functions - both then structurally guarantee no higher-paying symbol can
  end up more frequent than a lower-paying one.
- Make `rankTilt` the default `frequencyMode`. `premiumSplit` remains
  selectable (now order-safe) for continuity. `randomSearch` is unchanged in
  strategy.
- Fix the progress log / diagnostics to show the current step's error
  alongside the best-seen error, so convergence is visible.
- Reuse the existing seeded-RNG utilities (`createSeededRng`,
  `generateTargetGrid`, both already in `core/SlotMath.js` from the earlier
  seeded-reels work) instead of the ad hoc `mulberry32` this session added
  locally to `SpinSimulator.js` for `randomSearch` - dedup, no behavior
  change to that function beyond the RNG source.

## Non-goals

- No full multi-dimensional (per-symbol) gradient descent. Explicitly
  scoped down to a single shared tilt/multiplier parameter per phase, per
  this session's decision.
- No new UI inputs for learning rate, epsilon, or decay factor - sane
  internal constants only. The only user-visible UI change is the mode
  dropdown's default and the progress log line.
- `randomSearch`'s sampling strategy is unchanged - it adopts the same seeded
  RNG for its own measurements (for reproducible runs, restating the
  existing `searchSeed` intent) but does not switch to gradient descent.
- No change to live gameplay (`SlotEngine.spin`) or `RUN SIMULATION`'s
  default (unseeded) behavior - scoped entirely to `tuneFrequencies`.
- The scatter-vs-non-scatter "no premium symbols at all" fallback (uniform
  non-scatter scaling, for games with a scatter type but no premium type) is
  untouched - neither `fruitmachine` nor `bookbookbook` exercises it (both
  declare at least one `premium`-typed symbol), so it's out of scope for
  verification here.

## Design

### 1. Seeded simulation (`core/SpinSimulator.js`)

`simulateSpins(config, numBaseSpins, betPerLine, linesCount, rng = Math.random)`
gains a trailing `rng` parameter - a `() => number` function, matching
`createSeededRng`'s return shape (not a raw seed), consistent with
`generateTargetGrid`'s existing convention.

- The inline per-spin target-grid-building loop is replaced with a call to
  `generateTargetGrid(simConfig.reelStrips, simConfig.rowsCount, rng)`
  (imported from `./SlotMath.js`) - this is a pre-existing pure function that
  already does exactly what the inline loop does (pick a random stop index,
  read off `rowsCount` consecutive symbols per reel).
- The free-spin expanding-symbol pick (currently its own `Math.random()`
  call) also draws from `rng()` instead, so a seeded run is fully
  deterministic end to end.
- Default `rng = Math.random` preserves today's behavior for every existing
  call site with no changes required there - live gameplay and `RUN
  SIMULATION` stay non-deterministic unless a caller explicitly passes a
  seeded `rng`.
- The local `mulberry32` added to `SpinSimulator.js` earlier this session
  (for `randomSearch`) is removed; both `randomSearch` and the new
  gradient-descent phases import `createSeededRng` from `./SlotMath.js`.

### 2. Generalized tiered-tilt builder

Extract the existing `rankTilt` weight-construction logic into a reusable
piece parameterized by an injected tier map, instead of always using
`computeValueRanks`'s payout-based ranks:

```js
// weight(s) = baseFreq(s) * t^tierOf(s), renormalized to valueBudget.
// Guarantees non-decreasing weight as tier increases, for any tierOf map,
// as long as t >= 1.
function buildTieredWeights(valueSymbols, baseFreq, tierOf, t, valueBudget) { ... }
```

- **`rankTilt`**: `tierOf` = `computeValueRanks(pt1, valueSymbols)` (existing
  - one tier per distinct payout value, ties share a tier).
- **`premiumSplit`**: `tierOf(s) = 0` if `pt1[s].type === 'premium'`, else
  `1`. Two tiers only - the same "reallocate between premium and everything
  else" knob as today, but built on the same `t >= 1`-clamped mechanism, so
  premium's weight can never structurally exceed any other symbol's. (Order
  *within* the non-premium tier still depends on the base paytable already
  being ordered there - which, after this session's earlier fixes, it is for
  both games using this tool.)
- If a chosen tiering is degenerate (every symbol lands in the same tier -
  e.g. `premiumSplit` requested on a paytable with zero `premium`-typed
  symbols), fall back to the existing "scale every non-scatter symbol
  together" branch rather than silently no-op.

### 3. `gradientDescent1D` helper

Replaces bisection in: the scatter-frequency phase, and the tiered-tilt
phase (covering both `rankTilt` and `premiumSplit`, which now differ only in
their `tierOf` map).

- Operates in log-space: `x = ln(param)`, converts to `param = exp(x)`
  before building each trial paytable.
- Loss: `(measuredMetric - target)^2` (squared error, standard for gradient
  descent, replacing today's plain `abs(rtp - target)`).
- Gradient via finite difference: measure loss at `x` and `x + epsilon`,
  **using the same seeded rng for both** (common random numbers) - a fresh
  seed is drawn per step (not per measurement), so consecutive steps see
  independent noise but the two measurements within one step don't. When
  `trialsPerPoint > 1` (existing option, averages multiple simulated runs per
  candidate to reduce noise), the *same* set of N per-trial seeds is reused
  for both the `x` and `x + epsilon` measurements - CRN and multi-trial
  averaging compose rather than one replacing the other.
- Step: `x -= learningRate * gradient`; `learningRate *= decayFactor` each
  iteration. Internal defaults: `learningRate = 0.5`, `decayFactor = 0.85`,
  `epsilon = 0.05`.
- Clamped to `[minX, maxX]` per phase (tiered-tilt: `minX = 0` i.e. `t >= 1`;
  scatter phase keeps its existing `[0.05, 8]` bound, log-transformed).
- Still tracks the best-seen candidate (lowest loss) across all steps
  regardless of where the final step landed - same noise-robustness
  rationale as today's "track best, not just final bisection point."
- `onProgress(phase, i, param, result, best)` - `result` now carries its own
  `.error` (this step's `|measured - target|`) alongside `.rtp` /
  `.triggerRate`, so callers can distinguish "this step" from "best so far."

### 4. Mode wiring (`tuneFrequencies` options)

- `frequencyMode` default changes from `'premiumSplit'` to `'rankTilt'`.
- `premiumSplit` remains a selectable value, now backed by the generalized
  tiered builder + gradient descent instead of its own bespoke bisection
  block (which is deleted).
- `randomSearch` unchanged in strategy; only its RNG source is deduped to
  `createSeededRng`.
- `valueOrderExcludeTypes` (default `['wild']`) still applies to both
  `rankTilt` and `premiumSplit` identically, since they share the same
  tiered builder.

### 5. UI (`core/SimulationPanel.js`)

- Progress log line changes from showing only `(best so far: err=X)` to
  showing both current-step and best error, e.g.:
  `RTP=42.10%  trigger=0.000%  Δ=1.20 (best Δ=0.80)`.
- Mode dropdown's default selection becomes Rank Tilt; the `premiumSplit`
  option label gets a short clarifying suffix (e.g. "Premium / Other Split
  (order-preserving)") so it's clear the safety guarantee now applies there
  too.
- No new inputs added.

## Testing / Verification

- Full regression suite (`node --test tests/*.mjs`) - nothing currently
  asserts on `tuneFrequencies` internals, so no expected breakage; the one
  pre-existing RTP-target failure (paytable frequencies mid-tune) is
  unrelated and untouched by this change.
- Scripted check (ad hoc, like this session's earlier probes): run
  `tuneFrequencies` with `frequencyMode: 'rankTilt'` and `'premiumSplit'`
  against the live fruitmachine paytable; programmatically assert, for every
  pair of *non-wild* symbols (i.e. excluding types in
  `valueOrderExcludeTypes`, same exclusion the tuner itself applies) in the
  returned paytable, that a strictly higher payout implies frequency `<=`
  the lower-paying symbol's - across the entire paytable, not spot-checked.
- Confirm the progress log's current-step error visibly changes/descends
  step to step (not frozen) via a console-callback probe.
- Confirm `simulateSpins` called with no `rng` argument still varies
  run-to-run (backward compatible default), and with a fixed seeded `rng` is
  exactly reproducible across repeated calls.
- Confirm `randomSearch` and `RUN SIMULATION` are bit-for-bit unaffected in
  behavior/API (only their internal RNG source changed for `randomSearch`,
  and not at all for `RUN SIMULATION`).
