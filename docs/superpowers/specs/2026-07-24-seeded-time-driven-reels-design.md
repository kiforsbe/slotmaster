# Seeded, Time-Driven Reel Spins — Design

## Context

`core/SlotEngine.js`'s reel-stop mechanism determines *when a reel has visually
landed* by accumulating a decaying `speed` value frame-by-frame and checking
whether the currently-displayed symbols happen to match the pre-chosen target
grid (`checkReelMatchesTarget`). This session fixed two bugs in that mechanism
(an unbounded-overshoot bug that let turbo mode spin forever, then an
off-by-one in the fix that broke normal mode too) before the user asked for
the underlying architecture to change instead of patching the physics further.

The core problem: correctness (does the reel show the right symbols) is
**detected** by watching physics converge, rather than being **guaranteed** by
construction. Any tuning of speed/acceleration/deceleration constants (like a
turbo multiplier) risks silently breaking the detection condition again.

## Goals

- Reel landing is guaranteed correct by construction, independent of any
  speed/timing constant — turbo, normal, or any future speed can never
  "overshoot" or "undershoot" the target.
- Spin outcomes (the target grid) are generated from a seed, so the exact same
  outcome can be reproduced later (dev/debug tool now; player-facing surface
  possible later without rework).
- The current visual feel is preserved: acceleration ramp-up while spinning,
  staggered per-reel stopping, a small bounce on landing.
- Turbo mode and the manual STOP button (early stop) keep working, and become
  simpler/safer than today since they're just timing compression, not physics
  perturbation.

## Non-goals

- Not seeding/making deterministic: particle effects, the expanding-symbol
  selection RNG, bonus-round symbol-choice RNG, or any other `Math.random()`
  use outside the reel target grid. Those are separate concerns.
- Not building a player-facing replay/history UI. The design keeps the door
  open (the seed is captured and available) but no UI is built now.
- Not changing `SlotMath.js`'s win-evaluation logic (`checkWins`,
  `checkExpandingWins`) or the simulator/tuner — unaffected by this change.

## Design

### 1. Outcome generation — pure, seeded, replayable

`SlotMath.js` gains two new exports:

```js
export function createSeededRng(seed) { ... } // extracted from generateReel's
                                                 // private _mulberry32, unchanged algorithm
export function generateTargetGrid(reelStrips, rowsCount, rng) { ... }
```

`generateTargetGrid` is the pure-function equivalent of today's
`SlotEngine.generateTargetGrid()` instance method: for each reel strip, pick a
random stop index via `rng()` and read off `rowsCount` consecutive symbols.
Taking an `rng` function (not a raw seed) keeps it composable and matches
`generateReel`'s existing style.

`generateReel` is refactored to call `createSeededRng` instead of its private
copy of the same algorithm (dedup, no behavior change).

### 2. Spin outcome flow (seed + replay)

`SlotEngine.spin(seed)` accepts an optional seed:

- If omitted, a fresh seed is generated (e.g. `(Date.now() ^ (Math.random() *
  0xFFFFFFFF)) >>> 0`) — spins are still effectively random by default.
- The engine stores `this.lastSpinSeed = seed` and logs it in debug mode.
- `this.targetGrid = generateTargetGrid(this.config.reelStrips,
  this.config.rowsCount, createSeededRng(seed))`.
- Calling `engine.spin(engine.lastSpinSeed)` (or any previously-logged seed)
  later reproduces the identical target grid — this *is* the replay tool,
  with no separate replay subsystem needed.

`forceWinResult()` (the existing debug cheat buttons) is unaffected: it
already bypasses grid generation via `this.forcedTargetGrid = true`, and
`spin()` continues to skip seed/grid generation in that case exactly as it
does today.

### 3. Visual animation — time-driven, not physics-driven

Per-reel state machine, replacing today's `spinning → stopping → bounce`:

- **`spinning`** (unchanged, cosmetic only): accelerates `speed` up to
  `maxSpeed`, scrolls, wraps in random decorative symbols. No correctness
  dependency — purely eye candy.
- **`landing`** (replaces `stopping`): begins at a precomputed
  `landStartTime` (`spinStart + reel.stopDelay - landDuration`). The instant
  it begins, `reel.symbols` is set **once**, directly, to the final correct
  array — `[filler, ...targetGrid[col], filler, filler]` — not fed in
  incrementally based on distance traveled. For the fixed `landDuration` (e.g.
  450ms, 150ms in turbo), the visual offset is purely
  `symbolHeight * (1 - easeOutCubic(elapsed / landDuration))`: a time-driven
  tween from "one symbol-height above rest" down to exactly 0. There is
  nothing to detect and nothing that can overshoot — correctness is fixed the
  moment the phase begins.
- **`bounce`** (unchanged, cosmetic only): short fixed-duration overshoot
  after landing, purely visual, uninvolved in correctness.

`checkReelMatchesTarget()` is removed — there's no longer a "does it match"
question at runtime; it's guaranteed by construction.

### 4. Turbo mode & manual early stop

- Turbo becomes purely a set of smaller timing constants (`spinDuration`,
  `landDuration`, per-reel stagger interval). No risk category left for it to
  fall into.
- `stopSpin()` (the STOP button) compresses remaining timing: reels still in
  `spinning` get an imminent, staggered `landStartTime`; reels already in
  `landing` finish their (already short) tween uninterrupted.

## Data flow summary

```
spin(seed?)
  → seed ||= freshSeed(); this.lastSpinSeed = seed
  → rng = createSeededRng(seed)
  → this.targetGrid = generateTargetGrid(reelStrips, rowsCount, rng)   [SlotMath.js, pure]
  → per reel: schedule stopDelay → landStartTime, start 'spinning'

update() [per frame]
  → 'spinning': cosmetic scroll/acceleration (unchanged)
  → now >= landStartTime: snap reel.symbols to final array, enter 'landing'
  → 'landing': offsetY = f(elapsed/landDuration)  [pure function of time]
  → elapsed >= landDuration: enter 'bounce' (unchanged, cosmetic)
```

## Testing / verification

This repo has no test framework configured (`package.json` is empty), so
verification follows the pattern already used throughout this session:

- Ad hoc Node scripts against the new pure functions:
  `createSeededRng(seed)` called twice with the same seed produces identical
  sequences; `generateTargetGrid` is deterministic per seed and varies across
  seeds.
- A scripted simulation of the new `landing` phase (mirroring the approach
  used to verify the previous physics fix) confirming: landing always
  completes in exactly `landDuration`, for both turbo and normal constants,
  across the full plausible range of `symbolHeight`.
- Manual in-browser verification (via the `run` skill): spin/turbo/autoplay
  repeatedly and confirm reels always land on the correct symbols with no
  stalls, for at least a few dozen consecutive spins in each mode.

## Migration notes

- `SlotEngine.generateTargetGrid()` (instance method) is removed; its logic
  moves to `SlotMath.js` as the pure `generateTargetGrid` export, called from
  `spin()`.
- `reel.speed`'s meaning during `landing` goes away (no longer used to gate
  anything); it's still used during `spinning` for the cosmetic ramp-up.
- The rename `'stopping' → 'landing'` applies only to **per-reel**
  `reel.state`. It's distinct from the top-level `engine.state`, which also
  has its own unrelated `'stopping'` value (set in `update()` when the first
  reel begins landing, read by `game.js`'s `handleStateChange(state)` at line
  563) — that top-level state machine is untouched by this design and keeps
  using `'stopping'` as-is. Confirmed via search that no code outside
  `SlotEngine.js` reads `reel.state` directly (only the engine-level
  `engine.state`), so the per-reel rename has no external call sites to
  update.
