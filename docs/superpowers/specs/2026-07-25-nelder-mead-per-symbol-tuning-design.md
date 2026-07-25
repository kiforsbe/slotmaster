# Per-Symbol Nelder-Mead Frequency Tuning — Design

## Context

`tuneFrequencies` (in `core/SpinSimulator.js`) currently tunes each reel's value-symbol
weights via a single shared "tilt" scalar per reel: `weight(s) = baseFreq(s) *
t^tierOf(s)`, `t >= 1`, searched via 1D gradient descent (`gradientDescent1D`), cycled
across reels via coordinate descent (`rounds`), with a hard post-hoc floor
(`minOrderSafeTilt`) that forces `t` up whenever needed to guarantee "higher payout ⇒
lower/equal frequency" within a reel.

Testing against the real, hand-authored `FREQUENCY_REEL1/2/3` data (`games/fruitmachine/game.js`)
found this architecture fundamentally cannot reduce RTP for reels whose baseline data
already violates the ordering guarantee by a wide margin:

- `FREQUENCY_REEL1` has `melon` (pays 15x, tier 2) at frequency 20 and `grapes` (pays 10x,
  tier 3) at frequency 4 — backwards. Fixing just this one pair analytically requires
  `t >= 5.0`.
- The RTP-targeting search alone had already converged nicely at `t = 2.583` (error 0.79
  points, well within tolerance) — but the hard floor unconditionally overrides this up to
  `t = 5.0`, regardless of what that does to RTP.
- For this reel's composition, raising `t` always *raises* RTP (measured directly: 80% at
  t=1, 95% at t=2.583, higher still at t=5.0) because `cherries` (tier 4, worst nominal
  payout) pays on 1-of-a-kind and 2-of-a-kind matches too, not just 3-of-a-kind — its EV
  contribution per unit frequency vastly exceeds symbols that only pay on a full 3-match.
  Since the tiered scheme always shifts weight *toward* the highest tier as `t` rises, and
  `t` can never go below 1, every reel whose floor is nonzero can only ever push RTP up
  from that floor's forced state, never down.
- The result: reel 0 gets force-tilted to a state whose own RTP contribution is far above
  target, before reel 1 or reel 2 are even touched — and reels 1/2 have the same one-way
  problem, so the combined RTP has no path back down. Measured end state: ~131% RTP against
  a 96% target.

This isn't a bug in `gradientDescent1D` — it correctly recognizes there's nowhere useful to
move once pinned at `t=1`, and the search itself is not the problem. The problem is a single
scalar per reel cannot simultaneously satisfy "fix this one ordering violation" and "hit
this RTP target" when those two goals require moving in different amounts (or directions)
for different symbols on the same reel.

## Decision

Replace the tiered scalar-tilt-per-reel design with a genuine multi-dimensional
optimization: one free weight per (value symbol, reel) pair, searched via a vendored
**Nelder-Mead simplex** minimizer (the same algorithm behind `scipy.optimize.minimize
(method='Nelder-Mead')` / MATLAB's `fminsearch`). "Higher payout ⇒ lower/equal frequency"
becomes a soft penalty term in the loss, not a hard post-hoc override — the optimizer can
accept a small remaining violation if fully fixing it would blow RTP far off target, but it
never disappears silently: any remaining violations are reported in diagnostics.

Nelder-Mead was chosen over multi-dimensional gradient descent (finite-difference
gradients across all ~24 dimensions) because the objective (`simulateSpins`' measured RTP)
is inherently noisy — it's a Monte Carlo estimate, not a closed-form function — and
Nelder-Mead's derivative-free design (compare function values across simplex vertices,
no gradient probes) is the standard, well-established choice for exactly this kind of
noisy black-box objective. It also avoids the ~24 extra probe simulations per iteration a
full numerical gradient would need.

There's no bundler in this repo (plain ES modules loaded directly in-browser), so this is
vendored as a small, self-contained, cleanly-commented implementation of the standard
algorithm in `core/SpinSimulator.js` — not an npm dependency, since there's no build step
to resolve one into the browser bundle.

## Parameterization

One log-space weight `x_{r,s} = ln(weight_{r,s})` for every value symbol `s` present
(baseline frequency `> 0`) on every reel `r`, excluding:
- Symbols whose `type` is in `valueOrderExcludeTypes` (default `['wild']`) — held fixed at
  their current frequency, exactly as today.
- **Symbols with baseline frequency `0` on a given reel are never turned into a
  dimension at all** — they are excluded from the optimizable parameter set entirely, the
  same way `generateReel` already excludes explicit `frequency: 0` symbols from a reel's
  weights. There is no path in this design by which the optimizer can move a symbol off
  zero on a reel it was authored to never appear on; the projection step (below) never
  touches these positions, and the loss function has no dimension for them to move through.
- Scatter-typed symbols — handled entirely by the existing, unchanged Phase 1 (see below).

For fruitmachine, this is 8 value symbols (bar, clover, pear, melon, grapes, plum, orange,
cherries) × 3 reels = 24 dimensions.

## Loss function

```
loss(weights) = |RTP(weights) - targetRtp| + orderingPenaltyWeight * orderingPenalty(weights)

orderingPenalty(weights) = sum over each reel r, each same-reel pair (a, b) where
  tierOf[a] < tierOf[b] (a pays strictly more than b), of:
    max(0, weight_{r,a} - weight_{r,b})
```

`orderingPenaltyWeight` is a new tunable option (see below) — high enough to discourage
violations in the common case, but never an absolute wall, so RTP convergence always wins
when the two truly conflict. This directly answers the "soft penalty" design question:
violations cost the optimizer something, proportional to their size, but are never
force-corrected regardless of RTP cost.

`computeValueRanks` (tier-ranking by nominal payout) is unchanged and still used — now only
to build the pair list for the penalty term, not to construct weights directly.
`tieredRawWeights` and `minOrderSafeTilt` are deleted; there is no more hard floor.

## Optimization mechanics

- **Simplex:** 25 vertices for 24 dimensions (n+1, standard). Vertex 0 = today's baseline
  weights (`t=1` equivalent). Each of the other 24 vertices perturbs exactly one dimension
  from the baseline by `initialStepSize` (new option, log-space).
- **Standard coefficients:** reflection α=1, expansion γ=2, contraction ρ=0.5, shrink σ=0.5.
- **Projection:** before every vertex evaluation, its raw weights are clamped to a sane
  range (prevents the simplex drifting to a degenerate near-zero or runaway value) and then
  renormalized per reel back to that reel's fixed value-budget — the same role
  `renormalizeWeights` plays today, just applied to a full 24-dim candidate instead of one
  reel's tiered weights.
- **Noise handling (CRN):** every vertex evaluated within one generation (iteration) shares
  the same RNG seed, so relative comparisons between vertices reflect the parameter
  differences, not independent noisy Monte Carlo draws. The seed advances between
  generations (same `seedBase + i * <prime>` pattern `gradientDescent1D` already uses).
- **Termination:** `maxIterations` reached, or the best vertex's RTP error is within
  `rtpTolerancePct` **and** the simplex has sufficiently converged (spread of loss values
  across vertices below a small threshold) — mirroring today's `converged` semantics but
  applied to the whole joint search instead of one reel's turn.
- This single call replaces the entire `rounds` × `reelsCount` nested loop from today's
  Phase 2 — there is no more "visit each reel in turn," since every dimension moves
  together as one joint search.

Phase 1 (scaling scatter-typed symbols to hit the free-spin trigger rate) is **unchanged** —
it's an orthogonal concern (scatter frequency is normalized in its own separate budget,
never touching the value-symbol budget Phase 2 optimizes over).

## API changes

`tuneFrequencies(paytable, reelFrequencyTables, options)` — signature unchanged.

**Options removed:** `rounds`, `tiltBounds`.
**Options added:**
- `orderingPenaltyWeight` (default TBD during implementation, tuned against fruitmachine's
  real data so a meaningful violation costs comparably to a few RTP points)
- `initialStepSize` (default a moderate log-space perturbation, e.g. `0.5`)

`maxIterations` is kept, now meaning total Nelder-Mead iterations for the one joint search
(previously: gradient steps per reel per round).

**Return shape:** `{ reelFrequencyTables, rtp, triggerRatePct, diagnostics }` — unchanged
shape. `diagnostics.rtpPhase` drops `roundsRun`, adds:
- `iterationsRun: number`
- `orderingViolations: Array<{ reel: number, higherPaySymbol: string, lowerPaySymbol: string, amount: number }>` —
  whatever remains unresolved at the end, always reported even though it's non-fatal.

**`onProgress` callback:** shape becomes `(phase, iteration, weightsSummary, result, best)` —
the `context: { reelIndex, round }` parameter is dropped for phase `'shape'`, since there is
no longer a "current reel/round" — every dimension moves together each iteration. Phase
`'scatter'` callback shape is unchanged.

## UI impact (`core/SimulationPanel.js`)

- The "Coordinate Descent Rounds" `<input>` is removed (no longer a meaningful concept).
- Progress step labels simplify from `"Reel X · round Y · step Z"` to `"Step N"`.
- Results rendering (per-reel tables, copy-paste textarea) is unchanged — the *shape* of
  `reelFrequencyTables` coming out is identical to today, just produced differently.
- If `diagnostics.rtpPhase.orderingViolations` is non-empty, the panel should surface it
  (a short warning list: which reel, which symbol pair, by how much) so a remaining
  soft violation is visible rather than silently accepted.

## Testing

`tests/tunefrequencies.test.mjs` needs updates:
- Remove/replace the `'tuneFrequencies never inverts payout order within any single reel'`
  hard-assertion test — replace with a softer check (e.g. "ordering violations, if any, are
  reported in diagnostics and are small relative to baseline" or "running against known-easy
  data with no baseline violations produces zero ordering violations").
- Keep `'tuneFrequencies never gives a reel-absent symbol (frequency 0) a nonzero frequency'`
  unchanged — this guarantee is structural now (excluded from the parameter set entirely),
  not merely enforced by a floor, so it should hold even more robustly than before.
- New test: a synthetic reel with a deliberate large ordering violation (like
  melon/grapes) converges RTP close to target rather than getting stuck, unlike the old
  design.
- Update `onProgress` diagnostics test for the new callback shape (no `context` for phase
  `'shape'`).
