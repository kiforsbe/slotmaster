# Tuning Search Robustness Design

## Problem

Debugging barfruits' TUNE FREQUENCIES panel surfaced two related issues with
`tuneFrequencies`' Phase 2 search (the Nelder-Mead simplex over per-symbol reel
frequencies, in `core/SpinSimulator.js`):

1. **Genuinely infeasible targets grind through the full iteration budget with no way to
   escape early.** With `star`'s payout raised to `[0, 0, 80, 800, 2400]` and a 1% target
   free-spin trigger rate, the scatter symbol's own RTP contribution alone came out to
   ~121% - already past the 96% target before any other symbol's line wins are counted.
   Phase 2 has no way to recognize this; it just runs all 150 iterations and reports
   whatever it landed on (in this case ~152%, matching the user's "stuck at 153%" report),
   with no explanation of *why*.
2. **The search doesn't reliably escape a bad trajectory.** A sweep of
   `orderingPenaltyWeight`/`limitPenaltyWeight` values against barfruits' reels appeared at
   first to show "low weight never converges, high weight does." A controlled follow-up
   (identical seeded calls, twice, in-process) confirmed `tuneFrequencies` **is fully
   deterministic** - the apparent weight-direction effect doesn't reproduce; it was
   seed-sensitivity (different weight values reshape the loss landscape enough that the
   *same* fixed search seed's simplex trajectory lands in a better or worse local region,
   effectively at random for a given seed/paytable). The search has no mechanism to notice
   it's stuck in a bad trajectory and try a different one.

Both trace back to the same gap: Phase 2 runs `nelderMead()` once, start to finish, with no
feedback loop watching whether the search is actually making progress.

## Goals

- Detect when Phase 2's search has stalled (RTP error, ordering-violation total, and
  limit-violation total have all stopped meaningfully improving) and escape it - either by
  retrying wider and under different Monte Carlo noise, or by giving up early once retrying
  clearly isn't helping, rather than spending the full iteration budget on a dead end.
- Stop immediately, without spending remaining budget, once the result is already
  essentially exact.
- Make the *reason* the search stopped - and how close it got on each of RTP, ordering, and
  limit constraints - visible in both the returned diagnostics and the TUNE FREQUENCIES UI,
  so "doesn't work" becomes "here's specifically what's unresolved and why."

## Non-goals

- Changing `nelderMead()` itself. It stays a generic, unmodified minimizer; all new logic is
  specific to how `tuneFrequencies`' Phase 2 wrapper drives repeated calls to it.
- Per-symbol RTP attribution (e.g. automatically computing "scatter alone contributes X% of
  RTP," the way the barfruits investigation did by hand with a throwaway script). Useful, but
  a materially bigger feature - out of scope here.
- Changing Phase 1 (the scatter/trigger-rate `gradientDescent1D` search), which already has
  its own plateau-widening logic and isn't what's being debugged here.

## Design

### Phase 2 becomes a loop of rounds, not one `nelderMead()` call

Replace the single `nelderMead({..., maxIterations})` call with a loop that runs it in
**rounds** of `stallWindowIterations` iterations each (default 15), tracking progress across
rounds:

```
point = initialPoint
stepSize = initialStepSize
restarts = 0
iterationsUsed = 0
best = null              // best-ever vertex across all rounds
stallStreak = 0
stalledOut = false

while iterationsUsed < maxIterations:
  roundIterations = min(stallWindowIterations, maxIterations - iterationsUsed)
  nmSeed = baseNmSeed + restarts * 1300021   // shifted each time a restart has happened - see below
  nm = nelderMead({ initialPoint: point, initialStepSize: stepSize,
                     evaluate: evaluateAtSeed(nmSeed), maxIterations: roundIterations, ... })
  iterationsUsed += nm.iterations
  if best is null or nm.result.error < best.error: best = nm.result

  if fully resolved (error <= earlyAcceptErrorPct AND orderingPenaltyRemaining <= 0 AND limitPenaltyRemaining <= 0):
    break

  improvedAny = errorImproved OR orderingImproved OR limitsImproved   // each vs. its own best-so-far, relative threshold
  if improvedAny:
    stallStreak = 0
    point = nm.point                      // keep refining from here, same step size
  else:
    stallStreak += 1
    restarts += 1
    point = best.point                    // restart from the best point ever seen, not this round's
    stepSize *= stallWidenFactor
    if stallStreak >= maxStallRestarts:
      stalledOut = true
      break
```

`nelderMead()` itself is unchanged and called the same way every round - only the wrapper
decides when to start a new round, from where, and how wide. There is deliberately no
separate "RTP within tolerance but violations stopped improving" exit: that's just a normal
instance of the loop above (`improvedAny` is false because none of the three fronts moved),
handled by the same stall-and-restart machinery. What distinguishes `converged-with-violations`
from `stalled` is only how `reason` classifies the *final* state once the loop stops (see
below) - not a separate code path.

### "Improved" is tracked per-component, not as one blended number

Three independent trackers, each comparing this round's value against its own best-so-far
via one shared relative-improvement rule:

```
function improved(newValue, prevBest, relativeThreshold = 0.02) {
  if (prevBest <= 0) return false;   // already at zero - nothing left to improve
  return (prevBest - newValue) > prevBest * relativeThreshold;
}
```

applied to RTP error, the ordering-violation total, and the limit-violation total
independently. A round only counts as a stall (`improvedAny === false` above) when **none**
of the three improved by at least 2% relative to their own best-so-far. This is what makes
"RTP is stuck but ordering violations are still being resolved" *not* trigger a restart - real
progress on any front keeps the search going.

This also directly answers the earlier question about `orderingPenaltyWeight`/
`limitPenaltyWeight`: RTP hitting target while violations remain is no longer a silent
"converged" - see `reason` below.

### Restarting also shifts the search seed, not just the step size

Phase 2 currently evaluates every point in a call under one fixed seed
(`nmSeed = searchSeed + 700000`) for common-random-numbers comparability within that call -
this is why it's fully deterministic. A stalled restart now also offsets that seed
(`nmSeed + restarts * 1300021`, an arbitrary large odd increment to avoid overlapping with
other seed derivations elsewhere in the file) for the next round. This directly targets the
seed-sensitivity finding above: a restart escapes not just a too-small step size, but also
whatever specific noisy trajectory the previous seed produced. Determinism is preserved
end-to-end - the whole sequence of rounds, widenings, and seed shifts is still a pure function
of the original `searchSeed`.

### How the loop actually stops

Three ways out, in the order the loop above checks them:

- **Fully resolved**: RTP error `<= earlyAcceptErrorPct` (new option, default `0.01`
  percentage points) *and* both ordering and limit violation totals are `<= 0`. Stop
  immediately - already essentially exact, no reason to spend more budget refining further.
  `reason` ends up `'converged'`.
- **Stalled out**: `maxStallRestarts` consecutive rounds with no improvement on any of the
  three fronts. This is the only way "RTP is within tolerance but violations remain and
  stopped improving" ends the search - it's not a separate check, just this same condition
  reached while `error` happens to already be `<= rtpTolerancePct`. `reason` ends up
  `'converged-with-violations'` in that case, or `'stalled'` if RTP itself never got within
  tolerance either.
- **Budget exhausted**: `iterationsUsed` reaches `maxIterations` while still on an improving
  streak (never triggered `stalledOut`). `reason` ends up `'exhausted'`.

### New diagnostics

`diagnostics.rtpPhase` gains (existing fields - `error`, `converged`, `rtp`, `triggerRate`,
`orderingViolations`, `limitViolations` - are unchanged, so nothing that reads them today
breaks):

| Field | Meaning |
|---|---|
| `reason` | `'converged'` (RTP + violations all resolved) \| `'converged-with-violations'` (RTP hit target, but ordering/limit violations remain and stopped improving) \| `'stalled'` (nothing improving on any of the three fronts, gave up early) \| `'exhausted'` (ran out of `maxIterations` while still making progress on at least one front) |
| `restarts` | Count of stall-triggered widen-and-reseed restarts |
| `iterationsRun` / `iterationsBudget` | Actual iterations spent vs. `maxIterations` - shows when a search stopped early rather than using its full budget |
| `rtpRange` | `{ min, max }` RTP measured across every point evaluated in the whole Phase 2 search (every round) - shows the breadth actually explored |
| `orderingPenaltyRemaining` / `limitPenaltyRemaining` | Summed magnitude still outstanding (a headline number alongside the existing itemized `orderingViolations`/`limitViolations` lists) |
| `stillImproving` | `{ rtp, ordering, limits }` booleans - which of the three were still getting better in the final round before the search stopped |
| `fixedSymbols` | `[{ reel, symbol }]` - symbols excluded from Phase 2 entirely (`fixed: true` on that reel), for context on what was never tunable to begin with |

`converged` keeps its current meaning (`error <= rtpTolerancePct`) unchanged, for backward
compatibility with anything already reading it.

### UI (`core/SimulationPanel.js`)

The existing "Target RTP was NOT reached" warning block branches on `reason`:

- `converged-with-violations`: a distinct message - "RTP target reached, but N ordering / M
  limit violations remain (totaling X / Y) - the search stopped trying to resolve them
  further after R restarts."
- `stalled`: "search gave up after R restarts with no further improvement on RTP, ordering,
  or limits (used I of B iterations)" - makes clear it stopped *itself*, not that it ran out
  of budget, and that raising Max Iterations alone won't help.
- `exhausted`: existing-style "closest attempt found is off by X points" message, plus a note
  that it was still improving when the budget ran out - raising Max Iterations may help here,
  unlike `stalled`.
- In all non-fully-converged cases, show the `rtpRange` explored ("RTP ranged from X% to Y%
  during the search") so it's visible the search wasn't just sitting still even when it
  didn't reach target.

`fixedSymbols` is included in the returned diagnostics (and the existing
`console.log('Frequency tuner diagnostics:', diagnostics)`) but not given its own UI
paragraph - it's context for the console, not a headline concern.

### New `tuneFrequencies` options

All optional, with the defaults used above:

- `stallWindowIterations` (15) - round size
- `stallWidenFactor` (3) - step-size multiplier on a stalled restart
- `maxStallRestarts` (4) - consecutive non-improving rounds before giving up early
- `earlyAcceptErrorPct` (0.01) - RTP error threshold for the "fully resolved" early exit

`relativeThreshold` (2%, used by the shared `improved()` check) is not exposed as an option -
it's an internal implementation detail of what counts as "still making progress," not
something a game author needs to tune per-call.

## Testing

- **Determinism regression**: two calls with identical options (including the new
  restart/seed-shift logic) produce byte-identical `reelFrequencyTables` - guards the
  property this whole design depends on and that the barfruits investigation confirmed
  manually.
- **Stalled/infeasible case**: a fixture engineered so Phase 2 cannot reach target RTP no
  matter what (mirroring the barfruits scatter-payout scenario) - assert `reason === 'stalled'`,
  `restarts > 0`, and `iterationsRun < iterationsBudget` (it gave up early rather than
  grinding through the full budget).
- **Early-accept case**: a fixture already essentially at target from the start - assert
  `reason === 'converged'` and `iterationsRun` is small (well under `maxIterations`).
- **Converged-with-violations case**: a fixture where RTP is easy to hit but the ordering
  preference can't be fully satisfied without moving RTP off target - assert
  `reason === 'converged-with-violations'` and `orderingPenaltyRemaining > 0`.
- **Per-component stall tracking**: a case where RTP error plateaus early but ordering
  violations keep improving for a while after - assert the search keeps running past the
  point where RTP alone would look stalled (i.e. `restarts` doesn't increase just because RTP
  stopped moving, as long as ordering is still improving).
- **`rtpRange`/`fixedSymbols` shape**: present, sane (`min <= max`, `fixedSymbols` entries
  reference real reel/symbol pairs) on a normal run.
