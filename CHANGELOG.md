# Changelog

Notable changes per release. Starts at 0.6.0 — earlier releases are described by their
annotated tags (`git show 0.5.0`).

## 0.10.2 — 2026-08-02

### Added

- **New particle effects for Lemon Pop's mini Pop features and Pop Rush** — `ParticleSystem`
  gained a citrus swirl burst and a fizzy pop-scatter burst, with `CascadeDropAnimator` and
  `SlotRenderer` extended to trigger and time them around mini Pop and Pop Rush board transitions.

### Changed

- **Pop Rush no longer requires fully charging the Pop meter first** — it now upgrades any settle
  where the board is fully clear or holds at most one wild can. A fully cleared board also awards
  a 25× total-bet bonus on top, independent of whether Pop Rush triggers.
- **Lemon Pop's Pop meter was redesigned** — updated visual styling and layout for the charge ring
  and Pop Rush indicator, with clearer state feedback as segments fill.
- **Paytable panel scrollbar and symbol typing were unified across all games** — the shared
  `PaytableRenderer`/`slot-game.css` now render a themed scrollbar on the paytable panel and a
  Premium/Regular badge (or a corner-dot indicator for the compact cluster headers) next to each
  symbol.

### Fixed

- Cleaned up a broken duplicate `<div>` left before `<!doctype html>` in Lemon Pop's `index.html`
  and a duplicate rules bullet in its `README.md`, both stray leftovers from an earlier
  AI-assisted edit.

## 0.10.1 — 2026-08-01

### Fixed

- **The RUN SIMULATION panel's stat cards no longer duplicate on repeated runs** — a stale
  `document.getElementById('sim-stats')` reference re-queried on every click (Lemon Pop) could
  resolve to the grid the panel itself created on the previous run, and the panel's own
  `getOrCreateStatsGrid` couldn't recognize being handed the grid as its own host (`querySelector`
  only searches descendants), so it nested a second stats grid inside the first instead of
  clearing it. The panel now always hosts its stat-card grid on `panel` itself, ignoring any
  legacy per-field `domRefs` a caller supplies.

### Changed

- **Simulation panel stat cards unified across games** — RTP is no longer a hero (full-width)
  card and the Seed card no longer forces full width, so all five stat cards fit on one row on
  desktop widths; the duplicate "Overall Seed" bar in the Detailed Win Breakdown section was
  removed, since the seed is already shown in the stat-card row.
- **Removed the stale hand-written `#sim-modal`/`#sim-stats` skeleton** from barfruits',
  bookbookbook's, candyfrenzy's, fruitmachine's, and mayantumble's `index.html` — the simulation
  panel and its stat cards have been fully DOM-built by `DeveloperPanels.js`/`SimulationPanel.js`
  since 0.9.0's developer-panel work, so this static markup was dead weight, silently discarded on
  the first RUN SIMULATION click of every session.

## 0.10.0 — 2026-08-01

### Added

- **Lemon Pop game and assets were added** — includes tile definitions/artwork and a dedicated
  no-refill cascade implementation (`Pop Rush`) with game-specific mechanics and effects, including
  `LemonPopSpinMechanic.js`, `LemonPopFeatures.js`, and `StraightLineMath.js` for line-based evaluation.
- **New rendering components for line games** — `StraightLineWinRenderer.js` added to support
  payline visualization in cascade games like Lemon Pop.

### Changed

- **Lemon Pop paytable and mechanics were refined** — payout tuning, paytable presentation,
  and related test coverage were updated after the initial game add.
- **Web Audio music playback now uses `resume()` flow** for better browser audio-context
  integration across all games.
- **Pop Rush mechanics and effects were enhanced** — game features and UI elements were updated
  to improve the no-refill cascade experience.

## 0.9.0 — 2026-07-31

### Added

- **Shared responsive slot UI across all games** — common controls and state handling now cover
  bet size, lines, balance, spin/stop, autoplay, turbo, sound, and music, with layouts that scale
  from embedded views through fullscreen desktop, tablet, and phone sizes.
- **Dynamic paytables for line and cluster games**, including symbol artwork, payline diagrams,
  scatter-specific payouts, and cluster payout tables.
- **Dedicated developer panels** for simulation, tuning, and live spin logging, with proper
  panel chrome, movable/resizable/collapsible spin logging, live updates, and shared panel
  management.
- **Configurable cascade win visualization** — cluster outlines support themed colors, glow,
  pulse, rounded and concave corners, line styles, and payline-cascade winning-cell outlines.
- **Generic asset and sprite animation loading**, including animated clear effects and Mayan
  Tumble's stone-explosion assets.
- **GitHub Pages deployment workflow** and updated game portal presentation.

### Changed

- **Simulation and tuning were refactored into dedicated modules** under `core/simulation/` and
  `core/tuning/`, with worker-pool execution, bounded concurrency, deterministic trial seeds,
  explicit exploration/holdout measurements, improved diagnostics, structural search, frequency
  comparison tables, and clearer result/export reporting.
- **Developer UI files were moved into `core/ui/dev/`**, file I/O into `core/io/`, and spin-log
  support into `core/logging/`, removing the old root-level compatibility shims and updating games
  and tests to use the real modules.
- **Slot rendering was further decomposed**: cluster geometry now lives in
  `core/math/ClusterOutline.js`, while Canvas painting is handled by
  `core/rendering/ClusterOutlineRenderer.js`; `SlotRenderer` remains the frame orchestrator.
- **Cascade paylines now support all-at-once win clearing**, showing each active payline before
  clearing the combined winning positions.
- **Audio and game assets use shared engine services**, including music toggling, preloaded music,
  accelerated stopping, and unified sprite/tilemap handling.
- **Free-spins intro handling now pauses autoplay and queued spin requests** until the player
  explicitly enters the bonus round.

### Fixed

- **Cluster visualization now works for payline-based cascade games** such as Mayan Tumble: the
  active payline remains visible and the configured outline is also painted around its winning
  cells.
- **Cascade clear stopping no longer references an undefined turbo flag**, including the
  all-at-once payline transition path.
- **Tuning output now preserves the actual measurement budget and uncertainty** instead of
  presenting a single-trial exploration result as a fully validated result.
- **Legacy per-game UI and win-handling duplication was removed**, preventing inconsistent control
  behavior and stale panel wiring between games.

## 0.8.0 — 2026-07-29

### Added

- **Per-game background music**, with duck-on-effect and a master compressor
  (`config.music`, `SlotAudio.setDuckingConfig`/`setCompressionConfig`) — a game can also
  disable or tune either independently.
- **Full-canvas viewport backgrounds** (`config.viewportBackground`) — a color/noise/image
  backdrop covering the whole canvas, drawn behind everything else, independent of the
  existing per-reels-rect `config.playfield.background`.
- **`config.playfield.background` gained a `color` type**, alongside the existing `noise`/
  `image` — previously setting `color` was a silent no-op.
- **Cluster win popups (cascade games) are now configurable**: amount/detail text can each be
  shown or hidden, and position/scale/font-size are each independently animatable, backed by a
  new reusable `core/animation/AnimatedValue.js` — a CSS-transition-style resolver
  (`{ default, animation: { to, duration, easing } }`) usable on any numeric property, not just
  popups.
- **Cluster win popups can show a `base × multiplier` breakdown** before the final total, for
  wins boosted by a free-spins tile multiplier, with a configurable minimum hold time so it's
  actually readable instead of flashing past.
- **The reels' outline glow is themeable**: `outlineWidth`, `outlineGlowIntensity` (how
  saturated/opaque it reads, independent of spread or thickness), and `outlineBehindSymbols`
  (draw in front of, or behind, the grid).

### Changed

- **The canvas now fills its `.game-viewport` container exactly**, instead of being
  letterboxed to the reel grid's own aspect ratio — no dead space around it, so a background
  (CSS or `viewportBackground`) lines up pixel-for-pixel with the visible playfield. Any extra
  room around the reels' own aspect-fit grid now stays inside the canvas itself.
- **The reels' outline/glow is built from layered `ctx.filter` blur passes** instead of
  `ctx.shadowBlur`, which stayed too faint on a thin stroke to read as an actual glow.

### Fixed

- **Both line-pay and cascade games showed a blank grid before the player's first spin** —
  added an optional `showIdle()` animator hook, called once from `CoreSlotEngine.init()`.
- **A cleared cascade cluster could briefly reappear at full opacity** mid-multi-cluster
  cascade, before the next clear pass ran. Clearing now works on a private grid copy and nulls
  out each cluster's own cells the moment its poof finishes, instead of only mutating the
  clear-variants map.
- **`playEntrance` could fire more than once per spin** in certain cascade step-transition
  sequences.
- **The reels' outline/glow was silently painted over every frame** by the grid's own `frame`
  border stroke, drawn after it — reordered so the glow always renders last. It's also now
  clipped to stay outside the reels' own interior, so it can never bleed onto the symbols
  regardless of width/blur settings.
- **Mayan Tumble's `viewportBackground` never rendered** — it was nested under `playfield`,
  where only `background` is read; `viewportBackground` is a top-level key.
- **Mayan Tumble's cabinet and bet-adjuster sizing/styling didn't match the other games** —
  its cabinet was sized for a 7x7 grid despite being a 5x3 game, and its bet-adjuster used an
  older circular-button style.

## 0.7.0 — 2026-07-28

`core/SlotEngine.js` and `core/CascadeEngine.js` — the two ~1,200-line monolith classes every
game's live rendering, animation, and state machine ran through — are gone, replaced by
`core/engine/CoreSlotEngine.js`: a skeleton owning only the state machine and the animation
dispatch loop. Everything else the two old classes each did their own way (grid resolution,
spin animation, drawing, particles, audio, free-spins payout rules, spin logging) is now a
separate, independently testable component class the engine calls through a small fixed
interface, never importing a concrete implementation itself. All five games run on it. No
gameplay behaviour is intended to change — see Fixed below for the two places it actually did,
both real gaps the migration surfaced rather than anything deliberately different.

### Changed

- **`core/` is reorganized into subfolders** — `math/` (`SlotMath.js`, `CascadeMath.js`,
  `ClusterMath.js`), `rendering/` (`GridLayout.js`, `SpriteDrawer.js`, `ParticleSystem.js`, and
  the new `SlotRenderer.js`), `audio/` (`SlotAudio.js`), and `engine/` (`CoreSlotEngine.js`,
  the mechanics, the animators, and every other new component below). `SpinSimulator.js` and
  the tuner support modules stay where they were — they were never engine-specific.
- **A mechanic gained a normalized live-play entry point.** `LineMechanic`/
  `CascadeSpinMechanic` already shared `resolveSpin` for batch simulation; each now also
  exposes `resolveLiveSpin`, returning `{ steps, scatterWin }` with every step's `payout`
  already converted to money. `CoreSlotEngine` sums that across every step and never needs to
  know which mechanic it's driving.
- **Spin animation is a pluggable `SpinAnimator`**, not baked into the engine class:
  `ReelScrollAnimator` (reel spin-up/land physics, the Book-of-Dead expanding reveal) and
  `CascadeDropAnimator` (drop-in/clear/fall) are faithful ports of the two old engines' own
  `update()` loops, restructured into self-contained `playEntrance`/`playTransition` calls.
- **Drawing is a pluggable `Renderer`.** `SlotRenderer` holds every drawing primitive both
  animators call into — symbols, borders, win effects, paylines, playfield theming, cascade
  clear/fall visuals, cluster win popups — for both engine families, branching once at the top
  on which mechanic is active.
- **Audio and spin logging are pluggable components too** — `AudioController` (spin-lifecycle
  hooks forwarding to the `SlotAudio` singleton) and `SpinLogRecorder` (replaces the duplicated
  `_pushSpinLogEntry` each old engine used to maintain separately).
- **Playfield backgrounds gained an `image` type**, alongside the existing generated `noise`
  texture — `{ type: 'image', image: url }` stretches a static image behind the reels. Mayan
  Tumble and Book of Book Book both use it now.

### Fixed

- **The SPIN LOG button silently showed zero spins** on every migrated game — `CoreSlotEngine`
  never exposed a `spinLog` property, so `SpinLogPanel.js`'s `engine.spinLog || []` always read
  as empty. Added a getter backed by the plugged-in `SpinLogRecorder`'s own entries.
- **Book of Book Book's expanding-wild wins were paid but never logged** — resolved correctly
  and added to the balance, but the spin log entry's `expandingWin`/`expandingReels` fields
  stayed at their zeroed defaults, since nothing wired the resolved expansion result through to
  the recorder. `CoreSlotEngine._finishSpin` now passes it through.

### Known issues

- Mayan Tumble's RUN SIMULATION still reports an RTP far from its 96% target (currently
  measuring well above it, on both this release's reel frequencies and the ones tuned
  independently on `main` while this refactor was in progress). Not yet root-caused; not
  believed to be caused by this refactor, since it reproduces against the pre-refactor engine
  too, but not yet confirmed either way.

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
_Docs last synced with the codebase: 2026-08-01, HEAD `e7cf178` (tag v0.10.0)._
