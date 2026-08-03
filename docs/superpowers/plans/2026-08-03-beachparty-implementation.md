# Beach Party Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Beach Party, a new 5×5, 30-line reel game (`LineMechanic` + `ReelScrollAnimator`) with wide 256×128 art, tall stacked surfer symbols, and a free-spins bonus where full stacks become wilds and collecting all four colors at once pays a fixed jackpot.

**Architecture:** Three small, generic core additions (non-square cells, a generalized reel-landing window, a stacked-symbol renderer, a free-spins background swap for line-pay games), then a game built the way every other game here is: `games/beachparty/game.js` (data + engine wiring, structured like lemonpop's), `index.html`/`game.css` (copied from barfruits and adapted), and a custom `winEvaluator` closure that layers Beach Party's bonus rules on top of the shared `checkWins`.

**Tech Stack:** Vanilla JS ES modules, HTML5 Canvas, `node --test` for unit tests. No build step, no new dependencies.

**Design doc:** `games/beachparty/docs/DESIGN.md` — read it first if anything below is ambiguous, it's the source of truth for game-feel decisions (payout tiers, jackpot amount, trigger shape).

## Global Constraints

- No new npm dependencies.
- Every core change must be additive/opt-in via config (default value = previous behavior) — no existing game's rendering, math, or tests may change output. Verify by running that existing game's own test file after each core-touching task.
- Match this codebase's existing conventions exactly: `node:test` + `node:assert/strict` for tests, ES module `import`/`export`, JSDoc-style comments only where they explain *why* (see any existing `core/` file for tone), 2-space indent, single quotes.
- Assets already exist and are already committed — do not regenerate or rename anything under `games/beachparty/assets/` or `assets/beachparty/`.
- Never run `git commit`/`git push` as part of these tasks unless the user asks in that same request (project + user convention).

---

### Task 1: Non-square cell layout support (core)

**Files:**
- Modify: `core/rendering/GridLayout.js`
- Modify: `core/engine/CoreSlotEngine.js:172-199`
- Test: `tests/gridlayout.test.mjs`

**Interfaces:**
- Produces: `computeGridLayout(parentWidth, parentHeight, dpr, reelsCount, rowsCount, marginXFrac = 0.05, marginYFrac = 0.08, cellAspectRatio = 1)` returns `{ cssWidth, cssHeight, canvasWidth, canvasHeight, cellSize, cellWidth, cellHeight, reelsWidth, reelsHeight, reelsX, reelsY }`. `cellSize` is kept as an alias for `cellHeight` (back-compat — nothing else reads `cellWidth`/`cellHeight` yet).
- Consumed by: Task 9's `game.js` via `config.symbolAspectRatio: 2`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/gridlayout.test.mjs` (keep the 3 existing tests unchanged, append these):

```js
test('computeGridLayout with cellAspectRatio 1 (default) behaves exactly as before', () => {
  const withDefault = computeGridLayout(900, 900, 1, 7, 7);
  const withExplicit = computeGridLayout(900, 900, 1, 7, 7, 0.05, 0.08, 1);
  assert.equal(withDefault.cellWidth, withExplicit.cellWidth);
  assert.equal(withDefault.cellWidth, withDefault.cellHeight);
  assert.equal(withDefault.cellWidth, withDefault.cellSize);
});

test('computeGridLayout with cellAspectRatio 2 produces cells twice as wide as tall', () => {
  const layout = computeGridLayout(2000, 1000, 1, 5, 5, 0.05, 0.08, 2);
  assert.ok(Math.abs(layout.cellWidth - layout.cellHeight * 2) < 1e-9);
  assert.ok(Math.abs(layout.reelsWidth - layout.cellWidth * 5) < 1e-9);
  assert.ok(Math.abs(layout.reelsHeight - layout.cellHeight * 5) < 1e-9);
});

test('computeGridLayout with cellAspectRatio 2 still fits inside the available box, centered', () => {
  const layout = computeGridLayout(2000, 1000, 1, 5, 5, 0.05, 0.08, 2);
  const marginX = 2000 * 0.05;
  const marginY = 1000 * 0.08;
  const availW = 2000 - 2 * marginX;
  const availH = 1000 - 2 * marginY;
  assert.ok(layout.reelsWidth <= availW + 1e-6);
  assert.ok(layout.reelsHeight <= availH + 1e-6);
  assert.ok(layout.reelsX >= marginX - 1e-6);
  assert.ok(layout.reelsY >= marginY - 1e-6);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/gridlayout.test.mjs`
Expected: FAIL — `cellWidth`/`cellHeight` are `undefined` (property doesn't exist yet).

- [ ] **Step 3: Implement `cellAspectRatio` in `computeGridLayout`**

Replace the whole function body in `core/rendering/GridLayout.js`:

```js
export function computeGridLayout(parentWidth, parentHeight, dpr, reelsCount, rowsCount, marginXFrac = 0.05, marginYFrac = 0.08, cellAspectRatio = 1) {
  const cssWidth = parentWidth;
  const cssHeight = parentHeight;

  const marginX = cssWidth * marginXFrac;
  const marginY = cssHeight * marginYFrac;
  const availW = cssWidth - (2 * marginX);
  const availH = cssHeight - (2 * marginY);
  const cellHeight = Math.min(availW / (reelsCount * cellAspectRatio), availH / rowsCount);
  const cellWidth = cellHeight * cellAspectRatio;
  const reelsWidth = cellWidth * reelsCount;
  const reelsHeight = cellHeight * rowsCount;

  return {
    cssWidth,
    cssHeight,
    canvasWidth: cssWidth * dpr,
    canvasHeight: cssHeight * dpr,
    cellSize: cellHeight,
    cellWidth,
    cellHeight,
    reelsWidth,
    reelsHeight,
    reelsX: marginX + (availW - reelsWidth) / 2,
    reelsY: marginY + (availH - reelsHeight) / 2,
  };
}
```

Also update the JSDoc `@param`/`@returns` block above it to document `cellAspectRatio` and the two new return fields (one line each, same style as the existing entries).

- [ ] **Step 4: Wire `CoreSlotEngine.resize()` to consume it**

In `core/engine/CoreSlotEngine.js`, change line 175 and lines 185-186:

```js
    const layout = computeGridLayout(parentRect.width, parentRect.height, dpr, this.config.reelsCount, this.config.rowsCount, undefined, undefined, this.config.symbolAspectRatio ?? 1);
```

```js
    this.symbolWidth = layout.cellWidth;
    this.symbolHeight = layout.cellHeight;
```

(`undefined` for `marginXFrac`/`marginYFrac` keeps their defaults — every existing caller passed nothing for those either.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/gridlayout.test.mjs`
Expected: PASS, all 6 tests.

- [ ] **Step 6: Verify no existing game regressed**

Run: `node --test tests/barfruits.test.mjs tests/lemonpop.test.mjs tests/coreslotengine.test.mjs`
Expected: PASS (none of these set `symbolAspectRatio`, so `?? 1` keeps them byte-identical).

- [ ] **Step 7: Commit**

```bash
git add core/rendering/GridLayout.js core/engine/CoreSlotEngine.js tests/gridlayout.test.mjs
git commit -m "feat(core): support non-square reel cells via symbolAspectRatio"
```

---

### Task 2: Generalize `ReelScrollAnimator`'s landed-symbols window to any `rowsCount`

**Files:**
- Modify: `core/engine/animators/ReelScrollAnimator.js:107-118`
- Test: `tests/reelscrollanimator.test.mjs` (new)

**Interfaces:**
- Produces: `buildLandedSymbols(strip, targetColumn, pickRandom)` — exported pure function, returns `[pickRandom(strip), ...targetColumn, pickRandom(strip), pickRandom(strip)]`.
- Consumed by: Task 3's stacked-symbol renderer (reads `reel.symbols`, which must be `rowsCount + 3` long and correctly hold the real landed column at indices `[1, 1+rowsCount)`).

**Why this is a bug, not just a missing feature:** `playEntrance`'s landing block currently hardcodes `reel.symbols = [random, targetGrid[r][0], targetGrid[r][1], targetGrid[r][2], random, random]` — exactly 3 visible rows, regardless of `engine.config.rowsCount`. Every game that has ever used this animator so far happens to have `rowsCount === 3`, so it's never been exercised with a different value. Beach Party's `rowsCount === 5` would silently show only 3 of its 5 landed symbols (and get a wrong-length array `drawReelsSymbols` doesn't expect).

- [ ] **Step 1: Write the failing test**

Create `tests/reelscrollanimator.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLandedSymbols } from '../core/engine/animators/ReelScrollAnimator.js';

test('buildLandedSymbols wraps a 3-row target column with one leading and two trailing filler symbols', () => {
  const calls = [];
  const pickRandom = (strip) => { calls.push(strip); return 'FILLER'; };
  const result = buildLandedSymbols(['a', 'b'], ['x', 'y', 'z'], pickRandom);
  assert.deepEqual(result, ['FILLER', 'x', 'y', 'z', 'FILLER', 'FILLER']);
  assert.equal(calls.length, 3, 'pickRandom is called once per filler slot');
});

test('buildLandedSymbols generalizes to a 5-row target column (Beach Party grid shape)', () => {
  const pickRandom = () => 'FILLER';
  const result = buildLandedSymbols(['a'], ['r1', 'r2', 'r3', 'r4', 'r5'], pickRandom);
  assert.deepEqual(result, ['FILLER', 'r1', 'r2', 'r3', 'r4', 'r5', 'FILLER', 'FILLER']);
  assert.equal(result.length, 5 + 3, 'matches the rowsCount + 3 buffer size _ensureReels allocates');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/reelscrollanimator.test.mjs`
Expected: FAIL — `buildLandedSymbols` is not exported (doesn't exist yet).

- [ ] **Step 3: Extract and export the helper, and use it in `playEntrance`**

In `core/engine/animators/ReelScrollAnimator.js`, add this exported function above the `ReelScrollAnimator` class (after `easeOutCubic`):

```js
// Builds a reel's landed symbol window: one random filler above the real column, the target
// column itself, then two more random fillers below - matching _ensureReels' rowsCount + 3
// buffer size for any rowsCount, not just 3. Exported standalone so it's testable without
// spinning up the animation loop (playEntrance's tick() is driven by Date.now()/rAF, not
// something a unit test wants to drive directly).
export function buildLandedSymbols(strip, targetColumn, pickRandom) {
  return [
    pickRandom(strip),
    ...targetColumn,
    pickRandom(strip),
    pickRandom(strip),
  ];
}
```

Then replace the hardcoded assignment inside `playEntrance`'s `if (now >= reel.landStartTime)` block (currently lines 108-113):

```js
            reel.symbols = buildLandedSymbols(reel.strip, targetGrid[r], (s) => this._getRandomSymbol(s));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/reelscrollanimator.test.mjs`
Expected: PASS, both tests.

- [ ] **Step 5: Verify no existing game regressed**

Run: `node --test tests/coreslotengine.test.mjs tests/barfruits.test.mjs`
Expected: PASS (3-row output is byte-identical to before — same values, same order).

- [ ] **Step 6: Commit**

```bash
git add core/engine/animators/ReelScrollAnimator.js tests/reelscrollanimator.test.mjs
git commit -m "fix(core): generalize ReelScrollAnimator's landed window past 3 rows"
```

---

### Task 3: Stacked-symbol renderer (core)

**Files:**
- Create: `core/rendering/StackedSymbols.js`
- Modify: `core/rendering/SlotRenderer.js:250-263` (`drawReelsSymbols`), `:1030-1032` (its call site in `_drawLine`)
- Test: `tests/stackedsymbols.test.mjs` (new), extend `tests/slotrenderer.test.mjs`

**Interfaces:**
- Produces: `resolveStackedSymbolTileName(gridColumn, row, stackedSymbols)` — pure function, returns the tile name to draw for `gridColumn[row]`.
- Consumed by: Task 9's `game.js` via `config.stackedSymbols` (the `STACKED_SYMBOLS` map from Task 6).

**Design recap (see DESIGN.md §1.3):** a symbol is drawn using its tall-stack variant tile only when the *entire visible column* is that one symbol; anything shorter draws the plain tile everywhere. This is checked against `reel.symbols` (the animator's own settled state) rather than `engine.grid`, and only while the reel is fully at rest (`state === 'idle'`) — this sidesteps needing the two data structures to stay in sync, and reads exactly what's already about to be drawn on screen that frame.

- [ ] **Step 1: Write the failing test for the pure resolver**

Create `tests/stackedsymbols.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStackedSymbolTileName } from '../core/rendering/StackedSymbols.js';

const VARIANTS = {
  surfer_yellow: ['surfer_yellow_1', 'surfer_yellow_2', 'surfer_yellow_3', 'surfer_yellow_4', 'surfer_yellow_5'],
};

test('a full column of one stacked-eligible symbol resolves to its per-row variant tile', () => {
  const column = ['surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 0, VARIANTS), 'surfer_yellow_1');
  assert.equal(resolveStackedSymbolTileName(column, 4, VARIANTS), 'surfer_yellow_5');
});

test('a partial column (not every row the same symbol) resolves to the plain symbol name', () => {
  const column = ['surfer_yellow', 'surfer_yellow', 'ace', 'surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 0, VARIANTS), 'surfer_yellow');
  assert.equal(resolveStackedSymbolTileName(column, 3, VARIANTS), 'surfer_yellow');
});

test('a symbol with no stackedSymbols entry always resolves to itself', () => {
  const column = ['ace', 'ace', 'ace', 'ace', 'ace'];
  assert.equal(resolveStackedSymbolTileName(column, 2, VARIANTS), 'ace');
});

test('a column shorter than the variant set never stacks, even if uniform', () => {
  const column = ['surfer_yellow', 'surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 1, VARIANTS), 'surfer_yellow');
});

test('a column taller than the variant set uses variants for the first N rows and the plain tile after', () => {
  const shortVariants = { x: ['x_1', 'x_2'] };
  const column = ['x', 'x', 'x'];
  assert.equal(resolveStackedSymbolTileName(column, 0, shortVariants), 'x_1');
  assert.equal(resolveStackedSymbolTileName(column, 1, shortVariants), 'x_2');
  assert.equal(resolveStackedSymbolTileName(column, 2, shortVariants), 'x');
});

test('missing stackedSymbols map (games that opt out) never throws and always resolves to the plain symbol', () => {
  const column = ['ace', 'ace'];
  assert.equal(resolveStackedSymbolTileName(column, 0, undefined), 'ace');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/stackedsymbols.test.mjs`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `core/rendering/StackedSymbols.js`**

```js
// Resolves which sprite tile to draw for a grid cell that might be part of a tall "stacked"
// symbol (Beach Party's surfer colors: several consecutive tiles of one plain symbol name, e.g.
// "surfer_yellow" x5 in a column, drawn as one continuous piece of art via per-row variant
// tiles "surfer_yellow_1".."surfer_yellow_5" instead of the same square tile repeated). Generic
// and config-driven - a game that never sets `stackedSymbols` always gets the plain symbol name
// back, so this is a no-op for every existing game.
//
// "Full stack" means the entire visible column is one stacked-eligible symbol - a run shorter
// than the column height (standalone or partially stacked) always renders as the plain tile,
// per the game's own brief: shorter stacks look like ordinary repeated symbols, not partial art.
//
// @param {string[]} gridColumn - one reel's visible symbols, top to bottom.
// @param {number} row - which row in gridColumn to resolve a tile name for.
// @param {Object<string, string[]>|undefined} stackedSymbols - base symbol name -> ordered
//   variant tile names (index 0 = topmost row of the stack).
// @returns {string} the tile name to draw - either a variant tile or the plain symbol name.
export function resolveStackedSymbolTileName(gridColumn, row, stackedSymbols) {
  const symbol = gridColumn[row];
  const variants = stackedSymbols?.[symbol];
  if (!variants || variants.length === 0) return symbol;
  if (gridColumn.length < variants.length) return symbol;
  if (!gridColumn.every(cell => cell === symbol)) return symbol;
  return row < variants.length ? variants[row] : symbol;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/stackedsymbols.test.mjs`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Write the failing wiring test in `tests/slotrenderer.test.mjs`**

Append to `tests/slotrenderer.test.mjs` (add the import at the top alongside the existing ones):

```js
import { SlotRenderer } from '../core/rendering/SlotRenderer.js';
```
(already imported — just add this test below the existing ones, reusing the file's own `layout` const isn't enough since `drawReelsSymbols` needs `symbolWidth`/`symbolHeight`/`reelsX`/`reelsY`, so build a fresh one inline)

```js
function spriteCaptureContext() {
  const draws = [];
  return {
    draws,
    save() {}, restore() {}, translate() {}, scale() {}, drawImage(...args) { draws.push(args); },
  };
}

test('drawReelsSymbols draws a stacked symbol\'s per-row variant tiles when the whole column matches, once the reel is idle', () => {
  const ctx = spriteCaptureContext();
  const asset = { image: {} };
  const symbolsConfig = {
    surfer_yellow: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow_1: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow_2: { x: 0, y: 128, w: 256, h: 128 },
    surfer_yellow_3: { x: 0, y: 256, w: 256, h: 128 },
  };
  const stackedSymbols = { surfer_yellow: ['surfer_yellow_1', 'surfer_yellow_2', 'surfer_yellow_3'] };
  const gridLayout = { reelsX: 0, reelsY: 0, symbolWidth: 256, symbolHeight: 128 };
  const reels = [{
    state: 'idle', offsetY: 0, speed: 0,
    symbols: ['filler', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'filler', 'filler'],
  }];

  new SlotRenderer().drawReelsSymbols(ctx, asset, symbolsConfig, gridLayout, 1, reels, stackedSymbols);

  const sourceYs = ctx.draws.map(args => args[2]); // drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) -> sy at index 2
  assert.deepEqual(sourceYs, [0, 0, 128, 256, 0, 0], 'the 3 visible rows use variant tiles 1/2/3 (sy 0/128/256); the 2 filler rows stay plain (sy 0)');
});

test('drawReelsSymbols does not stack a symbol while the reel is still spinning', () => {
  const ctx = spriteCaptureContext();
  const asset = { image: {} };
  const symbolsConfig = {
    surfer_yellow: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow_1: { x: 0, y: 0, w: 256, h: 128 },
  };
  const stackedSymbols = { surfer_yellow: ['surfer_yellow_1'] };
  const gridLayout = { reelsX: 0, reelsY: 0, symbolWidth: 256, symbolHeight: 128 };
  const reels = [{
    state: 'spinning', offsetY: 40, speed: 10,
    symbols: ['surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow'],
  }];

  new SlotRenderer().drawReelsSymbols(ctx, asset, symbolsConfig, gridLayout, 1, reels, stackedSymbols);

  const sourceYs = ctx.draws.map(args => args[2]);
  assert.ok(sourceYs.every(sy => sy === 0), 'mid-spin, every draw uses the plain tile (sy 0), never a variant');
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test tests/slotrenderer.test.mjs`
Expected: FAIL — `drawReelsSymbols` doesn't accept a `stackedSymbols` argument yet, so every draw still uses the plain tile in the first (idle) test.

- [ ] **Step 7: Wire `resolveStackedSymbolTileName` into `SlotRenderer.drawReelsSymbols`**

Add the import at the top of `core/rendering/SlotRenderer.js` (alongside its other imports):

```js
import { resolveStackedSymbolTileName } from './StackedSymbols.js';
```

Replace `drawReelsSymbols` (currently lines 250-263):

```js
  drawReelsSymbols(ctx, asset, symbolsConfig, layout, reelsCount, reels, stackedSymbols) {
    const { reelsX, reelsY, symbolWidth, symbolHeight } = layout;
    for (let col = 0; col < reelsCount; col++) {
      const reel = reels[col];
      const cx = reelsX + (col * symbolWidth);
      // Only resolve stacked variants once the reel is fully at rest - reel.symbols[1..rowsCount]
      // is exactly what's on screen at that moment (see _ensureReels' rowsCount + 3 buffer
      // layout: 1 leading filler, rowsCount visible, 2 trailing filler). Reading from the
      // animator's own settled state (not engine.grid) means this never needs the two to be
      // kept in sync, and naturally covers the pre-spin idle/attract-mode reels too.
      const visibleColumn = reel.state === 'idle' ? reel.symbols.slice(1, reel.symbols.length - 2) : null;

      for (let s = 0; s < reel.symbols.length; s++) {
        const symbol = reel.symbols[s];
        const cy = reelsY + ((s - 1) * symbolHeight) + reel.offsetY;
        const isSpinningFast = reel.state === 'spinning' && reel.speed > 30;
        const row = s - 1;
        const tileName = (visibleColumn && row >= 0 && row < visibleColumn.length)
          ? resolveStackedSymbolTileName(visibleColumn, row, stackedSymbols)
          : symbol;
        this.drawSymbol(ctx, asset, symbolsConfig, tileName, cx, cy, symbolWidth, symbolHeight, isSpinningFast ? reel.speed : 0);
      }
    }
  }
```

Then update its call site in `_drawLine` (around line 1032):

```js
      this.drawReelsSymbols(ctx, symbols, symbols?.tiles || {}, layout, engine.config.reelsCount, engine.animator.reels, engine.config.stackedSymbols);
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --test tests/slotrenderer.test.mjs tests/stackedsymbols.test.mjs`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 9: Verify no existing game regressed**

Run: `node --test tests/barfruits.test.mjs tests/lemonpop.test.mjs`
Expected: PASS (`engine.config.stackedSymbols` is `undefined` for every other game, so `resolveStackedSymbolTileName` always falls through to the plain symbol - byte-identical behavior).

- [ ] **Step 10: Commit**

```bash
git add core/rendering/StackedSymbols.js core/rendering/SlotRenderer.js tests/stackedsymbols.test.mjs tests/slotrenderer.test.mjs
git commit -m "feat(core): render tall stacked symbols via a config-driven variant map"
```

---

### Task 4: Free-spins viewport background swap for line-pay games (core)

**Files:**
- Modify: `core/rendering/SlotRenderer.js:1005-1010` (`_drawLine`)
- Test: extend `tests/slotrenderer.test.mjs`

**Interfaces:**
- Produces: `selectViewportBackground(config, { inFreeSpins })` — pure exported function.
- Consumed by: Task 9's `game.js` via `config.freeSpinsViewportBackground`.

- [ ] **Step 1: Write the failing test**

Append to `tests/slotrenderer.test.mjs`:

```js
import { selectViewportBackground } from '../core/rendering/SlotRenderer.js';

test('selectViewportBackground uses the base background outside free spins', () => {
  const config = { viewportBackground: 'base.png', freeSpinsViewportBackground: 'bonus.png' };
  assert.equal(selectViewportBackground(config, { inFreeSpins: false }), 'base.png');
});

test('selectViewportBackground prefers freeSpinsViewportBackground while inFreeSpins', () => {
  const config = { viewportBackground: 'base.png', freeSpinsViewportBackground: 'bonus.png' };
  assert.equal(selectViewportBackground(config, { inFreeSpins: true }), 'bonus.png');
});

test('selectViewportBackground falls back to the base background if freeSpinsViewportBackground is unset', () => {
  const config = { viewportBackground: 'base.png' };
  assert.equal(selectViewportBackground(config, { inFreeSpins: true }), 'base.png');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/slotrenderer.test.mjs`
Expected: FAIL — `selectViewportBackground` is not exported.

- [ ] **Step 3: Implement and wire it**

Add this exported function near the top of `core/rendering/SlotRenderer.js` (module scope, not a class method - alongside `drawSpriteSymbol` if that's a standalone function, otherwise just above the `SlotRenderer` class):

```js
// Which viewportBackground image a line-pay game's frame should draw this frame. Generic and
// opt-in: a game that never sets freeSpinsViewportBackground gets exactly the old behavior
// (always config.viewportBackground) whether or not it's in free spins.
export function selectViewportBackground(config, { inFreeSpins = false } = {}) {
  if (inFreeSpins) {
    return config.freeSpinsViewportBackground || config.viewportBackground;
  }
  return config.viewportBackground;
}
```

Replace lines 1007-1009 inside `_drawLine`:

```js
    const viewportBackground = selectViewportBackground(engine.config, { inFreeSpins: engine.inFreeSpins });
```

(Leave `_drawCascade`'s own pop-rush background selection at lines 1055-1057 completely untouched - it's a different, cascade-specific concept and no cascade game needs this new field.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/slotrenderer.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Verify no existing game regressed**

Run: `node --test tests/barfruits.test.mjs`
Expected: PASS (`engine.inFreeSpins` is `false` outside free spins, and barfruits never sets `freeSpinsViewportBackground`, so `viewportBackground` is chosen exactly as before either way).

- [ ] **Step 6: Commit**

```bash
git add core/rendering/SlotRenderer.js tests/slotrenderer.test.mjs
git commit -m "feat(core): swap the viewport background during free spins for line-pay games"
```

---

### Task 5: Add the 5×5 payline template to the docs catalog

**Files:**
- Modify: `docs/PAYLINES-TEMPLATES.md`

- [ ] **Step 1: Append a new section**

Add this section at the end of `docs/PAYLINES-TEMPLATES.md`:

```markdown
## 5x5 playfield
```js
// Payline definitions - 5 reels x 5 rows, 30 fixed lines (Beach Party's grid size - no
// existing template covered it). Rows are 0 (top) to 4 (bottom), center row 2. Straight rows,
// then diagonals, V/inverted-V at three depths, step patterns, U-shapes at three depths,
// zigzags at three row-pairs, and W/M shapes at three spreads, so all 5 rows carry real weight
// instead of the extra rows just being tacked onto a 5x3/5x4 shape.
export const PAYLINES = [
  [0,0,0,0,0], [1,1,1,1,1], [2,2,2,2,2], [3,3,3,3,3], [4,4,4,4,4],       // 1-5: straight rows
  [0,1,2,3,4], [4,3,2,1,0],                                              // 6-7: diagonals
  [0,2,4,2,0], [4,2,0,2,4],                                              // 8-9: deep V / inverted-V
  [1,2,3,2,1], [3,2,1,2,3],                                              // 10-11: shallow V / inverted-V
  [0,1,3,1,0], [4,3,1,3,4],                                              // 12-13: wide V / inverted-V (skip row 2)
  [0,0,2,4,4], [4,4,2,0,0],                                              // 14-15: step down / up
  [0,1,1,1,0], [4,3,3,3,4],                                              // 16-17: shallow U top / bottom
  [1,0,0,0,1], [3,4,4,4,3],                                              // 18-19: U top / bottom (rows 0-1 / 3-4)
  [2,1,0,1,2], [2,3,4,3,2],                                              // 20-21: U top / bottom (rows 0-2 / 2-4)
  [0,1,0,1,0], [4,3,4,3,4],                                              // 22-23: zigzag top / bottom
  [1,2,1,2,1], [3,2,3,2,3],                                              // 24-25: zigzag upper-mid / lower-mid
  [0,2,0,2,0], [4,2,4,2,4],                                              // 26-27: W / M wide (rows 0/2, 2/4)
  [0,4,0,4,0], [4,0,4,0,4],                                              // 28-29: extreme W / M (rows 0/4)
  [1,3,1,3,1],                                                           // 30: W mid (rows 1/3)
];
```
```

(this exact array is what Task 6 uses verbatim.)

- [ ] **Step 2: Commit**

```bash
git add docs/PAYLINES-TEMPLATES.md
git commit -m "docs: add the 5x5 payline template used by Beach Party"
```

---

### Task 6: Beach Party symbol/paytable/reel-strip data

**Files:**
- Create: `games/beachparty/game.js` (this task only writes the data section - top of the file, through `REEL_STRIPS`; later tasks append to the same file)
- Test: `tests/beachparty.test.mjs` (new)

**Interfaces:**
- Produces: `REELS_COUNT`, `ROWS_COUNT`, `REEL_SEEDS`, `REEL_LENGTH`, `BET_PER_LINE`, `BET_PER_LINE_STEP`, `BET_PER_LINE_MAX`, `LINES_COUNT`, `WILD_SYMBOL`, `BONUS_SYMBOL`, `SURFER_COLORS`, `JACKPOT_MULTIPLIER`, `BONUS_REEL_INDEXES`, `BONUS_SPINS_AWARD`, `PAYTABLE`, `PAYLINES`, `STACKED_SYMBOLS`, `FREQUENCY_REELS`, `REEL_STRIPS` — all named exports other tasks (and the test) import.
- Consumes: `generateReel` from `core/math/SlotMath.js` (already used identically by every other game).

- [ ] **Step 1: Write the failing test**

Create `tests/beachparty.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins } from '../core/simulation/SpinSimulator.js';
import {
  REELS_COUNT, ROWS_COUNT, PAYTABLE, PAYLINES, REEL_STRIPS, REEL_LENGTH, BET_PER_LINE, LINES_COUNT,
  STACKED_SYMBOLS, SURFER_COLORS, BONUS_REEL_INDEXES, BONUS_SYMBOL,
} from '../games/beachparty/game.js';

test('beachparty grid shape: 5 reels, 5 rows', () => {
  assert.equal(REELS_COUNT, 5);
  assert.equal(ROWS_COUNT, 5);
});

test('beachparty paylines and reel strips have consistent shapes', () => {
  assert.equal(PAYLINES.length, 30);
  PAYLINES.forEach(path => {
    assert.equal(path.length, REELS_COUNT);
    path.forEach(row => assert.ok(row >= 0 && row < ROWS_COUNT));
  });
  assert.equal(REEL_STRIPS.length, REELS_COUNT);
  REEL_STRIPS.forEach(strip => assert.equal(strip.length, REEL_LENGTH));
});

test('every stacked-symbol variant list has exactly ROWS_COUNT entries, one per surfer color', () => {
  assert.deepEqual(Object.keys(STACKED_SYMBOLS).sort(), [...SURFER_COLORS].sort());
  Object.values(STACKED_SYMBOLS).forEach(variants => assert.equal(variants.length, ROWS_COUNT));
});

test('the bonus symbol only appears on reels 1, 3, 5 (indexes 0, 2, 4)', () => {
  assert.deepEqual(BONUS_REEL_INDEXES, [0, 2, 4]);
  REEL_STRIPS.forEach((strip, reelIndex) => {
    const appears = strip.includes(BONUS_SYMBOL);
    if (BONUS_REEL_INDEXES.includes(reelIndex)) {
      assert.ok(appears, `expected ${BONUS_SYMBOL} on reel ${reelIndex}`);
    } else {
      assert.ok(!appears, `did not expect ${BONUS_SYMBOL} on reel ${reelIndex}`);
    }
  });
});

test('every paytable symbol referenced by STACKED_SYMBOLS or as a plain symbol exists as a real tile name', () => {
  // Sanity check against the actual sheet, so a typo'd symbol name fails loudly here instead of
  // silently drawing nothing in the browser.
  const tilesJson = JSON.parse(
    require('node:fs').readFileSync(
      new URL('../games/beachparty/assets/symbols/symbols.tiles.json', import.meta.url), 'utf8'
    )
  );
  const tileNames = new Set(tilesJson.tiles.map(t => t.name));
  Object.keys(PAYTABLE).forEach(symbol => assert.ok(tileNames.has(symbol), `${symbol} missing from symbols.tiles.json`));
  Object.values(STACKED_SYMBOLS).flat().forEach(name => assert.ok(tileNames.has(name), `${name} missing from symbols.tiles.json`));
});

test('beachparty simulated RTP is a finite, sane number (baseline is untuned - see README)', () => {
  const config = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paytable: PAYTABLE,
    reelStrips: REEL_STRIPS, paylines: PAYLINES,
  };
  const results = simulateSpins(config, 150000, BET_PER_LINE, LINES_COUNT);
  assert.ok(
    Number.isFinite(results.rtpRaw) && results.rtpRaw > 0 && results.rtpRaw < 5,
    `RTP ${results.rtp} is not a sane value - PAYTABLE/FREQUENCY_REELn wiring may be broken`
  );
});
```

Note: this test deliberately does not import `winEvaluator` — `simulateSpins` here uses the default `checkWins` since `config.winEvaluator` is omitted, which is exactly what a base-game-only sanity check needs. Task 7 adds a dedicated test file for the custom evaluator's own logic.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/beachparty.test.mjs`
Expected: FAIL — `games/beachparty/game.js` doesn't exist yet.

- [ ] **Step 3: Write `games/beachparty/game.js` (data section only)**

Create `games/beachparty/game.js` with this content:

```js
// Beach Party — 5x5, 30-line reel game. Wide 256x128 tile art (vs. every other game's square
// tiles) and tall multi-row "stacked" surfer symbols are new to this game; see
// games/beachparty/docs/DESIGN.md for the full design.
import { generateReel } from '../../core/math/SlotMath.js';

// Grid/reel parameters - single source of truth for the live game, RUN SIMULATION, and the
// frequency tuner (same convention as every other game here - see barfruits' own game.js).
export const REELS_COUNT = 5;
export const ROWS_COUNT = 5;
export const REEL_SEEDS = [3001, 3003, 3007, 3011, 3013];
export const REEL_LENGTH = 400;
export const BET_PER_LINE = 0.05;
export const BET_PER_LINE_STEP = 0.05;
export const BET_PER_LINE_MAX = 5;
export const LINES_COUNT = 30;

export const WILD_SYMBOL = 'wild';
export const BONUS_SYMBOL = 'bonus';
// Blue is the highest-paying surfer (see PAYTABLE below) - the jackpot itself pays a flat
// JACKPOT_MULTIPLIER rather than a specific symbol's own line payout, so there's no separate
// "jackpot symbol" constant to track here beyond that ordering.
export const SURFER_COLORS = ['surfer_yellow', 'surfer_pink', 'surfer_green', 'surfer_blue'];
export const JACKPOT_MULTIPLIER = 250;
// Reels 1, 3, 5 in human terms - the only reels the bonus symbol can land on.
export const BONUS_REEL_INDEXES = [0, 2, 4];
export const BONUS_SPINS_AWARD = 8;

// New 5x5 template - see docs/PAYLINES-TEMPLATES.md's "5x5 playfield" section for the shape
// rationale (straight rows, diagonals, V/inverted-V at 3 depths, steps, U-shapes at 3 depths,
// zigzags at 3 row-pairs, W/M at 3 spreads).
export const PAYLINES = [
  [0,0,0,0,0], [1,1,1,1,1], [2,2,2,2,2], [3,3,3,3,3], [4,4,4,4,4],
  [0,1,2,3,4], [4,3,2,1,0],
  [0,2,4,2,0], [4,2,0,2,4],
  [1,2,3,2,1], [3,2,1,2,3],
  [0,1,3,1,0], [4,3,1,3,4],
  [0,0,2,4,4], [4,4,2,0,0],
  [0,1,1,1,0], [4,3,3,3,4],
  [1,0,0,0,1], [3,4,4,4,3],
  [2,1,0,1,2], [2,3,4,3,2],
  [0,1,0,1,0], [4,3,4,3,4],
  [1,2,1,2,1], [3,2,3,2,3],
  [0,2,0,2,0], [4,2,4,2,4],
  [0,4,0,4,0], [4,0,4,0,4],
  [1,3,1,3,1],
];

// Paytable. Seed payout values, to be tuned for real RTP (~96% target) via the TUNE FREQUENCIES
// panel once reels exist - not hand-computed (same workflow every other game here uses).
// payout[i] is the payout for (i+1) matching symbols, left-to-right from reel 1 (indexes 0/1
// unused - nothing pays on 1 or 2 of a kind in this paytable).
export const PAYTABLE = {
  wild:          { type: 'wild', friendlyName: 'Wild Surfer', wild: true, payout: [0, 0, 25, 100, 400] },
  surfer_blue:   { type: 'premium', friendlyName: 'Blue Surfer', payout: [0, 0, 20, 60, 250] },
  surfer_green:  { type: 'premium', friendlyName: 'Green Surfer', payout: [0, 0, 15, 45, 180] },
  surfer_pink:   { type: 'premium', friendlyName: 'Pink Surfer', payout: [0, 0, 10, 30, 120] },
  surfer_yellow: { type: 'premium', friendlyName: 'Yellow Surfer', payout: [0, 0, 8, 25, 100] },
  ace:           { type: 'regular', friendlyName: 'Ace', payout: [0, 0, 6, 20, 60] },
  king:          { type: 'regular', friendlyName: 'King', payout: [0, 0, 5, 16, 50] },
  queen:         { type: 'regular', friendlyName: 'Queen', payout: [0, 0, 4, 14, 40] },
  jack:          { type: 'regular', friendlyName: 'Jack', payout: [0, 0, 4, 12, 35] },
  ten:           { type: 'regular', friendlyName: 'Ten', payout: [0, 0, 3, 10, 30] },
  // Trigger-only: reels 1/3/5, no direct line payout. `type`/`paymode` mirror barfruits' `star`
  // so PaytableRenderer's existing scatter-style rendering picks it up correctly, and
  // `triggerFreeSpins: true` gives it generateReel's default minGap spacing (3) even though the
  // actual trigger check is custom (see evaluateBeachPartyWin in the win-evaluator section below)
  // rather than checkWins' built-in "anywhere on the grid" scatter path.
  bonus:         { type: 'scatter', paymode: 'any', friendlyName: 'Beach Bonus', triggerFreeSpins: true },
};

// Rendering-only: each surfer color's 5-tall stack variant tiles, top row to bottom row. Never
// appears as its own paytable entry - a stacked run still pays as N-of-a-kind on the base
// symbol name, identical to an unstacked run (see core/rendering/StackedSymbols.js).
export const STACKED_SYMBOLS = {
  surfer_yellow: ['surfer_yellow_1', 'surfer_yellow_2', 'surfer_yellow_3', 'surfer_yellow_4', 'surfer_yellow_5'],
  surfer_pink:   ['surfer_pink_1', 'surfer_pink_2', 'surfer_pink_3', 'surfer_pink_4', 'surfer_pink_5'],
  surfer_green:  ['surfer_green_1', 'surfer_green_2', 'surfer_green_3', 'surfer_green_4', 'surfer_green_5'],
  surfer_blue:   ['surfer_blue_1', 'surfer_blue_2', 'surfer_blue_3', 'surfer_blue_4', 'surfer_blue_5'],
};

const FREQUENCIES = {
  defaults: { minGap: 1, maxStack: 1, minStack: 1 },
  symbols: {
    wild:          { frequency: 0.025, minGap: 4 },
    surfer_blue:   { frequency: 0.035, minStack: 2, maxStack: 5, stackChance: 0.45 },
    surfer_green:  { frequency: 0.045, minStack: 2, maxStack: 5, stackChance: 0.45 },
    surfer_pink:   { frequency: 0.060, minStack: 2, maxStack: 5, stackChance: 0.45 },
    surfer_yellow: { frequency: 0.075, minStack: 2, maxStack: 5, stackChance: 0.45 },
    ace:           { frequency: 0.110 },
    king:          { frequency: 0.130 },
    queen:         { frequency: 0.150 },
    jack:          { frequency: 0.170 },
    ten:           { frequency: 0.190 },
    bonus:         { frequency: 0.040 },
  },
};

// One frequency table per reel, bonus zeroed out on reels 2 and 4 (indexes 1 and 3) - it only
// ever lands on reels 1, 3, 5 (indexes 0, 2, 4).
export const FREQUENCY_REELS = REEL_SEEDS.map((_, reelIndex) => {
  const table = structuredClone(FREQUENCIES);
  if (!BONUS_REEL_INDEXES.includes(reelIndex)) table.symbols.bonus.frequency = 0;
  return table;
});

export const REEL_STRIPS = FREQUENCY_REELS.map((table, index) => generateReel(table, REEL_LENGTH, REEL_SEEDS[index], [], 3, PAYTABLE));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/beachparty.test.mjs`
Expected: PASS, all 6 tests. (If the RTP sanity test fails wildly out of range, double check the seed payout values above were copied exactly - this test is only a wiring smoke check, not a tuning target.)

- [ ] **Step 5: Commit**

```bash
git add games/beachparty/game.js tests/beachparty.test.mjs
git commit -m "feat(beachparty): symbol roster, paytable, paylines, and reel strips"
```

---

### Task 7: Custom win evaluator — bonus trigger, stacked wilds, mini jackpot

**Files:**
- Modify: `games/beachparty/game.js` (append below `REEL_STRIPS`)
- Test: `tests/beachpartywinevaluator.test.mjs` (new)

**Interfaces:**
- Consumes: `checkWins` from `core/math/SlotMath.js`; `SURFER_COLORS`, `BONUS_SYMBOL`, `BONUS_REEL_INDEXES`, `JACKPOT_MULTIPLIER`, `WILD_SYMBOL` from Task 6.
- Produces: `fullyStackedColor(grid, col)`, `detectBonusTrigger(grid)`, `detectJackpot(grid)`, `evaluateBeachPartyWin(grid, paytable, paylines, linesCount, wildSymbol, scatterSymbol, { inFreeSpins })`, `winEvaluator` (the closure the live engine actually uses — reads the module's own `engine` binding for `inFreeSpins`, declared in Task 9).

**Why `inFreeSpins` is a parameter, not read from `engine` directly:** `evaluateBeachPartyWin` needs to be callable from a plain unit test with no `CoreSlotEngine` involved at all. `winEvaluator` (used by the live engine) is a thin wrapper that supplies `inFreeSpins` from `engine.inFreeSpins`; everything else is the pure, fully-tested function.

**Known scope limitation (document, don't fix here):** `SpinSimulator`'s batch path (`LineMechanic.resolveSpin`) never tells a `winEvaluator` whether a given simulated spin is a free spin — that plumbing (`FreeSpinsModes`) only exists for `CascadeSpinMechanic` today, not `LineMechanic`. Building it is a separate, much larger feature and out of scope here (YAGNI - not requested). Practical effect: RUN SIMULATION/TUNE FREQUENCIES for Beach Party measures **base-game economics only** (the stacked-wild/jackpot bonus math never fires in simulation, only in live play) — same "first pass, not RTP-tuned for the bonus round yet" situation barfruits documents for its whole game. Note this in the file comment where `winEvaluator` is defined.

- [ ] **Step 1: Write the failing tests**

Create `tests/beachpartywinevaluator.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fullyStackedColor, detectBonusTrigger, detectJackpot, evaluateBeachPartyWin,
  PAYTABLE, PAYLINES, WILD_SYMBOL, JACKPOT_MULTIPLIER,
} from '../games/beachparty/game.js';

function plainGrid() {
  // 5 reels x 5 rows, no surfers/wild/bonus anywhere - just cards.
  return [
    ['ten', 'jack', 'queen', 'king', 'ace'],
    ['ten', 'jack', 'queen', 'king', 'ace'],
    ['ten', 'jack', 'queen', 'king', 'ace'],
    ['ten', 'jack', 'queen', 'king', 'ace'],
    ['ten', 'jack', 'queen', 'king', 'ace'],
  ];
}

test('fullyStackedColor returns the color when a whole column is one surfer color', () => {
  const grid = plainGrid();
  grid[0] = ['surfer_blue', 'surfer_blue', 'surfer_blue', 'surfer_blue', 'surfer_blue'];
  assert.equal(fullyStackedColor(grid, 0), 'surfer_blue');
});

test('fullyStackedColor returns null for a partial column or a non-surfer symbol', () => {
  const grid = plainGrid();
  grid[0] = ['surfer_blue', 'surfer_blue', 'ace', 'surfer_blue', 'surfer_blue'];
  assert.equal(fullyStackedColor(grid, 0), null);
  assert.equal(fullyStackedColor(grid, 1), null, 'reel 1 is all cards, not a surfer color');
});

test('detectBonusTrigger reports triggerFreeSpins only when reels 1, 3, and 5 all show bonus', () => {
  const grid = plainGrid();
  grid[0][2] = 'bonus';
  grid[2][0] = 'bonus';
  grid[4][4] = 'bonus';
  const trigger = detectBonusTrigger(grid);
  assert.equal(trigger.count, 3);
  assert.equal(trigger.triggerFreeSpins, true);
  assert.equal(trigger.winningPositions.length, 3);
});

test('detectBonusTrigger does not trigger with only 2 of the 3 required reels', () => {
  const grid = plainGrid();
  grid[0][0] = 'bonus';
  grid[2][0] = 'bonus';
  const trigger = detectBonusTrigger(grid);
  assert.equal(trigger.count, 2);
  assert.equal(trigger.triggerFreeSpins, false);
});

test('detectJackpot is true only when all 4 surfer colors are fully stacked at once', () => {
  const grid = plainGrid();
  grid[0] = Array(5).fill('surfer_blue');
  grid[1] = Array(5).fill('surfer_green');
  grid[2] = Array(5).fill('surfer_pink');
  grid[3] = Array(5).fill('surfer_yellow');
  assert.equal(detectJackpot(grid), true, 'all 4 colors present across reels 0-3');

  const missingOne = plainGrid();
  missingOne[0] = Array(5).fill('surfer_blue');
  missingOne[1] = Array(5).fill('surfer_green');
  missingOne[2] = Array(5).fill('surfer_pink');
  assert.equal(detectJackpot(missingOne), false, 'only 3 of 4 colors present');
});

test('evaluateBeachPartyWin does not substitute stacked reels as wild in the base game', () => {
  const grid = plainGrid();
  grid[0] = Array(5).fill('surfer_blue');
  grid[1] = Array(5).fill('surfer_blue');
  const result = evaluateBeachPartyWin(grid, PAYTABLE, PAYLINES, PAYLINES.length, WILD_SYMBOL, null, { inFreeSpins: false });
  // Row 0 payline ([0,0,0,0,0]) sees surfer_blue, surfer_blue, ten, ten, ten - only a 2-match
  // (no payout defined for 2-of-a-kind), so this line should NOT pay via wild substitution.
  const rowZeroWin = result.lineWins.find(w => w.lineIndex === 0);
  assert.equal(rowZeroWin, undefined, 'without free-spins wild substitution, this line does not complete a paying run');
});

test('evaluateBeachPartyWin substitutes a fully-stacked reel as wild only while inFreeSpins', () => {
  const grid = plainGrid();
  // Every reel's row 0 is surfer_blue, but only reels 0 and 1 are FULLY stacked (all 5 rows);
  // reels 2-4 keep their card rows on rows 1-4, so only reels 0/1 qualify as full stacks.
  for (let col = 0; col < 5; col++) grid[col][0] = 'surfer_blue';
  grid[0] = Array(5).fill('surfer_blue');
  grid[1] = Array(5).fill('surfer_blue');

  const result = evaluateBeachPartyWin(grid, PAYTABLE, PAYLINES, PAYLINES.length, WILD_SYMBOL, null, { inFreeSpins: true });
  const rowZeroWin = result.lineWins.find(w => w.lineIndex === 0);
  assert.ok(rowZeroWin, 'reels 0 and 1 count as wild, extending the surfer_blue run on row 0 to at least 3');
  assert.equal(rowZeroWin.symbol, 'surfer_blue');
  assert.ok(rowZeroWin.count >= 3);
});

test('evaluateBeachPartyWin pays the jackpot multiplier via scatterWin only while inFreeSpins and all 4 colors are stacked', () => {
  const grid = plainGrid();
  grid[0] = Array(5).fill('surfer_blue');
  grid[1] = Array(5).fill('surfer_green');
  grid[2] = Array(5).fill('surfer_pink');
  grid[3] = Array(5).fill('surfer_yellow');

  const inBonus = evaluateBeachPartyWin(grid, PAYTABLE, PAYLINES, PAYLINES.length, WILD_SYMBOL, null, { inFreeSpins: true });
  assert.equal(inBonus.scatterWin.jackpot, true);
  assert.equal(inBonus.scatterWin.payout, JACKPOT_MULTIPLIER);

  const inBase = evaluateBeachPartyWin(grid, PAYTABLE, PAYLINES, PAYLINES.length, WILD_SYMBOL, null, { inFreeSpins: false });
  assert.equal(inBase.scatterWin, null, 'the jackpot never fires in the base game, only during Beach Bonus');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/beachpartywinevaluator.test.mjs`
Expected: FAIL — none of `fullyStackedColor`/`detectBonusTrigger`/`detectJackpot`/`evaluateBeachPartyWin` are exported yet.

- [ ] **Step 3: Append the evaluator to `games/beachparty/game.js`**

Add this below `export const REEL_STRIPS = ...` (and add `checkWins` to the existing `SlotMath.js` import at the top of the file):

```js
import { generateReel, checkWins } from '../../core/math/SlotMath.js';
```

```js
// Returns the surfer color fully covering this reel's column (all ROWS_COUNT rows the same
// surfer symbol), or null if the column isn't a full stack of one surfer color.
export function fullyStackedColor(grid, col) {
  const column = grid[col];
  const first = column[0];
  if (!SURFER_COLORS.includes(first)) return null;
  return column.every(cell => cell === first) ? first : null;
}

// Custom, reel-restricted trigger check: `bonus` must land on reels 1, 3, and 5 (not merely
// "anywhere on the grid", which is what checkWins' built-in scatterSymbol path assumes) - see
// DESIGN.md §5. Shaped exactly like checkWins' own scatterWin object so it flows through
// CoreSlotEngine's existing onScatterTrigger unchanged.
export function detectBonusTrigger(grid) {
  const coveredReels = BONUS_REEL_INDEXES.filter(col => grid[col].includes(BONUS_SYMBOL));
  const winningPositions = coveredReels.flatMap(col => grid[col]
    .map((cell, row) => (cell === BONUS_SYMBOL ? [col, row] : null))
    .filter(Boolean));
  return {
    symbol: BONUS_SYMBOL,
    count: coveredReels.length,
    payout: 0,
    winningPositions,
    triggerFreeSpins: coveredReels.length === BONUS_REEL_INDEXES.length,
  };
}

// "Reef Royale" mini jackpot: true when full 5-tall stacks of all 4 distinct surfer colors are
// on the board at once (needs >= 4 of the 5 reels fully stacked, one per color).
export function detectJackpot(grid) {
  const stackedColors = new Set();
  for (let col = 0; col < grid.length; col++) {
    const color = fullyStackedColor(grid, col);
    if (color) stackedColors.add(color);
  }
  return SURFER_COLORS.every(color => stackedColors.has(color));
}

// Wraps checkWins with two Beach-Bonus-only rules layered on top - both no-ops outside free
// spins, so the base game is exactly checkWins' own line-pay math:
//   1. Stacked wilds: a reel that's a full 5-tall stack of one surfer color counts as wild for
//      line-matching (the grid is copied for this - engine.grid, used for rendering, is
//      untouched, so the surfer art still displays instead of a wild icon).
//   2. Mini jackpot: collecting a full stack of all 4 colors at once pays JACKPOT_MULTIPLIER x
//      total bet, via scatterWin.payout (which LineMechanic already scales by totalBet, unlike
//      lineWins which scale by betPerLine) - on top of the (already large) wild-substituted
//      line win from rule 1, not instead of it.
//
// NOTE: SpinSimulator's batch path has no concept of "is this simulated spin a free spin" for
// LineMechanic (unlike CascadeSpinMechanic's FreeSpinsModes) - so `inFreeSpins` only ever comes
// from live play. RUN SIMULATION/TUNE FREQUENCIES therefore measures base-game economics only;
// building the missing plumbing is a separate feature, intentionally out of scope here.
export function evaluateBeachPartyWin(grid, paytable, paylines, linesCount, wildSymbol, scatterSymbol, { inFreeSpins = false } = {}) {
  const evalGrid = inFreeSpins
    ? grid.map((column, col) => (fullyStackedColor(grid, col) ? column.map(() => wildSymbol) : column))
    : grid;
  const winData = checkWins(evalGrid, paytable, paylines, linesCount, wildSymbol, scatterSymbol);

  const bonusTrigger = detectBonusTrigger(grid);
  const jackpotHit = inFreeSpins && detectJackpot(grid);
  const scatterWin = (bonusTrigger.count > 0 || jackpotHit)
    ? { ...bonusTrigger, payout: jackpotHit ? JACKPOT_MULTIPLIER : 0, jackpot: jackpotHit }
    : null;

  return { ...winData, scatterWin };
}

// The live engine's own winEvaluator - a thin wrapper supplying inFreeSpins from the module's
// own `engine` binding (declared and assigned in initGame(), below). Not used by tests directly
// (they call evaluateBeachPartyWin, which takes inFreeSpins as a plain argument instead).
export const winEvaluator = (grid, paytable, paylines, linesCount, wildSymbol, scatterSymbol) =>
  evaluateBeachPartyWin(grid, paytable, paylines, linesCount, wildSymbol, scatterSymbol, { inFreeSpins: engine?.inFreeSpins === true });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/beachpartywinevaluator.test.mjs`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Run the full existing test suite once for this file group**

Run: `node --test tests/beachparty.test.mjs tests/beachpartywinevaluator.test.mjs`
Expected: PASS (Task 6's test file still passes - `winEvaluator` references `engine`, which is `undefined` at module scope until Task 9 declares it; that's fine, `winEvaluator` is never called by Task 6's test).

- [ ] **Step 6: Commit**

```bash
git add games/beachparty/game.js tests/beachpartywinevaluator.test.mjs
git commit -m "feat(beachparty): custom win evaluator for the reel-restricted bonus trigger, stacked wilds, and mini jackpot"
```

---

### Task 8: `index.html` + `game.css` scaffold

**Files:**
- Create: `games/beachparty/index.html` (start from `games/barfruits/index.html`)
- Create: `games/beachparty/game.css` (start from `games/barfruits/game.css`)

No unit test for this task (DOM/visual) - it's verified in Task 11 (browser smoke check).

- [ ] **Step 1: Copy the barfruits scaffold**

```bash
cp games/barfruits/index.html games/beachparty/index.html
cp games/barfruits/game.css games/beachparty/game.css
```

- [ ] **Step 2: Edit `games/beachparty/index.html`**

Read the copied file and apply these changes (keep every other element/ID exactly as barfruits has it - `game.js` in Task 9-10 wires up the same IDs barfruits uses: `game-canvas`, `btn-spin`, `btn-auto`, `btn-turbo`, `btn-mute`, `btn-paytable`, `btn-paytable-ok`, `display-balance`, `bet-value`/`bet-minus`/`bet-plus`, `display-total-bet`, `lines-value`/`lines-minus`/`lines-plus`, `game-ticker`, `btn-sim`/`btn-tune`/`btn-spinlog`, `sim-stats`/`sim-rtp`/`sim-total-spins`/`sim-max-win`/`sim-free-spins`, `modal-paytable`, `paytable-grid-content`, `paylines-preview`, `modal-fs-trigger`/`modal-fs-summary`, `btn-start-fs`/`btn-close-fs-summary`, `fs-award-amount`, `fs-panel`/`fs-counter`/`fs-total-win`, `cheat-scatter`/`cheat-bigwin`, `.debug-shortcuts`):

1. `<title>` → `Beach Party`
2. The game logo/header text (wherever barfruits shows "Bar Fruits" or similar) → `Beach Party`
3. `<script type="module" src="./game.js">` stays pointing at `./game.js` (already correct after the copy)
4. The free-spins trigger modal's copy (wherever it says something like "SCATTER TRIGGER!" / free-spins explanation text) → rename to reference "Beach Bonus" (e.g. "BEACH BONUS TRIGGERED!")
5. The `fs-panel` counter label → "BEACH BONUS" instead of "FREE SPINS" (cosmetic text only, IDs unchanged)
6. Relabel `cheat-scatter`'s button text (if it says "Scatter") to "Force Bonus Trigger", and `cheat-bigwin`'s to "Force Big Win" if not already

- [ ] **Step 3: Edit `games/beachparty/game.css`**

Read the copied file and adjust only cosmetic theme values, keeping every class/ID selector name unchanged so Task 9-10's `game.js` DOM wiring keeps working:
1. Any barfruits-specific accent color values → a beach/sun palette (e.g. warm sand/turquoise tones) - pick values that read clearly against both `beach_lifeguard_hut_2.png` and `boards_on_the_beach.png` (both already committed under `games/beachparty/assets/backgrounds/`, open them to check contrast before picking exact hex values)
2. Leave layout, sizing, and animation rules untouched - the canvas now renders 256x128 (2:1) cells instead of square ones, which Task 1's `symbolAspectRatio` config handles entirely inside the canvas; no CSS layout change is needed for that

- [ ] **Step 4: Commit**

```bash
git add games/beachparty/index.html games/beachparty/game.css
git commit -m "feat(beachparty): HTML/CSS scaffold, adapted from barfruits"
```

---

### Task 9: `initGame()` — engine construction and core wiring

**Files:**
- Modify: `games/beachparty/game.js` (append `initGame` and its supporting DOM-ref/module-level code)

**Interfaces:**
- Consumes: everything from Tasks 6-7 (`REELS_COUNT`, `ROWS_COUNT`, `PAYTABLE`, `PAYLINES`, `REEL_STRIPS`, `STACKED_SYMBOLS`, `WILD_SYMBOL`, `winEvaluator`, `FREQUENCY_REELS`, `BET_PER_LINE*`, `LINES_COUNT`), and the DOM IDs Task 8 established.
- Consumes core APIs: `CoreSlotEngine`, `LineMechanic`, `ReelScrollAnimator`, `SlotRenderer`, `SpinLogRecorder`, `AudioController`, `bindCommonSlotControls`/`observeSlotViewport`/`updateSlotStateUI` (`core/ui/SlotGameUI.js`), `ensureDeveloperPanels` (`core/ui/DeveloperPanels.js`), `openSpinLogPanel`, `runSimulationAndRender`, `openTuningPanel`.
- Produces: module-level `let engine` (read by Task 7's `winEvaluator`), `initGame()` (called on `window load`), DOM refs used by Task 10.

- [ ] **Step 1: Append imports and module-level declarations**

At the very top of `games/beachparty/game.js`, alongside the existing `SlotMath.js` import, add:

```js
import { CoreSlotEngine } from '../../core/engine/CoreSlotEngine.js';
import { LineMechanic } from '../../core/engine/mechanics/LineMechanic.js';
import { ReelScrollAnimator } from '../../core/engine/animators/ReelScrollAnimator.js';
import { SlotRenderer } from '../../core/rendering/SlotRenderer.js';
import { SpinLogRecorder } from '../../core/engine/SpinLogRecorder.js';
import { AudioController } from '../../core/engine/AudioController.js';
import { runSimulationAndRender } from '../../core/ui/dev/SimulationPanel.js';
import { openTuningPanel } from '../../core/ui/dev/tuning/TuningPanelView.js';
import { openSpinLogPanel } from '../../core/ui/dev/SpinLogPanel.js';
import { bindCommonSlotControls, observeSlotViewport, updateSlotStateUI } from '../../core/ui/SlotGameUI.js';
import { ensureDeveloperPanels } from '../../core/ui/DeveloperPanels.js';
import { renderLinePaytable } from '../../core/ui/PaytableRenderer.js';
```

Then, after the `winEvaluator` export from Task 7, add:

```js
const GAME_ASSET_MANIFEST = {
  symbols: { url: './assets/symbols/symbols.tiles.json', type: 'tilemap' },
  music: { url: './assets/music/pacific_drift_theme.mp3', type: 'music' },
};

const DEBUG_MODE = true; // Set to false in production - matches every other game's own flag.

let engine = null;
let pendingBonusSpinsAward = 0;
let refs = {};
```

- [ ] **Step 2: Write `initGame()`**

Append to the end of `games/beachparty/game.js`:

```js
async function initGame() {
  refs = {
    canvas: document.getElementById('game-canvas'),
    spin: document.getElementById('btn-spin'), auto: document.getElementById('btn-auto'),
    turbo: document.getElementById('btn-turbo'), mute: document.getElementById('btn-mute'),
    paytable: document.getElementById('btn-paytable'), paytableOk: document.getElementById('btn-paytable-ok'),
    balance: document.getElementById('display-balance'), bet: document.getElementById('bet-value'),
    betMinus: document.getElementById('bet-minus'), betPlus: document.getElementById('bet-plus'),
    totalBet: document.getElementById('display-total-bet'), lines: document.getElementById('lines-value'),
    linesMinus: document.getElementById('lines-minus'), linesPlus: document.getElementById('lines-plus'),
    ticker: document.getElementById('game-ticker'),
    sim: document.getElementById('btn-sim'), tune: document.getElementById('btn-tune'), spinlog: document.getElementById('btn-spinlog'),
    simStats: document.getElementById('sim-stats'), simRtp: document.getElementById('sim-rtp'),
    simTotalSpins: document.getElementById('sim-total-spins'), simMaxWin: document.getElementById('sim-max-win'),
    simFreeSpins: document.getElementById('sim-free-spins'),
    paytableModal: document.getElementById('modal-paytable'),
    fsTriggerModal: document.getElementById('modal-fs-trigger'), fsSummaryModal: document.getElementById('modal-fs-summary'),
    btnStartFs: document.getElementById('btn-start-fs'), btnCloseFsSummary: document.getElementById('btn-close-fs-summary'),
    fsAwardAmount: document.getElementById('fs-award-amount'),
    fsPanel: document.getElementById('fs-panel'), fsCounter: document.getElementById('fs-counter'), fsTotalWin: document.getElementById('fs-total-win'),
    cheatBonus: document.getElementById('cheat-scatter'), cheatBigWin: document.getElementById('cheat-bigwin'),
    debugShortcuts: document.querySelector('.debug-shortcuts'),
  };
  if (refs.debugShortcuts && DEBUG_MODE) refs.debugShortcuts.classList.add('debug-enabled');

  const developerPanels = ensureDeveloperPanels();
  const renderer = new SlotRenderer();

  engine = new CoreSlotEngine(refs.canvas, {
    mechanic: LineMechanic,
    animator: new ReelScrollAnimator(renderer),
    renderer,
    spinLogRecorder: new SpinLogRecorder({ betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, scatterSymbol: BONUS_SYMBOL }),
    audioController: new AudioController(),

    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT,
    paytable: PAYTABLE, reelStrips: REEL_STRIPS, paylines: PAYLINES,
    wildSymbol: WILD_SYMBOL,
    // Only used by the debug forceWinResult('scatter') cheat (see _buildForcedGrid in
    // CoreSlotEngine.js) - lands 'bonus' on reels 0/2/4, which happens to be exactly
    // BONUS_REEL_INDEXES for a 5-reel grid. The live win evaluator ignores this field entirely,
    // computing its own reel-restricted trigger from the raw grid (see detectBonusTrigger).
    scatterSymbol: BONUS_SYMBOL,
    winEvaluator,
    betPerLine: BET_PER_LINE, linesCount: LINES_COUNT,

    symbolAspectRatio: 2, // 256x128 tiles - wide cells, new to this game (see GridLayout.js).
    stackedSymbols: STACKED_SYMBOLS,

    assetManifest: GAME_ASSET_MANIFEST,
    viewportBackground: { type: 'image', image: './assets/backgrounds/beach_lifeguard_hut_2.png' },
    freeSpinsViewportBackground: { type: 'image', image: './assets/backgrounds/boards_on_the_beach.png' },

    onStateChange: state => updateSlotStateUI({
      engine, state, refs: { spin: refs.spin, ticker: refs.ticker }, onUpdate: updateUI,
      messages: {
        spinning: 'SPINNING...', stopping: 'STOPPING...',
        // Reef Royale jackpot gets its own ticker message instead of the generic win amount -
        // engine.winData is the same object SlotRenderer._drawLine already reads (see
        // engine.winData in core/rendering/SlotRenderer.js), carrying the scatterWin our own
        // evaluateBeachPartyWin (Task 7) returned for this spin, jackpot flag included.
        showing_wins: game => (game.winData?.scatterWin?.jackpot
          ? `\u{1F389} REEF ROYALE JACKPOT! +$${game.lastWin.toFixed(2)}`
          : `WIN: $${game.lastWin.toFixed(2)}!`),
        free_spins_intro: 'BEACH BONUS!', game_over: 'BEACH BONUS COMPLETE!', idle: 'IDLE',
      },
      onGameOver: handleBonusComplete,
    }),
    onScatterTrigger: (count, isInFreeSpins) => handleBonusTrigger(count, isInFreeSpins),
  });
  await engine.init();

  updateUI();
  bindCommonSlotControls({ getEngine: () => engine, onUpdate: updateUI, betStep: BET_PER_LINE_STEP, betMax: BET_PER_LINE_MAX, linesMax: LINES_COUNT });
  observeSlotViewport();
  setupUIHandlers();
  buildPaytableContent();
}

function updateUI() {
  if (!engine) return;
  refs.balance.textContent = `$${engine.balance.toFixed(2)}`;
  refs.bet.textContent = engine.betPerLine.toFixed(2);
  refs.lines.textContent = `${engine.linesCount} / ${LINES_COUNT}`;
  refs.totalBet.textContent = `$${engine.totalBet.toFixed(2)}`;

  if (engine.inFreeSpins) {
    refs.fsPanel.classList.add('active');
    refs.fsCounter.textContent = `BEACH BONUS: ${engine.freeSpinsRemaining} / ${engine.freeSpinsTotal}`;
  } else {
    refs.fsPanel.classList.remove('active');
  }
}

function buildPaytableContent() {
  renderLinePaytable({
    container: document.getElementById('paytable-grid-content'), paytable: PAYTABLE, paylines: PAYLINES,
    reelsCount: REELS_COUNT, assets: engine?.assets, scatterTriggerCount: BONUS_REEL_INDEXES.length,
    freeSpinsAward: BONUS_SPINS_AWARD, paylinePreviewContainer: document.getElementById('paylines-preview'),
  });
}

export { initGame };

if (typeof window !== 'undefined') window.addEventListener('load', initGame);
```

`setupUIHandlers`, `handleBonusTrigger`, and `handleBonusComplete` are written in Task 10 - `initGame` references them but they don't exist until that task lands, which is fine since this whole file is only ever executed in a browser (import-time errors from an undefined function reference don't surface until the function is actually *called*, and nothing calls `initGame` under Node).

- [ ] **Step 2: Sanity-check the file still imports cleanly under Node**

Run: `node --test tests/beachparty.test.mjs tests/beachpartywinevaluator.test.mjs`
Expected: PASS - these tests only import data/pure-function exports, never trigger `window.addEventListener('load', ...)`, so the DOM-only code added in this task doesn't run.

- [ ] **Step 3: Commit**

```bash
git add games/beachparty/game.js
git commit -m "feat(beachparty): initGame() engine construction and core wiring"
```

---

### Task 10: Beach Bonus lifecycle UI + control handlers

**Files:**
- Modify: `games/beachparty/game.js` (append `setupUIHandlers`, `handleBonusTrigger`, `startBonus`, `handleBonusComplete`, `closeBonusSummary`)

**Interfaces:**
- Consumes: `refs`/`engine` from Task 9; `BONUS_SPINS_AWARD` from Task 6.

- [ ] **Step 1: Append the bonus lifecycle and control-handler functions**

Append to `games/beachparty/game.js` (mirrors barfruits' own `handleScatterTrigger`/`startFreeSpins`/`handleFreeSpinsComplete`/`closeFreeSpinsSummary`/`setupUIHandlers` exactly, renamed for Beach Bonus and with no lines/bet-cap logic changes):

```js
// Bonus lifecycle - game code decides everything, CoreSlotEngine only provides the mechanism
// (enterFreeSpinsIntro/enterFreeSpins/retriggerFreeSpins/exitFreeSpins). No expanding symbol
// here (that's the separate Book-of-Dead-style mechanic this game doesn't use) - Beach Bonus's
// own stacked-wild/jackpot rules live entirely inside winEvaluator (Task 7), gated on
// engine.inFreeSpins, so enterFreeSpins is called with expandingSymbol = null.
function handleBonusTrigger(count, isInFreeSpins) {
  if (isInFreeSpins) {
    engine.retriggerFreeSpins(BONUS_SPINS_AWARD);
    refs.ticker.textContent = `+${BONUS_SPINS_AWARD} MORE BONUS SPINS!`;
    engine.audio.playScatterTrigger();
    updateUI();
    return;
  }

  pendingBonusSpinsAward = BONUS_SPINS_AWARD;
  engine.enterFreeSpinsIntro();
  refs.fsAwardAmount.textContent = BONUS_SPINS_AWARD;
  refs.fsTriggerModal.classList.add('active');
  engine.audio.playScatterTrigger();
}

function startBonus() {
  refs.fsTriggerModal.classList.remove('active');
  engine.enterFreeSpins(pendingBonusSpinsAward, null);
}

function handleBonusComplete() {
  refs.fsTotalWin.textContent = `$${engine.freeSpinsAccumulatedWin.toFixed(2)}`;
  refs.fsSummaryModal.classList.add('active');
  engine.audio.playScatterTrigger();
}

function closeBonusSummary() {
  refs.fsSummaryModal.classList.remove('active');
  engine.returnToIdle();
  updateUI();
  engine.handleAutoPlay();
}

function setupUIHandlers() {
  refs.spin.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') engine.stopSpin();
    else engine.requestSpin();
  });

  refs.betMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.betPerLine > BET_PER_LINE_STEP + 1e-9) {
      engine.betPerLine = Math.round((engine.betPerLine - BET_PER_LINE_STEP) * 100) / 100;
      engine.updateBet();
      updateUI();
    }
  });

  refs.betPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newBetPerLine = Math.round((engine.betPerLine + BET_PER_LINE_STEP) * 100) / 100;
    const newTotalBet = newBetPerLine * engine.linesCount;
    if (newBetPerLine <= BET_PER_LINE_MAX + 1e-9 && engine.balance >= newTotalBet) {
      engine.betPerLine = newBetPerLine;
      engine.updateBet();
      updateUI();
    }
  });

  refs.linesMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.linesCount > 1) {
      engine.linesCount--;
      engine.updateBet();
      updateUI();
    }
  });

  refs.linesPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newLinesCount = engine.linesCount + 1;
    const newTotalBet = engine.betPerLine * newLinesCount;
    if (newLinesCount <= LINES_COUNT && engine.balance >= newTotalBet) {
      engine.linesCount = newLinesCount;
      engine.updateBet();
      updateUI();
    }
  });

  refs.auto.addEventListener('click', () => {
    engine.autoPlay = !engine.autoPlay;
    refs.auto.classList.toggle('active', engine.autoPlay);
    if (engine.autoPlay && engine.state === 'idle') engine.spin();
  });

  refs.turbo.addEventListener('click', () => {
    engine.turboMode = !engine.turboMode;
    refs.turbo.classList.toggle('active', engine.turboMode);
  });

  refs.mute.addEventListener('click', () => {
    const isMuted = engine.audio.toggleMute();
    refs.mute.textContent = isMuted ? '\u{1F507} Sound OFF' : '\u{1F50A} Sound ON';
    refs.mute.classList.toggle('active', isMuted);
  });

  refs.paytable.addEventListener('click', () => refs.paytableModal.classList.add('active'));
  refs.paytableOk.addEventListener('click', () => refs.paytableModal.classList.remove('active'));
  document.querySelectorAll('.btn-modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const overlay = btn.closest('.modal-overlay');
      if (overlay) { overlay.classList.remove('active'); return; }
      const simModalEl = btn.closest('.sim-modal');
      if (simModalEl) simModalEl.style.display = 'none';
    });
  });

  if (refs.btnStartFs) refs.btnStartFs.addEventListener('click', startBonus);
  if (refs.btnCloseFsSummary) refs.btnCloseFsSummary.addEventListener('click', closeBonusSummary);

  refs.sim.addEventListener('click', () => runSimulationAndRender({
    engine, paytable: PAYTABLE, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, numSpins: 200000,
    domRefs: {
      btnSim: refs.sim, panel: developerPanelsRef.simulation, simModal: developerPanelsRef.simulation,
      simStats: refs.simStats, simRtpDisplay: refs.simRtp, simTotalSpinsDisplay: refs.simTotalSpins,
      simMaxWinDisplay: refs.simMaxWin, simFreeSpinsDisplay: refs.simFreeSpins,
    },
  }));
  refs.tune.addEventListener('click', () => openTuningPanel({
    paytable: PAYTABLE, reelFrequencyTables: FREQUENCY_REELS, panel: developerPanelsRef.tuning,
    tuneConfig: {
      reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, scatterSymbol: BONUS_SYMBOL,
      reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
      minClusterSize: 3, reelCoupling: 'independent', targetRtp: 96,
    },
  }));
  refs.spinlog.addEventListener('click', () => openSpinLogPanel({ engine, domRefs: { panel: developerPanelsRef.spinLog } }));

  if (DEBUG_MODE) {
    if (refs.cheatBonus) refs.cheatBonus.addEventListener('click', () => engine.forceWinResult('scatter'));
    if (refs.cheatBigWin) refs.cheatBigWin.addEventListener('click', () => engine.forceWinResult('bigwin'));
  }
}
```

- [ ] **Step 2: Wire `developerPanelsRef` so `setupUIHandlers` can reach it**

`setupUIHandlers` above references `developerPanelsRef`, which `initGame` (Task 9) currently holds as a local `const developerPanels`. Change Task 9's `initGame` to assign it to a module-level variable instead, so `setupUIHandlers` (a sibling function, not a nested closure) can read it. In `games/beachparty/game.js`:

1. Add `let developerPanelsRef = null;` next to the other module-level `let` declarations from Task 9 Step 1.
2. In `initGame`, change `const developerPanels = ensureDeveloperPanels();` to `developerPanelsRef = ensureDeveloperPanels();`.

- [ ] **Step 3: Sanity-check the file still imports cleanly under Node**

Run: `node --test tests/beachparty.test.mjs tests/beachpartywinevaluator.test.mjs`
Expected: PASS - same reasoning as Task 9 Step 2, none of this DOM-only code executes under Node.

- [ ] **Step 4: Commit**

```bash
git add games/beachparty/game.js
git commit -m "feat(beachparty): Beach Bonus lifecycle UI and spin/bet/lines controls"
```

---

### Task 11: Browser smoke verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run (background): `pwsh -File serve.ps1` (or whatever this repo's existing dev-server script/command is - check `package.json`'s `scripts` and `README.md`'s "how to run things" section first if `serve.ps1` isn't it). Capture the PID and report a kill command to the user per this session's own standing convention, e.g.:

```powershell
Get-NetTCPConnection -LocalPort <PORT> | Select -Expand OwningProcess | Stop-Process -Force
```

- [ ] **Step 2: Load `games/beachparty/index.html` in a browser and verify, in order:**

1. The page loads with no console errors.
2. The reel grid renders with visibly wide (2:1) cells, not square ones.
3. Clicking SPIN plays a spin and lands a 5x5 grid; card/surfer/wild art displays correctly.
4. Let several spins play out (or use the debug "Force Bonus Trigger" shortcut) until a bonus symbol lands on reels 1/3/5 together - the trigger modal should appear, and starting it should swap the background to `boards_on_the_beach.png` and show the Beach Bonus counter panel.
5. Open the paytable modal (PAYTABLE button) and confirm every symbol - including the 4 surfer colors and the wild - renders its icon and payout correctly, with no missing/broken sprites.
6. Spin enough times (or force it) to observe a natural 2-5 tall surfer stack landing during a normal spin, confirming the tall composite art renders instead of repeated plain tiles.
7. Click RUN SIMULATION and confirm it completes and shows a finite RTP figure with no console errors.

If any of these fail, fix the root cause (do not proceed to declare the task done with a workaround) and re-verify from Step 2.

- [ ] **Step 3: Stop the dev server**

Run the kill command reported in Step 1.

- [ ] **Step 4: Report results to the user**

Summarize what was verified and any deviations from DESIGN.md discovered along the way (there should be none, since Tasks 1-10 implement it directly) - no commit for this task, it produces no file changes.

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** wide tiles → Task 1; stacked-symbol rendering → Task 3; reel-restricted bonus trigger → Task 7; stacked-wild-in-bonus → Task 7; mini jackpot → Task 7; new paylines → Task 5/6; backgrounds → Task 4/9; music → Task 9 (`GAME_ASSET_MANIFEST`); paytable/reel data → Task 6; UI/lifecycle → Tasks 8/9/10; end-to-end check → Task 11. Every DESIGN.md section maps to a task.
- **Known, intentionally-scoped-out gap:** Task 7's evaluator only applies bonus rules in live play, not in `SpinSimulator`'s batch path (documented inline, in DESIGN.md is not called out explicitly - worth a one-line addition to DESIGN.md's §5 if this surprises anyone during Task 11's RUN SIMULATION check, but not a blocker for shipping).
- **Type/name consistency check performed:** `resolveStackedSymbolTileName` (Task 3) is called identically in `StackedSymbols.js` and its two tests; `evaluateBeachPartyWin`'s `{ inFreeSpins }` option object shape matches between Task 7's implementation and Task 9's `winEvaluator` wrapper; `BONUS_REEL_INDEXES` is the one name used everywhere (game.js, both test files) - no `BONUS_REELS` vs `BONUS_REEL_INDEXES` drift.
