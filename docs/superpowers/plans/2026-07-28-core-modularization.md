# Core Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `core/` into `math/`/`rendering/`/`engine/`/`audio/` subfolders and replace
`SlotEngine.js`/`CascadeEngine.js` (96KB combined, ~15 duplicated method names) with one
`CoreSlotEngine` skeleton that owns only the state machine and animation loop, with every other
concern — grid resolution, spin/cascade animation, drawing, particles, audio, free-spins payout
rules, spin logging — as its own class in its own file, plugged in through configuration.

**Architecture:** See `docs/superpowers/specs/2026-07-28-core-modularization-design.md` for the
full design and rationale. Summary: every spin resolves to a normalized step-sequence
(`{ steps: [...], scatterWin }`); `Mechanic.resolveLiveSpin(...)` produces it for live play,
reusing/extending the same `Mechanic` objects `SpinSimulator.js` already calls for batch
simulation. `CoreSlotEngine` dispatches to a `SpinAnimator` (entrance/transition animation), a
`Renderer` (draw calls), a `ParticleSystem`, an `AudioController`, a `FreeSpinsMode`, and a
`SpinLogRecorder` — each its own file under `core/engine/` or `core/rendering/`.

**Tech Stack:** Plain ES modules, no build step, no bundler. `node --test` for all automated
tests (no DOM available — canvas-touching code is verified manually in-browser, matching how
`SlotEngine.js`/`CascadeEngine.js` are verified today). Windows/PowerShell dev environment;
`./serve.ps1` starts the static server for manual verification.

## Global Constraints

- No build step, no bundler, no TypeScript — plain ES modules only (design doc, confirmed).
- `core/math/` stays pure: no DOM, no mutable state, same inputs → same outputs (existing rule,
  unaffected by this refactor).
- Every existing `tests/*.mjs` file must keep passing, unmodified in behavior (import paths only),
  after every task in Milestone 1 — this is the evidence that payout math is untouched.
- `Mechanic` objects (and anything they close over) must stay resolvable by name via
  `core/mechanicRegistry.js`, and must remain stateless per call — required so
  `SimulationWorkerPool.js`'s concurrent trials and CMA-ES/Nelder-Mead's concurrent candidate
  evaluation keep working unmodified (design doc, "Mechanic is the shared contract with
  CoreSimulationEngine").
- Commit after every task (or every numbered step group inside a task where noted). Never use
  `git add -A`; stage the exact files each task touches.
- Windows dev environment: use PowerShell/`Move-Item` semantics for file moves shown below, or the
  equivalent `git mv` — either is fine as long as git records a rename, not a delete+add.

---

## Milestone 1 — Folder reorganization (mechanical, no behavior change)

Each task in this milestone: create the target folder, move the files with `git mv`, fix every
downstream import (listed exactly — derived from a full repo grep of every file that imports the
files being moved), run `npm test`, commit. No code inside any moved file changes in this
milestone — only import specifiers.

### Task 1: Move math modules into `core/math/`

**Files:**
- Move: `core/SlotMath.js` → `core/math/SlotMath.js`
- Move: `core/CascadeMath.js` → `core/math/CascadeMath.js`
- Move: `core/ClusterMath.js` → `core/math/ClusterMath.js`
- Modify (import path only): `core/CascadeSpinMechanic.js`, `core/CMAES.js`,
  `core/mechanicRegistry.js`, `core/SimulationPanel.js`, `core/SlotEngine.js`,
  `core/LineMechanic.js`, `core/SpinSimulator.js`, `core/simulationTrialWorker.js`,
  `core/CascadeEngine.js`, `games/barfruits/game.js`, `games/candyfrenzy/game.js`,
  `games/mayantumble/game.js`, `games/bookbookbook/game.js`, `games/fruitmachine/game.js`,
  `tests/mayantumble.test.mjs`, `tests/cascademath.test.mjs`, `tests/cascadesimulator.test.mjs`,
  `tests/book-rtp-regression.test.mjs`, `tests/fruitmachine-rtp.test.mjs`,
  `tests/spinsimulator.test.mjs`, `tests/tunefrequencies.test.mjs`, `tests/slotmath.test.mjs`,
  `tests/reelspacing.test.mjs`, `tests/clustermath.test.mjs`

**Interfaces:**
- Produces: `core/math/SlotMath.js`, `core/math/CascadeMath.js`, `core/math/ClusterMath.js` at
  their new paths, every export unchanged (no code edits, only the file's own location).

- [ ] **Step 1: Move the three files**

```powershell
New-Item -ItemType Directory -Force core/math | Out-Null
git mv core/SlotMath.js core/math/SlotMath.js
git mv core/CascadeMath.js core/math/CascadeMath.js
git mv core/ClusterMath.js core/math/ClusterMath.js
```

Note: `core/ClusterMath.js` imports `./CascadeMath.js` and `core/math/CascadeMath.js` imports
`./SlotMath.js` — both siblings moved together, so these two relative imports need **no edit**.

- [ ] **Step 2: Fix every downstream import (core/, one file each)**

In `core/CascadeSpinMechanic.js` — no `SlotMath`/`CascadeMath`/`ClusterMath` import here (it
imports `CascadeMath.js` — check: it does not, per its current imports it only imports
`CascadeMath.js`... actually skip, this file's only moved-file import is `./CascadeMath.js`):

```diff
- import { resolveCascadeSequence } from './CascadeMath.js';
+ import { resolveCascadeSequence } from './math/CascadeMath.js';
```

In `core/CMAES.js`:
```diff
- import { createSeededRng } from './SlotMath.js';
+ import { createSeededRng } from './math/SlotMath.js';
```

In `core/mechanicRegistry.js`:
```diff
- import { checkWins, checkWildLineWins } from './SlotMath.js';
- import { checkClusterWins } from './ClusterMath.js';
+ import { checkWins, checkWildLineWins } from './math/SlotMath.js';
+ import { checkClusterWins } from './math/ClusterMath.js';
```

In `core/SimulationPanel.js`:
```diff
- import { resolveFrequencyBounds } from './SlotMath.js';
+ import { resolveFrequencyBounds } from './math/SlotMath.js';
```

In `core/SlotEngine.js`:
```diff
- import { checkWins, createSeededRng } from './SlotMath.js';
+ import { checkWins, createSeededRng } from './math/SlotMath.js';
```

In `core/LineMechanic.js`:
```diff
- import { generateTargetGrid, checkExpandingWins, checkWins } from './SlotMath.js';
+ import { generateTargetGrid, checkExpandingWins, checkWins } from './math/SlotMath.js';
```

In `core/SpinSimulator.js`:
```diff
- import { generateReel, createSeededRng, resolveFrequencyBounds } from './SlotMath.js';
+ import { generateReel, createSeededRng, resolveFrequencyBounds } from './math/SlotMath.js';
```

In `core/simulationTrialWorker.js`:
```diff
- import { createSeededRng } from './SlotMath.js';
+ import { createSeededRng } from './math/SlotMath.js';
```

In `core/CascadeEngine.js`:
```diff
- import { applyCascade } from './CascadeMath.js';
- import { createSeededRng } from './SlotMath.js';
+ import { applyCascade } from './math/CascadeMath.js';
+ import { createSeededRng } from './math/SlotMath.js';
```

- [ ] **Step 3: Fix every downstream import (games/, five files)**

In each of `games/barfruits/game.js`, `games/candyfrenzy/game.js`, `games/mayantumble/game.js`,
`games/bookbookbook/game.js`, `games/fruitmachine/game.js`, change the `SlotMath.js` import line
(the exact named imports already differ per game — keep the same names, only change the path):

```diff
- import { generateReel, ... } from '../../core/SlotMath.js';
+ import { generateReel, ... } from '../../core/math/SlotMath.js';
```

Additionally in `games/candyfrenzy/game.js`:
```diff
- import { checkClusterWins } from '../../core/ClusterMath.js';
+ import { checkClusterWins } from '../../core/math/ClusterMath.js';
```

- [ ] **Step 4: Fix every downstream import (tests/, ten files)**

In each of `tests/mayantumble.test.mjs`, `tests/cascadesimulator.test.mjs`,
`tests/book-rtp-regression.test.mjs`, `tests/fruitmachine-rtp.test.mjs`,
`tests/spinsimulator.test.mjs`, `tests/tunefrequencies.test.mjs`, `tests/slotmath.test.mjs`,
`tests/reelspacing.test.mjs`, change:

```diff
- from '../core/SlotMath.js';
+ from '../core/math/SlotMath.js';
```

In `tests/cascademath.test.mjs`:
```diff
- import { nextStripSymbol, applyCascade, checkScatterCount, resolveCascadeSequence } from '../core/CascadeMath.js';
+ import { nextStripSymbol, applyCascade, checkScatterCount, resolveCascadeSequence } from '../core/math/CascadeMath.js';
```

In `tests/clustermath.test.mjs`:
```diff
- import { findClusters, checkClusterWins } from '../core/ClusterMath.js';
+ import { findClusters, checkClusterWins } from '../core/math/ClusterMath.js';
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: every test file passes, identical pass/fail counts to before this task (no test content
changed — only import paths).

- [ ] **Step 6: Commit**

```bash
git add core/math core/CascadeSpinMechanic.js core/CMAES.js core/mechanicRegistry.js core/SimulationPanel.js core/SlotEngine.js core/LineMechanic.js core/SpinSimulator.js core/simulationTrialWorker.js core/CascadeEngine.js games/barfruits/game.js games/candyfrenzy/game.js games/mayantumble/game.js games/bookbookbook/game.js games/fruitmachine/game.js tests/mayantumble.test.mjs tests/cascademath.test.mjs tests/cascadesimulator.test.mjs tests/book-rtp-regression.test.mjs tests/fruitmachine-rtp.test.mjs tests/spinsimulator.test.mjs tests/tunefrequencies.test.mjs tests/slotmath.test.mjs tests/reelspacing.test.mjs tests/clustermath.test.mjs
git commit -m "refactor: move math modules into core/math/"
```

---

### Task 2: Move rendering primitives into `core/rendering/`

**Files:**
- Move: `core/GridLayout.js` → `core/rendering/GridLayout.js`
- Move: `core/SpriteDrawer.js` → `core/rendering/SpriteDrawer.js`
- Move: `core/ParticleSystem.js` → `core/rendering/ParticleSystem.js`
- Modify: `core/SlotEngine.js`, `core/CascadeEngine.js`, `tests/gridlayout.test.mjs`

**Interfaces:**
- Produces: `core/rendering/GridLayout.js` (`computeGridLayout`), `core/rendering/SpriteDrawer.js`
  (`drawSpriteSymbol`), `core/rendering/ParticleSystem.js` (`ParticleSystem` class) — same
  exports, new path.

- [ ] **Step 1: Move the three files**

```powershell
New-Item -ItemType Directory -Force core/rendering | Out-Null
git mv core/GridLayout.js core/rendering/GridLayout.js
git mv core/SpriteDrawer.js core/rendering/SpriteDrawer.js
git mv core/ParticleSystem.js core/rendering/ParticleSystem.js
```

- [ ] **Step 2: Fix imports in `core/SlotEngine.js`**

```diff
- import { computeGridLayout } from './GridLayout.js';
- import { drawSpriteSymbol } from './SpriteDrawer.js';
- import { ParticleSystem } from './ParticleSystem.js';
+ import { computeGridLayout } from './rendering/GridLayout.js';
+ import { drawSpriteSymbol } from './rendering/SpriteDrawer.js';
+ import { ParticleSystem } from './rendering/ParticleSystem.js';
```

- [ ] **Step 3: Fix imports in `core/CascadeEngine.js`**

```diff
- import { computeGridLayout } from './GridLayout.js';
- import { drawSpriteSymbol } from './SpriteDrawer.js';
- import { ParticleSystem } from './ParticleSystem.js';
+ import { computeGridLayout } from './rendering/GridLayout.js';
+ import { drawSpriteSymbol } from './rendering/SpriteDrawer.js';
+ import { ParticleSystem } from './rendering/ParticleSystem.js';
```

- [ ] **Step 4: Fix import in `tests/gridlayout.test.mjs`**

```diff
- import { computeGridLayout } from '../core/GridLayout.js';
+ import { computeGridLayout } from '../core/rendering/GridLayout.js';
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: identical pass/fail counts to Task 1's end state.

- [ ] **Step 6: Commit**

```bash
git add core/rendering core/SlotEngine.js core/CascadeEngine.js tests/gridlayout.test.mjs
git commit -m "refactor: move rendering primitives into core/rendering/"
```

---

### Task 3: Move `SlotAudio.js` into `core/audio/`

**Files:**
- Move: `core/SlotAudio.js` → `core/audio/SlotAudio.js`
- Modify: `core/SlotEngine.js`, `core/CascadeEngine.js`

**Interfaces:**
- Produces: `core/audio/SlotAudio.js` exporting the same `audio` singleton, new path.

- [ ] **Step 1: Move the file**

```powershell
New-Item -ItemType Directory -Force core/audio | Out-Null
git mv core/SlotAudio.js core/audio/SlotAudio.js
```

- [ ] **Step 2: Fix imports**

In `core/SlotEngine.js`:
```diff
- import { audio } from './SlotAudio.js';
+ import { audio } from './audio/SlotAudio.js';
```

In `core/CascadeEngine.js`:
```diff
- import { audio } from './SlotAudio.js';
+ import { audio } from './audio/SlotAudio.js';
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: identical pass/fail counts to Task 2's end state (no test imports `SlotAudio.js`
directly today, so this is a pure sanity check that nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add core/audio core/SlotEngine.js core/CascadeEngine.js
git commit -m "refactor: move SlotAudio.js into core/audio/"
```

---

### Task 4: Move mechanics and free-spins modes into `core/engine/`

**Files:**
- Move: `core/LineMechanic.js` → `core/engine/mechanics/LineMechanic.js`
- Move: `core/CascadeSpinMechanic.js` → `core/engine/mechanics/CascadeSpinMechanic.js`
- Move: `core/FreeSpinsModes.js` → `core/engine/FreeSpinsModes.js`
- Modify: `core/SlotEngine.js`, `core/CascadeEngine.js`, `core/SpinSimulator.js`,
  `core/mechanicRegistry.js`, `games/candyfrenzy/game.js`, `games/mayantumble/game.js`,
  `tests/mayantumble.test.mjs`, `tests/cascadesimulator.test.mjs`

**Interfaces:**
- Produces: `core/engine/mechanics/LineMechanic.js` (`LineMechanic`),
  `core/engine/mechanics/CascadeSpinMechanic.js` (`CascadeSpinMechanic`),
  `core/engine/FreeSpinsModes.js` (`createFlatMultiplierMode`, `createMultiplierTilesMode`) — same
  exports, new paths. Internal imports inside the moved files themselves also change (two levels
  deep now under `engine/mechanics/`).

- [ ] **Step 1: Move the three files**

```powershell
New-Item -ItemType Directory -Force core/engine/mechanics | Out-Null
git mv core/LineMechanic.js core/engine/mechanics/LineMechanic.js
git mv core/CascadeSpinMechanic.js core/engine/mechanics/CascadeSpinMechanic.js
git mv core/FreeSpinsModes.js core/engine/FreeSpinsModes.js
```

- [ ] **Step 2: Fix the moved files' own internal imports**

`core/engine/mechanics/LineMechanic.js` is now two levels below `core/` (was one):
```diff
- import { generateTargetGrid, checkExpandingWins, checkWins } from './math/SlotMath.js';
- import { createSpinLogEntry, applyExpandingWinToSpinLogEntry } from './SpinLog.js';
+ import { generateTargetGrid, checkExpandingWins, checkWins } from '../../math/SlotMath.js';
+ import { createSpinLogEntry, applyExpandingWinToSpinLogEntry } from '../../SpinLog.js';
```
(Note: Task 1 already rewrote the `SlotMath.js` import to `./math/SlotMath.js` when the file was
still at `core/LineMechanic.js`; this step corrects it again for the file's new two-levels-deep
location. If executing this plan tasks-in-order, the import at this point in time reads
`'./math/SlotMath.js'` — verify against the actual file content before editing, since the exact
diff base depends on Task 1 having already run.)

`core/engine/mechanics/CascadeSpinMechanic.js`:
```diff
- import { resolveCascadeSequence } from './math/CascadeMath.js';
- import { createCascadeSpinLogEntry } from './SpinLog.js';
- import { createFlatMultiplierMode } from './FreeSpinsModes.js';
+ import { resolveCascadeSequence } from '../../math/CascadeMath.js';
+ import { createCascadeSpinLogEntry } from '../../SpinLog.js';
+ import { createFlatMultiplierMode } from '../FreeSpinsModes.js';
```

`core/engine/FreeSpinsModes.js` — check its own header imports (not listed in the grep above,
meaning it currently has none from the moved set); if it has no relative imports, no change is
needed here.

- [ ] **Step 3: Fix imports in `core/SlotEngine.js`**

```diff
- import { LineMechanic } from './LineMechanic.js';
+ import { LineMechanic } from './engine/mechanics/LineMechanic.js';
```

- [ ] **Step 4: Fix imports in `core/CascadeEngine.js`**

```diff
- import { createFlatMultiplierMode } from './FreeSpinsModes.js';
- import { CascadeSpinMechanic } from './CascadeSpinMechanic.js';
+ import { createFlatMultiplierMode } from './engine/FreeSpinsModes.js';
+ import { CascadeSpinMechanic } from './engine/mechanics/CascadeSpinMechanic.js';
```

- [ ] **Step 5: Fix imports in `core/SpinSimulator.js`**

```diff
- import { LineMechanic } from './LineMechanic.js';
+ import { LineMechanic } from './engine/mechanics/LineMechanic.js';
```

- [ ] **Step 6: Fix imports in `core/mechanicRegistry.js`**

```diff
- import { LineMechanic } from './LineMechanic.js';
- import { CascadeSpinMechanic } from './CascadeSpinMechanic.js';
- import { createFlatMultiplierMode, createMultiplierTilesMode } from './FreeSpinsModes.js';
+ import { LineMechanic } from './engine/mechanics/LineMechanic.js';
+ import { CascadeSpinMechanic } from './engine/mechanics/CascadeSpinMechanic.js';
+ import { createFlatMultiplierMode, createMultiplierTilesMode } from './engine/FreeSpinsModes.js';
```

- [ ] **Step 7: Fix imports in `games/candyfrenzy/game.js`**

```diff
- import { createMultiplierTilesMode } from '../../core/FreeSpinsModes.js';
- import { CascadeSpinMechanic } from '../../core/CascadeSpinMechanic.js';
+ import { createMultiplierTilesMode } from '../../core/engine/FreeSpinsModes.js';
+ import { CascadeSpinMechanic } from '../../core/engine/mechanics/CascadeSpinMechanic.js';
```

- [ ] **Step 8: Fix imports in `games/mayantumble/game.js`**

```diff
- import { createMultiplierTilesMode } from '../../core/FreeSpinsModes.js';
- import { CascadeSpinMechanic } from '../../core/CascadeSpinMechanic.js';
+ import { createMultiplierTilesMode } from '../../core/engine/FreeSpinsModes.js';
+ import { CascadeSpinMechanic } from '../../core/engine/mechanics/CascadeSpinMechanic.js';
```

- [ ] **Step 9: Fix imports in `tests/mayantumble.test.mjs`**

```diff
- import { CascadeSpinMechanic } from '../core/CascadeSpinMechanic.js';
+ import { CascadeSpinMechanic } from '../core/engine/mechanics/CascadeSpinMechanic.js';
```

- [ ] **Step 10: Fix imports in `tests/cascadesimulator.test.mjs`**

```diff
- import { LineMechanic } from '../core/LineMechanic.js';
- import { CascadeSpinMechanic } from '../core/CascadeSpinMechanic.js';
- import { createMultiplierTilesMode } from '../core/FreeSpinsModes.js';
+ import { LineMechanic } from '../core/engine/mechanics/LineMechanic.js';
+ import { CascadeSpinMechanic } from '../core/engine/mechanics/CascadeSpinMechanic.js';
+ import { createMultiplierTilesMode } from '../core/engine/FreeSpinsModes.js';
```

- [ ] **Step 11: Run the full test suite**

Run: `npm test`
Expected: identical pass/fail counts to Task 3's end state.

- [ ] **Step 12: Commit**

```bash
git add core/engine games/candyfrenzy/game.js games/mayantumble/game.js tests/mayantumble.test.mjs tests/cascadesimulator.test.mjs core/SlotEngine.js core/CascadeEngine.js core/SpinSimulator.js core/mechanicRegistry.js
git commit -m "refactor: move mechanics and FreeSpinsModes into core/engine/"
```

Milestone 1 is now complete: `core/math/`, `core/rendering/`, `core/audio/`, and
`core/engine/{mechanics/,FreeSpinsModes.js}` exist; `core/SlotEngine.js`/`core/CascadeEngine.js`
still work exactly as before (only their imports changed); every test passes.

---

## Milestone 2 — Pure, testable engine pieces (TDD, no canvas required)

### Task 5: `CoreSlotEngine` skeleton — state machine only

Build the skeleton with no real components wired in yet, verified entirely with stub
mechanic/animator/renderer objects (plain JS objects — no DOM/canvas needed, since the skeleton
itself never calls `ctx` methods).

**Files:**
- Create: `core/engine/CoreSlotEngine.js`
- Test: `tests/coreslotengine.test.mjs`

**Interfaces:**
- Produces: `class CoreSlotEngine` with constructor `(canvas, config)`, public methods
  `requestSpin()`, `spin(seed)`, `stopSpin()`, `enterFreeSpinsIntro()`,
  `enterFreeSpins(spinsCount)`, `retriggerFreeSpins(spinsCount)`, `exitFreeSpins()`,
  `returnToIdle()`; fields `state`, `balance`, `lastWin`, `inFreeSpins`, `freeSpinsRemaining`,
  `freeSpinsTotal`, `freeSpinsAccumulatedWin`, `spinSequence`, `stepIndex`, `grid`,
  `lastSpinSeed`. Config accepts component references: `mechanic`, `animator`, `renderer`,
  `particleSystem`, `freeSpinsMode`, `audioController`, `spinLogRecorder` — all optional at the
  skeleton level (a concrete game always supplies `mechanic`/`animator`/`renderer`; the skeleton
  itself never assumes any of them exist beyond calling their documented methods when present).
- Consumes: nothing yet (components are stubbed in this task's own tests; Tasks 6–13 build the
  real ones this later plugs into).

- [ ] **Step 1: Write the failing test for construction + initial state**

```javascript
// tests/coreslotengine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreSlotEngine } from '../core/engine/CoreSlotEngine.js';

function stubCanvas() {
  return { width: 800, height: 600, getContext: () => ({}) };
}

test('CoreSlotEngine starts idle with the given balance and no active spin', () => {
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
    animator: { playEntrance: (step, ctx, onDone) => onDone(), playTransition: (a, b, ctx, onDone) => onDone() },
    renderer: { draw: () => {} },
  });
  assert.equal(engine.state, 'idle');
  assert.equal(engine.balance, 1000);
  assert.equal(engine.inFreeSpins, false);
  assert.equal(engine.spinSequence, null);
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/coreslotengine.test.mjs`
Expected: FAIL — `Cannot find module '../core/engine/CoreSlotEngine.js'`.

- [ ] **Step 3: Write the skeleton (construction + fields only)**

```javascript
// core/engine/CoreSlotEngine.js
// A skeleton, not a monolith: owns the state machine and animation loop only. Every other
// concern - grid resolution, animation style, drawing, particles, audio, free-spins payout
// rules, spin logging - is a component plugged in through config, each its own file. See
// docs/superpowers/specs/2026-07-28-core-modularization-design.md.
export class CoreSlotEngine {
  constructor(canvas, config = {}) {
    this.canvas = canvas;
    this.ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;

    this.config = {
      reelsCount: 5,
      rowsCount: 3,
      paytable: {},
      reelStrips: [],
      betPerLine: 1,
      linesCount: 10,
      betAmount: null,
      onStateChange: () => {},
      onScatterTrigger: () => {},
      onWin: () => {},
      ...config,
    };

    this.mechanic = config.mechanic ?? null;
    this.animator = config.animator ?? null;
    this.renderer = config.renderer ?? null;
    this.particleSystem = config.particleSystem ?? null;
    this.freeSpinsMode = config.freeSpinsMode ?? null;
    this.audioController = config.audioController ?? null;
    this.spinLogRecorder = config.spinLogRecorder ?? null;

    this.spritesheetUrl = config.spritesheetUrl || '';
    this.symbolsConfig = config.symbolsConfig || {};

    this.state = 'idle';
    this.balance = 1000;
    this.betPerLine = this.config.betPerLine;
    this.linesCount = this.config.linesCount;
    this.betAmount = this.config.betAmount;
    this.lastWin = 0;

    this.inFreeSpins = false;
    this.freeSpinsRemaining = 0;
    this.freeSpinsTotal = 0;
    this.freeSpinsAccumulatedWin = 0;
    this.freeSpinsModeState = null;

    this.spinSequence = null;
    this.stepIndex = 0;
    this.grid = null;
    this.lastSpinSeed = null;

    this.turboMode = false;
    this.autoPlay = false;
    this.pendingSpinRequest = false;
  }

  _setState(next) {
    this.state = next;
    this.config.onStateChange(next);
  }
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/coreslotengine.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `spin()`'s state transitions**

```javascript
test('spin() moves idle -> spinning -> showing_wins when the mechanic reports a payout', async () => {
  const states = [];
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: {
      resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 5 }], scatterWin: null }),
    },
    animator: {
      playEntrance: (step, ctx, onDone) => onDone(),
      playTransition: (a, b, ctx, onDone) => onDone(),
    },
    renderer: { draw: () => {} },
    onStateChange: (s) => states.push(s),
  });

  await engine.spin(42);

  assert.equal(engine.state, 'showing_wins');
  assert.deepEqual(states, ['spinning', 'evaluating', 'showing_wins']);
  assert.equal(engine.lastSpinSeed, 42);
  assert.deepEqual(engine.grid, [['a']]);
});

test('spin() moves idle -> spinning -> idle when the mechanic reports no payout', async () => {
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
    animator: { playEntrance: (step, ctx, onDone) => onDone(), playTransition: (a, b, ctx, onDone) => onDone() },
    renderer: { draw: () => {} },
  });

  await engine.spin(1);

  assert.equal(engine.state, 'idle');
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `node --test tests/coreslotengine.test.mjs`
Expected: FAIL — `engine.spin is not a function`.

- [ ] **Step 7: Implement `spin()`, `requestSpin()`, `stopSpin()`**

```javascript
  requestSpin() {
    if (this.state !== 'idle' && this.state !== 'showing_wins' && this.state !== 'game_over') {
      this.pendingSpinRequest = true;
      return;
    }
    this.spin();
  }

  async spin(seed = Math.floor(Math.random() * 0xFFFFFFFF)) {
    this.lastSpinSeed = seed;
    this._setState('spinning');

    const result = this.mechanic.resolveLiveSpin({
      reelStrips: this.config.reelStrips,
      rowsCount: this.config.rowsCount,
      seed,
      rng: undefined, // set by a mechanic-specific adapter if it needs an rng function instead of a seed
      config: this.config,
      linesCount: this.linesCount,
      winEvaluator: this.config.winEvaluator,
      maxCascadeSteps: this.config.maxCascadeSteps,
    });

    this.spinSequence = result.steps;
    this.stepIndex = 0;

    await this._playStep(this.stepIndex);

    if (result.scatterWin && result.scatterWin.triggerFreeSpins) {
      this.config.onScatterTrigger(result.scatterWin.count, this.inFreeSpins);
    }

    this._finishSpin();
  }

  async _playStep(index) {
    const step = this.spinSequence[index];
    this.grid = step.grid;
    await new Promise((resolve) => this.animator.playEntrance(step, this.ctx, resolve));
    if (index + 1 < this.spinSequence.length) {
      this.stepIndex = index + 1;
      const nextStep = this.spinSequence[this.stepIndex];
      await new Promise((resolve) => this.animator.playTransition(step, nextStep, this.ctx, resolve));
      await this._playStep(this.stepIndex);
    }
  }

  _finishSpin() {
    this._setState('evaluating');
    const totalPayout = this.spinSequence.reduce((sum, step) => sum + (step.payout || 0), 0);
    const betAmount = this.betAmount ?? (this.betPerLine * this.linesCount);
    this.lastWin = totalPayout * betAmount;
    this.balance += this.lastWin;

    if (this.spinLogRecorder) {
      this.spinLogRecorder.record({ sequence: this.spinSequence, seed: this.lastSpinSeed, timestamp: Date.now() });
    }

    if (this.lastWin > 0) {
      this.config.onWin({ amount: this.lastWin });
      this._setState('showing_wins');
    } else {
      this._setState('idle');
    }

    if (this.pendingSpinRequest) {
      this.pendingSpinRequest = false;
      this.requestSpin();
    }
  }

  stopSpin() {
    // Turbo/skip hook - a real animator's playEntrance/playTransition should resolve immediately
    // when this is set; the skeleton just exposes the flag components read.
    this._skipAnimation = true;
  }
```

- [ ] **Step 8: Run it, confirm it passes**

Run: `node --test tests/coreslotengine.test.mjs`
Expected: PASS, all tests in the file.

- [ ] **Step 9: Write the failing test for free-spins lifecycle**

```javascript
test('enterFreeSpins sets inFreeSpins and the spins counters; exitFreeSpins clears them', () => {
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
    animator: { playEntrance: (s, c, d) => d(), playTransition: (a, b, c, d) => d() },
    renderer: { draw: () => {} },
  });

  engine.enterFreeSpinsIntro();
  assert.equal(engine.state, 'free_spins_intro');

  engine.enterFreeSpins(10);
  assert.equal(engine.inFreeSpins, true);
  assert.equal(engine.freeSpinsRemaining, 10);
  assert.equal(engine.freeSpinsTotal, 10);

  engine.retriggerFreeSpins(5);
  assert.equal(engine.freeSpinsRemaining, 15);
  assert.equal(engine.freeSpinsTotal, 15);

  engine.exitFreeSpins();
  assert.equal(engine.inFreeSpins, false);
  assert.equal(engine.freeSpinsRemaining, 0);
});
```

- [ ] **Step 10: Run it, confirm it fails, then implement**

Run: `node --test tests/coreslotengine.test.mjs` → FAIL (`enterFreeSpinsIntro is not a function`).

```javascript
  enterFreeSpinsIntro() {
    this._setState('free_spins_intro');
  }

  enterFreeSpins(spinsCount) {
    this.inFreeSpins = true;
    this.freeSpinsRemaining = spinsCount;
    this.freeSpinsTotal = spinsCount;
    this.freeSpinsAccumulatedWin = 0;
    if (this.freeSpinsMode) {
      this.freeSpinsModeState = this.freeSpinsMode.createState(this);
    }
    this._setState('spinning');
  }

  retriggerFreeSpins(spinsCount) {
    this.freeSpinsRemaining += spinsCount;
    this.freeSpinsTotal += spinsCount;
  }

  exitFreeSpins() {
    this.inFreeSpins = false;
    this.freeSpinsRemaining = 0;
    this.freeSpinsTotal = 0;
    this.freeSpinsAccumulatedWin = 0;
    if (this.freeSpinsMode) {
      this.freeSpinsModeState = this.freeSpinsMode.createState(this);
    }
    this._setState('game_over');
  }

  returnToIdle() {
    this._setState('idle');
  }
```

- [ ] **Step 11: Run it, confirm it passes**

Run: `node --test tests/coreslotengine.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 12: Commit**

```bash
git add core/engine/CoreSlotEngine.js tests/coreslotengine.test.mjs
git commit -m "feat: add CoreSlotEngine skeleton with state machine + free-spins lifecycle"
```

**Note for the next task's implementer:** `spin()`'s call to `mechanic.resolveLiveSpin({...})`
above passes a superset of named parameters (`rng`, `seed`, `config`, `linesCount`,
`winEvaluator`, `maxCascadeSteps`) — each mechanic destructures only what it needs (Tasks 6/7
finalize each mechanic's own destructured signature and must keep it compatible with this call
shape). The `rng: undefined` line is a placeholder for Task 6, which needs an `rng` function
rather than a raw `seed` (unlike Task 7's cascade mechanic, which takes `seed` directly) — Task 6
must either derive its own `rng` from `seed` internally (preferred, keeps this call site
unchanged) or this call site must be revisited. Resolve this explicitly in Task 6, don't leave it
inconsistent.

---

### Task 6: `LineMechanic.resolveLiveSpin`

**Files:**
- Modify: `core/engine/mechanics/LineMechanic.js`
- Test: `tests/linemechanic.test.mjs` (new)

**Interfaces:**
- Consumes: `generateTargetGrid(reelStrips, rowsCount, rng)`, `checkWins(...)` (both already
  imported in this file, per Task 1/4's moves — `../../math/SlotMath.js`).
- Produces: `LineMechanic.resolveLiveSpin({ reelStrips, rowsCount, seed, config, linesCount }) →
  { steps: [{ grid, lineWins, scatterWin, payout }], scatterWin }`. Derives its own `rng` from
  `seed` internally via `createSeededRng` (resolving the note left at the end of Task 5), so
  `CoreSlotEngine.spin()`'s call site never needs a mechanic-specific branch.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/linemechanic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { LineMechanic } from '../core/engine/mechanics/LineMechanic.js';

test('resolveLiveSpin returns a single-step sequence with the resolved grid and payout', () => {
  const reelStrips = [['a', 'b'], ['a', 'b'], ['a', 'b']];
  const config = {
    paytable: { a: { payout: [0, 0, 5], type: 'normal' } },
    paylines: [[0, 0, 0]],
  };

  const result = LineMechanic.resolveLiveSpin({
    reelStrips, rowsCount: 1, seed: 1, config, linesCount: 1,
  });

  assert.equal(result.steps.length, 1);
  assert.ok(Array.isArray(result.steps[0].grid));
  assert.equal(typeof result.steps[0].payout, 'number');
  assert.ok('lineWins' in result.steps[0]);
  assert.ok('scatterWin' in result.steps[0]);
  assert.ok('scatterWin' in result);
});

test('resolveLiveSpin is deterministic for a given seed', () => {
  const reelStrips = [['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c']];
  const config = { paytable: { a: { payout: [0, 0, 5] } }, paylines: [[0, 0, 0]] };

  const first = LineMechanic.resolveLiveSpin({ reelStrips, rowsCount: 1, seed: 7, config, linesCount: 1 });
  const second = LineMechanic.resolveLiveSpin({ reelStrips, rowsCount: 1, seed: 7, config, linesCount: 1 });

  assert.deepEqual(first.steps[0].grid, second.steps[0].grid);
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/linemechanic.test.mjs`
Expected: FAIL — `LineMechanic.resolveLiveSpin is not a function`.

- [ ] **Step 3: Implement `resolveLiveSpin`**

Add to `core/engine/mechanics/LineMechanic.js`. First add `createSeededRng` to its existing
`SlotMath.js` import line:

```diff
- import { generateTargetGrid, checkExpandingWins, checkWins } from '../../math/SlotMath.js';
+ import { generateTargetGrid, checkExpandingWins, checkWins, createSeededRng } from '../../math/SlotMath.js';
```

Then add the method (after `evaluateExpandingWin`, before `createFreeSpinsState`):

```javascript
  // Live-play entry point (core/engine/CoreSlotEngine.js) - the normalized step-sequence
  // counterpart to resolveSpin's batch-simulation entry point below. Always a single-step
  // sequence: a line-pay spin has no cascade steps. Derives its own rng from `seed` so the
  // caller never needs to know whether a mechanic wants a seed or an rng function.
  resolveLiveSpin({ reelStrips, rowsCount, seed, config, linesCount }) {
    const rng = createSeededRng(seed);
    const grid = this.getTargetGrid(reelStrips, rowsCount, rng);
    const winData = this.evaluateWin(grid, config, linesCount);
    const payout = (winData.totalLinePayoutMultiplier || 0) + (winData.totalScatterPayoutMultiplier || 0);
    return {
      steps: [{ grid, lineWins: winData.lineWins || [], scatterWin: winData.scatterWin || null, payout }],
      scatterWin: winData.scatterWin || null,
    };
  },
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/linemechanic.test.mjs`
Expected: PASS, both tests.

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npm test`
Expected: every pre-existing test still passes (this method is additive; `getTargetGrid`/
`evaluateWin`/`resolveSpin` are untouched).

- [ ] **Step 6: Commit**

```bash
git add core/engine/mechanics/LineMechanic.js tests/linemechanic.test.mjs
git commit -m "feat: add LineMechanic.resolveLiveSpin for CoreSlotEngine"
```

---

### Task 7: `CascadeSpinMechanic.resolveLiveSpin`

**Files:**
- Modify: `core/engine/mechanics/CascadeSpinMechanic.js`
- Test: `tests/cascadespinmechanic.test.mjs` (new)

**Interfaces:**
- Consumes: `this.resolveSequence(reelStrips, rowsCount, seed, winEvaluator, maxCascadeSteps)`
  (already exists on this object), which returns `{ cascadeSteps, totalPayoutMultiplier,
  finalGrid, scatterWin }` (per `core/math/CascadeMath.js`'s `resolveCascadeSequence`, documented
  in `docs/ARCHITECTURE.md`). Each `cascadeSteps[i]` already has the shape
  `{ grid, fallOffsets, clusterWins, payout }`.
- Produces: `CascadeSpinMechanic.resolveLiveSpin({ reelStrips, rowsCount, seed, winEvaluator,
  maxCascadeSteps }) → { steps: cascadeSteps, scatterWin }` — a thin adapter, since
  `resolveSequence`'s output already matches the normalized step shape field-for-field.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/cascadespinmechanic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { CascadeSpinMechanic } from '../core/engine/mechanics/CascadeSpinMechanic.js';

test('resolveLiveSpin returns the cascade sequence steps plus the sequence-level scatterWin', () => {
  const reelStrips = [
    ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a'],
  ];
  const noWinEvaluator = () => ({ clusterWins: [], totalPayoutMultiplier: 0, scatterWin: null });

  const result = CascadeSpinMechanic.resolveLiveSpin({
    reelStrips, rowsCount: 3, seed: 1, winEvaluator: noWinEvaluator, maxCascadeSteps: 10,
  });

  assert.ok(Array.isArray(result.steps));
  assert.ok(result.steps.length >= 1);
  assert.ok('grid' in result.steps[0]);
  assert.ok('fallOffsets' in result.steps[0]);
  assert.ok('clusterWins' in result.steps[0]);
  assert.ok('payout' in result.steps[0]);
  assert.equal(result.scatterWin, null);
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/cascadespinmechanic.test.mjs`
Expected: FAIL — `CascadeSpinMechanic.resolveLiveSpin is not a function`.

- [ ] **Step 3: Implement `resolveLiveSpin`**

Add to `core/engine/mechanics/CascadeSpinMechanic.js`, after `resolveSequence`:

```javascript
  // Live-play entry point (core/engine/CoreSlotEngine.js) - a thin adapter, since
  // resolveSequence already returns cascadeSteps in the normalized { grid, fallOffsets, wins,
  // payout } shape CoreSlotEngine expects. scatterWin lives at the sequence level (not per-step)
  // because free-spins triggering is a whole-spin question, not a per-step one.
  resolveLiveSpin({ reelStrips, rowsCount, seed, winEvaluator, maxCascadeSteps }) {
    const sequence = this.resolveSequence(reelStrips, rowsCount, seed, winEvaluator, maxCascadeSteps);
    return { steps: sequence.cascadeSteps, scatterWin: sequence.scatterWin };
  },
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/cascadespinmechanic.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: no regressions (additive method only).

- [ ] **Step 6: Commit**

```bash
git add core/engine/mechanics/CascadeSpinMechanic.js tests/cascadespinmechanic.test.mjs
git commit -m "feat: add CascadeSpinMechanic.resolveLiveSpin for CoreSlotEngine"
```

**Note for Task 5/13's implementer:** `CoreSlotEngine.spin()` must pass `winEvaluator` for a
cascade game, since unlike `LineMechanic` (which reads `config.winEvaluator` internally via
`evaluateWin`), `CascadeSpinMechanic.resolveLiveSpin` takes `winEvaluator` directly as a
parameter. Task 13 (assembling the full engine) must build this the same way
`CascadeEngine._buildWinEvaluatorForSpin` does today (source: `core/CascadeEngine.js:541`) —
wrapping `config.winEvaluator` with the active `freeSpinsMode` only while `inFreeSpins`.

---

### Task 8: `SpinLogRecorder`

**Files:**
- Create: `core/engine/SpinLogRecorder.js`
- Test: `tests/spinlogrecorder.test.mjs`

**Interfaces:**
- Consumes: `createSpinLogEntry`, `applyExpandingWinToSpinLogEntry`, `createCascadeSpinLogEntry`
  from `core/SpinLog.js` (already-existing pure functions, unchanged by this plan).
- Produces: `class SpinLogRecorder` with `.entries` (array), `.maxEntries` (default `20000`,
  matching `SPIN_LOG_MAX_ENTRIES` in both existing engine classes), and `record(entry)` which
  pushes and trims to the cap.

**Before writing this task's implementation**, open `core/SlotEngine.js:737-755`
(`_pushSpinLogEntry`) and `core/CascadeEngine.js:481-507` (`_pushSpinLogEntry`) and confirm the
cap-trimming behavior below matches both exactly (push then trim from the front once over
`maxEntries`) — these line numbers are accurate as of this plan's writing but may drift if earlier
tasks change line counts in those files; search for the method name if the numbers no longer
line up.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/spinlogrecorder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpinLogRecorder } from '../core/engine/SpinLogRecorder.js';

test('record() appends an entry built from a line-pay spin sequence', () => {
  const recorder = new SpinLogRecorder({ betPerLine: 1, linesCount: 10, scatterSymbol: 'scatter' });
  const sequence = [{ grid: [['a']], lineWins: [], scatterWin: null, payout: 0 }];

  recorder.record({ sequence, seed: 42, timestamp: 1000, phase: 'base', chargedBet: 10 });

  assert.equal(recorder.entries.length, 1);
  assert.equal(recorder.entries[0].seed, 42);
});

test('record() trims the oldest entry once maxEntries is exceeded', () => {
  const recorder = new SpinLogRecorder({ betPerLine: 1, linesCount: 1, scatterSymbol: null, maxEntries: 3 });
  const sequence = [{ grid: [['a']], lineWins: [], scatterWin: null, payout: 0 }];

  for (let i = 0; i < 5; i++) {
    recorder.record({ sequence, seed: i, timestamp: i, phase: 'base', chargedBet: 1 });
  }

  assert.equal(recorder.entries.length, 3);
  assert.equal(recorder.entries[0].seed, 2); // entries for seed 0 and 1 were trimmed
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/spinlogrecorder.test.mjs`
Expected: FAIL — cannot find module `core/engine/SpinLogRecorder.js`.

- [ ] **Step 3: Implement `SpinLogRecorder`**

```javascript
// core/engine/SpinLogRecorder.js
// Replaces the duplicated `_pushSpinLogEntry` methods in SlotEngine.js/CascadeEngine.js with one
// component both a line-pay and cascade CoreSlotEngine plug in. Builds entries from
// core/SpinLog.js's existing pure functions - this class only owns the bounded buffer and the
// choice of which SpinLog builder a given sequence shape needs.
import { createSpinLogEntry, applyExpandingWinToSpinLogEntry, createCascadeSpinLogEntry } from '../SpinLog.js';

const DEFAULT_MAX_ENTRIES = 20000;

export class SpinLogRecorder {
  constructor(gameConfig = {}) {
    this.gameConfig = gameConfig;
    this.maxEntries = gameConfig.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.entries = [];
  }

  record({ sequence, seed, timestamp, phase, chargedBet }) {
    const isCascade = sequence.length > 0 && 'clusterWins' in sequence[0];
    const entry = isCascade
      ? this._buildCascadeEntry(sequence, seed, timestamp, phase, chargedBet)
      : this._buildLineEntry(sequence, seed, timestamp, phase, chargedBet);

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    return entry;
  }

  _buildLineEntry(sequence, seed, timestamp, phase, chargedBet) {
    const step = sequence[0];
    const winData = { lineWins: step.lineWins, scatterWin: step.scatterWin };
    const entry = createSpinLogEntry({
      spinIndex: this.entries.length,
      phase,
      betPerLine: this.gameConfig.betPerLine,
      linesCount: this.gameConfig.linesCount,
      chargedBet,
      scatterBetBase: this.gameConfig.betPerLine * this.gameConfig.linesCount,
      winData,
      scatterSymbol: this.gameConfig.scatterSymbol,
      seed,
      timestamp,
    });
    if (step.expandingWin) {
      applyExpandingWinToSpinLogEntry(entry, step.expandingWin);
    }
    return entry;
  }

  _buildCascadeEntry(sequence, seed, timestamp, phase, chargedBet) {
    const scatterWin = sequence.find((s) => s.scatterWin)?.scatterWin ?? null;
    return createCascadeSpinLogEntry({
      spinIndex: this.entries.length,
      phase,
      betAmount: this.gameConfig.betAmount,
      chargedBet,
      cascadeSteps: sequence,
      scatterSymbol: (scatterWin ? scatterWin.symbol : this.gameConfig.scatterSymbol) ?? null,
      scatterWin,
      seed,
      timestamp,
    });
  }
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/spinlogrecorder.test.mjs`
Expected: PASS, both tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: no regressions (new file, no existing import touched).

- [ ] **Step 6: Commit**

```bash
git add core/engine/SpinLogRecorder.js tests/spinlogrecorder.test.mjs
git commit -m "feat: add SpinLogRecorder, replacing duplicated _pushSpinLogEntry"
```

---

## Milestone 3 — Rendering & animation components (extraction, manually verified)

These four tasks pull existing, working canvas code out of `core/SlotEngine.js`/
`core/CascadeEngine.js` into new component files. **There is no automated test harness for
canvas drawing** — this matches today's reality (`docs/superpowers/specs/
2026-07-28-core-modularization-design.md`'s "Testing & risk" section: the engine classes have zero
automated coverage today, verified only by hand in-browser). Each task below is an **extraction**,
not a rewrite: move the named method's body from the given source line range into the new file,
adapt `this.xxx` references to the new method's explicit parameters (the "Interfaces" block in
each task states exactly what those parameters must be), and do not change any drawing logic
while moving it. Verification for these four tasks is "the file parses and exports the right
shape" (`node --check`) plus a full re-verification once Milestone 4 wires everything together and
Task 14 puts a real game on it — do not attempt to visually verify a component in isolation before
then, since nothing renders it standalone.

### Task 9: `SlotRenderer` — line-pay drawing primitives

**Files:**
- Create: `core/rendering/SlotRenderer.js`

**Interfaces:**
- Produces: `class SlotRenderer` with drawing-primitive methods, each taking explicit parameters
  (canvas `ctx`, layout, symbol config, colors) instead of reading `this.xxx` off an engine
  instance — the whole point of extraction is that this class holds no game state itself, only
  drawing logic:
  - `drawCabinet(ctx, layout, config)`
  - `drawPlayfieldBackground(ctx, layout, theme)`
  - `drawLoading(ctx, layout, theme)`
  - `drawReelsBackground(ctx, layout, config)`
  - `drawSymbol(ctx, name, x, y, width, height, spritesheet, symbolsConfig, blurSpeed)`
  - `drawGridBorders(ctx, layout, config)`
  - `drawWinEffects(ctx, winData, layout, config)`
  - `drawTag(ctx, num, x, y, color)`
  - `getNeonColorForLine(lineIdx)`

- [ ] **Step 1: Extract from `core/SlotEngine.js`**

Open `core/SlotEngine.js` and locate these methods (line numbers as of this plan's writing —
re-locate by method name if a prior task shifted them):

| Source method | Approx. lines | Target `SlotRenderer` method |
|---|---|---|
| `renderPlayfieldBackground` | 873–887 | `drawPlayfieldBackground(ctx, layout, theme)` |
| `renderLoading` | 888–903 | `drawLoading(ctx, layout, theme)` |
| `renderCabinet` | 904–929 | `drawCabinet(ctx, layout, config)` |
| `renderReelsBackground` | 930–945 | `drawReelsBackground(ctx, layout, config)` |
| `renderReelsSymbols` | 946–968 | (folded into `drawReelsBackground`'s caller in Task 11 — the reel-scroll-specific symbol placement belongs in `ReelScrollAnimator`, not here; extract the parts of this method that are pure drawing (calls to `drawSymbol`) into this class, leave reel-position math for Task 11) |
| `drawSymbol` | 969–972 | `drawSymbol(ctx, name, x, y, width, height, spritesheet, symbolsConfig, blurSpeed)` |
| `renderGridBorders` | 1040–1062 | `drawGridBorders(ctx, layout, config)` |
| `renderWinEffects` | 1063–1159 | `drawWinEffects(ctx, winData, layout, config)` |
| `drawTag` | 1160–1178 | `drawTag(ctx, num, x, y, color)` |
| `getNeonColorForLine` | 1179–1194 | `getNeonColorForLine(lineIdx)` (pure, copy verbatim) |

For each: copy the method body into a `SlotRenderer` method of the target name, replacing every
`this.foo` reference with the corresponding parameter (e.g. `this.ctx` → the `ctx` parameter,
`this.config.playfield` → the `theme` parameter, `this.spritesheet`/`this.symbolsConfig` →
explicit parameters as listed in the Interfaces block above). `renderExpandingAnimation` (973–1039)
stays out of `SlotRenderer` for this task — it is bookbookbook-specific and gets its own pass in
Task 16 when that game migrates, so `CoreSlotEngine`'s general-purpose renderer isn't carrying a
one-game special case from day one.

- [ ] **Step 2: Write the class shell tying the methods together**

```javascript
// core/rendering/SlotRenderer.js
// Draw-call primitives extracted from SlotEngine.js's render()-and-below (line-pay games) and,
// in a later pass (see CascadeEngine extraction), the cascade-specific ones. Holds no game
// state - every method takes exactly what it needs to draw, nothing implicit off `this`. See
// docs/superpowers/specs/2026-07-28-core-modularization-design.md.
export class SlotRenderer {
  // ... methods extracted in Step 1 above, verbatim in behavior, adapted to explicit parameters.
}
```

- [ ] **Step 3: Verify the file parses**

Run: `node --check core/rendering/SlotRenderer.js`
Expected: no output (valid syntax).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: no regressions (new file, not yet imported anywhere).

- [ ] **Step 5: Commit**

```bash
git add core/rendering/SlotRenderer.js
git commit -m "feat: extract line-pay drawing primitives into SlotRenderer"
```

---

### Task 10: Extend `SlotRenderer` with cascade-specific drawing

**Files:**
- Modify: `core/rendering/SlotRenderer.js`

**Interfaces:**
- Adds to `SlotRenderer`: `drawGridSymbols(ctx, grid, cellOffsets, layout, spritesheet,
  symbolsConfig, bounceState)`, `drawWinLine(ctx, lineIndex, paylines, layout, color)`,
  `drawLineTag(ctx, num, x, y, color)`, `drawClusterWinPopups(ctx, popups, layout)`,
  `drawPlayfieldNoise(ctx, layout, theme)`. Reconciles with Task 9's `drawPlayfieldBackground`/
  `drawCabinet`/`drawLoading`/`drawGridBorders` to be theme-driven for **both** mechanics (today
  these are cascade-only; per the design, they become available to every game) — where
  `CascadeEngine.js`'s version differs from `SlotEngine.js`'s (e.g. `_renderCabinet` vs
  `renderCabinet`), fold the cascade version's extra `theme`-driven behavior into the one method
  from Task 9 rather than keeping two.

- [ ] **Step 1: Extract from `core/CascadeEngine.js`**

Locate these methods (line numbers as of this plan's writing):

| Source method | Approx. lines | Target `SlotRenderer` method |
|---|---|---|
| `_generatePlayfieldNoise` | 845–879 | `drawPlayfieldNoise(ctx, layout, theme)` |
| `_renderPlayfieldBackground` | 880–897 | merge into Task 9's `drawPlayfieldBackground` (add the `noise` handling this version has that `SlotEngine`'s doesn't) |
| `_renderGridSymbols` | 898–943 | `drawGridSymbols(ctx, grid, cellOffsets, layout, spritesheet, symbolsConfig, bounceState)` |
| `_applyLandingBounce` | 944–959 | keep as a private helper called by `drawGridSymbols` |
| `_renderClearGlow` | 960–978 | keep as a private helper called by `drawGridSymbols` |
| `_applyClearTransform` | 979–1019 | keep as a private helper called by `drawGridSymbols` |
| `_renderOutgoingGridSymbols` | 1020–1035 | fold into `drawGridSymbols` (an `outgoingGrid` parameter, drawn the same way as the main grid) |
| `_renderGridBorders` | 1036–1064 | merge into Task 9's `drawGridBorders` (add the `gridLines`-or-`null` theme choice this version has) |
| `_renderClusterWinPopups` | 1072+ | `drawClusterWinPopups(ctx, popups, layout)` |
| `_renderWinLine` | 744–788 | `drawWinLine(ctx, lineIndex, paylines, layout, color)` |
| `_renderLineTag` | 789–806 | `drawLineTag(ctx, num, x, y, color)` |
| `_renderLoading` | 807–817 | merge into Task 9's `drawLoading` (compare bodies; if identical modulo the `theme` parameter already threaded through, no new method needed — just confirm) |
| `_renderCabinet` | 818–844 | merge into Task 9's `drawCabinet` (same theme-parameterization check) |

Same extraction rule as Task 9: copy each method body, replace `this.xxx` with explicit
parameters, do not change drawing logic. Where "merge" is noted, diff the two source bodies
(`SlotEngine.js`'s and `CascadeEngine.js`'s versions of the same concern) and keep the union of
behavior gated by the `theme`/`config` parameter, so a line-pay game passing no special theme
renders exactly as `SlotEngine.js` does today, and a cascade game passing its theme renders
exactly as `CascadeEngine.js` does today.

- [ ] **Step 2: Verify the file parses**

Run: `node --check core/rendering/SlotRenderer.js`
Expected: no output.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: no regressions.

- [ ] **Step 4: Commit**

```bash
git add core/rendering/SlotRenderer.js
git commit -m "feat: extend SlotRenderer with cascade drawing, unify theme handling"
```

---

### Task 11: `ReelScrollAnimator`

**Files:**
- Create: `core/engine/animators/ReelScrollAnimator.js`

**Interfaces:**
- Produces: `class ReelScrollAnimator` implementing `playEntrance(step, ctx, onDone)` and
  `playTransition(prevStep, nextStep, ctx, onDone)` (per Task 5's `SpinAnimator` contract).
  `playTransition` is a no-op that calls `onDone()` immediately — a line-pay spin's step sequence
  always has length 1, so `CoreSlotEngine._playStep` never actually calls it, but the method must
  exist to satisfy the interface every animator implements.

- [ ] **Step 1: Extract from `core/SlotEngine.js`**

Locate `animate` (230–235), `update` (236–470), `easeOutCubic` (471–480), and the reel-position
parts of `renderReelsSymbols` (946–968, the half not already moved to `SlotRenderer.drawSymbol`
calls in Task 9). These implement the physical reel-scroll: spin-up, per-reel staggered stop
(`reelDelay`), landing tween against a precomputed `landStartTime`, blur-while-spinning. Move this
logic into `playEntrance(step, ctx, onDone)`, replacing the existing per-frame
`requestAnimationFrame` loop's job of "keep calling until landed" with an explicit tween loop that
calls `onDone()` once every reel has landed on `step.grid`. Reference `SlotRenderer.drawSymbol`
(Task 9) for the actual per-symbol draw call inside the loop, passed in via a `renderer`
constructor argument.

```javascript
// core/engine/animators/ReelScrollAnimator.js
// Physical reel-scroll entrance (SlotEngine.js's default today): reels spin up, then land in a
// staggered stop, one after another. A line-pay spin's step sequence is always length 1, so
// playTransition is never actually invoked by CoreSlotEngine - it exists only to satisfy the
// SpinAnimator interface every animator implements. See
// docs/superpowers/specs/2026-07-28-core-modularization-design.md.
export class ReelScrollAnimator {
  constructor(renderer, { spinDuration = 2000, reelDelay = 150 } = {}) {
    this.renderer = renderer;
    this.spinDuration = spinDuration;
    this.reelDelay = reelDelay;
  }

  playEntrance(step, ctx, onDone) {
    // Extract SlotEngine.js's animate()/update()/easeOutCubic() (lines 230-480) and the
    // symbol-placement half of renderReelsSymbols (946-968) here, replacing `this.state`-driven
    // control flow with a local tween loop scoped to this one call, and every `this.xxx` engine
    // field this logic reads (reels[], symbolWidth/Height, reelsX/Y) with parameters or fields on
    // this class. Call onDone() once every reel's landing tween has completed against step.grid.
    onDone();
  }

  playTransition(prevStep, nextStep, ctx, onDone) {
    onDone();
  }
}
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check core/engine/animators/ReelScrollAnimator.js`
Expected: no output.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: no regressions (new file, unwired).

- [ ] **Step 4: Commit**

```bash
git add core/engine/animators/ReelScrollAnimator.js
git commit -m "feat: add ReelScrollAnimator skeleton for line-pay spins"
```

**Flag for Task 14's implementer:** the `playEntrance` body above is a stub with the extraction
instructions inline, not the finished extraction — finishing it (pulling the real tween logic out
of `SlotEngine.js:230-480`) is part of Task 14 (Lucky Fruits migration), the first task that
actually needs this animator to draw something and can be manually verified against a running
game. Splitting it this way keeps this task's commit buildable/testable in isolation, per the
Task Right-Sizing principle, without pretending a canvas animation loop can be verified by
`node --check` alone.

- [ ] **Step 5 (deferred to Task 14, tracked here so it isn't lost): finish the extraction**

This step's checkbox belongs to Task 14's session, not this one — listed here only so the
plan's reader knows this task is intentionally incomplete until then.

---

### Task 12: `CascadeDropAnimator`

**Files:**
- Create: `core/engine/animators/CascadeDropAnimator.js`

**Interfaces:**
- Produces: `class CascadeDropAnimator` implementing `playEntrance(step, ctx, onDone)` (the
  initial fill dropping in) and `playTransition(prevStep, nextStep, ctx, onDone)` (a cluster's
  clear animation, then the next step's cells falling in) — both meaningfully used, since a
  cascade sequence is typically multi-step.

- [ ] **Step 1: Extract from `core/CascadeEngine.js`**

Locate `animate` (241–246), `update` (247–332), `_rampSpeed` (333–342), `_columnStartDelay`
(343–351), `_onStepLanded` (352–368), `_beginClusterClear` (369–394),
`_spawnClusterWinPopups` (395–412), `_advanceToNextStep` (413–429), `_spawnClearParticles`
(430–437). This is the largest and most stateful extraction in the plan (staggered per-column
fall-in, per-cluster sequential clearing, cascade step advancement). Move it into
`playEntrance`/`playTransition` following the same rule as Task 11: replace `this.xxx` engine
fields with parameters/instance fields on this class, replace `this.state`-driven control flow
with explicit callback-driven completion (`onDone()` once landed / once a step's clears+falls are
done).

```javascript
// core/engine/animators/CascadeDropAnimator.js
// Cascade drop-in/clear/fall entrance and transition (CascadeEngine.js's default today): the
// initial grid drops in column by column (playEntrance); between cascade steps, a winning
// cluster's cells clear one cluster at a time, then the vacated cells' replacements fall in
// (playTransition). See docs/superpowers/specs/2026-07-28-core-modularization-design.md.
export class CascadeDropAnimator {
  constructor(renderer, particleSystem, { normalClearDurationMs = 760, turboClearDurationMs = 300 } = {}) {
    this.renderer = renderer;
    this.particleSystem = particleSystem;
    this.normalClearDurationMs = normalClearDurationMs;
    this.turboClearDurationMs = turboClearDurationMs;
  }

  playEntrance(step, ctx, onDone) {
    // Extract CascadeEngine.js's animate()/update()/_rampSpeed()/_columnStartDelay()
    // (lines 241-351) here for the "cells fall in" half - the initial-fill case (no clearing,
    // nothing to clear yet). Call onDone() once every column has landed on step.grid.
    onDone();
  }

  playTransition(prevStep, nextStep, ctx, onDone) {
    // Extract _onStepLanded()/_beginClusterClear()/_spawnClusterWinPopups()/
    // _advanceToNextStep()/_spawnClearParticles() (lines 352-437) here: clear prevStep's winning
    // cells (one cluster at a time, via this.particleSystem for the clear-burst effect), then
    // fall nextStep's grid in using the same per-column logic as playEntrance. Call onDone()
    // once nextStep.grid is fully landed.
    onDone();
  }
}
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check core/engine/animators/CascadeDropAnimator.js`
Expected: no output.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: no regressions.

- [ ] **Step 4: Commit**

```bash
git add core/engine/animators/CascadeDropAnimator.js
git commit -m "feat: add CascadeDropAnimator skeleton for cascade spins"
```

**Flag for Task 17's implementer:** same as Task 11 — this task's `playEntrance`/`playTransition`
bodies are stubs with extraction instructions inline; finishing the extraction happens in Task 17
(Candy Frenzy migration), the first point this animator can be manually verified against a
running, rendering game.

---

## Milestone 4 — Wire `CoreSlotEngine` end-to-end

### Task 13: `AudioController` + full assembly

**Files:**
- Create: `core/engine/AudioController.js`
- Modify: `core/engine/CoreSlotEngine.js`

**Interfaces:**
- Produces: `class AudioController` wrapping the existing `core/audio/SlotAudio.js` singleton
  behind the hook interface `onSpinStart()`, `onReelStop(reelIndex)`, `onWin(amount)`,
  `onScatterTrigger()`, `onExpand()` — each just calls the matching `SlotAudio` method
  (`playSpin`, `playReelStop`, `playWin`, `playScatterTrigger`, `playExpand`).
- Modifies `CoreSlotEngine.spin()`/`_finishSpin()`/`enterFreeSpinsIntro()` (from Task 5) to call
  `this.audioController?.onXxx(...)` at the equivalent points `SlotEngine.js`/`CascadeEngine.js`
  call `this.audio.playXxx(...)` directly today, and wires `winEvaluator` construction (the
  free-spins-mode-wrapping logic flagged at the end of Task 7) for cascade mechanics.

- [ ] **Step 1: Write `AudioController`**

```javascript
// core/engine/AudioController.js
// Wraps the SlotAudio singleton behind the hook interface CoreSlotEngine calls generically, so
// the skeleton never imports or calls SlotAudio by name itself (today SlotEngine.js/
// CascadeEngine.js each do, at ad hoc points inside their own methods).
import { audio } from '../audio/SlotAudio.js';

export class AudioController {
  onSpinStart() { audio.playSpin(); }
  onReelStop(reelIndex) { audio.playReelStop(reelIndex); }
  onWin(amount) { audio.playWin(amount); }
  onScatterTrigger() { audio.playScatterTrigger(); }
  onExpand() { audio.playExpand(); }
}
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check core/engine/AudioController.js`
Expected: no output.

- [ ] **Step 3: Wire `winEvaluator` construction into `CoreSlotEngine.spin()`**

In `core/engine/CoreSlotEngine.js`, add a private method (mirrors
`CascadeEngine._buildWinEvaluatorForSpin`, source `core/CascadeEngine.js:541`):

```javascript
  _buildWinEvaluatorForSpin() {
    if (!this.inFreeSpins || !this.freeSpinsMode) {
      return this.config.winEvaluator;
    }
    return this.freeSpinsMode.wrapWinEvaluator(this.config.winEvaluator, this.freeSpinsModeState, this);
  }
```

Then update `spin()`'s call to `resolveLiveSpin` to use it instead of `this.config.winEvaluator`
directly:

```diff
    const result = this.mechanic.resolveLiveSpin({
      reelStrips: this.config.reelStrips,
      rowsCount: this.config.rowsCount,
      seed,
-     rng: undefined, // set by a mechanic-specific adapter if it needs an rng function instead of a seed
      config: this.config,
      linesCount: this.linesCount,
-     winEvaluator: this.config.winEvaluator,
+     winEvaluator: this._buildWinEvaluatorForSpin(),
      maxCascadeSteps: this.config.maxCascadeSteps,
    });
```

(The `rng` line is removed per Task 6's resolution — `LineMechanic.resolveLiveSpin` derives its
own `rng` from `seed` internally, so the skeleton never needs to pass one.)

- [ ] **Step 4: Wire `AudioController` hooks into the lifecycle methods**

```diff
  async spin(seed = Math.floor(Math.random() * 0xFFFFFFFF)) {
    this.lastSpinSeed = seed;
    this._setState('spinning');
+   this.audioController?.onSpinStart();
```

```diff
    if (result.scatterWin && result.scatterWin.triggerFreeSpins) {
      this.config.onScatterTrigger(result.scatterWin.count, this.inFreeSpins);
+     this.audioController?.onScatterTrigger();
    }
```

```diff
    if (this.lastWin > 0) {
      this.config.onWin({ amount: this.lastWin });
+     this.audioController?.onWin(this.lastWin);
      this._setState('showing_wins');
```

- [ ] **Step 5: Write the failing test for `AudioController` wiring**

```javascript
// tests/coreslotengine.test.mjs — append
test('spin() calls audioController.onSpinStart and onWin when configured', async () => {
  const calls = [];
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 5 }], scatterWin: null }) },
    animator: { playEntrance: (s, c, d) => d(), playTransition: (a, b, c, d) => d() },
    renderer: { draw: () => {} },
    audioController: {
      onSpinStart: () => calls.push('spinStart'),
      onWin: (amt) => calls.push(`win:${amt}`),
      onScatterTrigger: () => calls.push('scatter'),
    },
  });

  await engine.spin(1);

  assert.deepEqual(calls, ['spinStart', `win:${engine.lastWin}`]);
});
```

- [ ] **Step 6: Run it, confirm it fails, then passes**

Run: `node --test tests/coreslotengine.test.mjs`
Expected: FAIL first (no `audioController` calls wired), then PASS after Step 4's edits.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including every test from Tasks 5–8.

- [ ] **Step 8: Commit**

```bash
git add core/engine/AudioController.js core/engine/CoreSlotEngine.js tests/coreslotengine.test.mjs
git commit -m "feat: wire AudioController and free-spins-aware winEvaluator into CoreSlotEngine"
```

`CoreSlotEngine` is now feature-complete against the design's skeleton contract. Nothing has been
wired into a real game yet — Milestone 5 does that, one game at a time, which is also where
Tasks 11/12's stubbed animator bodies get finished and first become visually verifiable.

---

## Milestone 5 — Game migrations (incremental, safest to riskiest)

Each task in this milestone follows the same shape: swap the game's engine instantiation from
`SlotEngine`/`CascadeEngine` to `CoreSlotEngine` + components, finish any animator extraction the
game newly exercises, then manually verify. The old engine classes are untouched and still power
every not-yet-migrated game throughout this milestone.

**Manual verification checklist, used by every task below:**
1. `./serve.ps1`, open the game, confirm it loads with no console errors.
2. Click SPIN. Confirm reels/cells animate and land on a grid, balance updates correctly.
3. Trigger a scatter (use the game's forced-outcome debug button if present) — confirm free spins
   intro plays and `enterFreeSpins` starts the bonus correctly.
4. Play through free spins to `game_over`, confirm `exitFreeSpins`/`returnToIdle` returns to
   normal play.
5. Open RUN SIMULATION, run 100,000 spins, record the RTP.
6. Compare that RTP against the same game's pre-migration RTP (run once on `main` before starting
   this task, using the same seed, and record it in this task's own notes) — must match within
   the simulator's own stated tolerance (no engine change affects `simulateSpins`, so this should
   match almost exactly; a divergence means the migration changed win-evaluation behavior, which
   is a bug to find before continuing, not a discrepancy to wave off as "close enough").

### Task 14: Migrate Lucky Fruits (`fruitmachine`)

**Files:**
- Modify: `games/fruitmachine/game.js`

**Interfaces:**
- Consumes: `CoreSlotEngine` (Task 13), `LineMechanic` (Task 6), `ReelScrollAnimator` (Task 11,
  finished in this task), `SlotRenderer` (Task 9), `SpinLogRecorder` (Task 8), `AudioController`
  (Task 13).

- [ ] **Step 1: Finish `ReelScrollAnimator`'s extraction (Task 11's deferred step)**

Complete the real tween/landing logic in `core/engine/animators/ReelScrollAnimator.js`'s
`playEntrance`, per Task 11's inline instructions, now that Lucky Fruits gives it something real
to animate.

- [ ] **Step 2: Swap the engine instantiation**

In `games/fruitmachine/game.js`:

```diff
- import { SlotEngine } from '../../core/SlotEngine.js';
+ import { CoreSlotEngine } from '../../core/engine/CoreSlotEngine.js';
+ import { LineMechanic } from '../../core/engine/mechanics/LineMechanic.js';
+ import { ReelScrollAnimator } from '../../core/engine/animators/ReelScrollAnimator.js';
+ import { SlotRenderer } from '../../core/rendering/SlotRenderer.js';
+ import { SpinLogRecorder } from '../../core/engine/SpinLogRecorder.js';
+ import { AudioController } from '../../core/engine/AudioController.js';
```

Find the `new SlotEngine(canvas, { ... })` call and change it to:

```diff
- const engine = new SlotEngine(canvas, {
+ const renderer = new SlotRenderer();
+ const engine = new CoreSlotEngine(canvas, {
+   mechanic: LineMechanic,
+   animator: new ReelScrollAnimator(renderer),
+   renderer,
+   spinLogRecorder: new SpinLogRecorder({ betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, scatterSymbol: null }),
+   audioController: new AudioController(),
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    paylines: PAYLINES,
    winEvaluator: checkWildLineWins,
    betPerLine: BET_PER_LINE,
    linesCount: LINES_COUNT,
    symbolsConfig,
    spritesheetUrl,
    onStateChange,
    onScatterTrigger,
    onWin,
  });
```

(Keep every existing config field exactly as-is — `reelsCount` through `onWin` — only the
constructor and the four new component fields change. `engine.runSimulation(...)` — used by this
game's RUN SIMULATION button — must also start working unmodified once `CoreSlotEngine` supports
it; if it doesn't yet, that's a gap Task 13 missed and must be fixed there, not patched around
here.)

- [ ] **Step 3: Run the manual verification checklist above**

Record this game's pre- and post-migration RTP (same seed) in this task's PR/commit description.

- [ ] **Step 4: Run the full automated test suite**

Run: `npm test`
Expected: all tests pass (this game's own math/tuning tests, e.g. `tests/fruitmachine-rtp.test.mjs`,
never touch `SlotEngine`/`CoreSlotEngine` directly, so they're unaffected either way — they're the
independent confirmation that `LineMechanic`'s payout math is unchanged).

- [ ] **Step 5: Commit**

```bash
git add games/fruitmachine/game.js core/engine/animators/ReelScrollAnimator.js
git commit -m "refactor: migrate Lucky Fruits to CoreSlotEngine"
```

---

### Task 15: Migrate Bar Fruits

**Files:**
- Modify: `games/barfruits/game.js`

**Interfaces:** Same as Task 14 (`CoreSlotEngine` + `LineMechanic` + `ReelScrollAnimator` +
`SlotRenderer` + `SpinLogRecorder` + `AudioController`), plus Bar Fruits' scatter → free-spins
wiring (`onScatterTrigger`, `engine.enterFreeSpinsIntro()`/`enterFreeSpins(...)`) must keep
working through `CoreSlotEngine`'s free-spins lifecycle (Task 5).

- [ ] **Step 1: Swap the engine instantiation**

Same diff shape as Task 14 Step 2, applied to `games/barfruits/game.js`'s own
`new SlotEngine(canvas, {...})` call and its own `PAYTABLE`/`REEL_STRIPS`/`PAYLINES`/
`BET_PER_LINE`/`LINES_COUNT` names.

- [ ] **Step 2: Run the manual verification checklist**, including free spins (this game has
  them, unlike Lucky Fruits) — steps 3–4 of the checklist are exercised for real here for the
  first time.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including `tests/barfruits.test.mjs`.

- [ ] **Step 4: Commit**

```bash
git add games/barfruits/game.js
git commit -m "refactor: migrate Bar Fruits to CoreSlotEngine"
```

---

### Task 16: Migrate Book of Book Book (expanding symbol)

**Files:**
- Modify: `games/bookbookbook/game.js`
- Modify: `core/rendering/SlotRenderer.js` (add the expanding-symbol drawing deferred from Task 9)
- Modify: `core/engine/CoreSlotEngine.js` (wire `checkExpandingWins`, deferred from Task 5/13)

**Interfaces:**
- Adds to `SlotRenderer`: `drawExpandingAnimation(ctx, expandingSymbol, expandedReelsState,
  expansionProgress, layout, spritesheet, symbolsConfig)` — extracted from
  `SlotEngine.js:973-1039`'s `renderExpandingAnimation`, deferred from Task 9 specifically for
  this task.
- Adds to `CoreSlotEngine`: after a spin's normal win evaluation, if `this.inFreeSpins &&
  this.config.expandingSymbol`, call `LineMechanic.evaluateExpandingWin(...)` and fold its result
  into `lastWin`/the spin log entry — mirrors `SlotEngine.evaluateSpinResult()`'s existing
  handling (source `core/SlotEngine.js:644-736`), which this plan has not yet ported since no
  earlier task's game needed it.

- [ ] **Step 1: Extract `drawExpandingAnimation` into `SlotRenderer`**

Open `core/SlotEngine.js:973-1039` (`renderExpandingAnimation`), copy its body into
`SlotRenderer.drawExpandingAnimation`, adapting `this.xxx` references the same way every prior
extraction task did.

- [ ] **Step 2: Wire expanding-win evaluation into `CoreSlotEngine.spin()`**

In `core/engine/CoreSlotEngine.js`, after the existing scatter-trigger handling in `spin()`:

```diff
    if (result.scatterWin && result.scatterWin.triggerFreeSpins) {
      this.config.onScatterTrigger(result.scatterWin.count, this.inFreeSpins);
      this.audioController?.onScatterTrigger();
    }
+
+   if (this.inFreeSpins && this.config.expandingSymbol && this.mechanic.evaluateExpandingWin) {
+     const expandingResult = this.mechanic.evaluateExpandingWin(
+       this.grid, this.config.expandingSymbol, this.config, this.linesCount,
+     );
+     if (expandingResult.totalPayoutMultiplier > 0) {
+       const betAmount = this.betAmount ?? (this.betPerLine * this.linesCount);
+       this.lastWin += expandingResult.totalPayoutMultiplier * betAmount;
+       this.audioController?.onExpand();
+     }
+   }
```

- [ ] **Step 3: Swap the engine instantiation in `games/bookbookbook/game.js`**

Same diff shape as Task 14 Step 2, plus `expandingSymbol` handling: keep this game's existing
`onScatterTrigger` handler that calls `engine.enterFreeSpinsIntro()` and, once the player is
ready, `engine.enterFreeSpins(spinsCount, expandingSymbol)` — `CoreSlotEngine.enterFreeSpins`
(Task 5) must accept and store `expandingSymbol` the same way `SlotEngine.enterFreeSpins` does
today; if it currently only takes `spinsCount` (as built in Task 5), extend its signature here:

```diff
- enterFreeSpins(spinsCount) {
+ enterFreeSpins(spinsCount, expandingSymbol = null) {
    this.inFreeSpins = true;
    this.freeSpinsRemaining = spinsCount;
    this.freeSpinsTotal = spinsCount;
    this.freeSpinsAccumulatedWin = 0;
+   this.config.expandingSymbol = expandingSymbol;
    if (this.freeSpinsMode) {
      this.freeSpinsModeState = this.freeSpinsMode.createState(this);
    }
    this._setState('spinning');
  }
```

(This is a `core/engine/CoreSlotEngine.js` edit — do it alongside Step 2, both are part of this
task's "wire expanding win support into the skeleton" work.)

- [ ] **Step 4: Run the manual verification checklist**, including confirming the expanding
  symbol visually covers a full reel during free spins and pays out correctly.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including `tests/book-rtp-regression.test.mjs`.

- [ ] **Step 6: Commit**

```bash
git add games/bookbookbook/game.js core/rendering/SlotRenderer.js core/engine/CoreSlotEngine.js
git commit -m "refactor: migrate Book of Book Book, add expanding-symbol support to CoreSlotEngine"
```

Every line-pay game (`fruitmachine`, `barfruits`, `bookbookbook`) is now on `CoreSlotEngine`.
`core/SlotEngine.js` is no longer imported by any game, but stays in the repo until Task 19 —
`core/CascadeEngine.js` still needs it as a design reference for Tasks 17–18's extraction work,
and deleting early would remove that reference mid-migration.

---

### Task 17: Migrate Candy Frenzy (cascade + multiplier-tiles free spins)

**Files:**
- Modify: `games/candyfrenzy/game.js`

**Interfaces:** `CoreSlotEngine` + `CascadeSpinMechanic` (Task 7) + `CascadeDropAnimator`
(Task 12, finished in this task) + `SlotRenderer`'s cascade methods (Task 10) +
`SpinLogRecorder` + `AudioController` + `createMultiplierTilesMode` (`core/engine/
FreeSpinsModes.js`, unchanged, already generalized to work with any mechanic per the design).

- [ ] **Step 1: Finish `CascadeDropAnimator`'s extraction (Task 12's deferred step)**

Complete the real per-column fall-in and per-cluster clear logic in
`core/engine/animators/CascadeDropAnimator.js`'s `playEntrance`/`playTransition`, per Task 12's
inline instructions, now that Candy Frenzy gives it something real to animate.

- [ ] **Step 2: Swap the engine instantiation**

In `games/candyfrenzy/game.js`:

```diff
- import { CascadeEngine } from '../../core/CascadeEngine.js';
+ import { CoreSlotEngine } from '../../core/engine/CoreSlotEngine.js';
+ import { CascadeSpinMechanic } from '../../core/engine/mechanics/CascadeSpinMechanic.js';
+ import { CascadeDropAnimator } from '../../core/engine/animators/CascadeDropAnimator.js';
+ import { SlotRenderer } from '../../core/rendering/SlotRenderer.js';
+ import { SpinLogRecorder } from '../../core/engine/SpinLogRecorder.js';
+ import { AudioController } from '../../core/engine/AudioController.js';
```

```diff
- const engine = new CascadeEngine(canvas, {
+ const renderer = new SlotRenderer();
+ const particleSystem = new (await import('../../core/rendering/ParticleSystem.js')).ParticleSystem();
+ const engine = new CoreSlotEngine(canvas, {
+   mechanic: CascadeSpinMechanic,
+   animator: new CascadeDropAnimator(renderer, particleSystem),
+   renderer,
+   particleSystem,
+   spinLogRecorder: new SpinLogRecorder({ betAmount: BET_AMOUNT, scatterSymbol: 'bonus' }),
+   audioController: new AudioController(),
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    winEvaluator: (grid) => checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3),
    scatterSymbol: 'bonus',
    freeSpinsMode: createMultiplierTilesMode({ badgeStyle: 'background' }),
    playfield: { /* this game's existing theme object, unchanged */ },
    betAmount: BET_AMOUNT,
    symbolsConfig,
    spritesheetUrl,
    onStateChange,
    onScatterTrigger,
    onWin,
  });
```

Use a top-level `import { ParticleSystem } from '../../core/rendering/ParticleSystem.js';` instead
of the dynamic `import(...)` shown above — the dynamic form is only to keep this diff readable
inline; the real edit should be a normal static import alongside the others in Step 1's import
block.

- [ ] **Step 3: Run the manual verification checklist**, including confirming multiplier tiles
  persist correctly across a free-spins round and reset between rounds.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including `tests/clustermath.test.mjs` and `tests/cascadesimulator.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add games/candyfrenzy/game.js core/engine/animators/CascadeDropAnimator.js
git commit -m "refactor: migrate Candy Frenzy to CoreSlotEngine"
```

---

### Task 18: Migrate Mayan Tumble (cascade + line-pay evaluator + payline tags)

**Files:**
- Modify: `games/mayantumble/game.js`
- Modify: `core/rendering/SlotRenderer.js` if `drawWinLine`/`drawLineTag` (Task 10) need any
  adjustment once exercised by a real line-pay-over-cascade evaluator (Task 10's extraction was
  necessarily unverified against a live game, same caveat as every Milestone 3 task)

**Interfaces:** `CoreSlotEngine` + `CascadeSpinMechanic` + `CascadeDropAnimator` (now fully
extracted, from Task 17) + `SlotRenderer`'s `drawWinLine`/`drawLineTag` (Task 10) +
`SpinLogRecorder` + `AudioController` + `createMultiplierTilesMode`.

- [ ] **Step 1: Swap the engine instantiation**

Same diff shape as Task 17 Step 2, using this game's own `checkLineCascadeWins`-style evaluator
(its own win evaluator mapping `SlotMath.js`'s `checkWins` line wins into the cluster-wins shape,
per `docs/ARCHITECTURE.md`'s description of this game) and `paylines: PAYLINES` (this game passes
paylines to the engine, unlike Candy Frenzy, specifically so `drawWinLine` can draw them).

- [ ] **Step 2: Run the manual verification checklist**, including confirming a payline win
  during a cascade draws the correct numbered line across the grid (this game's distinguishing
  feature, per `docs/ARCHITECTURE.md`'s "Payline indicators" section).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including `tests/mayantumble.test.mjs` — this test file specifically
asserts the tuning-worker rebuild is field-for-field identical to the live evaluator (per
`docs/ARCHITECTURE.md`), which is exactly the kind of drift this migration must not introduce.

- [ ] **Step 4: Commit**

```bash
git add games/mayantumble/game.js core/rendering/SlotRenderer.js
git commit -m "refactor: migrate Mayan Tumble to CoreSlotEngine"
```

If this task's manual verification and test suite both pass with no `CoreSlotEngine`/component
changes beyond what Task 17 already needed, the design's central claim — one skeleton, pluggable
components, no per-game special-casing in the skeleton itself — holds for every existing game.

---

## Milestone 6 — Cleanup

### Task 19: Delete the old engines, update docs

**Files:**
- Delete: `core/SlotEngine.js`, `core/CascadeEngine.js`
- Modify: `README.md`, `docs/ARCHITECTURE.md`

**Interfaces:** none (no code depends on the deleted files after Task 18 — verified in Step 1).

- [ ] **Step 1: Confirm nothing still imports the old engines**

Run:
```bash
grep -rn "SlotEngine.js'" games/ core/ tests/ || echo "no matches"
grep -rn "CascadeEngine.js'" games/ core/ tests/ || echo "no matches"
```
Expected: both report "no matches" — every game migrated in Milestone 5, and no `core/` or
`tests/` file imports either class directly.

- [ ] **Step 2: Delete the files**

```bash
git rm core/SlotEngine.js core/CascadeEngine.js
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass — this is the final confirmation that deleting these two files broke
nothing.

- [ ] **Step 4: Update `docs/ARCHITECTURE.md`**

Rewrite the "Layering" section's mermaid diagram and the `core/SlotEngine.js`/
`core/CascadeEngine.js` prose sections to describe `CoreSlotEngine` + its components instead,
following the shape already laid out in `docs/superpowers/specs/
2026-07-28-core-modularization-design.md`. Update every `core/Xxx.js` path reference throughout
the doc to its new location (`core/math/`, `core/rendering/`, `core/audio/`, `core/engine/`).
Per this project's own convention, update the "Docs last synced" footer at the bottom of the file
to today's date and the commit this task produces.

- [ ] **Step 5: Update `README.md`**

Update the "Project layout" section and the `core/` module bullet list to reflect the new
subfolder structure and `CoreSlotEngine`. Update its own "Docs last synced" footer the same way.

- [ ] **Step 6: Commit**

```bash
git add core/SlotEngine.js core/CascadeEngine.js docs/ARCHITECTURE.md README.md
git commit -m "refactor: remove SlotEngine.js/CascadeEngine.js, update docs for CoreSlotEngine"
```

This completes the plan: `core/` is organized into `math/`/`rendering/`/`engine/`/`audio/`, every
game runs on one `CoreSlotEngine` skeleton with pluggable components, and the docs describe the
system that actually exists.

---

## Plan self-review notes

- **Spec coverage:** every section of the design doc has a corresponding task —
  folder reorg (Tasks 1–4), step-sequence normalization (Tasks 6–7), skeleton + components
  (Tasks 5, 8–13), pure/data/model/rendering split (Tasks 9–12 extract rendering out of the
  model), `Mechanic`-as-shared-contract-with-`CoreSimulationEngine` (Global Constraints, enforced
  by every task keeping `mechanicRegistry.js` imports correct and `resolveLiveSpin` stateless),
  migration order (Milestone 5, matches the design doc's ordering exactly), testing/risk (manual
  checklist + RTP comparison in every Milestone 5 task).
- **Known incompleteness, disclosed rather than hidden:** Tasks 11/12's animator bodies are
  intentionally left as extraction instructions rather than finished code, finished in Tasks 14/17
  respectively — canvas animation logic cannot be responsibly hand-authored into this plan without
  having read every line of two ~48KB source files, and doing so risks introducing exactly the
  kind of silent divergence (a dropped field, a changed timing constant) this plan's whole
  point is to avoid. An implementer completing those steps must diff against the real source at
  the given line ranges, not invent new behavior.
- **Type consistency:** `resolveLiveSpin`'s `{ steps, scatterWin }` return shape is used
  identically by `CoreSlotEngine.spin()` (Task 5), `LineMechanic` (Task 6), and
  `CascadeSpinMechanic` (Task 7). `SpinAnimator`'s `playEntrance(step, ctx, onDone)`/
  `playTransition(prevStep, nextStep, ctx, onDone)` signature is identical across Task 5's usage,
  Task 11's `ReelScrollAnimator`, and Task 12's `CascadeDropAnimator`.
