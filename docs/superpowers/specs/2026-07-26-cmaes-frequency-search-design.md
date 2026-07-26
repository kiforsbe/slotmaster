# CMA-ES Frequency Search Design

## Problem

`tuneFrequencies`' Phase 2 search (the per-reel-per-symbol joint weight search in
`core/SpinSimulator.js`) is a Nelder-Mead simplex over a search space that keeps growing as
games get more elaborate: Candy Frenzy alone is ~84 tunable dimensions (7 reels x 12 tunable
value symbols, `bonus` excluded as the trigger symbol). Two properties of this problem are a
poor match for Nelder-Mead specifically:

1. **Nelder-Mead's cost scales badly with dimension.** Its simplex needs `n+1` vertices just to
   initialize (85 evaluations for Candy Frenzy before a single real search step happens), and
   its most expensive operation - a shrink, re-evaluating the whole simplex - gets
   proportionally more likely to trigger as dimension grows.
2. **Every Nelder-Mead decision is a raw `<` comparison on a single noisy loss value**
   (`vertices[0].loss`, `reflected.loss`, etc. throughout `nelderMead()`), with no notion of
   "is this actually better, or just a luckier Monte Carlo sample?" We measured Candy Frenzy's
   own standard error at ~70% at the panel's own defaults - most of the simplex's reflect/
   expand/contract/shrink decisions are being driven by measurement noise, not real signal.
   Nelder-Mead is documented in the simulation-optimization literature as degrading badly under
   exactly this kind of noise.

Neither is fixable by tuning existing options (`stallWidenFactor`, `maxStallRestarts`, etc.) -
they're a mismatch between the algorithm and the problem, not a mistuned parameter.

## Goals

- Add CMA-ES (Covariance Matrix Adaptation Evolution Strategy) as a second Phase 2 search
  algorithm, selectable per-run via a new `searchAlgorithm` option, without changing
  `nelderMead()`'s own behavior or `tuneFrequencies`' default (`searchAlgorithm: 'nelderMead'`
  stays byte-identical to today's output for every existing caller/test).
- Make the choice of "did this candidate actually beat the incumbent best?" noise-aware,
  regardless of which algorithm produced the candidate - this is the one place a statistically
  meaningful improvement is cheap to make without touching either algorithm's internals.
- Population-based evaluation (CMA-ES's whole point) must run concurrently across the existing
  Worker pool (`SimulationWorkerPool.js`), the same way Nelder-Mead's initial simplex and shrink
  batches already do via `Promise.all`.
- Stay fully deterministic given a fixed `searchSeed` - CMA-ES introduces a second source of
  randomness (sampling new candidates from its covariance distribution) beyond the existing
  Monte Carlo trial noise, and that sampling must itself be seeded.

## Non-goals

- Changing `nelderMead()` itself, or Phase 1 (the scatter/trigger-rate `gradientDescent1D`
  search). Both stay exactly as they are.
- Adding statistical-significance testing *inside* either algorithm's own internal comparisons
  (Nelder-Mead's vertex sort, CMA-ES's population ranking for recombination). CMA-ES's
  population-based, rank-based update is already considerably more noise-tolerant than
  Nelder-Mead's pairwise comparisons by construction - the targeted fix here is one layer up, at
  `tuneFrequencies`' own round-loop `best`-tracking (see "Statistically-gated best tracking"
  below), consistent with the existing tuning-search-robustness design's precedent of putting
  cross-round logic in the wrapper rather than the algorithm.
- SPSA. A real option discussed alongside CMA-ES, deliberately deferred - this design covers
  CMA-ES only, so it can be evaluated on its own before deciding whether SPSA is still wanted
  too.
- Collapsing Phase 1 and Phase 2 into one search (discussed and explicitly rejected - the two
  targets have independently-meaningful tolerances at very different scales, and merging them
  loses the separate `scatterPhase.converged` / `rtpPhase.converged` diagnostics).
- Any change to `dims`/`projectPoint`/`renormalizeWeights`/the penalty functions
  (`orderingPenaltyOf`, `limitPenaltyOf`, `uniformityPenaltyOf`) - both algorithms consume the
  exact same `evaluate(x)` closure `tuneFrequencies` already builds.

## Design

### New module: `core/CMAES.js`

A standalone, dependency-free implementation of CMA-ES (following Hansen's reference
`purecmaes` algorithm), exported as a single async function matching the exact return shape
`nelderMead()` already returns, so `tuneFrequencies`' round loop can call either
interchangeably:

```js
export async function cmaes({
  initialPoint, initialStepSize, evaluate, maxIterations,
  seed,                      // NEW vs. nelderMead - seeds CMA-ES's own candidate sampling
  convergenceTolerance = 1e-4,
  onProgress, onBusy, busyReportIntervalMs = 300, yieldToEventLoop,
}) {
  // ... returns { point, loss, result, iterations, converged }
}
```

`core/SpinSimulator.js` stays the file that owns the *problem* (reel tables, penalties,
measurement); `core/CMAES.js` owns the *algorithm*, same separation already drawn between
`SpinSimulator.js` and `nelderMead()` (which happens to live in the same file today, but is
already a generic, standalone minimizer with no knowledge of reels or RTP). Splitting the new,
substantially-sized algorithm (matrix math, eigendecomposition) into its own file keeps
`SpinSimulator.js` from growing further and keeps the algorithm independently testable.

### The algorithm itself

Standard, un-simplified CMA-ES (population size, recombination weights, and every learning
rate below are the standard formulas from Hansen's tutorial - not hand-tuned - so they scale
correctly with `n` automatically):

```
n = initialPoint.length
lambda = 4 + floor(3 * ln(n))                      // population size per generation
mu = floor(lambda / 2)                             // parents used for recombination
weights[i] = ln(mu + 0.5) - ln(i + 1), i = 0..mu-1  // log-linear, best-ranked gets most weight
weights /= sum(weights)                             // normalize to sum 1
mueff = 1 / sum(weights[i]^2)

cc    = (4 + mueff/n) / (n + 4 + 2*mueff/n)         // time constant, C's evolution path
cs    = (mueff + 2) / (n + mueff + 5)               // time constant, sigma's evolution path
c1    = 2 / ((n + 1.3)^2 + mueff)                   // rank-one update rate for C
cmu   = min(1 - c1, 2*(mueff - 2 + 1/mueff) / ((n + 2)^2 + mueff))  // rank-mu update rate
damps = 1 + 2*max(0, sqrt((mueff - 1) / (n + 1)) - 1) + cs
chiN  = sqrt(n) * (1 - 1/(4n) + 1/(21n^2))          // expected length of N(0, I)

state: m = initialPoint, sigma = initialStepSize, C = I(n), pc = 0, ps = 0, B = I, D = 1s

each generation:
  sample lambda candidates: z_k ~ N(0, I) (seeded), y_k = B . (D * z_k), x_k = m + sigma*y_k
  evaluate all lambda candidates concurrently (Promise.all - see below)
  sort by loss ascending; recombine the best mu into a new mean via `weights`
  update ps (sigma's evolution path), then sigma itself (exponential update toward chiN)
  update pc (C's evolution path, with the standard hsig stall-guard)
  update C via its rank-one (pc pc^T) and rank-mu (weighted sum of y_i y_i^T) terms
  periodically (every ~n/(10*(c1+cmu)) generations, not every generation - this is the
  expensive O(n^3) step) re-symmetrize C and recompute its eigendecomposition into B, D
```

This is implemented faithfully rather than simplified, since it's a well-understood, widely
validated reference algorithm - deviating from the standard formulas would be reinventing a
worse version of something already solved.

### Eigendecomposition: Jacobi algorithm

CMA-ES needs the eigendecomposition of a symmetric `n x n` matrix (`C`) to sample from its
distribution and to compute `C^{-1/2}` for the sigma evolution path. The classic **Jacobi
eigenvalue algorithm** is used: it only works on symmetric matrices (which `C` always is by
construction), is numerically stable, always converges, and is simple enough to implement and
test in isolation (~50 lines: repeatedly zero out the largest off-diagonal element via a
Givens rotation until the matrix is diagonal enough). At `n` ~ 84-91 this is `O(n^3)` per
decomposition, which is why it only runs periodically (see above) rather than every
generation - the reference implementation's own amortization schedule exists specifically to
keep this affordable.

`core/CMAES.js` exports `eigenSymmetric(matrix)` as its own tested unit, separate from the
`cmaes()` function that calls it - the same "small testable pieces" approach already used for
`projectPoint`/`renormalizeWeights` inside `tuneFrequencies`.

### Concurrency: population evaluation via the Worker pool

Every generation's `lambda` candidates are mutually independent (no candidate's evaluation
depends on another's), exactly like Nelder-Mead's initial simplex or shrink batch - so they're
dispatched together via `Promise.all`, the same pattern already established. This is the
single biggest practical payoff of CMA-ES over Nelder-Mead in this codebase: *every* generation
is a full-population batch (`lambda` ~ 4 + 3*ln(84) ~ 17 concurrent evaluations), whereas
Nelder-Mead only hits that scale of parallelism on the relatively rare shrink step - so CMA-ES
keeps the Worker pool consistently busy instead of mostly evaluating one or two points at a
time.

`onBusy` fires the same way the existing shrink-batch reporting does: once immediately (no
`verticesEvaluated`), then at most once per `busyReportIntervalMs` while the generation's
`lambda` evaluations are still resolving, with `verticesToEvaluate: lambda`.

`onProgress` is called once per generation, with the same positional shape
`nelderMead()`'s callers already expect: `(iter, bestOfGeneration.point, bestOfGeneration,
bestEver, bestOfGeneration)` - `attempted` is the best candidate this generation actually
produced (mirroring Nelder-Mead's "what this iteration attempted" semantics), so
`SimulationPanel.js`'s existing live-log/gauge code (which already reads `result`/`attempted`
off of whichever object `onProgress` hands it) needs **no changes** to work with either
algorithm.

### Determinism: seeding CMA-ES's own sampling

Unlike `nelderMead()` (which takes no seed itself - all its randomness comes from whatever
`evaluate` does internally), `cmaes()` takes an explicit `seed` and uses a seeded RNG (reusing
`createSeededRng`, already in `core/SpinSimulator.js`) for every generation's `z_k ~ N(0, I)`
sampling (via the existing Box-Muller approach already used for `sampleNormalFrequency`).
`tuneFrequencies` passes its existing round seed (`nmSeed = baseNmSeed + restarts * 1300021`)
through unchanged - the same seed that already seeds `evaluate`'s own Monte Carlo trials, so a
restart reseeds *both* the search's own sampling and its measurements together, preserving the
project's hard invariant that identical `searchSeed` always produces byte-identical
`reelFrequencyTables`.

### `tuneFrequencies` becomes search-algorithm-agnostic

Inside the existing Phase 2 round loop (`do { ... } while` in `tuneFrequencies`), the direct
`nelderMead({...})` call is replaced with a dispatch on the new option:

```js
const runSearch = options.searchAlgorithm === 'cmaes' ? cmaes : nelderMead;
const nm = await runSearch({
  initialPoint: point, initialStepSize: stepSize, evaluate: makeEvaluate(nmSeed),
  maxIterations: roundIterations, seed: nmSeed,   // ignored by nelderMead, used by cmaes
  onProgress: ..., onBusy: ..., busyReportIntervalMs, yieldToEventLoop,
});
```

Nothing else in the round loop changes - restart/stall detection, seed-shifting, and `reason`
classification are all algorithm-agnostic already (they only look at `nm.point`, `nm.result`,
`nm.iterations`, `nm.converged`), which is exactly why this was designed as a pluggable
interface rather than a parallel code path.

### New option: `searchAlgorithm`

`'nelderMead'` (default, unchanged behavior) or `'cmaes'`. Exposed in `SimulationPanel.js` as a
dropdown next to the existing "Initial Frequency Strategy" select, defaulting to "Nelder-Mead
(default)".

### Statistically-gated best tracking

Independent of which algorithm is chosen, `tuneFrequencies`' round loop currently updates its
cross-round incumbent with a raw comparison:

```js
if (!best || nm.result.loss < best.loss) best = nm.result;
```

This is upgraded to require the new candidate to beat the incumbent by more than their combined
measurement uncertainty, using `trialRtpStdError` (already computed by `measure()` from earlier
work this session):

```js
function beatsIncumbent(candidate, incumbent, z) {
  if (!incumbent) return true;
  const margin = z * Math.sqrt((candidate.trialRtpStdError ?? 0) ** 2 + (incumbent.trialRtpStdError ?? 0) ** 2);
  return (incumbent.loss - candidate.loss) > margin;
}
```

New option `bestAcceptanceZ` (default `1.0`, ~68% one-sided confidence) controls `z`. On a
low-noise game (`trialRtpStdError` near 0), `margin` collapses to near 0 and this is
indistinguishable from today's raw comparison - so this only actually changes behavior on
noisy mechanics like Candy Frenzy's cascade bonus, which is exactly where it's needed. This
same check replaces every `best = ...` comparison in the round loop (RTP error's own
best-tracking specifically - the separate ordering/limit/uniformity penalty best-trackers are
deterministic given a candidate, so they're untouched).

## Testing

- **`core/CMAES.js` standalone (new `tests/cmaes.test.mjs`)**:
  - Minimizes a simple 2D quadratic bowl (mirrors the existing `nelderMead` test) - converges
    near the known minimum.
  - Minimizes a higher-dimensional (~20-30 dim) quadratic bowl within a modest iteration
    budget - demonstrates it scales past where Nelder-Mead becomes impractical.
  - Tolerates a noisy `evaluate` (loss + seeded Gaussian noise added) and still lands close to
    the true minimum - the noise-robustness property motivating this whole design.
  - `eigenSymmetric()` unit-tested directly: recovers known eigenvalues/eigenvectors of a small
    hand-constructed symmetric matrix.
  - Determinism: identical `seed` + inputs produce byte-identical output, matching the same
    invariant already required of `nelderMead`/`tuneFrequencies`.
  - Population evaluation dispatches concurrently: same delay-based `evaluate` /
    `maxConcurrent`-tracking pattern already used for Nelder-Mead's initial-simplex/shrink
    concurrency tests.
  - `onProgress`/`onBusy` fire with the documented shape and cadence.
  - Respects `maxIterations`; `converged` reflects whether `sigma` collapsed below
    `convergenceTolerance` rather than the budget running out.
- **`tuneFrequencies` integration (`tests/tunefrequencies.test.mjs`)**:
  - `searchAlgorithm` omitted (or `'nelderMead'`) produces **byte-identical**
    `reelFrequencyTables` to before this change, on the existing fixtures - regression guard
    that adding the option doesn't alter the default path at all.
  - `searchAlgorithm: 'cmaes'` converges to a sane RTP on a real fixture (fruitmachine).
  - `beatsIncumbent`/statistically-gated best-tracking tested directly with synthetic
    candidates carrying controlled `trialRtpStdError` values - asserts a noisy "improvement"
    smaller than the combined standard error does *not* replace the incumbent, and a real
    improvement larger than it does.

---
_Design reviewed inline; ready for `docs/superpowers/plans/2026-07-26-cmaes-frequency-search.md`._
