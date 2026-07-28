# Core modularization: folders, components, and a unified engine skeleton

Status: proposal — not yet approved for implementation.

## Why

`core/` is a flat folder of ~28 files. Two of the largest, `SlotEngine.js` (line-pay live game,
~48KB) and `CascadeEngine.js` (cascade live game, ~48KB), independently implement the same
concerns — state machine, animation loop, resize handling, free-spins lifecycle, particle
spawning, cabinet/loading-screen rendering, spin-log pushing, `runSimulation` wiring — under the
same ~15 method names (`init`, `animate`, `update`, `spin`, `requestSpin`, `enterFreeSpins`,
`retriggerFreeSpins`, `exitFreeSpins`, `render`, `runSimulation`, ...). Everything genuinely
game-specific (reel-scroll vs. cascade-drop animation, cluster vs. line win shapes) is a small
fraction of each file; the rest is duplicated scaffolding that has to be kept in sync by hand.

This proposal does two things:

1. **Reorganizes `core/` into subfolders** by architectural concern — pure math, rendering, engine
   — instead of one flat directory.
2. **Replaces `SlotEngine.js`/`CascadeEngine.js` with one `CoreSlotEngine` skeleton** that owns
   only the state machine and animation loop, with every other concern (grid resolution,
   spin/cascade animation, drawing, particles, audio, free-spins payout rules, spin logging) as
   its own class in its own file, plugged in through configuration — not two independent
   implementations of the same 15 methods.

Everything downstream of `core/math/` (win logic, RNG, reel building) is untouched. This is a
structural/architectural refactor, not a payout-behavior change — RTP for every game must measure
identically before and after (see "Testing & risk").

## Scope for this phase

In scope: `core/math/`, `core/rendering/`, `core/engine/`, `core/audio/` — the modules named in the
request (math, rendering, game engine) plus audio (self-contained singleton, low risk to relocate
alongside them).

Out of scope for this phase, left flat in `core/` for now: `SpinSimulator.js` and the tuning
modules (`TuningValidation.js`, `TuningUnits.js`, `StructuralSensitivity.js`, `StructuralSearch.js`,
`PlayerExperience.js`, `TuneLog.js`, `CMAES.js`), `SimulationPanel.js`, `SpinLogPanel.js`,
`FileIO.js`, `SpinLog.js`, `SimulationWorkerPool.js`, `simulationTrialWorker.js`,
`mechanicRegistry.js`. These are already reasonably well-factored (each does one job, each has its
own tests) and weren't called out in the request. A later phase can fold them into `simulation/`,
`tuning/`, and `ui/` following the same pattern established here — noted as a roadmap, not designed
in detail in this doc.

No build step is introduced. This stays plain ES modules served directly (`./serve.ps1`), matching
the existing "no bundler" constraint — modularity comes from folder structure, explicit relative
imports, and one class/concern per file, not from tooling.

## Target folder structure (this phase)

```
core/
  math/
    SlotMath.js          (unchanged, pure)
    CascadeMath.js        (unchanged, pure)
    ClusterMath.js         (unchanged, pure)
  rendering/
    SlotRenderer.js       (NEW — draw-call code extracted from both engine classes)
    GridLayout.js
    SpriteDrawer.js
    ParticleSystem.js
  engine/
    CoreSlotEngine.js     (NEW — replaces SlotEngine.js + CascadeEngine.js)
    mechanics/
      LineMechanic.js
      CascadeSpinMechanic.js
    animators/
      ReelScrollAnimator.js  (NEW)
      CascadeDropAnimator.js (NEW)
    FreeSpinsModes.js
    SpinLogRecorder.js    (NEW — replaces duplicated `_pushSpinLogEntry`)
  audio/
    SlotAudio.js
  # unchanged, flat, out of scope this phase:
  SpinSimulator.js, SimulationWorkerPool.js, simulationTrialWorker.js, mechanicRegistry.js,
  TuningValidation.js, TuningUnits.js, StructuralSensitivity.js, StructuralSearch.js,
  PlayerExperience.js, TuneLog.js, CMAES.js, SimulationPanel.js, SpinLogPanel.js, FileIO.js,
  SpinLog.js
```

Every game's imports (`games/<name>/game.js`, 27 files reference `core/` paths across games and
tests today) get their `core/X.js` paths updated to the new location as part of moving each file —
a mechanical, one-time path change per import, no behavior change.

## `CoreSlotEngine` — a skeleton, components plugged in

`CoreSlotEngine` is a thin host. It owns:

- canvas/context binding and resize handling
- the state machine — one explicit `state` field, a fixed transition table (a superset of both
  existing machines: `idle → spinning → stopping → evaluating → (free_spins_intro | showing_wins
  | idle) → ... → game_over`)
- the animation loop (`requestAnimationFrame` → `tick(dt)` → dispatch to components)
- balance/bet bookkeeping (identical between both classes today)
- thin lifecycle methods (`requestSpin()`, `spin(seed)`, `stopSpin()`, `enterFreeSpinsIntro()`,
  `enterFreeSpins(...)`, `retriggerFreeSpins(...)`, `exitFreeSpins()`, `returnToIdle()`,
  `runSimulation(...)`) that mutate state and delegate to plugged components
- firing `onStateChange`/`onScatterTrigger`/`onWin` config callbacks, same contract as today

It contains **zero** rendering code, **zero** reel/cascade-specific logic, **zero** direct audio
calls, **zero** particle code. Everything else is a separate class, in its own file, referenced
through the constructor config.

### The unifying trick: every spin is a step-sequence

A live spin resolves to a normalized array of steps, reusing the shape `resolveCascadeSequence`
(`CascadeMath.js`) already returns for cascades:

- A line-pay spin is a **1-step sequence**: `[{ grid, wins, payout }]`.
- A cascade spin is an **N-step sequence**: `[{ grid, fallOffsets, wins, payout }, ...]`.

`Mechanic.resolveLiveSpin(reelStrips, rowsCount, seed, config) → stepSequence` is the one call
`CoreSlotEngine` makes to resolve a spin, for every mechanic — extending the `resolveSpin`
batch-simulation entry point both `LineMechanic`/`CascadeSpinMechanic` already expose (per
`ARCHITECTURE.md`) to cover live play too, so live play and simulation share one resolution path
instead of two. Because a line-pay sequence always has length 1, every "is there another step"
check downstream is naturally a no-op for those games — no `if (isCascade)` branch anywhere in the
skeleton.

### Components — each its own class, its own file

| Component | Minimal interface | File | Today's equivalent |
|---|---|---|---|
| **Mechanic** | `resolveLiveSpin(strips, rows, seed, config) → stepSequence`, plus existing batch `resolveSpin` | `core/engine/mechanics/LineMechanic.js` / `CascadeSpinMechanic.js` | Already this shape (batch-only); extended to live play |
| **SpinAnimator** | `playEntrance(step, ctx, onDone)`, `playTransition(prevStep, nextStep, ctx, onDone)` | `core/engine/animators/ReelScrollAnimator.js` / `CascadeDropAnimator.js` | Baked inline into each engine class today |
| **Renderer** | `draw(engineState, config, ctx)` | `core/rendering/SlotRenderer.js` | `render()` and everything below it, duplicated in both classes |
| **ParticleSystem** | `spawn(...)`, `update(dt)`, `render(ctx)` | `core/rendering/ParticleSystem.js` | Already its own file; not yet composed as a plugged component (called ad hoc) |
| **FreeSpinsMode** | `createState(engine)`, `wrapWinEvaluator(...)`, `onStepCleared(...)`, `renderOverlay(...)` | `core/engine/FreeSpinsModes.js` | Already this shape; cascade-only today, opened up to every mechanic (a line-pay flat-multiplier mode is just `createFlatMultiplierMode()` reused) |
| **AudioController** | `onSpinStart()`, `onReelStop(i)`, `onWin(amount)`, `onScatterTrigger()`, `onExpand()` | `core/audio/SlotAudio.js` | Already a singleton; wrapped behind a small hook interface the engine calls generically, instead of being imported and called by name at ad hoc points inside `SlotEngine.js` |
| **SpinLogRecorder** | `record(spinResult) → entry`, holds `.entries` | `core/engine/SpinLogRecorder.js` (NEW) | `_pushSpinLogEntry`, duplicated per engine class |

A game assembles `new CoreSlotEngine(canvas, { mechanic: LineMechanic, animator:
ReelScrollAnimator, renderer: new SlotRenderer(...), freeSpinsMode, paylines, playfield, ... })`.
`LineMechanic` + `ReelScrollAnimator` reproduces today's `SlotEngine.js` behavior;
`CascadeSpinMechanic` + `CascadeDropAnimator` reproduces today's `CascadeEngine.js` behavior — same
outcomes, composed instead of duplicated. Payline-tag drawing and playfield theming (cascade-only
today) become available to every game, since they live in the shared `SlotRenderer`/config rather
than inside `CascadeEngine.js` specifically.

Component *internals* (e.g. exactly how `CascadeDropAnimator` times a fall, or the precise state
shape `SpinLogRecorder` holds) are intentionally left generic in this proposal — what's being
locked in is the interface and the file/class boundary, not the implementation, per the request to
keep components "generic for now" as long as each is its own class in its own file.

## `Mechanic` is the shared contract with `CoreSimulationEngine`

`CoreSlotEngine` (live, rendered play) is one of two consumers a `Mechanic` must serve. The other
is the existing headless simulator — `SpinSimulator.js` plus `SimulationWorkerPool.js` and
`mechanicRegistry.js` — which this doc treats as `CoreSlotEngine`'s conceptual peer,
**`CoreSimulationEngine`**: same `Mechanic` components plugged in, no rendering, no canvas, driving
RUN SIMULATION / TUNE FREQUENCIES instead of an animated frame.

This pairing already mostly exists today (`simulateSpins(config, ...)` is mechanic-agnostic via
`config.mechanic.resolveSpin`, and `options.runTrial` dispatches trials across
`SimulationWorkerPool.js`'s Worker threads, each resolving `config.mechanic` back from a name via
`mechanicRegistry.js` since a function/closure can't cross `postMessage`) — what this phase adds is
making it an explicit, named requirement on every `Mechanic`, not an incidental property of how
`SpinSimulator.js` happens to be written:

- **Name-resolvable.** A `Mechanic` (and any `winEvaluator`/`freeSpinsMode` it closes over) must
  stay registerable in `mechanicRegistry.js` so a solver's parallel trial — Nelder-Mead or CMA-ES,
  `core/SpinSimulator.js`/`core/CMAES.js` today — can rebuild it inside a Worker thread. Adding
  `resolveLiveSpin` to `LineMechanic`/`CascadeSpinMechanic` for `CoreSlotEngine` must not change
  what travels across that boundary for the existing batch `resolveSpin` path.
- **Stateless per call.** `resolveLiveSpin`/`resolveSpin` must not read or write any mutable state
  shared between calls — no field on the `Mechanic` object itself carries information from one spin
  to the next. This is already true (mechanics are plain objects wrapping pure functions) and is
  precisely what lets many concurrent Worker trials call the same `Mechanic` at once without
  interfering with each other, or with a live spin `CoreSlotEngine` is animating at the same time.
  This phase's changes must preserve that invariant, not just happen not to break it.
- **`CoreSimulationEngine` never touches `CoreSlotEngine`-only components.** `AudioController`,
  `SpinAnimator`, `Renderer`, `ParticleSystem`, `SpinLogRecorder` are live-play concerns with no
  headless equivalent — `CoreSimulationEngine` only ever plugs in `Mechanic` and (for a free-spins
  round's economics, not its visuals) `FreeSpinsMode`. Keeping that boundary sharp is what lets a
  solver run thousands of trials per second with no rendering cost anywhere in the loop.

Physically relocating `SpinSimulator.js`/`SimulationWorkerPool.js`/`mechanicRegistry.js` into
`core/engine/` (so `CoreSimulationEngine` is a real file/module alongside `CoreSlotEngine`, not
just a name in this doc) stays deferred to a later phase, per "Open items" below — but the contract
above is locked in now specifically so that later move is a pure file relocation, not a redesign.

## Pure data / logic / model / rendering — where each lives

| Layer | Contains | Location | Rule |
|---|---|---|---|
| Pure data | `PAYTABLE`, `PAYLINES`, `FREQUENCY_REELn` | `games/<name>/game.js` (unchanged) | Never imported by `core/` |
| Pure logic | `checkWins`, `resolveCascadeSequence`, `generateReel`, RNG | `core/math/` | No DOM, no state, same inputs → same outputs |
| Model | Engine state (grid, balance, bet, `state` field, spin-log entries) + state-machine transition rules | `core/engine/CoreSlotEngine.js` + component classes | Mutates state; never issues a draw call |
| Rendering | Everything that touches `ctx` | `core/rendering/` | Reads model state, draws; never mutates game state |

This mirrors the split both classes already have internally (`update()` vs. `render()` as separate
methods) — the change is making it a real module boundary (separate files/classes) instead of two
methods coexisting in one ~1500-line class.

## Migration plan — incremental, one game at a time

Building `CoreSlotEngine` and its components does not touch any game immediately, and old
`SlotEngine.js`/`CascadeEngine.js` keep working for not-yet-migrated games throughout. Order,
safest to riskiest:

1. Build `CoreSlotEngine`, `SlotRenderer`, `ReelScrollAnimator`, `SpinLogRecorder`; extend
   `LineMechanic` with `resolveLiveSpin`. Nothing plugged into a real game yet.
2. Migrate **Lucky Fruits** (`fruitmachine`) — simplest existing game (3×3, no free spins). Proves
   the skeleton + `LineMechanic` + `ReelScrollAnimator` combination works at all.
3. Migrate **Bar Fruits**, then **Book of Book Book** (adds free spins + expanding symbol). Proves
   `FreeSpinsMode`/`AudioController` hooks generalize correctly.
4. Build `CascadeDropAnimator`; migrate **Candy Frenzy** (cluster pays + multiplier-tiles
   free-spins mode + playfield theming). Proves the cascade path and step-transition animation.
5. Migrate **Mayan Tumble** last (cascade + line-pay evaluator + payline tags) — the hardest
   existing combination. If this works with no `CoreSlotEngine`/component changes beyond what
   Candy Frenzy already needed, the abstraction holds.
6. Delete `SlotEngine.js`/`CascadeEngine.js` only once all five games are migrated and verified.

Each step ships and is verifiable independently — a stalled or wrong step never blocks the other
four games.

## Testing & risk

`tests/*.mjs` (per `docs/ARCHITECTURE.md` and the current file listing) tests `core/math/`,
mechanics' batch `resolveSpin`, `SpinSimulator.js`, and the tuning modules — **not** the engine
classes themselves, which are canvas/browser-only and currently verified by hand. That doesn't
change here: every existing math/mechanic/simulator test keeps passing throughout this refactor
without modification, because none of them import `SlotEngine.js`/`CascadeEngine.js` — this is the
evidence that payout logic is untouched by a refactor that is, by design, only reorganizing and
recomposing the engine/rendering layer above it.

New coverage this proposal adds:

- Unit tests for `CoreSlotEngine`'s state-machine transitions against a stub renderer/animator (no
  canvas required) — something today's two classes have zero automated coverage of.
- Per-game manual smoke test after each migration step: spin, trigger free spins, confirm RUN
  SIMULATION's reported RTP is unchanged from before that game's migration.

## Open items for a later phase (not designed here)

- Physically relocating `SpinSimulator.js`/`SimulationWorkerPool.js`/`mechanicRegistry.js` into
  `core/engine/` as an actual `CoreSimulationEngine` module — this phase only locks in the
  `Mechanic` contract (name-resolvable, stateless per call) that makes that later move safe.
- Folding the remaining tuning modules into a `tuning/` subfolder.
- Folding `SimulationPanel.js`/`SpinLogPanel.js`/`FileIO.js` into a `ui/` subfolder.
- Whether `SpinLog.js` moves under `engine/` alongside the new `SpinLogRecorder.js` it will back.

---
_Docs last synced with the codebase: 2026-07-28, commit `492917d`._
