# Changelog

Notable changes per release. Starts at 0.6.0 — earlier releases are described by their
annotated tags (`git show 0.5.0`).

## 0.6.1 — 2026-07-27

Documentation only. No behaviour changed — 0.6.0 shipped a fifth game and a substantially
rebuilt tuner without the docs catching up, and this is that catch-up.

### Documentation

- **`CHANGELOG.md`** — this file, starting at 0.6.0. Earlier releases keep their annotated tags
  as the record; reconstructing notes for them from commit subjects alone would be less accurate
  than what is already there.
- **Mayan Tumble's README** — a screenshot, and what building the game actually taught us. It is
  the first pairing of `CascadeEngine` with a *line* evaluator, which `CascadeSpinMechanic`'s doc
  had long claimed was possible but nothing had exercised. The claim held: no engine or mechanic
  change was needed. What did need changing was everything around it that had quietly started
  using "cascade" and "cluster" as the same word — now written up as its own sections on payline
  indicators and playfield theming, alongside the tuning failure and its real error text.
- **Top-level README** — Mayan Tumble in the games table, the modules 0.6.0 added to the layout
  list, and two new sections on tuning: why penalty weights are normalized, and why structural
  knobs move RTP far more than frequencies do.
- **`docs/ARCHITECTURE.md`** — the layering diagram gained the tuner-support modules and the
  Worker pool, split into search-side and reporting-side because the imports genuinely differ.
  `CascadeEngine`'s config table gained `paylines` and `playfield`; new sections cover payline
  indicators, playfield theming, a paragraph per tuner-support module, and the rule the Mayan
  Tumble tuning bug came from — **a game's `tuneConfig` must carry every primitive its
  `winEvaluator` closes over**, because a Worker rebuilds that evaluator from names and
  primitives alone.

## 0.6.0 — 2026-07-27

37 files changed, ~9,800 lines added, across 38 commits. Two themes: a fifth game, and a
frequency tuner that says which knob to turn, what each knob means in real units, and what the
resulting game feels like to play.

### Added

**Mayan Tumble** — a 5×3 payline cascade set in a Mayan temple, and the first game to pair
`CascadeEngine` with a *line* evaluator rather than a cluster one. Wins draw the payline that
paid them, numbered at both ends, one at a time while that win is being paid. This matters more
here than on a cluster game: three matching symbols on a 5×3 grid sit on several paylines at
once, so the highlighted cells alone cannot tell a player which line they were paid for, and the
payout differs per line.

**Phase 0 — diagnosis without a search.** Its own action with its own UI, not a prelude to
tuning:

- **Config validation** (`core/TuningValidation.js`) that refuses to tune on arithmetic errors —
  broken cluster payout ladders, impossible stack bounds, reel geometry that cannot hold the
  spacing it asks for. Candy Frenzy is the case in point: it ran for days against a premium
  ladder where a 7-cluster paid less than a 5-cluster, which makes "raise RTP" and "make big
  clusters rarer" the same instruction.
- **Structural sensitivity** (`core/StructuralSensitivity.js`) — ladders each structural knob and
  ranks them by elasticity, because on a cluster-cascade game `stackChance`/`maxStack`/`minStack`
  move RTP by one to two orders of magnitude more than the entire per-symbol frequency search.
- **Structural grid search** (`core/StructuralSearch.js`) — sweeps the knobs jointly and ranks
  candidates for free by composing the sensitivity ladders, simulating only the top few. It
  refuses to name a winner when the measurement noise floor exceeds the acceptance tolerance,
  rather than reporting a confident recommendation drawn from noise.
- **Loss-budget preview** — what each term is about to contribute, before the search spends an
  iteration on it.
- **Payout-scale solve**, now reachable from the panel. RTP is strictly proportional to a global
  payout multiplier, so `targetRtp / measuredRtp` is exact arithmetic rather than a search result.

**Tune log** (`core/TuneLog.js`) — every config that became the new best is kept and exportable,
as JSON or as paste-ready `FREQUENCY_REEL` code. A search reports one answer and used to discard
the dozen candidates it passed through, several of which may be better for a purpose the loss
function knows nothing about. Each entry carries enough to judge it without re-running anything:
what it achieved against what was asked for, its own error bar, what its payout actually looks
like, what it violated, and the frequencies themselves.

**Player experience** (`core/PlayerExperience.js`) — round-level win shape measured without
holding a log, plus bootstrap-resampled session outcomes, so a tuned result can be described by
what it feels like to play rather than only by what it returns.

**Volatility as a soft tuning target** — a band rather than a point, so it contributes exactly
zero to the loss anywhere inside it and never competes with an RTP that was already acceptable.
Off by default. It comes with a documented caveat, repeated in the tooltip and under the control
itself: on a cluster-cascade game volatility is dominated by the payout ladder shape and
`maxStack`, *not* by symbol frequencies, so the target mostly steers the structural
recommendation and the payout solve rather than the frequency search.

**Reel coupling** — `linked` shares one weight per symbol across every reel;
`linked-then-refine` runs a linked Phase 2a then a bounded per-reel Phase 2b. On Candy Frenzy the
free per-reel search had produced a 73× spread on one symbol between two reels, paying 74.70% RTP
— 27pp *worse* than giving every candy the same frequency. Linking makes that spread
unrepresentable rather than merely penalized, and cuts the search from 84 dimensions to 12.

### Changed

**Penalties are normalized**, so a weight means the same thing on every game. Raw penalty totals
were incommensurable — ordering measured in frequency units, spacing as a violation *count* — and
were being summed with an RTP error in percentage points. Each is now a scale-free fraction, so
weight 1 ≈ 1pp of RTP. They are also named by intent ("Insist", "Prefer") rather than by
magnitude.

**The tuning panel** is restructured around what a developer is asking for — what you want, how
the reels should look, how hard to look, advanced — rather than around the options that exist.
Every control is disabled mid-run, the two action buttons have distinct jobs, and each phase says
which strategy it is running and why.

**Candy Frenzy** gives every symbol its own payout ladder, 5 through 15+, Cotton Candy at 300x
down to Chocolate at 40x. The seven were previously two tied groups of three and four, so within
a group they were interchangeable to anything ranking symbols by payout. Its paytable now renders
as a matrix — cluster size down the side, symbol across the top — with both axes derived from
`PAYTABLE`.

**`CascadeEngine`'s playfield is themeable.** It drew everything behind and around the symbols in
Candy Frenzy's pink-on-purple: one engine, two games, one hardcoded palette. Defaults are
unchanged, so Candy Frenzy looks exactly as it did; Mayan Tumble passes stone and jungle, with no
ruled cells and a seeded grain in their place.

**Payline lines run tag to tag** in both engines — the numbered circles are where a line begins
and ends, not decorations parked beside it.

### Fixed

- **Mayan Tumble could not start a tune.** Trials run in Worker threads and a closure cannot
  cross `postMessage`, so the worker rebuilds a game's evaluator from `winEvaluatorName` plus the
  primitives in its config; `paylines` was never passed. A builder now declares what it cannot be
  rebuilt without and fails by name, instead of a `TypeError` several frames later.
- **Reproducibility headers were `undefined` mid-run.** The resolved tuning parameters were built
  beside the `return` they travelled in, so they did not exist until a run finished — but the
  tune log is live, and a config copied out mid-run carried a header of literal `undefined`s.
  They are now emitted as the first progress event, before validation and before a spin.
- **Random initial frequency strategies collapsed toward the average.** Two independent bugs:
  `minFrequency`/`maxFrequency` were enforced against the *renormalized* frequency but sampled as
  *raw* weights, and the preview showed a spread the search never actually started from.
- **The payout-scale check blamed the wrong cause.** A verification miss was reported as "your
  winEvaluator captured its own paytable" when it could equally be too few spins or a paytable
  that is not a plain multiplier. It now distinguishes the three, which have different fixes.

---
_Docs last synced with the codebase: 2026-07-27, commit `66218c8`._
