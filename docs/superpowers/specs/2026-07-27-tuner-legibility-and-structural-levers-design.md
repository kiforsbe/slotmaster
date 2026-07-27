# Tuner Legibility and Structural Levers — Design

**Status:** approved 2026-07-27. Packages 0–3 are a go; Package 4 is deferred but specified.

## Problem

The frequency tuner optimizes the weakest lever it has, and nothing tells the developer that. It searches per-reel symbol frequencies — one scalar objective against 84 degrees of freedom on Candy Frenzy — while the parameters that actually set RTP on a cluster-cascade game are hand-written constants it never touches, never validates, and never reports on.

The developer-facing symptom is the one that has recurred through every tuning session: *"some symbols get an over-abundance in frequency per reel, and that causes issues in RTP and cluster wins."* That is not a search defect. It is the optimizer correctly compensating for a structural setting, with no channel to say so.

### Measured evidence

Candy Frenzy at `849bc8a`, 40,000 base spins, seed 4242, `REEL_LENGTH` 500. Noise floor ≈ ±1.3pp RTP at 2σ.

| config | RTP | trigger | hit % | mean win | p99 | max |
|---|---|---|---|---|---|---|
| shipped tuned frequencies | **74.70%** | 0.530% | 52.2% | 1.43x | 6.0x | 29x |
| same reels, frequencies flattened to equal | **101.48%** | 0.563% | 62.0% | 1.64x | 5.8x | 40x |

Structural sensitivity at uniform frequencies:

```
stackChance   0.1→36%   0.2→77%   0.3→101%   0.4→121%   0.5→145%   0.7→181%   1.0→40%
maxStack        2→9%      3→40%      4→101%     5→189%     6→304%
minGap          1→105%    2→103%     3→103%     4→101%     6→102%
```

Three conclusions, which set the whole priority order:

1. **The only lever the tuner pulls is its weakest.** `maxStack 4→5` is worth +87pp. The entire frequency search is worth ±10pp — and on the shipped tables it is worth **−27pp**, because those frequencies were tuned against `stackChance: 0.40` and the pre-`849bc8a` premium ladder and were never re-tuned.
2. **`minGap` is free.** Flat across its range at the noise floor. On this game, spacing is an aesthetics knob, not an RTP tradeoff — which contradicts the working assumption behind several previous tuning sessions.
3. **`stackChance` is not monotone.** It cliffs at exactly 1.0 back to 40%, because `resolveStackChance() >= 1` switches `generateReel` from `_computeStackedPlacements` to `_computeClusterSizes`. Any 1-D search over it breaks on that discontinuity, and a designer setting `1` meaning "always stack" gets less than `0.3`.

## Goals

A developer should be able to:

- **See which knob matters** — "if you change these values, this is what it will do, given your current config."
- **Understand what a knob means** — a penalty weight should be denominated in something real, not an incantation.
- **Know what the numbers mean for a player** — RTP is a margin statistic and says almost nothing about the experience.
- **State a desire and get a candidate** to accept or reject, rather than hand-deriving the config that satisfies it.
- **Do all of the above from the panel**, without reading source or a diagnostics JSON dump. Every capability below has a UI obligation attached (see "User interface"); a feature that only exists as a `diagnostics` field is not done.

Non-goals for this design: the candidate-history/accept-reject UI (needs the metrics below to exist first — there is little to compare candidates *on* today), and any change to the live game engines' runtime behavior.

## Architecture

Four independently shippable packages. Each is its own spec→plan→implement cycle; this document is the shared design they all derive from.

```
Package 0  ──▶  Package 1  ──▶  Package 2  ──▶  Package 3
reel            what do          what do          will the
coupling        constants do     knobs mean       player have fun
                     │
                     └──▶  Package 4  (deferred; independent)
                           search correctness
```

Package 0 first because it is small and because cutting 84 dimensions to 12 makes every measurement in Packages 1–3 less noisy. Package 1 before 2 and 3 because its sweep produces the numbers those packages present.

### Cross-cutting constraints

- No new runtime dependencies; plain ES modules, no build step.
- Every new tuning option defaults to today's behavior. A game that does not opt in must produce byte-identical results.
- `tuneFrequencies` stays deterministic — every new random draw seeds off `searchSeed`.
- New progress phases must be handled in `SimulationPanel.js` and covered by the phase-contract test in `tests/tunefrequencies.test.mjs`. An unhandled phase with `best === null` took the panel down once already (`e023fb2`).
- No hash/golden tests on generated strips. Frequencies and structural settings change constantly; assert behavior, not output.

---

## User interface

Everything above is only as good as the panel it surfaces in, and today's panel is the same shape as the problem this design exists to fix: **one flat grid of roughly fifteen numeric inputs, every one equally prominent, with all the explanation buried in `title` tooltips.** "Uniformity Penalty Weight `[0]`" sits at exactly the same visual weight as "Target RTP `[96]`", though one is the entire point of the exercise and the other is an incantation nobody can price. A developer cannot tell from looking which boxes are the ask, which are the mechanism, and which are dangerous.

The UI is therefore treated as a first-class part of this design rather than a rendering step at the end of each package. **The panel is restructured before any package's own controls are added**, so each one lands somewhere coherent instead of extending the wall.

### Principles

1. **Ask for the desire, not the mechanism.** What a developer wants is three numbers — the RTP, roughly how often the bonus comes, and roughly how swingy it should feel. That is the top of the panel and nothing else is. Every other control is mechanism and gets hidden behind progressive disclosure.
2. **Diagnose before you search.** The most valuable output in this design (the sensitivity table) needs no search at all. It must be reachable without committing to a 150-iteration run.
3. **Express every quantity in the unit a human thinks in.** "1 in 167 spins" over "0.6%". "Low / Medium / High" over "σ = 1.9". "Insist" over "4". The raw number stays visible next to the friendly one — the goal is comprehension, not concealment.
4. **Every knob shows its own current measured value.** A preference is a choice about a real quantity; a control that does not show that quantity is asking for a guess.
5. **Results say what they mean, not just what they are.** "96.2% RTP" is a fact. "You win on 52% of spins and half those wins are under 0.8× your bet" is the same fact in a form that supports a decision.
6. **Nothing is silently applied.** Recommendations render with an explicit apply action targeting the copyable output, never the running game.

### Information architecture

Three screens in one panel, in the order a developer actually moves through them.

**1 — What do you want** (always visible, three controls)

```
WHAT DO YOU WANT?
  Target RTP           [ 96.0 ] %   ±[ 1.5 ]
  Free spins about     [ 1 in 167 ] spins        (0.6% ± 0.15)
  Volatility           [ Low ▾ ]                 (σ ≈ 2–3× bet)

  ▸ How the reels should look        (3 preferences set)
  ▸ Search settings                  (CMA-ES · 150 iterations · 300k spins)
  ▸ Advanced                         (raw weights, seeds, per-reel bias)

  [ CHECK MY CONFIG ]        [ START TUNING ]
```

Trigger rate is entered as "1 in N spins" with the percentage shown alongside, because that is how the number is reasoned about. Volatility is a named band, not a raw σ. The three collapsed sections carry a live summary of their own contents in the header, so a developer knows whether opening one is worth it.

**2 — Before you tune** (produced by `CHECK MY CONFIG`, and automatically at the start of a tune)

This is the "hey dev, if you change these values, this is what it will do" screen. `CHECK MY CONFIG` runs Phase 0a validation, 0b headroom and 0c sensitivity **only** — no Phase 1, no Phase 2 — so the answer arrives in seconds rather than after a full search. It is the single highest-value interaction in this design.

```
✖ 2 problems must be fixed before tuning
   cake pays LESS for a bigger cluster: 7+ pays 0.50x but 5+ pays 2.00x
     → Raise the 7+ multiplier above 2.00x. Until then the tuner is rewarded
       for making big clusters RARER.
⚠ 1 warning
   stackChance is 1.0 — that is a MODE SWITCH, not "always stack" (it pays 40%)

WHICH KNOB MATTERS      even frequencies pay 101.5% · target 96% · noise ±1.3pp
   maxStack       4     ████████████   ±1 ≈ 87pp     3:40%  [4:101%]  5:189%
   stackChance  0.30    ███            ±0.1 ≈ 25pp   0.2:77%  [0.3:101%]  0.4:121%
   minGap         4     ·              no effect     1:105%  [4:101%]  6:102%
                                       spacing is free here — spend it on looks

TO REACH 96% FROM HERE
   • scale every payout by 0.946     exact — RTP is strictly proportional to payouts
   • or set stackChance to ~0.29     interpolated between 0.2 and 0.3
                                                        [ APPLY TO OUTPUT ]

LOSS BUDGET AT START    what the search will actually optimize
   spacing      15.1pp  ◀── dominates; the search will trade RTP away for this
   RTP error     5.5pp
   ordering      2.7pp
```

The bar next to each knob is its elasticity, so leverage is visible before any number is read. A knob whose whole ladder sits inside the noise floor renders as "no effect" rather than a small misleading number.

**3 — What you got** (after a tune)

```
RTP 96.0% ✓        Bonus 1 in 189 ✓        Volatility LOW ✓

WHAT THIS GAME FEELS LIKE
  You win something on 52% of spins. Half of those wins are under 0.8x your
  bet — most "wins" return less than the spin cost.
  A 5x+ win lands every ~90 spins.  20x+ every ~2,400.  50x+: never observed.
  500-spin session at 1.00:  median −38 · worst 5% −131 · best 5% +47.

  Volatility LOW (σ = 1.9x). Cluster-cascade games typically run 4–8x
  — rule of thumb, not a measurement.

▸ Diagnostics    (loss breakdown, violations, per-phase reasons)
▸ Copy output    (frequencies, REEL_LENGTH, scaled paytable, full run header)
```

The live progress log and per-iteration table stay exactly as they are today — they are genuinely good — but collapse by default once a run finishes, since their job is reassurance during the wait, not the answer.

### Control inventory after the restructure

| section | controls |
|---|---|
| **What do you want** (always visible) | target RTP + tolerance; free-spins frequency as 1-in-N + tolerance; volatility band |
| **How the reels should look** | the five shaping preferences as `Off / Prefer / Insist / Require`, each showing its current measured value; reel coupling; per-reel ordering direction |
| **Search settings** | algorithm; iterations; trial spins; trials per point; initial-weight strategy |
| **Advanced** | raw numeric penalty weights; `searchSeed`; `maxRtpStdError`; `maxReelDeviation`; `sensitivitySpins`; skip-validation escape hatch |

The split is by **who needs it, and when** — not by which phase consumes it. A developer tuning a game touches the first section every time, the second occasionally, the third rarely, and the fourth when something has gone wrong.

### Per-package UI obligations

Each package must land its controls in the section above, not append to the panel:

- **Package 0** — reel coupling goes in *How the reels should look*, phrased as a design question ("should every reel use the same symbol mix?"), not as a dimensionality one. Its default for cascade games is pre-selected with the reason visible.
- **Package 1** — validation and sensitivity are the whole of screen 2, plus the `CHECK MY CONFIG` action that reaches them without a tune. The payout-scale solve renders as a *route to target* with an apply action, not as a checkbox buried among the weights.
- **Package 2** — the intent controls replace the raw weight inputs in *How the reels should look*; raw numbers move to *Advanced*. The loss budget joins screen 2.
- **Package 3** — the player-experience report becomes the top of screen 3, above the diagnostics. The volatility target joins *What do you want* as the third headline control.

---

## Package 0 — Reel coupling

**Core issue:** On a cluster-pays game, reel index carries no meaning — a cluster forms from cells adjacent on the grid, not from a position in a payline. Phase 2 nevertheless gives every reel its own free weight per symbol, so it invents per-reel asymmetry that nothing in the design asked for and nothing in the loss can justify. That asymmetry *is* the over-abundance: `chewy` at 0.4105 on reel 2 against 0.0056 on reel 3 is not a design decision, it is search noise given 84 degrees of freedom.

**Approach:** a `reelCoupling` option with three modes.

- `'independent'` (default) — today's behavior, one dimension per (symbol, reel).
- `'linked'` — one dimension per **symbol**. `projectPoint` writes the same raw weight to every reel, then renormalizes **per reel** against that reel's own `valueBudgetByReel[r]`. Per-reel renormalization is what preserves each reel's scatter:candy ratio, so Phase 1's trigger-rate result survives unchanged.
- `'linked-then-refine'` — Phase 2a linked, then Phase 2b independent starting from 2a's result, with per-dimension bounds clamped to `maxReelDeviation` (default 0.25, relative) around the linked value. Phase 2b can express "reel 4 runs slightly heavier on `cake`"; it cannot re-invent a 70× spread.

Linked mode requires every reel to carry the same symbol set. Validated up front with the offending reel and symbol named — silently linking mismatched tables would produce garbage.

**Data flow:** `dims` gains an optional `reelIndex: null` meaning "all reels". `projectPoint` branches on it. Nothing downstream (penalties, `measure`, diagnostics) changes shape.

**Reported as:** `diagnostics.rtpPhase.coupling = { mode, linkedRtp, refinedRtp, dimsLinked, dimsRefined }`, so a developer can see whether Phase 2b's asymmetry earned anything or merely added spread.

**Default:** cascade games opt into `'linked-then-refine'`. Line-pay games keep `'independent'` — reel position genuinely does mean something there.

---

## Package 1 — "What do these constants do?"

**Core issue:** `REEL_LENGTH`, `stackChance`, `maxStack`, `minStack`, `minGap`, `MIN_CLUSTER_SIZE` and the payout ladders are hand-written constants with no validation and no stated consequence. The tuner reports one number about them (`structuralHeadroom.uniformRtp`) and leaves every causal question unanswered.

### 1a. Config validation

A new pure module `core/TuningValidation.js`, importable by tests and by a game's own module, returning `[{ severity: 'error'|'warning'|'note', code, message, suggestion, subject }]`. `error` blocks the tune; `warning`/`note` report and proceed.

| code | check | why it exists |
|---|---|---|
| `payout-ladder-non-monotone` | multiplier must not decrease as `min` increases | the pre-`849bc8a` premium ladder paid 5-of-a-kind 2.00x and 7-of-a-kind 0.50x; the tuner would have optimized *toward* exactly-5 clusters, and nothing caught it |
| `payout-ladder-unsorted` | tiers ascending by `min`, no duplicates | `defaultPayoutOf` reads `tiers[tiers.length - 1]`; unsorted silently mis-ranks every symbol |
| `payout-ladder-floor` | lowest tier `min` >= `minClusterSize` | a tier below the cluster floor can never pay |
| `tier-inversion` | every `premium` top tier >= every `regular` top tier | otherwise the ordering penalty fights itself |
| `stack-bounds` | `minStack <= maxStack`, both >= 1 | |
| `stack-chance-mode-switch` | warn when `stackChance >= 1` | measured: 1.0 pays 40% where 0.7 pays 181% — it is a different code path, not more stacking |
| `mingap-infeasible` | `runs > floor(reelLength / minGap)` — promotes the existing `checkReelFeasibility` | `generateReel` gives up silently on a strip too dense |
| `reel-length-floor` | `reelLength >= symbolCount * minGap` | below this no arrangement satisfies the constraint |
| `cluster-size-reachable` | `minClusterSize <= reelsCount * rowsCount` | |
| `scatter-trigger-reachable` | `scatterTriggerCount <= reelsCount * rowsCount`, and expected scatters in view within an order of magnitude of it | catches a scatter frequency making the bonus impossible or constant |
| `frequency-bounds-contradiction` | `minFrequency <= maxFrequency`, `minFrequency * symbolCount <= 1` | otherwise the limit penalty can never reach zero |

### 1b. Structural sensitivity sweep

**The headline deliverable.** For each structural knob, hold everything else at the current config and measure a ladder of values; report ΔRTP, Δtrigger, Δhit-rate, and an elasticity so the table sorts by leverage.

Measured at **uniform frequencies** by default, isolating the structural effect from whatever the current frequencies happen to be. Cost: ~30 measurements at `sensitivitySpins` (default `trialSpins / 4`, `trialsPerPoint: 1`) ≈ 7 full candidate evaluations against a 150-iteration search.

Ladders: `stackChance` [0.1…0.7] (never crossing 1.0 without labelling it a mode switch), `maxStack` [current±2], `minStack` [1…maxStack], `minGap` [1,2,4,6,8], `reelLength` [current, 2×, 4×], payout scale [0.8…1.25].

Also derives `routesToTarget` — single-knob answers to "how do I reach `targetRtp` from here?", marked `exact` (payout scale, which is closed-form) or interpolated.

Rendered as prose plus a table, e.g.:

```
  maxStack      4  →  ±1 is worth ~87pp     2:9%  3:40%  [4:101%]  5:189%  6:304%
  minGap        4  →  no measurable effect  1:105%  2:103%  [4:101%]  6:102%
                       spacing is free on this game — spend it on how the reels look

  TO REACH 96% FROM HERE:
   • scale every payout by 0.946        (exact — RTP is strictly proportional to payouts)
   • or set stackChance to ~0.29        (interpolated)
```

The sweep must report its own noise floor alongside its ΔRTP values, or it will present ±1pp ties as signal.

### 1c. Make `solvePayoutScale` reachable and verifiable

The one **exact** RTP lever exists and is correct, but is off by default, has zero references anywhere in `SimulationPanel.js`, and cannot self-verify on Candy Frenzy because `winEvaluator` is a closure over `PAYTABLE` — so the verification run measures the original payouts and honestly reports `verified: false`.

New option `winEvaluatorFactory: (paytable) => winEvaluator` lets the verification run rebuild the evaluator around `scaledPaytable`. Panel gains a checkbox, a rendered scaled ladder, and the scaled paytable **as real code** in the copyable output — the same treatment `REEL_LENGTH` got in `2548ac2`.

### 1d. Structural search

Grid search, not CMA-ES: three of four knobs are small integers and the continuous one has a mode discontinuity. Seeded by 1b's ladder data, refined locally around the best cell. Runs before Phase 1 at uniform frequencies.

Produces a **recommendation** (`diagnostics.structuralRecommendation`), never silently applied — the accept/reject step the developer asked for. `respectDesignIntent` pins any knob the game marks fixed, so "maxStack 4 is a design decision, find me the rest" is expressible.

---

## Package 2 — "What do these knobs mean?"

**Core issue:** the loss weights are unitless, and the terms are on wildly incommensurable scales, so the same number means something different for each:

- RTP error: percentage points, range 0–30
- ordering: **raw frequency units** — 5.4489 on the shipped tables
- uniformity: unitless relative deviation, roughly 0–10
- spacing: **raw violation count** — 301 on shipped, 136 on uniform. At `spacingPenaltyWeight: 0.25` that term contributes 75 against an RTP term of 21, and would silently take over the search.

That spacing figure also says something worth surfacing: the tuned skew more than **doubled** clumping versus flat frequencies, and at the default weight of 0 the search never saw it.

### 2a. Normalize every penalty to RTP-percentage-point equivalents

Each penalty divides by a reference scale so **weight 1 means "worth 1 percentage point of RTP to me"**:

| penalty | normalization |
|---|---|
| ordering | `total / (equalShare × pairCount)` → mean fraction-of-a-share out of order |
| limits | `total / bound` per violation, averaged → mean relative overshoot |
| uniformity | `total / dimCount` → mean relative deviation per symbol |
| spacing | `violations / totalRuns` → fraction of runs violating |
| trigger rate | already percentage points — unchanged |

`penaltyNormalization: 'normalized' | 'raw'` defaults to `'raw'` for one release so saved configs do not silently change meaning; each game's `tuneConfig` opts in deliberately. Both raw and normalized values appear in diagnostics so a weight can be translated.

### 2b. Intent-named controls

Numeric weight boxes become named intents mapping onto normalized weights — `Off | Prefer | Insist | Require` → `0 / 1 / 4 / 12` — with a numeric override behind an "advanced" toggle. Each control states in one sentence what it does **and the current measured value of that quantity**, so "Insist" is visibly a choice about a real number.

### 2c. Loss budget preview

Before the search starts, evaluate the starting point once and print the breakdown in pp, sorted by contribution:

```
  spacing        15.1pp  ←── dominates. The search will trade RTP away to fix spacing.
  RTP error       5.5pp
  ordering        2.7pp
```

The panel already renders per-iteration contributions; this moves the same information to where it can still change a decision.

---

## Package 3 — "Will the player have fun?"

**Core issue:** `measure()` returns `rtp`, `triggerRate` and trial spread, and throws away `winDistribution`, `maxWin` and hit counts — all of which `simulateSpins` already computes. So "rough payout per win, no massive variance" has no metric, no target, no penalty and no display.

What the tuner *would* have said about the shipped game: hit rate 52.2%, mean win 1.43x, median 0.8x, p99 6.0x, p99.9 20.5x, max 29x over 40,000 spins, top 1% of wins = 9.8% of all payout. That is an extremely flat game — if anything **under**-volatile for a cluster cascade, not over.

### 3a. Round-level win shape

`simulateSpins` keys `winDistribution` by individual spin win, mixing base and free spins; free spins are charged 0 bet, so they inflate hit rate and deflate mean. What a player experiences is a **round**: one paid base spin plus every free spin it bought.

Add a round accumulator — count, sum, sum-of-squares, max, and a fixed log-spaced histogram (~60 buckets, 0.01x to 10,000x bet). A few counters per spin, no per-spin object, so it stays on by default at 1,000,000 spins. Explicitly not `logSpins`, which holds one object per spin.

Derived: `hitRate`, `meanWin`, `medianWin`, `p90`/`p99`/`p999`, `maxWin`, `top1PctShare`, `volatilityIndex` (σ of round return / bet). `measure()` averages these across trials and returns them alongside `rtp`.

### 3b. Player-experience report

A pure `core/PlayerExperience.js` translating round stats into plain language, rendered after a tune and after a plain simulation:

```
  You win something on 52% of spins. Half of those wins are under 0.8x your bet —
  most "wins" return less than the spin cost.

  Volatility: LOW  (σ = 1.9x bet). Commercial cluster-cascade games typically run 4–8x.
  A 5x+ win lands every ~90 spins.   A 20x+ win every ~2,400 spins.   50x+: never observed.

  A 500-spin session at 1.00:  median player ends −38.   worst 5% end −131.   best 5% end +47.
```

Session outcomes come from bootstrap resampling the round histogram — no extra simulation. The volatility bands and the "comparable games" range are rules of thumb and must be labelled as such in code and UI, not presented as measurements.

### 3c. Volatility as a tuning target

`targetVolatility`, `volatilityTolerancePct`, `volatilityPenaltyWeight` (normalized per 2a). Band penalty, same shape as `triggerRatePenaltyWeight` — exactly zero inside the band so it never fights RTP over a volatility that was already acceptable.

Stated plainly in the option doc and in the panel: volatility on a cluster-cascade game is dominated by the **payout ladder shape** and `maxStack`, not by symbol frequencies. This target therefore mostly steers 1c and 1d. Setting it against Phase 2 alone will move it very little, and the tuner should say so rather than let a developer burn a search discovering it.

---

## Package 4 — Search correctness (deferred)

Known defects, none visible from outside. Deferred because none is worth as much as Packages 0–3 — not because any is optional.

**4a. Phase 3, re-solve the trigger rate after Phase 2.** Phase 1 solves the scatter against the *baseline* distribution; Phase 2 replaces that distribution wholesale; nothing re-solves. On a cascade game the coupling is real and large (measured span 0.75%–2.04%). `triggerRateDrift` reports the damage and never repairs it, and the current mitigation (`triggerRatePenaltyWeight`) fights RTP inside the same loss when the fix is to re-run `bisect1D` on the finished tables — ~10 measurements, no tradeoff, and Phase 2 never touches trigger symbols so it cannot undo the result.

**4b. Cross-reel cluster-structure metric.** Every constraint the tuner knows iterates `dims` grouped by `reelIndex`. Nothing anywhere measures whether column *r*'s vertical run of a symbol overlaps column *r+1*'s — the mechanism that forms a cluster. The tuner's entire vocabulary for "shape" is blind to the thing generating the wins, which is why `stackChance` dominates everything the search can reach. Report first (cluster-size distribution, columns spanned, per-symbol adjacency opportunity); consider a penalty only once the report is measuring something recognizable.

**4c. Dead code.** `withStructuralDefaults` (`core/SpinSimulator.js:1397`) is defined, never called, and its comment cites a `structuralSearch` that does not exist. 1d either uses it or it goes. Also the unused `current` assignment in `refineTriggerCountsPerReel`.

---

## Testing strategy

- `core/TuningValidation.js` and `core/PlayerExperience.js` are pure functions with no simulation — direct unit tests, including a fixture reconstructing the pre-`849bc8a` premium ladder that must produce exactly one `payout-ladder-non-monotone` error.
- Option defaults are regression-tested: every new option absent must produce results identical to today.
- New progress phases are added to the existing phase-contract test.
- Statistical assertions use tolerances derived from the measured noise floor, never exact values, and never strip hashes.
- Panel tests assert on the formatter output (as `tests/simulationpanel.test.mjs` already does), not on DOM. Every screen-2 and screen-3 block is therefore built as a **pure exported formatter** taking plain data and returning a string or a small render descriptor — `formatSensitivityReport`, `formatValidationFindings`, `formatLossBudget`, `describePlayerExperience`. The panel's own job shrinks to placing those outputs, which keeps the interesting logic testable in `node --test` with no DOM.
- Unit conversions used by the controls (`1 in N` ↔ percent, volatility band ↔ σ range, intent ↔ weight) are pure functions with their own round-trip tests. A conversion that silently loses precision would misreport what the developer asked for.
- Live verification via Playwright against `http://localhost:5757` for each package's UI task: the control renders, its default is right, and the run completes with no console errors beyond the known favicon 404.

## Open risks

- **2a changes what every existing weight means.** The `'raw'` default plus dual reporting is the mitigation, but every game's `tuneConfig` needs a deliberate pass before the default flips.
- **All figures here are single-seed, 40,000-spin measurements.** They are directionally solid (the structural effects are tens of pp against a ~1.3pp noise floor) but the `minGap`-is-flat conclusion sits closest to the floor and should be re-measured at higher spin counts before anything depends on it structurally.
