# Seeded, Time-Driven Reel Spins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `core/SlotEngine.js`'s physics-accumulation reel-stop mechanism (which *detects* a correct landing by watching decelerating speed converge on a target) with a seeded outcome generator plus a time-driven landing tween that is *guaranteed* correct by construction, independent of any speed/timing constant.

**Architecture:** `core/SlotMath.js` gains two pure, seed-driven exports (`createSeededRng`, `generateTargetGrid`) that `SlotEngine.spin(seed)` calls to produce (and optionally replay) a spin outcome. Each reel's visual state machine changes from `spinning → stopping → bounce` (where `stopping` fed symbols incrementally and polled for a match) to `spinning → landing → bounce` (where `landing` snaps `reel.symbols` to the final correct array once, then eases `offsetY` from one symbol-height to zero as a pure function of elapsed time).

**Tech Stack:** Vanilla JS ES modules, Canvas 2D rendering, no test framework (`package.json` is `{}`) — verification uses ad hoc Node scripts for pure logic plus manual in-browser testing via the `run` skill, matching this repo's existing verification pattern.

## Global Constraints

- Do not modify `SlotMath.js`'s win-evaluation logic (`checkWins`, `checkExpandingWins`) or `SpinSimulator.js` — out of scope per the design spec's non-goals.
- Do not seed/make deterministic anything other than the reel target grid (particle effects, expanding-symbol selection, bonus RNG stay on `Math.random()`).
- Do not build a player-facing replay/history UI — the seed is captured and available, but no UI consumes it yet.
- Preserve the current visual feel: acceleration ramp-up while spinning, staggered per-reel stopping, a small bounce on landing.
- Full design context: `docs/superpowers/specs/2026-07-24-seeded-time-driven-reels-design.md`.

---

## File Structure

- **`core/SlotMath.js`** (modify) — add `createSeededRng(seed)` (extracted from `generateReel`'s private `_mulberry32`) and `generateTargetGrid(reelStrips, rowsCount, rng)` as new exports; refactor `generateReel` to call the shared `createSeededRng`.
- **`core/SlotEngine.js`** (modify) — `spin(seed)` accepts an optional seed and calls the new `SlotMath.js` exports; the per-reel `update()` state machine is rewritten around a time-driven `landing` phase; `checkReelMatchesTarget()` and the instance-method `generateTargetGrid()` are removed; `stopSpin()` is rewritten to compress `landStartTime` instead of forcing reel state.

No other files change. `games/bookbookbook/game.js` never touches `reel.state` or reel-internal fields directly (confirmed via grep — it only reads `engine.state` in `handleStateChange`), so it needs no changes.

---

### Task 1: `SlotMath.js` — seeded RNG and pure target-grid generator

**Files:**
- Modify: `core/SlotMath.js:248-334` (the `generateReel` function and its private `_mulberry32`)
- Test: temporary `tmp_test_slotmath.mjs` at the repo root (deleted at the end of this task, not committed)

**Interfaces:**
- Produces: `export function createSeededRng(seed)` → returns a `function(): number` producing floats in `[0, 1)`, deterministic per seed (same algorithm as the old private `_mulberry32`).
- Produces: `export function generateTargetGrid(reelStrips, rowsCount, rng)` → returns `grid[col][row]` (array of arrays of symbol-name strings), `col` in `0..reelStrips.length-1`, `row` in `0..rowsCount-1`.
- Consumes: nothing new — `generateReel`'s existing signature and behavior are unchanged from the caller's perspective.

- [ ] **Step 1: Write the failing verification script**

Create `tmp_test_slotmath.mjs` at the repo root:

```js
import { createSeededRng, generateTargetGrid, generateReel } from './core/SlotMath.js';

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}

// createSeededRng: same seed -> identical sequence
const rngA = createSeededRng(42);
const rngB = createSeededRng(42);
check(JSON.stringify([rngA(), rngA(), rngA()]) === JSON.stringify([rngB(), rngB(), rngB()]),
  'same seed must produce an identical rng sequence');

// createSeededRng: different seeds -> different first value
check(createSeededRng(42)() !== createSeededRng(43)(),
  'different seeds should produce different first values');

// generateTargetGrid: deterministic per seed, correct shape, symbols come from their own strip
const strips = [
  ['a', 'b', 'c', 'd'],
  ['e', 'f', 'g'],
  ['h', 'i', 'j', 'k', 'l'],
];
const gridA = generateTargetGrid(strips, 3, createSeededRng(7));
const gridB = generateTargetGrid(strips, 3, createSeededRng(7));
check(JSON.stringify(gridA) === JSON.stringify(gridB), 'generateTargetGrid must be deterministic per seed');
check(gridA.length === 3 && gridA[0].length === 3, 'grid shape must be reelStrips.length x rowsCount');
strips.forEach((strip, col) => {
  gridA[col].forEach(sym => {
    check(strip.includes(sym), `grid[${col}] contains a symbol not present in its own strip`);
  });
});

// generateReel: still deterministic per seed after being refactored onto createSeededRng
const paytable = {
  book: { frequency: 0.05, type: 'scatter' },
  king: { frequency: 0.5, type: 'regular' },
};
const reelA = generateReel(paytable, 100, 999);
const reelB = generateReel(paytable, 100, 999);
check(JSON.stringify(reelA) === JSON.stringify(reelB), 'generateReel must remain deterministic per seed');

if (failures === 0) {
  console.log('All SlotMath.js checks passed.');
} else {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tmp_test_slotmath.mjs`
Expected: `SyntaxError` — `The requested module './core/SlotMath.js' does not provide an export named 'createSeededRng'` (neither `createSeededRng` nor `generateTargetGrid` exist yet).

- [ ] **Step 3: Extract `createSeededRng` and add `generateTargetGrid`**

In `core/SlotMath.js`, insert the following two exports immediately before `export function generateReel(...)` (i.e. right after `checkExpandingWins`'s closing brace, before line 248):

```js
/**
 * Deterministic PRNG (mulberry32). The same seed always produces the same sequence of
 * floats in [0, 1) - this determinism is what makes a spin outcome seedable/replayable.
 * @param {number} seed
 * @returns {function(): number} rng function; call repeatedly for the next float
 */
export function createSeededRng(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

/**
 * Pick a random stop position on each reel strip and read off the visible window.
 * Pure function: the same rng sequence always produces the same grid, which is what
 * makes a spin outcome reproducible from a seed (see SlotEngine.spin()).
 * @param {Array<Array<string>>} reelStrips - one strip (array of symbol names) per reel
 * @param {number} rowsCount - visible rows per reel
 * @param {function(): number} rng - rng function as returned by createSeededRng()
 * @returns {Array<Array<string>>} grid[col][row] of symbol names
 */
export function generateTargetGrid(reelStrips, rowsCount, rng) {
  const grid = [];
  for (let col = 0; col < reelStrips.length; col++) {
    const strip = reelStrips[col];
    const reelCol = [];
    const stopIndex = Math.floor(rng() * strip.length);
    for (let row = 0; row < rowsCount; row++) {
      reelCol.push(strip[(stopIndex + row) % strip.length]);
    }
    grid.push(reelCol);
  }
  return grid;
}
```

Then, inside `generateReel`, delete the private `_mulberry32` function (the block at the top of `generateReel`, currently):

```js
  function _mulberry32(seed) {
    return function() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
  }
```

and change the line that builds the rng from:

```js
  const rng = _mulberry32(seed);
```

to:

```js
  const rng = createSeededRng(seed);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node tmp_test_slotmath.mjs`
Expected: `All SlotMath.js checks passed.` with exit code 0, nothing on stderr.

- [ ] **Step 5: Delete the temporary script and commit**

```bash
rm tmp_test_slotmath.mjs
git add core/SlotMath.js
git commit -m "refactor: extract createSeededRng and add generateTargetGrid to SlotMath.js

Pure, seed-driven functions that SlotEngine will use to make spin outcomes
reproducible. generateReel now shares the same PRNG instead of a private copy."
```

---

### Task 2: Algorithm validation — landing-phase timing simulation

This task writes and runs a standalone Node simulation of the new landing-phase
arithmetic (scheduling, easing, state transitions) *before* it's wired into
`SlotEngine.js`, mirroring the standalone-simulation approach already used earlier
this session (`full_reel_sim.mjs`) to de-risk timing logic that can't be unit-tested
directly — `SlotEngine` needs a DOM canvas to construct. This is a design-validation
gate, not a red/green test against existing code: there is nothing to be "red"
against yet since the algorithm doesn't exist anywhere. Task 6 (manual in-browser
testing) is the true end-to-end verification of the real class.

**Files:**
- Test: temporary `tmp_test_landing.mjs` at the repo root (deleted at the end of this task, not committed)

**Interfaces:**
- Consumes: nothing from other tasks — this is a self-contained model of the algorithm described in the design spec's "Data flow summary" section.
- Produces: confidence that `landStartTime = spinStart + stopDelay - landDuration` plus `offsetY = symbolHeight * (1 - easeOutCubic(elapsed / landDuration))` always resolves every reel to `idle`, with `offsetY` staying within `[0, symbolHeight]` throughout, across a range of `symbolHeight`, turbo/normal, and frame-rate (`dt`) combinations. Task 4 applies this exact algorithm to `SlotEngine.js`.

- [ ] **Step 1: Write the simulation script**

Create `tmp_test_landing.mjs` at the repo root:

```js
// Validates the new time-driven landing-phase algorithm (spinStart + stopDelay -
// landDuration scheduling; offsetY as a pure function of elapsed time) before it's
// wired into SlotEngine.js, which can't be instantiated in Node (needs a DOM canvas).

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function simulateSpin({ reelsCount, symbolHeight, turboMode, dt }) {
  const stopInterval = turboMode ? 100 : 150;
  const baseStop = turboMode ? 500 : 2000;
  const landDuration = turboMode ? 150 : 450;

  const reels = [];
  for (let r = 0; r < reelsCount; r++) {
    const stopDelay = baseStop + r * stopInterval;
    reels.push({
      state: 'spinning',
      offsetY: 0,
      landStartTime: stopDelay - landDuration,
      landElapsedStart: null,
      landDuration,
      bounceDir: 1,
      bouncePos: 0,
      history: [], // offsetY samples taken during 'landing', for bounds checking
    });
  }

  let now = 0;
  let allIdle = false;
  let iterations = 0;
  const maxIterations = 100000; // guards against an infinite loop in the model itself

  while (!allIdle && iterations < maxIterations) {
    now += dt;
    iterations++;
    allIdle = true;

    for (const reel of reels) {
      if (reel.state === 'spinning') {
        allIdle = false;
        if (now >= reel.landStartTime) {
          reel.state = 'landing';
          reel.landElapsedStart = now;
          reel.offsetY = symbolHeight;
        }
      } else if (reel.state === 'landing') {
        allIdle = false;
        const elapsed = now - reel.landElapsedStart;
        const progress = Math.min(elapsed / reel.landDuration, 1);
        reel.offsetY = symbolHeight * (1 - easeOutCubic(progress));
        reel.history.push(reel.offsetY);
        if (progress >= 1) {
          reel.offsetY = 0;
          reel.state = 'bounce';
          reel.bouncePos = 0;
          reel.bounceDir = 1;
        }
      } else if (reel.state === 'bounce') {
        allIdle = false;
        const bounceMax = symbolHeight * 0.12;
        const speed = bounceMax / 4;
        if (reel.bounceDir === 1) {
          reel.bouncePos += speed;
          if (reel.bouncePos >= bounceMax) reel.bounceDir = -1;
        } else {
          reel.bouncePos -= speed;
          if (reel.bouncePos <= 0) {
            reel.bouncePos = 0;
            reel.state = 'idle';
          }
        }
      }
    }
  }

  return { reels, totalTime: now, iterations };
}

let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}

for (const symbolHeight of [60, 100, 150, 220, 300]) {
  for (const turboMode of [false, true]) {
    for (const dt of [16, 33]) { // 60fps and ~30fps, checking frame-rate independence
      const { reels, totalTime, iterations } = simulateSpin({ reelsCount: 5, symbolHeight, turboMode, dt });
      const label = `symbolHeight=${symbolHeight} turbo=${turboMode} dt=${dt}`;

      check(iterations < 100000, `simulation for ${label} did not terminate`);

      reels.forEach((reel, r) => {
        check(reel.state === 'idle', `reel ${r} (${label}) ended in state '${reel.state}', not 'idle'`);
        check(reel.history.every(v => v >= -0.01 && v <= symbolHeight + 0.01),
          `reel ${r} offsetY left [0, symbolHeight] during landing (${label})`);
        check(reel.history.length > 0, `reel ${r} never recorded a landing sample (${label})`);
      });

      const expectedMinTotal = (turboMode ? 500 : 2000) + 4 * (turboMode ? 100 : 150);
      check(totalTime >= expectedMinTotal,
        `total time ${totalTime} shorter than the last reel's scheduled stop ${expectedMinTotal} (${label})`);
    }
  }
}

if (failures === 0) {
  console.log('All landing-phase timing checks passed across symbolHeight/turbo/framerate combinations.');
} else {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
```

- [ ] **Step 2: Run it and verify it passes**

Run: `node tmp_test_landing.mjs`
Expected: `All landing-phase timing checks passed across symbolHeight/turbo/framerate combinations.` with exit code 0.

If any check fails, do not proceed to Task 4 — the failure means the algorithm itself
(not yet the class) has a bug; fix the model here first, since Task 4 applies this
same logic verbatim to `SlotEngine.js`.

- [ ] **Step 3: Delete the temporary script**

```bash
rm tmp_test_landing.mjs
```

No commit for this task — it produces no source changes, only validates the design that Tasks 3-5 implement.

---

### Task 3: `SlotEngine.js` — seed plumbing in `spin()`

**Files:**
- Modify: `core/SlotEngine.js:2` (import line)
- Modify: `core/SlotEngine.js:510-565` (`spin()` method)
- Modify: `core/SlotEngine.js:567-586` (remove the instance-method `generateTargetGrid()`)

**Interfaces:**
- Consumes: `createSeededRng(seed)` and `generateTargetGrid(reelStrips, rowsCount, rng)` from Task 1's `core/SlotMath.js`.
- Produces: `spin(seed)` — `seed` is optional; when provided, replays that exact outcome; when omitted, a fresh seed is generated and stored on `this.lastSpinSeed` for later replay via `engine.spin(engine.lastSpinSeed)`. Sets `reel.landStartTime` and `reel.landDuration` per reel (consumed by Task 4's `update()` rewrite).

- [ ] **Step 1: Update the import line**

In `core/SlotEngine.js:2`, change:

```js
import { checkWins, checkExpandingWins, PAYLINES } from './SlotMath.js';
```

to:

```js
import { checkWins, checkExpandingWins, PAYLINES, createSeededRng, generateTargetGrid } from './SlotMath.js';
```

- [ ] **Step 2: Rewrite `spin()` to accept an optional seed and use the pure grid generator**

Replace the entire `spin()` method (`core/SlotEngine.js:510-565`) with:

```js
  spin(seed) {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;
    
    // Stop audio loops
    audio.stopBGM();

    // Check Balance
    if (!this.inFreeSpins) {
      if (this.balance < this.totalBet) {
        alert("Insufficient Balance!");
        this.autoPlay = false;
        return;
      }
      this.balance -= this.totalBet;
      this.lastWin = 0;
    }

    // Initialize/Reset State
    this.state = 'spinning';
    this.winData = null;
    this.expandingWinData = null;
    this.activeWinLineIndex = -1;
    this.expandedReelsState = Array(this.config.reelsCount).fill(false);

    // Initialize expansion timers
    this.expansionReelStartTimes = [];
    for (let i = 0; i < this.config.reelsCount; i++) {
        this.expansionReelStartTimes[i] = Date.now();
    }

    this.config.onStateChange(this.state);

    // Pre-calculate Spin Result (skip if forceWinResult already set targetGrid).
    // The seed is captured on the engine so the exact same outcome can be replayed
    // later via engine.spin(engine.lastSpinSeed) - no separate replay subsystem needed.
    if (!this.forcedTargetGrid) {
      const spinSeed = seed !== undefined ? seed : ((Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0);
      this.lastSpinSeed = spinSeed;
      this.targetGrid = generateTargetGrid(this.config.reelStrips, this.config.rowsCount, createSeededRng(spinSeed));
      if (this.debugMode) console.log(`[SPIN] seed=${spinSeed}`);
    }
    this.forcedTargetGrid = false; // Reset flag
    if (this.debugMode) console.log(`[SPIN] targetGrid:`, JSON.stringify(this.targetGrid));
    if (this.debugMode) console.log(`[SPIN] spinDuration=${this.spinDuration}, turbo=${this.turboMode}, symbolHeight=${this.symbolHeight}`);
    
    // Trigger Spin Sound
    audio.playSpin();

    // Setup spin timers
    this.spinStart = Date.now();
    
    const stopInterval = this.turboMode ? 100 : this.reelDelay;
    const landDuration = this.turboMode ? 150 : 450;
    for (let r = 0; r < this.reels.length; r++) {
      const reel = this.reels[r];
      reel.state = 'spinning';
      reel.speed = 20;
      const stopDelay = (this.turboMode ? 500 : this.spinDuration) + (r * stopInterval);
      reel.landDuration = landDuration;
      // The reel is guaranteed fully landed by spinStart + stopDelay: landing itself begins
      // landDuration ms before that instant, so it always finishes exactly on time regardless
      // of frame rate or any speed/acceleration constant used while 'spinning'.
      reel.landStartTime = this.spinStart + stopDelay - landDuration;
      if (this.debugMode) console.log(`[SPIN] Reel ${r}: lands ${stopDelay}ms after spin start, strip=${reel.strip.length} symbols`);
    }
  }
```

Note: this removes the `reel.stopDelay` and `reel.feedIndex` assignments that used to
appear in this loop — `stopDelay` is now a local variable folded directly into
`reel.landStartTime`, and `feedIndex` is retired entirely by Task 4 (the new `landing`
phase snaps `reel.symbols` once instead of feeding them in incrementally).

- [ ] **Step 3: Remove the instance-method `generateTargetGrid()`**

Delete the entire method at `core/SlotEngine.js:567-586`:

```js
  generateTargetGrid() {
    const grid = [];
    
    // Determine if we will force a scatter trigger for testing or generate randomly
    // A regular strip generation:
    for (let col = 0; col < this.config.reelsCount; col++) {
      const reelCol = [];
      const strip = this.config.reelStrips[col];
      
      // Select a random stop position on the strip
      const stopIndex = Math.floor(Math.random() * strip.length);
      for (let row = 0; row < this.config.rowsCount; row++) {
        const symbol = strip[(stopIndex + row) % strip.length];
        reelCol.push(symbol);
      }
      grid.push(reelCol);
    }
    
    return grid;
  }

```

Its logic now lives in `SlotMath.js`'s `generateTargetGrid` export (Task 1), called
from `spin()` (Step 2 above). `forceWinResult()` (just below where this method was)
is untouched — it already bypasses grid generation via `this.forcedTargetGrid = true`
before calling `this.spin()`, and `spin()` continues to honor that flag exactly as
before.

- [ ] **Step 4: Sanity-check with Node (syntax/reference check only)**

`SlotEngine.js` can't be instantiated in Node (its constructor touches `canvas`,
`Image`, `window`), so this step only confirms the file still parses and the new
imports resolve — full behavioral verification happens in Task 6.

Run:

```bash
node --input-type=module -e "import('./core/SlotEngine.js').then(() => console.log('SlotEngine.js parses and imports resolve.')).catch(e => { console.error(e); process.exit(1); })"
```

Expected: `SlotEngine.js parses and imports resolve.` — if it instead throws a
`ReferenceError` about `window`/`document`, that's expected only if it happens
*after* the "parses and imports resolve" message would have printed; if the error
happens on import itself (e.g. `document is not defined` at module scope, or a
genuine syntax error), check the message: a top-level DOM reference error at
`SlotEngine.js` module scope would be a pre-existing condition, not something this
task introduces, since nothing in this task touches module-level code — only inside
class methods. Confirm there is no `SyntaxError` or unresolved-import error, which
are the only failure modes this refactor could newly introduce.

- [ ] **Step 5: Commit**

```bash
git add core/SlotEngine.js
git commit -m "feat: make spin outcomes seeded and replayable

spin(seed) now generates (or accepts) a seed, stores it as lastSpinSeed, and
derives the target grid via SlotMath's pure generateTargetGrid + createSeededRng.
Calling spin(engine.lastSpinSeed) reproduces the identical outcome. The old
instance-method generateTargetGrid() is removed; its logic moved to SlotMath.js."
```

---

### Task 4: `SlotEngine.js` — time-driven `landing` state machine

**Files:**
- Modify: `core/SlotEngine.js:117-142` (`setupReels()` — reel object shape)
- Modify: `core/SlotEngine.js:216-236` (commented periodic-debug block referencing retired fields)
- Modify: `core/SlotEngine.js:247-365` (the per-reel physics loop inside `update()`)
- Modify: `core/SlotEngine.js:467-477` (remove `checkReelMatchesTarget`, add `easeOutCubic`)

**Interfaces:**
- Consumes: `reel.landStartTime` and `reel.landDuration`, set per spin by Task 3's `spin()`.
- Produces: reel states are now `idle | spinning | landing | bounce` (was `idle | spinning | stopping | bounce`). `this.state` (the top-level engine state) is untouched — it still transitions to `'stopping'` the moment the first reel begins landing, exactly as before, so `games/bookbookbook/game.js:563`'s `state === 'stopping'` check keeps working unmodified.

- [ ] **Step 1: Update the reel object shape in `setupReels()`**

In `core/SlotEngine.js:117-142`, replace the `this.reels.push({...})` block with:

```js
      this.reels.push({
        symbols: symbols,           // Array of symbol names (e.g. ['tut', 'jack', 'ace', ...])
        offsetY: 0,                 // Vertical scrolling pixel offset
        speed: 0,                   // Speed in pixels/frame - cosmetic, only used while 'spinning'
        state: 'idle',              // idle, spinning, landing, bounce
        strip: strip,               // The reel strip configuration
        targetStopIndex: 0,         // Index of strip where it should stop
        landStartTime: 0,           // Date.now()-scale timestamp when landing begins (set by spin())
        landElapsedStart: 0,        // Date.now()-scale timestamp when landing actually started
        landDuration: 0,            // ms the landing tween takes; set per-spin (turbo vs normal)
        bounceProgress: 0,          // For reel stop bounce animation
        bounceDirection: 1          // 1 down, -1 up
      });
```

This drops `stopDelay` and `feedIndex` (both retired — see Task 3) and adds
`landStartTime`, `landElapsedStart`, `landDuration`.

- [ ] **Step 2: Clean up the commented periodic-debug block**

In `core/SlotEngine.js:216-236`, the block is entirely commented out already. Update
it so it no longer references the retired `feedIndex` field, so a future reader who
un-comments it doesn't hit a silent `undefined`:

Replace:

```js
    // Periodic state summary (every 120 frames)
    // if (!this._stateLogTimer || now - this._stateLogTimer > 3000) {
    //   this._stateLogTimer = now;
    //   const reelStates = this.reels.map((r, i) => ({
    //     reel: i,
    //     state: r.state,
    //     speed: r.speed.toFixed(1),
    //     offsetY: r.offsetY.toFixed(1),
    //     feedIdx: r.feedIndex,
    //     visible: [r.symbols[1], r.symbols[2], r.symbols[3]]
    //   }));
    //   console.log(`[STATE] engine.state=${this.state}, spinStart=${this.spinStart}, elapsed=${(now - this.spinStart).toFixed(0)}ms, reels:`, JSON.stringify(reelStates));
    //   if (this.targetGrid) {
    //     console.log(`[STATE] targetGrid:`, JSON.stringify(this.targetGrid));
    //   }
    // }
```

with:

```js
    // Periodic state summary (every 120 frames)
    // if (!this._stateLogTimer || now - this._stateLogTimer > 3000) {
    //   this._stateLogTimer = now;
    //   const reelStates = this.reels.map((r, i) => ({
    //     reel: i,
    //     state: r.state,
    //     speed: r.speed.toFixed(1),
    //     offsetY: r.offsetY.toFixed(1),
    //     visible: [r.symbols[1], r.symbols[2], r.symbols[3]]
    //   }));
    //   console.log(`[STATE] engine.state=${this.state}, spinStart=${this.spinStart}, elapsed=${(now - this.spinStart).toFixed(0)}ms, reels:`, JSON.stringify(reelStates));
    //   if (this.targetGrid) {
    //     console.log(`[STATE] targetGrid:`, JSON.stringify(this.targetGrid));
    //   }
    // }
```

- [ ] **Step 3: Rewrite the per-reel physics loop**

Replace the entire `for (let r = 0; r < this.reels.length; r++) { ... }` loop at
`core/SlotEngine.js:247-365` (the block handling `reel.state === 'spinning'`,
`'stopping'`, and `'bounce'`) with:

```js
    // Update Reels Spin Physics
    for (let r = 0; r < this.reels.length; r++) {
      const reel = this.reels[r];
      
      if (reel.state === 'spinning') {
        allStopped = false;
        
        // Acceleration - cosmetic only. Correctness never depends on speed/timing here:
        // landing is scheduled for a precomputed instant below, not detected by watching
        // this physics converge, so it can never overshoot or undershoot the target.
        const maxSpeed = this.turboMode ? 80 : 50;
        if (reel.speed < maxSpeed) {
          reel.speed += 3;
        }
        
        reel.offsetY += reel.speed;
        
        // Wrap offset around symbol boundary, feeding random decorative symbols while spinning
        if (reel.offsetY >= this.symbolHeight) {
          const shiftCount = Math.floor(reel.offsetY / this.symbolHeight);
          reel.offsetY = reel.offsetY % this.symbolHeight;
          
          for (let s = 0; s < shiftCount; s++) {
            reel.symbols.pop();
            reel.symbols.unshift(this.getRandomSymbol(reel.strip));
          }
        }
        
        // Landing begins at a precomputed instant (set in spin()): reel.landStartTime =
        // spinStart + stopDelay - landDuration. The moment it begins, the final symbols are
        // set once, directly - not fed in incrementally based on distance traveled - so
        // there's nothing left to detect and nothing that can overshoot.
        if (now >= reel.landStartTime) {
          if (this.debugMode) console.log(`[Debug] Reel ${r} entering landing at ${now}`);
          reel.symbols = [
            this.getRandomSymbol(reel.strip),
            this.targetGrid[r][0],
            this.targetGrid[r][1],
            this.targetGrid[r][2],
            this.getRandomSymbol(reel.strip),
            this.getRandomSymbol(reel.strip)
          ];
          reel.offsetY = this.symbolHeight;
          reel.speed = 0;
          reel.state = 'landing';
          reel.landElapsedStart = now;

          // Set engine state to 'stopping' when the first reel starts landing
          if (this.state === 'spinning') {
            this.state = 'stopping';
            this.config.onStateChange(this.state);
          }
        }
      } 
      else if (reel.state === 'landing') {
        allStopped = false;

        const elapsed = now - reel.landElapsedStart;
        const progress = Math.min(elapsed / reel.landDuration, 1);
        reel.offsetY = this.symbolHeight * (1 - this.easeOutCubic(progress));

        if (this.debugMode && r === 0 && this.frameCount % 60 === 0) {
          console.log(`[LAND] Reel ${r}: progress=${progress.toFixed(2)}, offsetY=${reel.offsetY.toFixed(1)}`);
        }

        if (progress >= 1) {
          if (this.debugMode) console.log(`[Debug] Reel ${r} landed, bouncing at ${now}`);
          reel.offsetY = 0;
          reel.state = 'bounce';
          reel.bounceProgress = 0;
          reel.bounceDirection = 1; // Start bounce downward
          audio.playReelStop(r);
        }
      } 
      else if (reel.state === 'bounce') {
        allStopped = false;
        
        // mechanical bounce animation
        const bounceMax = this.symbolHeight * 0.12;
        const speed = bounceMax / 4;

        if (reel.bounceDirection === 1) {
          reel.offsetY += speed;
          if (reel.offsetY >= bounceMax) {
            reel.bounceDirection = -1;
          }
        } else {
          reel.offsetY -= speed;
          if (reel.offsetY <= 0) {
            reel.offsetY = 0;
            reel.state = 'idle';
            if (this.debugMode) console.log(`[Debug] Reel ${r} settled to idle at ${now}`);
          }
        }
      }
    }
```

The `bounce` branch is byte-for-byte unchanged from before — it was already purely
cosmetic and uninvolved in correctness, per the design spec.

- [ ] **Step 4: Replace `checkReelMatchesTarget` with `easeOutCubic`**

Replace the entire `checkReelMatchesTarget` method at `core/SlotEngine.js:467-477`:

```js
  checkReelMatchesTarget(reelIdx) {
    const reel = this.reels[reelIdx];
    // Check if the current 3 visible symbols match the target grid
    // Visible symbols are at index 1, 2, 3 of the array
    for (let r = 0; r < this.config.rowsCount; r++) {
      if (reel.symbols[r + 1] !== this.targetGrid[reelIdx][r]) {
        return false;
      }
    }
    return true;
  }
```

with:

```js
  // Standard ease-out-cubic: fast start, gentle settle. Drives the landing-phase tween
  // as a pure function of elapsed time - there is no "does it match" question anymore,
  // landing is guaranteed correct by construction the instant it begins (see update()).
  easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
```

- [ ] **Step 5: Verify no remaining references to retired members**

Run:

```bash
grep -n "checkReelMatchesTarget\|reel.feedIndex\|reel.stopDelay\|generateTargetGrid()" core/SlotEngine.js
```

Expected: no output (the only `generateTargetGrid` reference left should be the
call to the imported pure function inside `spin()`, i.e. `generateTargetGrid(` with
arguments — confirm any match found is that call, not a zero-arg method call).

- [ ] **Step 6: Sanity-check with Node (syntax/reference check only)**

Run the same import-resolution check as Task 3 Step 4:

```bash
node --input-type=module -e "import('./core/SlotEngine.js').then(() => console.log('SlotEngine.js parses and imports resolve.')).catch(e => { console.error(e); process.exit(1); })"
```

Expected: `SlotEngine.js parses and imports resolve.`

- [ ] **Step 7: Commit**

```bash
git add core/SlotEngine.js
git commit -m "refactor: replace physics-detected reel stop with time-driven landing

Per-reel state machine is now spinning -> landing -> bounce (was spinning ->
stopping -> bounce). landing snaps reel.symbols to the final correct array once,
then eases offsetY from one symbol-height to zero as a pure function of elapsed
time - correctness no longer depends on speed/acceleration/deceleration constants
converging, so turbo (or any future speed) can never overshoot or undershoot.
checkReelMatchesTarget() is removed; nothing polls for a match anymore."
```

---

### Task 5: `SlotEngine.js` — `stopSpin()` as timing compression

**Files:**
- Modify: `core/SlotEngine.js:625-640` (`stopSpin()`)

**Interfaces:**
- Consumes: `reel.landStartTime` (Task 4's reel shape) and the `now >= reel.landStartTime` transition already implemented in Task 4's `update()` rewrite — this task only changes how soon that transition is scheduled for reels still spinning when the STOP button is pressed.
- Produces: no new interface — `stopSpin()`'s external signature and call sites (`requestSpin()`) are unchanged.

- [ ] **Step 1: Rewrite `stopSpin()`**

Replace the entire `stopSpin()` method at `core/SlotEngine.js:625-640`:

```js
  stopSpin() {
    if (this.state !== 'spinning') {
      if (this.debugMode) console.log(`[Debug] stopSpin called but state is ${this.state}`);
      return;
    }
    if (this.debugMode) console.log(`[Debug] stopSpin called. State: ${this.state}`);
    this.state = 'stopping';
    this.config.onStateChange(this.state);
    
    const now = Date.now();
    for (let r = 0; r < this.reels.length; r++) {
      this.reels[r].state = 'stopping';
      this.reels[r].stopDelay = now - this.spinStart + (r * 100);
      if (this.debugMode) console.log(`[Debug] Reel ${r} stopDelay set to ${this.reels[r].stopDelay}`);
    }
  }
```

with:

```js
  stopSpin() {
    if (this.state !== 'spinning') {
      if (this.debugMode) console.log(`[Debug] stopSpin called but state is ${this.state}`);
      return;
    }
    if (this.debugMode) console.log(`[Debug] stopSpin called. State: ${this.state}`);
    this.state = 'stopping';
    this.config.onStateChange(this.state);
    
    const now = Date.now();
    for (let r = 0; r < this.reels.length; r++) {
      const reel = this.reels[r];
      if (reel.state === 'spinning') {
        // Compress the remaining spin time: this reel begins landing almost immediately,
        // still slightly staggered per reel so an early stop doesn't feel like every reel
        // freezes at once. Reels already 'landing' (or 'bounce') are left alone - their
        // tween is already short and guaranteed-correct, nothing to compress.
        reel.landStartTime = now + (r * 80);
      }
      if (this.debugMode) console.log(`[Debug] Reel ${r} landStartTime compressed to ${reel.landStartTime - this.spinStart}ms after spin start`);
    }
  }
```

Note this method no longer sets `reel.state = 'stopping'` directly (that per-reel
value no longer exists) — it only brings `reel.landStartTime` forward for reels
still in `'spinning'`; `update()`'s existing `now >= reel.landStartTime` check
(Task 4) picks up the change on the very next frame and transitions the reel into
`'landing'` through the normal path.

- [ ] **Step 2: Verify no remaining references to `reel.state = 'stopping'`**

Run:

```bash
grep -n "reel.state = 'stopping'\|\.state = 'stopping'" core/SlotEngine.js
```

Expected: no matches for `reel.state = 'stopping'` specifically. (`this.state = 'stopping'`
— the top-level engine state — legitimately still appears twice: once in `update()`'s
landing-transition block from Task 4, once here in `stopSpin()`. Confirm any matches
found are exactly those two, not a stray per-reel one.)

- [ ] **Step 3: Sanity-check with Node (syntax/reference check only)**

```bash
node --input-type=module -e "import('./core/SlotEngine.js').then(() => console.log('SlotEngine.js parses and imports resolve.')).catch(e => { console.error(e); process.exit(1); })"
```

Expected: `SlotEngine.js parses and imports resolve.`

- [ ] **Step 4: Commit**

```bash
git add core/SlotEngine.js
git commit -m "refactor: make stopSpin() compress landStartTime instead of forcing reel state

Early-stop now brings each still-spinning reel's scheduled landing instant forward
instead of setting a per-reel 'stopping' state that no longer exists, so it reuses
the same guaranteed-correct landing transition as a natural stop."
```

---

### Task 6: Manual end-to-end verification

No source changes in this task — it's the real integration test for a class that
can't be instantiated in Node. Use the `run` skill to start whatever local server
this repo uses for `games/bookbookbook/index.html` (check `package.json` / repo docs
for the exact command if not already known from this session) and open the game in
a browser.

- [ ] **Step 1: Verify normal spins**

Click SPIN at least 10 times in a row (turbo off). For each spin, confirm: the reels
visibly accelerate, spin, land in staggered order (reel 0 first, reel 4 last), give
a small bounce, and the final visible symbols never flicker or change after landing.
No stalls (spin button should return to `SPIN` and stay clickable after each result).

- [ ] **Step 2: Verify turbo spins**

Toggle Turbo on. Click SPIN at least 10 times. Confirm turbo spins are visibly
faster end-to-end than normal spins, reels still land staggered and correctly (no
skipped or duplicated symbols, no reel ever showing a mismatched or blank row), and
no stalls.

- [ ] **Step 3: Verify manual STOP**

Start a normal-speed spin and click STOP (same button, mid-spin) partway through.
Confirm all reels land promptly (compressed, but still slightly staggered), show
correct symbols, and the game proceeds to evaluate the result normally (win/no-win
resolves correctly, autoplay/free-spins logic afterward is unaffected).

- [ ] **Step 4: Verify autoplay across a free-spins round**

Enable Autoplay, let it run for at least 15 base spins (turbo off), and if a free
spins round triggers naturally let it fully play out (or use the scatter cheat
button, see Step 5, to force one). Confirm: no stalls at any transition (base spin
→ base spin, base spin → free spins intro → free spins, free spins → expanding win
→ next free spin, free spins → summary → base game), and expanding-symbol wins
still expand and pay visually as before.

- [ ] **Step 5: Verify the debug cheat buttons**

If the debug UI is enabled, click each of the "force win" cheat buttons (scatter,
expanding, bigwin) once each. Confirm each still produces the intended forced
result with correct visuals (these paths go through `forceWinResult()` →
`this.forcedTargetGrid = true` → `spin()`, which must still skip seed-based grid
generation exactly as before — Task 3 Step 2 preserves this).

- [ ] **Step 6: Verify replay (dev-tool check)**

With `engine.debugMode = true` (or via whatever debug console access this build
exposes), spin once and note the logged `[SPIN] seed=...` value. Call
`engine.spin(<that seed>)` again (e.g. from the browser devtools console) once the
engine is back in `idle`/`showing_wins`. Confirm the resulting `targetGrid` (and
therefore the landed symbols) is identical to the first spin with that seed — this
is the replay capability the design spec calls out as the primary near-term use
case.

- [ ] **Step 7: Report results**

If every check above passes, the feature is complete — no further commit is needed
(Tasks 1-5 already committed the source changes). If any check fails, use the
`superpowers:systematic-debugging` skill to investigate before making further
changes, rather than patching symptoms directly.

---

## Self-Review Notes

- **Spec coverage:** Design section 1 (outcome generation) → Task 1. Section 2 (spin
  outcome flow / seed + replay) → Task 3. Section 3 (visual animation) → Task 4.
  Section 4 (turbo & manual stop) → Task 4 (turbo is just the `landDuration`/`stopInterval`
  constants already threaded through `spin()`) and Task 5 (manual stop). Testing/verification
  section → Tasks 1, 2, and 6. Migration notes (removed methods, retired fields, the
  `reel.state` vs `engine.state` distinction) → Tasks 3, 4, 5.
- **Placeholder scan:** no TBD/TODO; every step shows complete code, not a description of code.
- **Type/name consistency:** `landStartTime`, `landElapsedStart`, `landDuration` are
  introduced in Task 4 Step 1 (reel shape) and used identically in Task 3 Step 2
  (`spin()` sets `landStartTime`/`landDuration`), Task 4 Step 3 (`update()` reads/sets
  all three), and Task 5 Step 1 (`stopSpin()` sets `landStartTime`). `createSeededRng`
  and `generateTargetGrid` are defined in Task 1 with the exact signatures Task 3
  imports and calls.
