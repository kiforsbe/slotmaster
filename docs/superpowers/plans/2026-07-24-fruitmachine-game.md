# Fruit Machine Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the shared slot-machine core (`core/SlotMath.js`, `core/SlotEngine.js`, `core/SpinSimulator.js`) to support arbitrary grid shapes and paylines, extract the reusable RUN SIMULATION / TUNE FREQUENCIES dev tooling out of `bookbookbook` into a shared module, and build a new classic 3-reel/5-line fruit machine game (`games/fruitmachine`) on top of it, targeting 96% RTP.

**Architecture:** Paylines move out of core into each game's own `game.js`. Two win-evaluator functions live side-by-side in `core/SlotMath.js` — the existing `checkWins` (book's single-global-wild/scatter model, now payline-agnostic) and a new `checkWildLineWins` (data-driven, reel-restricted dual-wild model for the fruit machine). `SlotEngine` and `SpinSimulator` call whichever evaluator a game's config supplies (`config.winEvaluator`), defaulting to `checkWins` for backward compatibility. Dev tooling (RUN SIMULATION / TUNE FREQUENCIES) is extracted into `core/SimulationPanel.js`, generalized to be data-driven from paytable field names instead of hardcoding book's symbol/type names.

**Tech Stack:** Vanilla JS ES modules, HTML5 Canvas, no build step, no test framework (verification uses disposable Node `.mjs` scripts run from the repo root and deleted before committing — the established pattern in this codebase; `.mjs` forces ES module parsing regardless of `package.json`).

## Global Constraints

- No test framework is configured (`package.json` is `{}`). Do not add one. Verification scripts are temporary `.mjs` files at the repo root, run with `node <file>.mjs`, deleted before the task's commit.
- Never use `git add -A` — stage files by exact name so a leftover verification script can't get committed by accident.
- Preserve `bookbookbook`'s exact current behavior (paylines, payouts, visuals, RTP) — every task touching shared core files must leave it working, verified at the checkpoints called out below.
- `core/SlotAudio.js` is not touched by this plan.
- Reel spin timing/physics (`core/SlotEngine.js`'s `spinning`/`landing`/`bounce` state machine) is not touched by this plan except where explicitly noted (the `renderWinEffects`/`forceWinResult` fixes in Task 3).

---

## File Structure

| File | Change |
|---|---|
| `core/SlotMath.js` | Modify: remove `PAYLINES` export, add `paylines` param to `checkWins`/`checkExpandingWins`, generalize grid-size validation, add `checkWildLineWins` |
| `core/SlotEngine.js` | Modify: `config.paylines`/`wildSymbol`/`scatterSymbol`/`winEvaluator`, fix hardcoded-5-reel bugs in `renderWinEffects`/`forceWinResult` |
| `core/SpinSimulator.js` | Modify: thread `paylines`/`winEvaluator`/`wildSymbol`/`scatterSymbol` through `simulateSpins`/`tuneFrequencies` |
| `core/SimulationPanel.js` | Create: shared RUN SIMULATION / TUNE FREQUENCIES dev-tooling UI |
| `games/bookbookbook/game.js` | Modify: local `PAYLINES` const, pass new config fields, call into `SimulationPanel.js` instead of local copies |
| `games/fruitmachine/index.html` | Create |
| `games/fruitmachine/game.js` | Create |
| `index.html` | Modify: add a card linking to the fruit machine |

---

### Task 1: Generalize `checkWins`/`checkExpandingWins` in `core/SlotMath.js`; remove `PAYLINES`

**Files:**
- Modify: `core/SlotMath.js:1-246`
- Test: `verify-slotmath-generic.mjs` (repo root, temporary — delete before committing)

**Interfaces:**
- Produces: `checkWins(grid, paytable, paylines, activeLinesCount = 10, wildSymbol = null, scatterSymbol = null, scatterTriggerCount = 3)` — note the inserted `paylines` param and new `null` defaults (was `'book'`).
- Produces: `checkExpandingWins(grid, expandingSymbol, paytable, paylines, activeLinesCount = 10, expandingPaytable = null)` — note the inserted `paylines` param.
- No more `export const PAYLINES` from this file.

- [ ] **Step 1: Write the failing verification script**

Create `verify-slotmath-generic.mjs` at the repo root:

```js
import { checkWins, checkExpandingWins } from './core/SlotMath.js';

// A 3x3 grid must be accepted (previously threw on any non-5-reel grid)
const grid3x3 = [
  ['a', 'a', 'a'],
  ['a', 'a', 'a'],
  ['a', 'a', 'a'],
];
const paylines3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
const paytable3 = { a: { payout: [0, 0, 5], paymode: 'line' } };

const result = checkWins(grid3x3, paytable3, paylines3, 3, null, null);
console.assert(result.lineWins.length === 3, `expected 3 line wins, got ${result.lineWins.length}`);
console.assert(result.totalLinePayoutMultiplier === 15, `expected 15, got ${result.totalLinePayoutMultiplier}`);
console.log('checkWins 3x3 grid: OK');

// Original 5-reel behavior must still work when given 5-reel paylines
const grid5x3 = [
  ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a']
];
const paylines5 = [[1, 1, 1, 1, 1]];
const paytable5 = { a: { payout: [0, 0, 0, 0, 20], paymode: 'line' } };
const result5 = checkWins(grid5x3, paytable5, paylines5, 1, null, null);
console.assert(result5.totalLinePayoutMultiplier === 20, `expected 20, got ${result5.totalLinePayoutMultiplier}`);
console.log('checkWins 5x3 grid: OK');

// checkExpandingWins on a non-5-reel, non-3-row grid
const expPaytable = { x: { payout: [0, 50, 500] } };
const gridExp = [
  ['x', 'b', 'b'], ['x', 'b', 'b'], ['b', 'b', 'b']
];
const expResult = checkExpandingWins(gridExp, 'x', expPaytable, paylines3, 3);
console.assert(expResult.expandingReels.length === 2, `expected 2 expanding reels, got ${expResult.expandingReels.length}`);
console.assert(expResult.expandedPositions.length === 6, `expected 6 expanded positions, got ${expResult.expandedPositions.length}`);
console.log('checkExpandingWins 3-reel grid: OK');

console.log('All SlotMath generalization checks passed.');
```

- [ ] **Step 2: Run it to confirm it fails against the current code**

Run: `node verify-slotmath-generic.mjs`
Expected: throws `Error: Grid must be 5 columns x 3 rows` (the old hardcoded check rejects the 3x3 grid).

- [ ] **Step 3: Replace the `PAYLINES` export and generalize `checkWins`**

In `core/SlotMath.js`, delete the entire `PAYLINES` export block (lines 3-19: the JSDoc comment and `export const PAYLINES = [...]`).

Replace the `checkWins` function (originally lines 21-158) with:

```js
/**
 * Check normal line wins and scatters for a slot grid.
 * Grid structure: grid[col][row], where col is 0..reelsCount-1 and row is 0..rowsCount-1.
 * @param {Array<Array<string>>} grid - reelsCount x rowsCount grid of symbol names
 * @param {Object} paytable - Maps symbol names to payout arrays (indexed by hit count)
 * @param {Array<Array<number>>} paylines - Payline definitions; each entry has one row index per reel
 * @param {number} activeLinesCount - Number of active paylines (default 10)
 * @param {string|null} wildSymbol - Symbol that acts as wild (default none)
 * @param {string|null} scatterSymbol - Symbol that acts as scatter (default none)
 * @param {number} scatterTriggerCount - Minimum scatter count to trigger free spins (default 3)
 * @returns {Object} Object containing lineWins, scatterWin, and total payouts
 */
export function checkWins(grid, paytable, paylines, activeLinesCount = 10, wildSymbol = null, scatterSymbol = null, scatterTriggerCount = 3) {
  // Input validation
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0) {
    throw new Error('Grid must be a non-empty reelsCount x rowsCount array');
  }
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('Invalid paytable');
  }
  if (!paylines || !Array.isArray(paylines) || paylines.length === 0) {
    throw new Error('paylines must be a non-empty array');
  }
  const reelsCount = grid.length;
  const rowsCount = grid[0].length;
  activeLinesCount = Math.min(activeLinesCount, paylines.length);

  const lineWins = [];
  let totalLinePayoutMultiplier = 0;

  // 1. Evaluate Line Wins (Left to Right)
  for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, paylines.length); lineIdx++) {
    const path = paylines[lineIdx];

    // Read symbols along the line path
    const lineSymbols = [];
    for (let col = 0; col < reelsCount; col++) {
      const row = path[col];
      lineSymbols.push(grid[col][row]);
    }

    // Determine the winning combination starting from the left
    let matchCount = 0;
    let targetSymbol = null;
    const winningPositions = [];

    for (let col = 0; col < reelsCount; col++) {
      const sym = lineSymbols[col];

      if (col === 0) {
        targetSymbol = sym;
        matchCount = 1;
        winningPositions.push([col, path[col]]);
      } else {
        const isWild = (sym === wildSymbol);
        const targetIsWild = (targetSymbol === wildSymbol);

        if (targetIsWild && !isWild) {
          // If first symbol was wild and current is not, target becomes the current symbol
          targetSymbol = sym;
          matchCount++;
          winningPositions.push([col, path[col]]);
        } else if (sym === targetSymbol || isWild) {
          // Normal match or wild substitution
          matchCount++;
          winningPositions.push([col, path[col]]);
        } else {
          // Win sequence is broken
          break;
        }
      }
    }

    // A scatter-paymode run (e.g. Book, Book, Book on line 1) must NOT be paid as a line win:
    // scatter symbols are already paid separately below using totalBet-scaled multipliers.
    // Paying them again per-line would double-count. Gate on the paytable's own paymode
    // rather than the wild symbol, since a symbol can be scatter-only without being wild.
    const targetMeta = targetSymbol && paytable[targetSymbol];
    if (targetSymbol && targetSymbol !== wildSymbol && targetMeta && targetMeta.paymode === 'line') {
      const payouts = targetMeta.payout;
      // payout[i] is the payout for (i+1) matching symbols (index 0 = 1 match, ... index 4 = 5 matches).
      if (payouts && payouts[matchCount - 1] > 0) {
        const payout = payouts[matchCount - 1];
        lineWins.push({
          lineIndex: lineIdx,
          symbol: targetSymbol,
          count: matchCount,
          payout: payout,
          winningPositions: winningPositions.slice(0, matchCount)
        });
        totalLinePayoutMultiplier += payout;
      }
    }
  }

  // 2. Evaluate Scatter Wins (Books anywhere)
  let scatterCount = 0;
  const scatterPositions = [];
  for (let col = 0; col < reelsCount; col++) {
    for (let row = 0; row < rowsCount; row++) {
      if (grid[col][row] === scatterSymbol) {
        scatterCount++;
        scatterPositions.push([col, row]);
      }
    }
  }

  let scatterWin = null;
  let triggerFreeSpins = false;
  if (scatterCount >= scatterTriggerCount) {
    triggerFreeSpins = true;
  }

  // Scatters pay based on total bet, usually defined separately in the paytable.
  // payout[i] is the payout for (i+1) scatters, same convention as line wins.
  const scatterPayouts = paytable[scatterSymbol] && paytable[scatterSymbol].payout;
  if (scatterPayouts && scatterPayouts[scatterCount - 1] > 0) {
    const payout = scatterPayouts[scatterCount - 1];
    scatterWin = {
      symbol: scatterSymbol,
      count: scatterCount,
      payout: payout, // multiplier of total bet
      winningPositions: scatterPositions,
      triggerFreeSpins: triggerFreeSpins
    };
  } else if (triggerFreeSpins) {
    // Retrigger or trigger free spins even if no payout is defined at this level
    scatterWin = {
      symbol: scatterSymbol,
      count: scatterCount,
      payout: 0,
      winningPositions: scatterPositions,
      triggerFreeSpins: true
    };
  }

  return {
    lineWins,
    scatterWin,
    totalLinePayoutMultiplier,
    totalScatterPayoutMultiplier: scatterWin ? scatterWin.payout : 0
  };
}
```

- [ ] **Step 4: Generalize `checkExpandingWins`**

Replace the `checkExpandingWins` function (originally lines 165-246) with:

```js
/**
 * Check Book of Dead style expanding wins during Free Spins.
 * Reels with the expanding symbol will have it expand to cover the entire reel.
 * Wins are evaluated on all active lines without needing to be adjacent.
 * Note: Expanding symbol pays on ALL active paylines, so 3 expanding reels
 * pays payout * numActiveLines. This is Book of Dead style behavior.
 * @param {Array<Array<string>>} grid - reelsCount x rowsCount grid of symbol names
 * @param {string} expandingSymbol - The symbol that expands during free spins
 * @param {Object} paytable - Maps symbol names to payout arrays (used for fallback)
 * @param {Array<Array<number>>} paylines - Payline definitions; each entry has one row index per reel
 * @param {number} activeLinesCount - Number of active paylines (default 10)
 * @param {Object|null} expandingPaytable - Separate paytable for expanding wins; if null, falls back to paytable
 * @returns {Object|null} Expanding win data or null if no win
 */
export function checkExpandingWins(grid, expandingSymbol, paytable, paylines, activeLinesCount = 10, expandingPaytable = null) {
  // Input validation
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0) {
    throw new Error('Grid must be a non-empty reelsCount x rowsCount array');
  }
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('Invalid paytable');
  }
  if (!paylines || !Array.isArray(paylines) || paylines.length === 0) {
    throw new Error('paylines must be a non-empty array');
  }
  const reelsCount = grid.length;
  const rowsCount = grid[0].length;

  // Find which reels contain the expanding symbol
  const expandingReels = [];
  const expandedPositions = [];

  for (let col = 0; col < reelsCount; col++) {
    let hasSymbol = false;
    for (let row = 0; row < rowsCount; row++) {
      if (grid[col][row] === expandingSymbol) {
        hasSymbol = true;
        break;
      }
    }
    if (hasSymbol) {
      expandingReels.push(col);
      // Once expanded, the symbol occupies every row of this column
      for (let row = 0; row < rowsCount; row++) {
        expandedPositions.push([col, row]);
      }
    }
  }

  const count = expandingReels.length;
  // Use the dedicated expanding paytable when available (separate from normal-mode line payouts)
  const payouts = (expandingPaytable && expandingPaytable[expandingSymbol] && expandingPaytable[expandingSymbol].payout)
    || (paytable[expandingSymbol] && paytable[expandingSymbol].payout);

  // High value symbols pay for 2 or more reels, low value for 3 or more.
  // We can determine this by checking if payout exists for count.
  // payout[i] is the payout for (i+1) expanded reels, same convention as line wins.
  const hasWin = payouts && payouts[count - 1] > 0;

  if (!hasWin || count === 0) {
    return null;
  }

  const wins = [];
  const payoutPerLine = payouts[count - 1];
  let totalPayout = 0;

  // In expanding mode, since the symbol covers all positions on the expanded reels,
  // it is active on all paylines on those reels. And since it doesn't need to be adjacent,
  // every active line gets a win of size equal to the number of expanding reels!
  for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, paylines.length); lineIdx++) {
    wins.push({
      lineIndex: lineIdx,
      symbol: expandingSymbol,
      count: count,
      payout: payoutPerLine,
      // The winning positions on this payline are the intersections of the payline and the expanded columns
      winningPositions: paylines[lineIdx].map((row, col) => {
        if (expandingReels.includes(col)) {
          return [col, row];
        }
        return null;
      }).filter(pos => pos !== null)
    });
    totalPayout += payoutPerLine;
  }

  return {
    symbol: expandingSymbol,
    expandingReels,
    expandedPositions,
    wins,
    totalPayoutMultiplier: totalPayout
  };
}
```

- [ ] **Step 5: Run the verification script again to confirm it passes**

Run: `node verify-slotmath-generic.mjs`
Expected: prints `checkWins 3x3 grid: OK`, `checkWins 5x3 grid: OK`, `checkExpandingWins 3-reel grid: OK`, `All SlotMath generalization checks passed.` — exit code 0.

- [ ] **Step 6: Delete the verification script and commit**

```bash
rm verify-slotmath-generic.mjs
git add core/SlotMath.js
git commit -m "refactor: make checkWins/checkExpandingWins payline- and grid-shape-agnostic"
```

---

### Task 2: Add `checkWildLineWins` to `core/SlotMath.js`

**Files:**
- Modify: `core/SlotMath.js` (append new export)
- Test: `verify-wildlinewins.mjs` (repo root, temporary)

**Interfaces:**
- Consumes: nothing from Task 1 beyond the file already existing.
- Produces: `checkWildLineWins(grid, paytable, paylines, activeLinesCount)` → `{ lineWins, totalLinePayoutMultiplier }`, where each `lineWins` entry is `{ lineIndex, symbol, count, payout, winningPositions, aloneBonus }`. This is what Task 3 wires into `SlotEngine` as a `config.winEvaluator` option, and what Task 10 (`games/fruitmachine/game.js`) imports directly.

- [ ] **Step 1: Write the failing verification script**

Create `verify-wildlinewins.mjs` at the repo root:

```js
import { checkWildLineWins } from './core/SlotMath.js';

const PAYTABLE = {
  bar:        { payout: [0, 0, 10] },
  clover:     { payout: [0, 0, 4], wildPenalty: 1 },
  pear:       { payout: [0, 0, 3] },
  grapes:     { payout: [0, 0, 2], wildPenalty: 1 },
  cherries:   { payout: [0.40, 0.80, 1.60] },
  star:       { payout: [0, 0, 0], wild: true, wildExcludes: ['cherries'] },
  strawberry: { payout: [0, 0, 0], wild: true, wildOnly: ['cherries'], aloneBonus: 0.80 },
};

function payoutFor(symbols) {
  // One active line, one row, so the line reads straight across columns
  const grid = [[symbols[0]], [symbols[1]], [symbols[2]]];
  const result = checkWildLineWins(grid, PAYTABLE, [[0, 0, 0]], 1);
  return result.totalLinePayoutMultiplier;
}

const cases = [
  [['bar', 'bar', 'bar'], 10],
  [['grapes', 'grapes', 'star'], 1],
  [['pear', 'pear', 'star'], 3],
  [['cherries', 'cherries', 'star'], 0.80],
  [['cherries', 'cherries', 'strawberry'], 1.60],
  [['bar', 'bar', 'strawberry'], 0.80],
  [['cherries', 'bar', 'strawberry'], 1.20],
  [['pear', 'clover', 'strawberry'], 0.80],
  [['bar', 'clover', 'bar'], 0],
];

let failures = 0;
for (const [symbols, expected] of cases) {
  const actual = payoutFor(symbols);
  const ok = Math.abs(actual - expected) < 1e-9;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${symbols.join(',')} -> ${actual} (expected ${expected})`);
  if (!ok) failures++;
}

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All checkWildLineWins cases passed.');
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node verify-wildlinewins.mjs`
Expected: `SyntaxError` / import error — `checkWildLineWins` is not exported yet.

- [ ] **Step 3: Implement `checkWildLineWins`**

Append to `core/SlotMath.js`:

```js
/**
 * Check line wins where certain symbols act as wilds restricted to the LAST grid position
 * of a line only, with optional per-target-symbol payout penalties and a flat "lands but
 * doesn't complete a win" bonus for a wild symbol. Fully data-driven from paytable fields -
 * no symbol names are hardcoded here, so this is reusable by any game with reel-restricted
 * wilds, not just one specific paytable.
 *
 * Paytable fields read (all optional except payout):
 *   payout: [pay-for-1, pay-for-2, ..., pay-for-reelsCount] per symbol, left-to-right from reel 1.
 *   wild: true - this symbol can substitute in the LAST grid position of a line only.
 *   wildExcludes: [symbols] - target symbols this wild can NOT substitute for.
 *   wildOnly: [symbols] - if present, this wild substitutes ONLY for these target symbols.
 *   wildPenalty: number - subtracted from the full-match payout when won via this wild.
 *   aloneBonus: number - flat payout when this wild lands in the last position without
 *     completing a win for that line.
 *
 * @param {Array<Array<string>>} grid - reelsCount x rowsCount grid of symbol names
 * @param {Object} paytable - see field table above
 * @param {Array<Array<number>>} paylines - payline definitions, one row index per reel
 * @param {number} activeLinesCount - number of active paylines to evaluate
 * @returns {Object} { lineWins, totalLinePayoutMultiplier }
 */
export function checkWildLineWins(grid, paytable, paylines, activeLinesCount) {
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0) {
    throw new Error('Grid must be a non-empty reelsCount x rowsCount array');
  }
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('Invalid paytable');
  }
  if (!paylines || !Array.isArray(paylines) || paylines.length === 0) {
    throw new Error('paylines must be a non-empty array');
  }

  const reelsCount = grid.length;
  const isWildFor = (wildSymbolName, targetSymbol) => {
    const meta = paytable[wildSymbolName];
    if (!meta || !meta.wild) return false;
    if (meta.wildOnly) return meta.wildOnly.includes(targetSymbol);
    if (meta.wildExcludes) return !meta.wildExcludes.includes(targetSymbol);
    return true;
  };

  const lineWins = [];
  let totalLinePayoutMultiplier = 0;

  for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, paylines.length); lineIdx++) {
    const path = paylines[lineIdx];
    const lineSymbols = [];
    for (let col = 0; col < reelsCount; col++) {
      lineSymbols.push(grid[col][path[col]]);
    }

    const s0 = lineSymbols[0];
    const lastCol = reelsCount - 1;
    const lastSymbol = lineSymbols[lastCol];
    const s0Meta = paytable[s0];

    // 1. Natural contiguous run length from reel 1
    let run = 1;
    for (let col = 1; col < reelsCount; col++) {
      if (lineSymbols[col] === s0) run++;
      else break;
    }

    let payout = 0;
    let wildUsed = false;

    if (run === reelsCount) {
      // Natural full match
      payout = (s0Meta && s0Meta.payout && s0Meta.payout[run - 1]) || 0;
    } else if (run === reelsCount - 1 && isWildFor(lastSymbol, s0)) {
      // A wild in the last position completes the match
      const fullPayout = (s0Meta && s0Meta.payout && s0Meta.payout[reelsCount - 1]) || 0;
      const penalty = (s0Meta && s0Meta.wildPenalty) || 0;
      payout = Math.max(0, fullPayout - penalty);
      wildUsed = true;
    } else if (s0Meta && s0Meta.payout && s0Meta.payout[run - 1] > 0) {
      // Partial match - only symbols with a nonzero partial payout (e.g. cherries) pay here
      payout = s0Meta.payout[run - 1];
    }

    // 2. Alone bonus: the last symbol has one defined, and it wasn't already used above
    // to complete a win (using it for both would double-pay the same wild).
    const lastMeta = paytable[lastSymbol];
    let aloneBonus = 0;
    if (lastMeta && lastMeta.aloneBonus && !wildUsed) {
      aloneBonus = lastMeta.aloneBonus;
    }

    const totalLinePayout = payout + aloneBonus;
    if (totalLinePayout > 0) {
      const winningPositions = [];
      for (let col = 0; col < run; col++) {
        winningPositions.push([col, path[col]]);
      }
      if (aloneBonus > 0 && !winningPositions.some(p => p[0] === lastCol)) {
        winningPositions.push([lastCol, path[lastCol]]);
      }

      lineWins.push({
        lineIndex: lineIdx,
        symbol: s0,
        count: run,
        payout: totalLinePayout,
        winningPositions,
        aloneBonus: aloneBonus > 0
      });
      totalLinePayoutMultiplier += totalLinePayout;
    }
  }

  return { lineWins, totalLinePayoutMultiplier };
}
```

- [ ] **Step 4: Run the verification script to confirm it passes**

Run: `node verify-wildlinewins.mjs`
Expected: every case prints `OK`, then `All checkWildLineWins cases passed.` — exit code 0.

- [ ] **Step 5: Delete the verification script and commit**

```bash
rm verify-wildlinewins.mjs
git add core/SlotMath.js
git commit -m "feat: add checkWildLineWins for reel-restricted dual-wild line pays"
```

---

### Task 3: Make `core/SlotEngine.js` payline-agnostic and fix hardcoded-5-reel bugs

**Files:**
- Modify: `core/SlotEngine.js`

**Interfaces:**
- Consumes: `checkWins`, `checkExpandingWins` from Task 1 (new signatures with `paylines` param).
- Produces: `SlotEngine` constructor now accepts `config.paylines` (required, no default), `config.wildSymbol` (default `null`), `config.scatterSymbol` (default `null`), `config.winEvaluator` (default `checkWins`). `forceWinResult('bigwin')` now generalized to any `reelsCount`/`rowsCount`.

- [ ] **Step 1: Update the import line**

In `core/SlotEngine.js`, line 2, change:

```js
import { checkWins, checkExpandingWins, PAYLINES, createSeededRng, generateTargetGrid } from './SlotMath.js';
```

to:

```js
import { checkWins, checkExpandingWins, createSeededRng, generateTargetGrid } from './SlotMath.js';
```

- [ ] **Step 2: Add the new config defaults**

In the constructor, find:

```js
    this.config = {
      reelsCount: 5,
      rowsCount: 3,
      paytable: {},
      reelStrips: [],
      onStateChange: () => {},
      onFreeSpinsTriggered: () => {},
      onScatterTrigger: (scatterCount) => {},
      onWin: () => {},
      ...config
    };
```

Replace with:

```js
    this.config = {
      reelsCount: 5,
      rowsCount: 3,
      paytable: {},
      reelStrips: [],
      // paylines has no default - every game must supply its own (see core/SlotMath.js).
      wildSymbol: null,
      scatterSymbol: null,
      winEvaluator: checkWins,
      onStateChange: () => {},
      onFreeSpinsTriggered: () => {},
      onScatterTrigger: (scatterCount) => {},
      onWin: () => {},
      ...config
    };
```

- [ ] **Step 3: Use `config.winEvaluator` and `config.paylines` in `evaluateSpinResult()`**

Find:

```js
    const results = checkWins(
      this.targetGrid, 
      this.config.paytable, 
      this.linesCount, 
      null,  // no wild symbol - book is scatter only
      'book'
    );
```

Replace with:

```js
    const results = this.config.winEvaluator(
      this.targetGrid,
      this.config.paytable,
      this.config.paylines,
      this.linesCount,
      this.config.wildSymbol,
      this.config.scatterSymbol
    );
```

- [ ] **Step 4: Pass `paylines` into the `checkExpandingWins` call**

A few lines further down in the same method, find:

```js
      const expandingResults = checkExpandingWins(
        this.targetGrid,
        this.expandingSymbol,
        this.config.paytable,
        this.linesCount,
        this.config.paytable
      );
```

Replace with:

```js
      const expandingResults = checkExpandingWins(
        this.targetGrid,
        this.expandingSymbol,
        this.config.paytable,
        this.config.paylines,
        this.linesCount,
        this.config.paytable
      );
```

- [ ] **Step 5: Fix `renderWinEffects()`'s hardcoded 5-reel loop**

Find (inside `renderWinEffects()`):

```js
      const path = PAYLINES[win.lineIndex];
      this.ctx.save();
      this.ctx.strokeStyle = this.getNeonColorForLine(win.lineIndex);
      this.ctx.lineWidth = 4;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      
      // Shadow glow
      this.ctx.shadowColor = this.ctx.strokeStyle;
      this.ctx.shadowBlur = 12;

      this.ctx.beginPath();
      for (let col = 0; col < 5; col++) {
        const row = path[col];
        const cx = this.reelsX + (col * this.symbolWidth) + (this.symbolWidth / 2);
        const cy = this.reelsY + (row * this.symbolHeight) + (this.symbolHeight / 2);
        if (col === 0) {
          this.ctx.moveTo(cx, cy);
        } else {
          this.ctx.lineTo(cx, cy);
        }
      }
      this.ctx.stroke();
      
      // Draw Line Tag numbers at start and end
      const startY = this.reelsY + (path[0] * this.symbolHeight) + (this.symbolHeight / 2);
      const endY = this.reelsY + (path[4] * this.symbolHeight) + (this.symbolHeight / 2);
```

Replace with:

```js
      const path = this.config.paylines[win.lineIndex];
      this.ctx.save();
      this.ctx.strokeStyle = this.getNeonColorForLine(win.lineIndex);
      this.ctx.lineWidth = 4;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      
      // Shadow glow
      this.ctx.shadowColor = this.ctx.strokeStyle;
      this.ctx.shadowBlur = 12;

      this.ctx.beginPath();
      for (let col = 0; col < this.config.reelsCount; col++) {
        const row = path[col];
        const cx = this.reelsX + (col * this.symbolWidth) + (this.symbolWidth / 2);
        const cy = this.reelsY + (row * this.symbolHeight) + (this.symbolHeight / 2);
        if (col === 0) {
          this.ctx.moveTo(cx, cy);
        } else {
          this.ctx.lineTo(cx, cy);
        }
      }
      this.ctx.stroke();
      
      // Draw Line Tag numbers at start and end
      const lastReel = this.config.reelsCount - 1;
      const startY = this.reelsY + (path[0] * this.symbolHeight) + (this.symbolHeight / 2);
      const endY = this.reelsY + (path[lastReel] * this.symbolHeight) + (this.symbolHeight / 2);
```

- [ ] **Step 6: Generalize `forceWinResult`'s `'bigwin'` branch**

Find the whole `forceWinResult` method:

```js
  forceWinResult(winType) {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;

    this.targetGrid = [];
    if (winType === 'scatter') {
      // Force 3 books on reels 1, 3, 5
      for (let col = 0; col < 5; col++) {
        const strip = this.config.reelStrips[col];
        const colSymbols = [this.getRandomSymbol(strip), this.getRandomSymbol(strip), this.getRandomSymbol(strip)];
        if (col === 0 || col === 2 || col === 4) {
          colSymbols[1] = 'book'; // Force book in middle
        }
        this.targetGrid.push(colSymbols);
      }
    } else if (winType === 'expanding') {
      // Force selected expanding symbol on 3 reels (e.g. 'tut' on 1, 3, 4)
      const sym = this.expandingSymbol || 'tut';
      for (let col = 0; col < 5; col++) {
        const strip = this.config.reelStrips[col];
        const colSymbols = [this.getRandomSymbol(strip), this.getRandomSymbol(strip), this.getRandomSymbol(strip)];
        if (col === 0 || col === 2 || col === 3) {
          colSymbols[Math.floor(Math.random() * 3)] = sym;
        }
        this.targetGrid.push(colSymbols);
      }
    } else if (winType === 'bigwin') {
      // Force line of 'tut'
      for (let col = 0; col < 5; col++) {
        this.targetGrid.push(['tut', 'tut', 'tut']);
      }
    }
    
    this.forcedTargetGrid = true;
    this.spin();
  }
```

Replace with:

```js
  forceWinResult(winType) {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;

    this.targetGrid = [];
    if (winType === 'scatter') {
      // Book-of-dead-specific: assumes a 5-reel layout with a scatter symbol named 'book'.
      // Only meaningful for games that configure one; fruit machine never calls this.
      for (let col = 0; col < 5; col++) {
        const strip = this.config.reelStrips[col];
        const colSymbols = [this.getRandomSymbol(strip), this.getRandomSymbol(strip), this.getRandomSymbol(strip)];
        if (col === 0 || col === 2 || col === 4) {
          colSymbols[1] = 'book'; // Force book in middle
        }
        this.targetGrid.push(colSymbols);
      }
    } else if (winType === 'expanding') {
      // Book-of-dead-specific: assumes a 5-reel layout with an expanding symbol.
      // Only meaningful for games that configure one; fruit machine never calls this.
      const sym = this.expandingSymbol || 'tut';
      for (let col = 0; col < 5; col++) {
        const strip = this.config.reelStrips[col];
        const colSymbols = [this.getRandomSymbol(strip), this.getRandomSymbol(strip), this.getRandomSymbol(strip)];
        if (col === 0 || col === 2 || col === 3) {
          colSymbols[Math.floor(Math.random() * 3)] = sym;
        }
        this.targetGrid.push(colSymbols);
      }
    } else if (winType === 'bigwin') {
      // Works for any grid shape: force every visible symbol to a single symbol picked
      // from reel 1's own strip, so it's guaranteed to actually exist on every reel.
      const firstLineSymbol = this.getRandomSymbol(this.config.reelStrips[0]);
      for (let col = 0; col < this.config.reelsCount; col++) {
        this.targetGrid.push(Array(this.config.rowsCount).fill(firstLineSymbol));
      }
    }
    
    this.forcedTargetGrid = true;
    this.spin();
  }
```

- [ ] **Step 7: Commit**

This task has no standalone Node-runnable verification (`SlotEngine` requires a `window`/`canvas` DOM environment). It's verified as part of Task 5's checkpoint once `bookbookbook/game.js` is updated to supply the new config fields.

```bash
git add core/SlotEngine.js
git commit -m "refactor: make SlotEngine payline-agnostic, generalize forceWinResult bigwin"
```

---

### Task 4: Thread `paylines`/`winEvaluator`/`wildSymbol`/`scatterSymbol` through `core/SpinSimulator.js`

**Files:**
- Modify: `core/SpinSimulator.js`
- Test: `verify-spinsimulator-generic.mjs` (repo root, temporary)

**Interfaces:**
- Consumes: `checkWildLineWins` from Task 2 (for the verification script only — not imported by `SpinSimulator.js` itself).
- Produces: `simulateSpins(config, ...)` now reads `config.paylines`, `config.winEvaluator` (default `checkWins`), `config.wildSymbol`, `config.scatterSymbol`. `tuneFrequencies(paytable, options)` gains `options.paylines`, `options.winEvaluator`, `options.wildSymbol`, `options.scatterSymbol`, threaded into the `config` object it builds for `simulateSpins`.

- [ ] **Step 1: Write the failing verification script**

Create `verify-spinsimulator-generic.mjs` at the repo root:

```js
import { simulateSpins } from './core/SpinSimulator.js';
import { checkWildLineWins, generateReel } from './core/SlotMath.js';

const PAYLINES3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 1, 2], [2, 1, 0]];
const PAYTABLE = {
  bar:    { payout: [0, 0, 10], frequency: 1 },
  clover: { payout: [0, 0, 4], frequency: 2, wildPenalty: 1 },
  star:   { payout: [0, 0, 0], frequency: 1, wild: true, wildExcludes: ['bar'] },
};

const reelStrips = [0, 1, 2].map((i) => generateReel(PAYTABLE, 100, 111 + i, i < 2 ? ['star'] : []));

const config = {
  reelsCount: 3,
  rowsCount: 3,
  paytable: PAYTABLE,
  reelStrips,
  paylines: PAYLINES3,
  winEvaluator: checkWildLineWins,
};

const results = simulateSpins(config, 20000, 1, 5);
console.assert(results.totalSpins === 20000, `expected 20000 spins, got ${results.totalSpins}`);
console.assert(typeof results.rtpRaw === 'number' && results.rtpRaw >= 0, 'rtpRaw should be a non-negative number');
console.log(`simulateSpins with checkWildLineWins: OK (rtp=${results.rtp})`);

// Regression: omitting winEvaluator/wildSymbol/scatterSymbol still runs the default checkWins path
const bookLikeConfig = {
  reelsCount: 3,
  rowsCount: 3,
  paytable: { x: { payout: [0, 0, 50], frequency: 1, paymode: 'line' } },
  reelStrips: [0, 1, 2].map((i) => generateReel({ x: { frequency: 1 } }, 50, 999 + i)),
  paylines: PAYLINES3,
};
const bookLikeResults = simulateSpins(bookLikeConfig, 5000, 1, 5);
console.assert(bookLikeResults.totalSpins === 5000, 'default checkWins path should still run');
console.log('simulateSpins default checkWins path: OK');

console.log('All SpinSimulator generalization checks passed.');
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node verify-spinsimulator-generic.mjs`
Expected: throws — `SpinSimulator.js` still calls `checkWins(targetGrid, simConfig.paytable, linesCount, null, 'book')`, which after Task 1's signature change misinterprets `linesCount` (a number) as the `paylines` array, throwing `Error: paylines must be a non-empty array`.

- [ ] **Step 3: Update `simulateSpins`' win-evaluation calls**

In `core/SpinSimulator.js`, find:

```js
  const simConfig = { ...config };
  simConfig.linesCount = linesCount;
  simConfig.betPerLine = betPerLine;
  simConfig.totalBet = betPerLine * linesCount;
  
  // Get configuration values with defaults
  const freeSpinsCount = simConfig.freeSpinsCount || 10;
  let expandingSymbol = simConfig.expandingSymbol || 'anubis';
```

Replace with:

```js
  const simConfig = { ...config };
  simConfig.linesCount = linesCount;
  simConfig.betPerLine = betPerLine;
  simConfig.totalBet = betPerLine * linesCount;

  const winEvaluator = simConfig.winEvaluator || checkWins;

  // Get configuration values with defaults
  const freeSpinsCount = simConfig.freeSpinsCount || 10;
  let expandingSymbol = simConfig.expandingSymbol || 'anubis';
```

Then find (inside `_runSingleSpin`):

```js
    // Evaluate wins using the existing math logic
    let winData = checkWins(
      targetGrid,
      simConfig.paytable,
      linesCount,
      null, // no wild symbol - book is scatter only
      'book'  // Scatter symbol for this specific game
    );
```

Replace with:

```js
    // Evaluate wins using this config's win evaluator (defaults to checkWins above)
    let winData = winEvaluator(
      targetGrid,
      simConfig.paytable,
      simConfig.paylines,
      linesCount,
      simConfig.wildSymbol ?? null,
      simConfig.scatterSymbol ?? null
    );
```

- [ ] **Step 4: Pass `paylines` into the `checkExpandingWins` call**

Find:

```js
    let expandingResults = null;
    if (isFreeSpin) {
      // Check for expanding wins using the configured expanding symbol and paytable
      expandingResults = checkExpandingWins(targetGrid, expandingSymbol, simConfig.paytable, linesCount);
    }
```

Replace with:

```js
    let expandingResults = null;
    if (isFreeSpin) {
      // Check for expanding wins using the configured expanding symbol and paytable
      expandingResults = checkExpandingWins(targetGrid, expandingSymbol, simConfig.paytable, simConfig.paylines, linesCount);
    }
```

- [ ] **Step 5: Thread the new options through `tuneFrequencies`**

Find the options destructuring near the top of `tuneFrequencies`:

```js
  const {
    reelsCount = 5,
    rowsCount = 3,
    reelLength = 220,
    reelSeeds = [1234, 567, 89, 765, 3321],
    betPerLine = 1,
    linesCount = 10,
    targetRtp = 96,
    rtpTolerancePct = 1.5,
    targetTriggerRatePct = 0.6,
    triggerRateTolerancePct = 0.15,
    trialSpins = 800000,
    trialsPerPoint = 3,
    maxIterations = 14,
    onProgress = null,
  } = options;
```

Replace with:

```js
  const {
    reelsCount = 5,
    rowsCount = 3,
    reelLength = 220,
    reelSeeds = [1234, 567, 89, 765, 3321],
    betPerLine = 1,
    linesCount = 10,
    paylines,
    winEvaluator,
    wildSymbol = null,
    scatterSymbol = null,
    targetRtp = 96,
    rtpTolerancePct = 1.5,
    targetTriggerRatePct = 0.6,
    triggerRateTolerancePct = 0.15,
    trialSpins = 800000,
    trialsPerPoint = 3,
    maxIterations = 14,
    onProgress = null,
  } = options;
```

Then find, inside `measure(pt)`:

```js
  function measure(pt) {
    const reelStrips = buildReelStrips(pt);
    const config = { reelsCount, rowsCount, paytable: pt, reelStrips };
```

Replace with:

```js
  function measure(pt) {
    const reelStrips = buildReelStrips(pt);
    const config = { reelsCount, rowsCount, paytable: pt, reelStrips, paylines, winEvaluator, wildSymbol, scatterSymbol };
```

- [ ] **Step 6: Run the verification script to confirm it passes**

Run: `node verify-spinsimulator-generic.mjs`
Expected: prints `simulateSpins with checkWildLineWins: OK (rtp=...)`, `simulateSpins default checkWins path: OK`, `All SpinSimulator generalization checks passed.` — exit code 0.

- [ ] **Step 7: Delete the verification script and commit**

```bash
rm verify-spinsimulator-generic.mjs
git add core/SpinSimulator.js
git commit -m "refactor: thread paylines/winEvaluator through SpinSimulator"
```

---

### Task 5: Update `games/bookbookbook/game.js` for the new core signatures; verify RTP preserved

**Files:**
- Modify: `games/bookbookbook/game.js`
- Test: `verify-book-rtp-baseline.mjs` (repo root, temporary)

**Interfaces:**
- Consumes: `SlotEngine` config additions from Task 3, `tuneFrequencies` options additions from Task 4.
- Produces: `games/bookbookbook/game.js` now has its own local `PAYLINES` constant; `bookbookbook` is fully working again after this task (Tasks 1-4 left it broken).

**Baseline for this task:** running bookbookbook's own simulation (1,000,000 base spins, `BET_PER_LINE=1`, `LINES_COUNT=10`, its real `PAYTABLE`/reel seeds) against the *current, unmodified* code gives **RTP ≈ 97.05%** (`rtpRaw` 0.970487, 5466 free-spins triggers out of 1,051,910 total spins including free spins). This was measured directly before writing this plan. Non-seeded `Math.random()` drives the simulation loop, so re-runs vary — treat anything in **96.0%–98.0%** at 1,000,000+ base spins as confirming no regression; a value far outside that band means something in Tasks 1-5 broke the win math.

- [ ] **Step 1: Update the import and add the local `PAYLINES` constant**

In `games/bookbookbook/game.js`, line 3, change:

```js
import { PAYLINES, generateReel } from '../../core/SlotMath.js';
```

to:

```js
import { generateReel } from '../../core/SlotMath.js';
```

Then, immediately after the existing constants block (`const LINES_COUNT = 10;`, before the `PAYTABLE` comment), add:

```js

// Payline definitions - previously lived in core/SlotMath.js as a shared default;
// each game now owns its own paylines so the core stays grid-shape-agnostic.
const PAYLINES = [
  [1, 1, 1, 1, 1], // Line 1: Horizontal Middle Row
  [0, 0, 0, 0, 0], // Line 2: Horizontal Top Row
  [2, 2, 2, 2, 2], // Line 3: Horizontal Bottom Row
  [0, 1, 2, 1, 0], // Line 4: V-Shape
  [2, 1, 0, 1, 2], // Line 5: Inverted V-Shape
  [0, 0, 1, 2, 2], // Line 6: Step Down-Up
  [2, 2, 1, 0, 0], // Line 7: Step Up-Down
  [1, 2, 2, 2, 1], // Line 8: U-Shape Bottom
  [1, 0, 0, 0, 1], // Line 9: U-Shape Top
  [0, 1, 0, 1, 0]  // Line 10: Zigzag
];
```

- [ ] **Step 2: Pass the new config fields to `SlotEngine`**

Find:

```js
  engine = new SlotEngine(canvas, {
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    symbolsConfig: themeAssets.symbolsConfig,
    spritesheetUrl: themeAssets.spritesheetUrl,
    
    onStateChange: (state) => handleStateChange(state),
    onScatterTrigger: (scatterCount, isInFreeSpins) => handleScatterTrigger(scatterCount, isInFreeSpins),
    onWin: (winInfo) => handleWin(winInfo)
  });
```

Replace with:

```js
  engine = new SlotEngine(canvas, {
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    paylines: PAYLINES,
    wildSymbol: null,
    scatterSymbol: 'book',
    symbolsConfig: themeAssets.symbolsConfig,
    spritesheetUrl: themeAssets.spritesheetUrl,
    
    onStateChange: (state) => handleStateChange(state),
    onScatterTrigger: (scatterCount, isInFreeSpins) => handleScatterTrigger(scatterCount, isInFreeSpins),
    onWin: (winInfo) => handleWin(winInfo)
  });
```

- [ ] **Step 3: Pass `paylines`/`scatterSymbol` into the tuning options**

Find, inside `startTuning()`:

```js
  const options = {
    // Grid shape, reel seeds, bet, and line count are fixed to whatever the live game
    // actually uses (see the shared constants near the top of this file) rather than
    // exposed as inputs - changing them would desync the tuner from PAYLINES/the real
    // game grid. Reel length is exposed since it's a legitimate balance lever that doesn't
    // break anything structural, and it must match REEL_LENGTH by default or the tuner
    // would be reasoning about a different virtual reel than the one the game actually spins.
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    reelSeeds: REEL_SEEDS,
    betPerLine: BET_PER_LINE,
    linesCount: LINES_COUNT,
    reelLength: parseInt(inputs.reelLength.value, 10) || REEL_LENGTH,
    targetRtp: parseFloat(inputs.targetRtp.value) || 96,
    targetTriggerRatePct: parseFloat(inputs.targetTriggerRatePct.value) || 0.6,
    trialSpins: parseInt(inputs.trialSpins.value, 10) || 300000,
    trialsPerPoint: parseInt(inputs.trialsPerPoint.value, 10) || 2,
    maxIterations: parseInt(inputs.maxIterations.value, 10) || 10,
  };
```

Replace with:

```js
  const options = {
    // Grid shape, reel seeds, bet, and line count are fixed to whatever the live game
    // actually uses (see the shared constants near the top of this file) rather than
    // exposed as inputs - changing them would desync the tuner from PAYLINES/the real
    // game grid. Reel length is exposed since it's a legitimate balance lever that doesn't
    // break anything structural, and it must match REEL_LENGTH by default or the tuner
    // would be reasoning about a different virtual reel than the one the game actually spins.
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paylines: PAYLINES,
    scatterSymbol: 'book',
    reelSeeds: REEL_SEEDS,
    betPerLine: BET_PER_LINE,
    linesCount: LINES_COUNT,
    reelLength: parseInt(inputs.reelLength.value, 10) || REEL_LENGTH,
    targetRtp: parseFloat(inputs.targetRtp.value) || 96,
    targetTriggerRatePct: parseFloat(inputs.targetTriggerRatePct.value) || 0.6,
    trialSpins: parseInt(inputs.trialSpins.value, 10) || 300000,
    trialsPerPoint: parseInt(inputs.trialsPerPoint.value, 10) || 2,
    maxIterations: parseInt(inputs.maxIterations.value, 10) || 10,
  };
```

- [ ] **Step 4: Write and run the RTP-preservation check**

Create `verify-book-rtp-baseline.mjs` at the repo root:

```js
import { simulateSpins } from './core/SpinSimulator.js';
import { generateReel } from './core/SlotMath.js';

const REELS_COUNT = 5;
const ROWS_COUNT = 3;
const REEL_LENGTH = 500;
const REEL_SEEDS = [1234, 567, 89, 765, 3321];
const BET_PER_LINE = 1;
const LINES_COUNT = 10;
const PAYLINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 2, 2, 2, 1], [1, 0, 0, 0, 1], [0, 1, 0, 1, 0]
];

const PAYTABLE = {
  book:     { payout: [0,  0,   2,   20,  200], frequency: 0.051, type: 'scatter', paymode: 'any',  wild: false, triggerFreeSpins: true,  friendlyName: 'Book of Books' },
  explorer: { payout: [0, 10, 100, 1000, 5000], frequency: 0.079, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'The Explorer' },
  tut:      { payout: [0,  5,  40,  400, 2000], frequency: 0.157, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Tutankhamun' },
  anubis:   { payout: [0,  5,  30,  100,  750], frequency: 0.234, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Anubis Guard' },
  scarab:   { payout: [0,  5,  30,  100,  750], frequency: 0.234, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Scarab Beetle' },
  ace:      { payout: [0,  0,   5,   40,  150], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Golden Ace' },
  king:     { payout: [0,  0,   5,   40,  150], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Pharaoh King' },
  queen:    { payout: [0,  0,   5,   30,  100], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Royal Queen' },
  jack:     { payout: [0,  0,   5,   30,  100], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Desert Jack' },
  ten:      { payout: [0,  0,   5,   30,  100], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Lucky Ten' },
};

const REEL_STRIPS = REEL_SEEDS.map(seed => generateReel(PAYTABLE, REEL_LENGTH, seed));

const config = {
  reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paytable: PAYTABLE, reelStrips: REEL_STRIPS,
  paylines: PAYLINES, wildSymbol: null, scatterSymbol: 'book',
};
const results = simulateSpins(config, 1000000, BET_PER_LINE, LINES_COUNT);
console.log(JSON.stringify({ rtp: results.rtp, rtpRaw: results.rtpRaw, freeSpinsTriggered: results.freeSpinsTriggered, totalSpins: results.totalSpins }, null, 2));

if (results.rtpRaw < 0.96 || results.rtpRaw > 0.98) {
  console.error(`RTP ${results.rtp} is outside the expected 96%-98% band - something broke.`);
  process.exit(1);
}
console.log('Book RTP preserved after refactor: OK');
```

Run: `node verify-book-rtp-baseline.mjs`
Expected: prints an RTP in the 96%-98% range (matching the ≈97.05% baseline captured before this plan) and `Book RTP preserved after refactor: OK` — exit code 0.

- [ ] **Step 5: Delete the verification script and commit**

```bash
rm verify-book-rtp-baseline.mjs
git add games/bookbookbook/game.js
git commit -m "refactor: update bookbookbook for payline-agnostic core (local PAYLINES const)"
```

- [ ] **Step 6: Manual smoke check**

Use the `run` skill to launch the app, open `games/bookbookbook/index.html`, and confirm: the page loads with no console errors, SPIN works, a win highlights the correct payline shape, and the paytable modal's payline-preview swatches render (proving the local `PAYLINES` constant is wired correctly end to end, not just in the Node-level check above).

---

### Task 6: Create `core/SimulationPanel.js`

**Files:**
- Create: `core/SimulationPanel.js`

**Interfaces:**
- Consumes: `tuneFrequencies` from `core/SpinSimulator.js` (Task 4's version).
- Produces:
  - `runSimulationAndRender({ engine, paytable, betPerLine, linesCount, numSpins, domRefs })`
  - `openTuneFrequenciesPanel({ paytable, tuneConfig, domRefs })`
  - `formatPaytableForCopy(paytable)`
  - `domRefs` shape (both functions): `{ btnSim, simModal, simStats, simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay }` (only `simModal` + `simStats` needed by `openTuneFrequenciesPanel`).
  - `tuneConfig` shape: `{ reelsCount, rowsCount, paylines, reelSeeds, betPerLine, linesCount, reelLength, winEvaluator, wildSymbol, scatterSymbol }`.

- [ ] **Step 1: Create the file**

Create `core/SimulationPanel.js`:

```js
// Shared RUN SIMULATION / TUNE FREQUENCIES dev-tooling UI, built on top of
// core/SpinSimulator.js's pure simulateSpins/tuneFrequencies functions.
// Every game's game.js calls into this instead of maintaining its own copy.
import { tuneFrequencies } from './SpinSimulator.js';

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function renderWinTable(counts, hitLabel, accentColor, emptyText) {
  const sortedKeys = Object.keys(counts).sort((a, b) => a - b);
  if (sortedKeys.length === 0) {
    return `<div style="color: #666; font-style: italic; font-size: 0.8em;">${emptyText}</div>`;
  }
  let html = `<table style="width: 100%; border-collapse: collapse; font-size: 0.95em;">`;
  html += `<thead><tr style="color: #888; font-size: 0.8em; text-transform: uppercase;">
              <th style="text-align: left; font-weight: normal; padding: 2px 4px 4px 0;">${hitLabel}</th>
              <th style="text-align: right; font-weight: normal; padding: 2px 4px 4px;">Wins</th>
              <th style="text-align: right; font-weight: normal; padding: 2px 4px 4px;">Avg Win</th>
              <th style="text-align: right; font-weight: normal; padding: 2px 0 4px;">Total Win</th>
            </tr></thead><tbody>`;
  sortedKeys.forEach(key => {
    const data = counts[key];
    const avg = data.totalAmount / data.count;
    html += `<tr>
                <td style="padding: 2px 4px 2px 0; color: ${accentColor};">${key}</td>
                <td style="text-align: right; padding: 2px 4px;">${data.count}</td>
                <td style="text-align: right; padding: 2px 4px;">$${fmt(avg)}</td>
                <td style="text-align: right; padding: 2px 0; font-weight: bold;">$${fmt(data.totalAmount)}</td>
              </tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

function createSection(title, symbols, symbolStats, paytable) {
  if (symbols.length === 0) return `<div style="color: #666; font-style: italic; font-size: 0.8em;">No wins found for ${title}</div>`;
  let sectionHtml = `<h4 style="margin: 15px 0 10px 0; color: #aaa; text-transform: uppercase; font-size: 0.75em; letter-spacing: 1px;">${title}</h4>`;
  sectionHtml += `<div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px;">`;

  symbols.forEach(symbol => {
    const stats = symbolStats[symbol] || { counts: {}, expanding: { counts: {} } };
    const friendlyName = paytable[symbol]?.friendlyName || symbol;
    const isScatter = paytable[symbol]?.type === 'scatter';

    sectionHtml += `<div style="border: 1px solid rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; background: rgba(255,255,255,0.05); font-size: 0.85em;">`;
    sectionHtml += `<strong style="display: block; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">${friendlyName}</strong>`;

    sectionHtml += `<div style="margin-bottom: 8px;">`;
    sectionHtml += `<span style="font-size: 0.7em; color: #999; text-transform: uppercase;">${isScatter ? 'Scatter Wins' : 'Normal Wins'}</span>`;
    sectionHtml += renderWinTable(stats.counts, 'Hits', '#ccc', isScatter ? 'No scatter wins' : 'No standard line wins');
    sectionHtml += `</div>`;

    if (stats.expanding && Object.keys(stats.expanding.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 8px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #ffd700; text-transform: uppercase;">Expanding Wins</span>`;
      sectionHtml += renderWinTable(stats.expanding.counts, 'Reels', '#ffd700', '');
      sectionHtml += `</div>`;
    }

    sectionHtml += `</div>`;
  });

  sectionHtml += `</div>`;
  return sectionHtml;
}

/**
 * Groups a paytable's symbols by their `type` field (in first-seen order, 'other' for
 * symbols with no type), for rendering one section per type in the win breakdown. This
 * is purely data-driven - it reflects whatever `type` values the caller's paytable uses,
 * with no hardcoded symbol or type name.
 */
function groupSymbolsByType(paytable) {
  const order = [];
  const groups = {};
  Object.keys(paytable).forEach(symbol => {
    const type = paytable[symbol].type || 'other';
    if (!groups[type]) {
      groups[type] = [];
      order.push(type);
    }
    groups[type].push(symbol);
  });
  return order.map(type => ({ type, symbols: groups[type] }));
}

/**
 * Runs engine.runSimulation() and renders the results (stats + detailed win breakdown)
 * into the given DOM refs.
 * @param {Object} args
 * @param {Object} args.engine - a SlotEngine instance (has .runSimulation())
 * @param {Object} args.paytable
 * @param {number} args.betPerLine
 * @param {number} args.linesCount
 * @param {number} [args.numSpins=1000000]
 * @param {Object} args.domRefs
 */
export function runSimulationAndRender({ engine, paytable, betPerLine, linesCount, numSpins = 1000000, domRefs }) {
  const { btnSim, simModal, simStats, simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay } = domRefs;

  btnSim.textContent = 'RUNNING...';
  btnSim.disabled = true;

  setTimeout(() => {
    try {
      const results = engine.runSimulation(numSpins, betPerLine, linesCount);

      if (simStats) simStats.style.display = '';
      simRtpDisplay.textContent = results.rtp;
      simTotalSpinsDisplay.textContent = results.totalSpins;
      simMaxWinDisplay.textContent = `$${results.maxWin}`;
      const pct = results.totalSpins > 0 ? (results.freeSpinsTriggered / results.totalSpins) * 100 : 0;
      simFreeSpinsDisplay.textContent = `${results.freeSpinsTriggered} (${pct.toFixed(2)}%)`;

      const symbolStats = {};
      results.detailedWins.forEach(win => {
        if (!symbolStats[win.symbol]) {
          symbolStats[win.symbol] = { counts: {}, expanding: { counts: {} } };
        }
        if (win.type === 'expanding') {
          if (!symbolStats[win.symbol].expanding.counts[win.count]) {
            symbolStats[win.symbol].expanding.counts[win.count] = { count: 0, totalAmount: 0 };
          }
          symbolStats[win.symbol].expanding.counts[win.count].count += 1;
          symbolStats[win.symbol].expanding.counts[win.count].totalAmount += win.winAmount;
        } else {
          if (!symbolStats[win.symbol].counts[win.count]) {
            symbolStats[win.symbol].counts[win.count] = { count: 0, totalAmount: 0 };
          }
          symbolStats[win.symbol].counts[win.count].count += 1;
          symbolStats[win.symbol].counts[win.count].totalAmount += win.winAmount;
        }
      });

      let detailsContainer = simModal.querySelector('#sim-details');
      if (!detailsContainer) {
        detailsContainer = document.createElement('div');
        detailsContainer.id = 'sim-details';
        detailsContainer.style.marginTop = '20px';
        detailsContainer.style.padding = '15px';
        detailsContainer.style.background = 'rgba(255, 255, 255, 0.1)';
        detailsContainer.style.borderRadius = '12px';
        detailsContainer.style.fontSize = '0.9em';
        simModal.appendChild(detailsContainer);
      } else {
        detailsContainer.innerHTML = '';
      }

      let detailsHtml = '<h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Detailed Win Breakdown</h3>';
      groupSymbolsByType(paytable).forEach(({ type, symbols }) => {
        const title = type.charAt(0).toUpperCase() + type.slice(1) + ' Symbols';
        detailsHtml += createSection(title, symbols, symbolStats, paytable);
      });
      detailsContainer.innerHTML = detailsHtml;

      simModal.style.display = 'block';
      simModal.style.maxWidth = '1200px';
      simModal.style.width = '95%';
    } catch (error) {
      console.error('Simulation failed:', error);
      alert('Error running simulation');
    } finally {
      btnSim.textContent = 'RUN SIMULATION';
      btnSim.disabled = false;
    }
  }, 50);
}

/**
 * Formats a paytable back out as a paste-ready `const PAYTABLE = { ... }` literal,
 * column-aligned. Field-agnostic: formats whichever scalar/array/boolean fields are
 * present (union across all symbols, first-seen order), so it works unchanged for
 * paytables with different field sets. `friendlyName` (if present) always renders last.
 */
export function formatPaytableForCopy(paytable) {
  const symbols = Object.keys(paytable);
  if (symbols.length === 0) return 'const PAYTABLE = {};';

  const keyWidth = Math.max(...symbols.map(s => s.length + 1));

  const fieldNames = [];
  symbols.forEach(s => {
    Object.keys(paytable[s]).forEach(field => {
      if (field !== 'payout' && field !== 'friendlyName' && !fieldNames.includes(field)) {
        fieldNames.push(field);
      }
    });
  });

  const payoutLen = paytable[symbols[0]].payout.length;
  const payoutColWidths = Array.from({ length: payoutLen }, (_, col) =>
    Math.max(...symbols.map(s => String(paytable[s].payout[col]).length))
  );
  const fmtPayout = (arr) =>
    '[' + arr.map((v, i) => String(v).padStart(payoutColWidths[i])).join(', ') + ']';

  const renderValue = (value) => {
    if (Array.isArray(value)) return `[${value.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ')}]`;
    if (typeof value === 'string') return `'${value}'`;
    return String(value);
  };

  const fmtField = (fieldName) => {
    const rendered = {};
    symbols.forEach(s => {
      rendered[s] = (fieldName in paytable[s]) ? `${fieldName}: ${renderValue(paytable[s][fieldName])},` : '';
    });
    const width = Math.max(...symbols.map(s => rendered[s].length));
    const padded = {};
    symbols.forEach(s => { padded[s] = rendered[s].padEnd(width); });
    return padded;
  };

  const fieldColumns = fieldNames.map(fmtField);

  const lines = symbols.map(symbol => {
    const data = paytable[symbol];
    const keyPart = `${symbol}:`.padEnd(keyWidth);
    const fieldsPart = fieldColumns.map(col => col[symbol]).filter(s => s.length > 0).join(' ');
    const namePart = data.friendlyName !== undefined ? ` friendlyName: '${data.friendlyName}'` : '';
    return `  ${keyPart} { payout: ${fmtPayout(data.payout)}, ${fieldsPart}${namePart} },`;
  });

  return `const PAYTABLE = {\n${lines.join('\n')}\n};`;
}

/**
 * Opens (or reuses) the frequency auto-balancer panel (SpinSimulator.js's tuneFrequencies)
 * with inputs for the tuning targets, showing live iteration-by-iteration progress. Only
 * ever reports a suggestion - never mutates the caller's live paytable/reels itself
 * (applying a result means regenerating reel strips, a deliberate source change).
 * @param {Object} args
 * @param {Object} args.paytable
 * @param {Object} args.tuneConfig - { reelsCount, rowsCount, paylines, reelSeeds, betPerLine, linesCount, reelLength, winEvaluator, wildSymbol, scatterSymbol }
 * @param {Object} args.domRefs - { simModal, simStats }
 */
export function openTuneFrequenciesPanel({ paytable, tuneConfig, domRefs }) {
  const { simModal, simStats } = domRefs;
  let tuneContainer = simModal.querySelector('#tune-details');
  if (!tuneContainer) {
    tuneContainer = document.createElement('div');
    tuneContainer.id = 'tune-details';
    tuneContainer.style.marginTop = '20px';
    tuneContainer.style.padding = '15px';
    tuneContainer.style.background = 'rgba(255, 255, 255, 0.1)';
    tuneContainer.style.borderRadius = '12px';
    tuneContainer.style.fontSize = '0.9em';
    simModal.appendChild(tuneContainer);

    tuneContainer.innerHTML = `
      <h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Frequency Tuner</h3>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px;">
        <label style="font-size: 0.8em; color: #ccc;">Target RTP (%)<br>
          <input id="tune-target-rtp" type="number" value="96" step="0.5" min="1" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Target Trigger Rate (%)<br>
          <input id="tune-target-trigger" type="number" value="0.6" step="0.05" min="0.01" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Reel Length<br>
          <input id="tune-reel-length" type="number" value="${tuneConfig.reelLength}" step="10" min="30" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Trial Spins / Candidate<br>
          <input id="tune-trial-spins" type="number" value="300000" step="50000" min="10000" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Trials Averaged / Candidate<br>
          <input id="tune-trials-per-point" type="number" value="2" step="1" min="1" max="10" style="width: 100%; margin-top: 4px;">
        </label>
        <label style="font-size: 0.8em; color: #ccc;">Max Iterations / Phase<br>
          <input id="tune-max-iterations" type="number" value="10" step="1" min="3" max="30" style="width: 100%; margin-top: 4px;">
        </label>
      </div>
      <button id="tune-start-btn" class="btn-close-sim">START TUNING</button>
      <div id="tune-progress-log" style="display: none; margin-top: 12px; max-height: 160px; overflow-y: auto; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;"></div>
      <div id="tune-results"></div>
    `;
    tuneContainer.querySelector('#tune-start-btn').addEventListener('click', () => startTuning({ paytable, tuneConfig, tuneContainer }));
  }

  if (simStats) simStats.style.display = 'none';

  simModal.style.display = 'block';
  simModal.style.maxWidth = '900px';
  simModal.style.width = '95%';
}

async function startTuning({ paytable, tuneConfig, tuneContainer }) {
  const startBtn = tuneContainer.querySelector('#tune-start-btn');
  const logEl = tuneContainer.querySelector('#tune-progress-log');
  const resultsEl = tuneContainer.querySelector('#tune-results');
  const inputs = {
    targetRtp: tuneContainer.querySelector('#tune-target-rtp'),
    targetTriggerRatePct: tuneContainer.querySelector('#tune-target-trigger'),
    reelLength: tuneContainer.querySelector('#tune-reel-length'),
    trialSpins: tuneContainer.querySelector('#tune-trial-spins'),
    trialsPerPoint: tuneContainer.querySelector('#tune-trials-per-point'),
    maxIterations: tuneContainer.querySelector('#tune-max-iterations'),
  };

  const options = {
    reelsCount: tuneConfig.reelsCount,
    rowsCount: tuneConfig.rowsCount,
    paylines: tuneConfig.paylines,
    reelSeeds: tuneConfig.reelSeeds,
    betPerLine: tuneConfig.betPerLine,
    linesCount: tuneConfig.linesCount,
    winEvaluator: tuneConfig.winEvaluator,
    wildSymbol: tuneConfig.wildSymbol,
    scatterSymbol: tuneConfig.scatterSymbol,
    reelLength: parseInt(inputs.reelLength.value, 10) || tuneConfig.reelLength,
    targetRtp: parseFloat(inputs.targetRtp.value) || 96,
    targetTriggerRatePct: parseFloat(inputs.targetTriggerRatePct.value) || 0.6,
    trialSpins: parseInt(inputs.trialSpins.value, 10) || 300000,
    trialsPerPoint: parseInt(inputs.trialsPerPoint.value, 10) || 2,
    maxIterations: parseInt(inputs.maxIterations.value, 10) || 10,
  };

  Object.values(inputs).forEach(el => { el.disabled = true; });
  startBtn.disabled = true;
  startBtn.textContent = 'TUNING...';
  resultsEl.innerHTML = '';
  logEl.style.display = 'block';
  logEl.innerHTML = '';

  const appendLog = (line) => {
    const row = document.createElement('div');
    row.textContent = line;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  };

  try {
    const { paytable: tunedPaytable, rtp, triggerRatePct, diagnostics } = await tuneFrequencies(paytable, {
      ...options,
      onProgress: (phase, i, mult, r, best) => {
        const label = phase === 'scatter' ? 'Scatter frequency' : 'Premium/regular split';
        appendLog(`[${label} ${i + 1}] RTP=${r.rtp.toFixed(2)}%  trigger=${r.triggerRate.toFixed(3)}%  (best so far: err=${best.error.toFixed(4)})`);
      }
    });

    appendLog(`Done. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%`);
    console.log('Frequency tuner diagnostics:', diagnostics);

    let html = `<p style="font-size: 0.85em; color: #ccc; margin: 12px 0 8px;">Achieved RTP: <strong>${rtp.toFixed(2)}%</strong> &nbsp;|&nbsp; Free spin trigger rate: <strong>${triggerRatePct.toFixed(3)}%</strong> (1 in ${(100 / triggerRatePct).toFixed(0)})</p>`;
    html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">`;
    html += `<thead><tr style="color: #888; font-size: 0.8em; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.15);">
                <th style="text-align: left; padding: 4px;">Symbol</th>
                <th style="text-align: left; padding: 4px;">Type</th>
                <th style="text-align: right; padding: 4px;">Current Freq</th>
                <th style="text-align: right; padding: 4px;">Suggested Freq</th>
                <th style="text-align: right; padding: 4px;">Δ</th>
              </tr></thead><tbody>`;
    Object.keys(paytable).forEach(symbol => {
      const current = paytable[symbol].frequency;
      const suggested = tunedPaytable[symbol].frequency;
      const delta = suggested - current;
      const deltaColor = Math.abs(delta) < 0.001 ? '#888' : (delta > 0 ? '#7fd97f' : '#e67f7f');
      html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                  <td style="padding: 4px;">${paytable[symbol].friendlyName || symbol}</td>
                  <td style="padding: 4px; color: #999;">${paytable[symbol].type}</td>
                  <td style="text-align: right; padding: 4px;">${current.toFixed(4)}</td>
                  <td style="text-align: right; padding: 4px; font-weight: bold;">${suggested.toFixed(4)}</td>
                  <td style="text-align: right; padding: 4px; color: ${deltaColor};">${delta >= 0 ? '+' : ''}${delta.toFixed(4)}</td>
                </tr>`;
    });
    html += `</tbody></table>`;
    html += `<p style="font-size: 0.75em; color: #888; margin-top: 10px;">This is a suggestion only - apply it by editing PAYTABLE's frequency values in game.js and reloading, so REEL_STRIPS regenerates from the new weights.</p>`;

    html += `<div style="margin-top: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">Copy-paste ready PAYTABLE</span>
                  <button id="tune-copy-btn" class="btn-icon btn-sim-btn" style="padding: 4px 10px; font-size: 0.75em;">COPY</button>
                </div>
                <textarea id="tune-paytable-output" readonly style="width: 100%; height: 200px; box-sizing: border-box; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.4); color: #ddd; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 8px; resize: vertical;"></textarea>
              </div>`;

    resultsEl.innerHTML = html;

    const paytableOutput = resultsEl.querySelector('#tune-paytable-output');
    paytableOutput.value = formatPaytableForCopy(tunedPaytable);

    const copyBtn = resultsEl.querySelector('#tune-copy-btn');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(paytableOutput.value);
      } catch (err) {
        paytableOutput.select();
      }
      const original = copyBtn.textContent;
      copyBtn.textContent = 'COPIED!';
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    });
  } catch (error) {
    console.error('Frequency tuning failed:', error);
    appendLog(`Error: ${error.message}`);
  } finally {
    Object.values(inputs).forEach(el => { el.disabled = false; });
    startBtn.disabled = false;
    startBtn.textContent = 'START TUNING';
  }
}
```

- [ ] **Step 2: Commit**

This file has no standalone Node-runnable test (it's pure DOM-manipulation code with no exported pure-logic function worth isolating beyond `formatPaytableForCopy`, whose behavior is exercised in Task 7's manual check once it's wired into a real page). Verification happens in Task 7.

```bash
git add core/SimulationPanel.js
git commit -m "feat: extract shared RUN SIMULATION / TUNE FREQUENCIES UI into core/SimulationPanel.js"
```

---

### Task 7: Rewire `games/bookbookbook/game.js` to use `core/SimulationPanel.js`

**Files:**
- Modify: `games/bookbookbook/game.js`

**Interfaces:**
- Consumes: `runSimulationAndRender`, `openTuneFrequenciesPanel`, `formatPaytableForCopy` from Task 6.
- Produces: `runSimulation()`, `openTunePanel()`, `startTuning()`, `formatPaytableForCopy()` are deleted from this file.

- [ ] **Step 1: Add the import**

At the top of `games/bookbookbook/game.js`, add a new import line after the existing `tuneFrequencies` import:

```js
import { SlotEngine } from '../../core/SlotEngine.js';
import { generateReel } from '../../core/SlotMath.js';
import { tuneFrequencies } from '../../core/SpinSimulator.js';
import { runSimulationAndRender, openTuneFrequenciesPanel } from '../../core/SimulationPanel.js';
```

(The `tuneFrequencies` import can actually be deleted too, since only `SimulationPanel.js` calls it now — remove that line entirely, leaving just the new `SimulationPanel.js` import.)

- [ ] **Step 2: Delete the four extracted functions**

Delete, in full, from `games/bookbookbook/game.js`:
- `runSimulation()` (the whole function, from `function runSimulation() {` to its closing `}`)
- `openTunePanel()` (the whole function)
- `formatPaytableForCopy()` (the whole function)
- `startTuning()` (the whole async function)

- [ ] **Step 3: Replace their call sites**

Find:

```js
  if (btnSim) {
    btnSim.addEventListener('click', runSimulation);
  }
  if (btnTune) {
    btnTune.addEventListener('click', openTunePanel);
  }
```

Replace with:

```js
  if (btnSim) {
    btnSim.addEventListener('click', () => {
      runSimulationAndRender({
        engine,
        paytable: PAYTABLE,
        betPerLine: BET_PER_LINE,
        linesCount: LINES_COUNT,
        numSpins: 1000000,
        domRefs: { btnSim, simModal, simStats, simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay },
      });
    });
  }
  if (btnTune) {
    btnTune.addEventListener('click', () => {
      openTuneFrequenciesPanel({
        paytable: PAYTABLE,
        tuneConfig: {
          reelsCount: REELS_COUNT,
          rowsCount: ROWS_COUNT,
          paylines: PAYLINES,
          scatterSymbol: 'book',
          reelSeeds: REEL_SEEDS,
          betPerLine: BET_PER_LINE,
          linesCount: LINES_COUNT,
          reelLength: REEL_LENGTH,
        },
        domRefs: { simModal, simStats },
      });
    });
  }
```

- [ ] **Step 4: Manual verification via the `run` skill**

Use the `run` skill to launch `games/bookbookbook/index.html`. Confirm:
- RUN SIMULATION opens the modal, shows RTP/total spins/max win/free spins stats, and a "Detailed Win Breakdown" with a "Scatter Symbols" section (containing `book`) and a "Premium Symbols" section — the exact same content as before the extraction, just now rendered via `core/SimulationPanel.js`.
- TUNE FREQUENCIES opens its panel, START TUNING runs and produces a results table + a non-empty "Copy-paste ready PAYTABLE" textarea.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add games/bookbookbook/game.js
git commit -m "refactor: rewire bookbookbook to use core/SimulationPanel.js"
```

---

### Task 8: Determine fruit machine symbol frequencies for 96% RTP

This task's deliverable is a set of concrete `frequency` numbers to hardcode into the fruit machine's `PAYTABLE` in Task 10 — the same "run the tuner once, hand-copy the result" workflow bookbookbook's own `PAYTABLE` comment documents using.

**Files:**
- Test: `tune-fruitmachine-tmp.mjs` (repo root, temporary)

**Interfaces:**
- Consumes: `checkWildLineWins` (Task 2), `generateReel` (unchanged, already generic).
- Produces: the frequency values below, used directly in Task 10. No file changes in this task.

- [ ] **Step 1: Write and run the offline tuning script**

This uses `checkWildLineWins` directly (not yet wired through `tuneFrequencies`/`SlotEngine`, which need the real fruit machine `game.js` to exist) to find a `bar` vs. everything-else frequency split that hits 96% RTP, holding total reel weight constant. `bar` is the only `type: 'premium'` symbol — everything else (including `star`/`strawberry`) is `type: 'other'` and gets scaled together as a single pool, mirroring the exact mechanism `tuneFrequencies`'s no-scatter fallback path already implements.

Create `tune-fruitmachine-tmp.mjs` at the repo root:

```js
import { generateReel } from './core/SlotMath.js';

const PAYLINES = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 1, 2], [2, 1, 0]];

function checkWildLineWins(grid, paytable, paylines, activeLinesCount) {
  const reelsCount = grid.length;
  const isWildFor = (wildSymbolName, targetSymbol) => {
    const meta = paytable[wildSymbolName];
    if (!meta || !meta.wild) return false;
    if (meta.wildOnly) return meta.wildOnly.includes(targetSymbol);
    if (meta.wildExcludes) return !meta.wildExcludes.includes(targetSymbol);
    return true;
  };
  let totalLinePayoutMultiplier = 0;
  for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, paylines.length); lineIdx++) {
    const path = paylines[lineIdx];
    const lineSymbols = [];
    for (let col = 0; col < reelsCount; col++) lineSymbols.push(grid[col][path[col]]);
    const s0 = lineSymbols[0];
    const lastCol = reelsCount - 1;
    const lastSymbol = lineSymbols[lastCol];
    const s0Meta = paytable[s0];
    let run = 1;
    for (let col = 1; col < reelsCount; col++) {
      if (lineSymbols[col] === s0) run++; else break;
    }
    let payout = 0, wildUsed = false;
    if (run === reelsCount) {
      payout = (s0Meta && s0Meta.payout && s0Meta.payout[run - 1]) || 0;
    } else if (run === reelsCount - 1 && isWildFor(lastSymbol, s0)) {
      const fullPayout = (s0Meta && s0Meta.payout && s0Meta.payout[reelsCount - 1]) || 0;
      const penalty = (s0Meta && s0Meta.wildPenalty) || 0;
      payout = Math.max(0, fullPayout - penalty);
      wildUsed = true;
    } else if (s0Meta && s0Meta.payout && s0Meta.payout[run - 1] > 0) {
      payout = s0Meta.payout[run - 1];
    }
    const lastMeta = paytable[lastSymbol];
    let aloneBonus = 0;
    if (lastMeta && lastMeta.aloneBonus && !wildUsed) aloneBonus = lastMeta.aloneBonus;
    totalLinePayoutMultiplier += payout + aloneBonus;
  }
  return { totalLinePayoutMultiplier };
}

const REELS_COUNT = 3, ROWS_COUNT = 3, REEL_LENGTH = 300;
const REEL_SEEDS = [1234, 567, 89];
const BET_PER_LINE = 1, LINES_COUNT = 5;

const BASE = {
  bar:        { payout: [0, 0, 10],          type: 'premium', baseFreq: 1 },
  clover:     { payout: [0, 0, 4],  wildPenalty: 1, type: 'other', baseFreq: 6 },
  pear:       { payout: [0, 0, 3],           type: 'other', baseFreq: 8 },
  melon:      { payout: [0, 0, 3],           type: 'other', baseFreq: 8 },
  grapes:     { payout: [0, 0, 2],  wildPenalty: 1, type: 'other', baseFreq: 10 },
  plum:       { payout: [0, 0, 2],           type: 'other', baseFreq: 10 },
  orange:     { payout: [0, 0, 1.6],         type: 'other', baseFreq: 14 },
  cherries:   { payout: [0.4, 0.8, 1.6],     type: 'other', baseFreq: 20 },
  star:       { payout: [0, 0, 0], wild: true, wildExcludes: ['cherries'], type: 'other', baseFreq: 6 },
  strawberry: { payout: [0, 0, 0], wild: true, wildOnly: ['cherries'], aloneBonus: 0.8, type: 'other', baseFreq: 5 },
};

function buildPaytable(scaleFactors) {
  const pt = {};
  for (const [sym, meta] of Object.entries(BASE)) {
    const scale = meta.type === 'premium' ? scaleFactors.premium : scaleFactors.other;
    pt[sym] = { ...meta, frequency: meta.baseFreq * scale };
  }
  return pt;
}

function buildReelStrips(pt) {
  return REEL_SEEDS.map((seed, i) => generateReel(pt, REEL_LENGTH, seed, i < 2 ? ['star', 'strawberry'] : []));
}

function simulate(pt, numSpins) {
  const reelStrips = buildReelStrips(pt);
  let totalBet = 0, totalWin = 0;
  for (let i = 0; i < numSpins; i++) {
    const grid = [];
    for (let col = 0; col < REELS_COUNT; col++) {
      const strip = reelStrips[col];
      const stop = Math.floor(Math.random() * strip.length);
      const reelSymbols = [];
      for (let row = 0; row < ROWS_COUNT; row++) reelSymbols.push(strip[(stop + row) % strip.length]);
      grid.push(reelSymbols);
    }
    totalBet += BET_PER_LINE * LINES_COUNT;
    totalWin += checkWildLineWins(grid, pt, PAYLINES, LINES_COUNT).totalLinePayoutMultiplier * BET_PER_LINE;
  }
  return (totalWin / totalBet) * 100;
}

const otherBaseTotal = Object.values(BASE).filter(m => m.type === 'other').reduce((s, m) => s + m.baseFreq, 0);
const premiumBaseTotal = Object.values(BASE).filter(m => m.type === 'premium').reduce((s, m) => s + m.baseFreq, 0);
const totalWeightTarget = premiumBaseTotal + otherBaseTotal;

function scalesFor(premiumMult) {
  const premiumWeight = premiumBaseTotal * premiumMult;
  const otherWeight = totalWeightTarget - premiumWeight;
  return { premium: premiumMult, other: otherWeight / otherBaseTotal };
}

let lo = 0.2, hi = 60, best = null;
for (let i = 0; i < 16; i++) {
  const mid = Math.sqrt(lo * hi);
  const scales = scalesFor(mid);
  if (scales.other <= 0) { hi = mid; continue; }
  const pt = buildPaytable(scales);
  const rtp = simulate(pt, 400000);
  const error = Math.abs(rtp - 96);
  if (!best || error < best.error) best = { mid, scales, rtp, error, pt };
  console.log(`iter ${i}: premiumMult=${mid.toFixed(3)} otherScale=${scales.other.toFixed(4)} rtp=${rtp.toFixed(2)}%`);
  if (error < 0.3) break;
  if (rtp < 96) lo = mid; else hi = mid;
}

console.log('Final frequencies:');
for (const [sym, meta] of Object.entries(best.pt)) {
  console.log(`  ${sym}: ${meta.frequency.toFixed(3)}`);
}
const finalRtp = simulate(best.pt, 2000000);
console.log(`Final verification RTP at 2M spins: ${finalRtp.toFixed(2)}%`);
```

Run: `node tune-fruitmachine-tmp.mjs`

**This has already been run once while writing this plan**, converging to (values will vary slightly run to run since the tuning simulation itself uses non-seeded `Math.random()` — treat the numbers below as the ones to actually use, already validated at ~96% RTP over 2,000,000 spins):

```
bar:        35.643
clover:      3.611
pear:        4.814
melon:       4.814
grapes:      6.018
plum:        6.018
orange:      8.425
cherries:   12.036
star:        3.611
strawberry:  3.009
```
(Final verification RTP at 2,000,000 spins: 96.10%.)

If re-running produces a materially different result (RTP not landing within roughly 95%-97% at the 2,000,000-spin check), use the re-run's own output instead — the numbers above are a snapshot, not a hardcoded requirement.

Note on `bar`'s frequency being unexpectedly high (worth flagging, not fixing): with only 5 lines on 3 reels, no partial pays for most symbols, and a payout ceiling of just 10x, hitting 96% RTP mathematically requires `bar` to appear far more often than a "rare jackpot" symbol would in a wider-reel game — it ends up roughly as common as any other symbol. This is a real consequence of the payout table's shape (all values came directly from the approved design spec), not a bug. It's freely adjustable later via the TUNE FREQUENCIES panel or by hand-editing `PAYTABLE`'s `frequency` values, exactly as intended.

- [ ] **Step 2: Delete the temporary script**

```bash
rm tune-fruitmachine-tmp.mjs
```

(Nothing to commit — this task produces numbers used in Task 10, not a file change.)

---

### Task 9: Create `games/fruitmachine/index.html`

**Files:**
- Create: `games/fruitmachine/index.html`

**Interfaces:**
- Produces: a page with `<canvas id="game-canvas">`, dashboard controls (`btn-spin`, `bet-minus`/`bet-plus`/`bet-value`, `btn-auto`, `btn-turbo`, `btn-mute`, `btn-paytable`), a paytable modal (`modal-paytable`, `paytable-grid-content`, `paylines-preview`, `btn-paytable-ok`), a sim-tools modal (`sim-modal`, `sim-stats`, `sim-rtp`, `sim-total-spins`, `sim-max-win`, `sim-free-spins`, `btn-close-sim`) and its trigger buttons (`btn-sim`, `btn-tune`), and a `<script type="module" src="./game.js">`. These IDs must match exactly what `core/SimulationPanel.js` (Task 6) and `games/fruitmachine/game.js` (Task 10) expect.

- [ ] **Step 1: Create the file**

Create `games/fruitmachine/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lucky Fruits - Classic Slot Machine</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700;900&family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">

  <style>
    :root {
      --gold: #ffd23f;
      --gold-glow: rgba(255, 210, 63, 0.4);
      --cabinet: #4a0e0e;
      --cabinet-light: #6b1414;
      --red: #c0392b;
      --text: #fff3d6;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
    }

    body {
      background-color: #1a0505;
      color: var(--text);
      font-family: 'Outfit', sans-serif;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at center, #3a0f0f 0%, #100303 100%);
    }

    .cabinet-container {
      position: relative;
      width: 100%;
      max-width: 820px;
      height: 100%;
      max-height: 640px;
      display: flex;
      flex-direction: column;
      border: 4px solid var(--gold);
      border-radius: 16px;
      background: var(--cabinet);
      box-shadow: 0 0 40px rgba(0,0,0,0.8), 0 0 20px var(--gold-glow);
      overflow: hidden;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 24px;
      background: linear-gradient(180deg, rgba(74,14,14,0.9) 0%, rgba(26,5,5,0.9) 100%);
      border-bottom: 2px solid rgba(255, 210, 63, 0.3);
      z-index: 10;
    }

    .title-logo {
      font-family: 'Cinzel', serif;
      font-size: 26px;
      font-weight: 900;
      color: #fff;
      text-shadow: 0 0 10px var(--gold), 0 0 20px var(--gold-glow);
      letter-spacing: 2px;
    }

    .title-logo span { color: var(--gold); }

    .top-controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }

    .btn-icon {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 210, 63, 0.3);
      color: var(--text);
      padding: 8px 14px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .btn-icon:hover { background: var(--gold-glow); color: #fff; border-color: var(--gold); }
    .btn-icon.active { background: var(--gold); color: #000; border-color: #fff; }

    .btn-sim-btn { border-color: var(--red) !important; color: #ff8a7a !important; }
    .btn-sim-btn:hover { background: rgba(192, 57, 43, 0.2) !important; color: #fff !important; }

    .game-viewport { flex: 1; position: relative; background-color: #0d0202; overflow: hidden; }

    canvas {
      display: block;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
    }

    .game-ticker {
      position: absolute;
      top: 10px;
      left: 20px;
      font-size: 12px;
      font-weight: 600;
      color: var(--gold);
      text-transform: uppercase;
      letter-spacing: 1px;
      background: rgba(0,0,0,0.6);
      padding: 4px 12px;
      border-radius: 4px;
      pointer-events: none;
    }

    .dashboard {
      display: grid;
      grid-template-columns: 2fr 1.2fr 2fr 1fr;
      align-items: center;
      padding: 16px 24px;
      background: rgba(26, 5, 5, 0.95);
      border-top: 2px solid rgba(255, 210, 63, 0.3);
      gap: 16px;
      z-index: 10;
    }

    .dashboard-panel { display: flex; gap: 12px; align-items: center; }
    .bet-container { display: flex; flex-direction: column; gap: 4px; }

    .dashboard-label {
      font-size: 11px;
      color: #c9a97a;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 1px;
    }

    .dashboard-value { font-size: 20px; font-weight: 800; color: #fff; }

    .bet-adjuster {
      display: flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      overflow: hidden;
    }

    .btn-adjust {
      background: transparent;
      border: none;
      color: var(--gold);
      width: 36px;
      height: 36px;
      font-size: 18px;
      font-weight: bold;
      cursor: pointer;
    }

    .btn-adjust:hover { background: rgba(255, 210, 63, 0.15); }

    .bet-display-value { width: 60px; text-align: center; font-size: 18px; font-weight: bold; color: #fff; }

    .spin-section { display: flex; justify-content: center; }

    .btn-spin {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      border: 4px solid var(--gold);
      background: radial-gradient(circle, #ffe27a 0%, #d19a1e 100%);
      color: #3a0f0f;
      font-family: 'Cinzel', serif;
      font-weight: 900;
      font-size: 15px;
      cursor: pointer;
      box-shadow: 0 0 15px var(--gold-glow), inset 0 2px 5px rgba(255,255,255,0.6);
      transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      outline: none;
    }

    .btn-spin:hover { transform: scale(1.08); box-shadow: 0 0 25px var(--gold), inset 0 2px 5px rgba(255,255,255,0.6); }
    .btn-spin:active { transform: scale(0.95); }

    .btn-spin.spinning {
      background: radial-gradient(circle, #ff6b6b 0%, #c92a2a 100%);
      border-color: #ffa8a8;
      color: #fff;
      font-size: 13px;
    }

    .aux-controls-container { display: flex; gap: 8px; justify-content: flex-end; }

    .modal-overlay {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(5, 2, 2, 0.85);
      display: flex; align-items: center; justify-content: center;
      z-index: 100; opacity: 0; pointer-events: none;
      transition: opacity 0.3s ease;
    }

    .modal-overlay.active { opacity: 1; pointer-events: all; }

    .modal-content {
      background: linear-gradient(135deg, #3a0f0f 0%, #1a0505 100%);
      border: 2px solid var(--gold);
      border-radius: 16px;
      padding: 30px;
      width: 90%;
      max-width: 560px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.8), 0 0 20px var(--gold-glow);
      text-align: center;
      position: relative;
      max-height: 85vh;
      overflow-y: auto;
    }

    .paytable-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin: 20px 0;
      max-height: 320px;
      overflow-y: auto;
      padding-right: 5px;
    }

    .paytable-item {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255, 210, 63, 0.2);
      border-radius: 8px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .paytable-symbol-name {
      font-size: 12px;
      font-weight: bold;
      color: var(--gold);
      text-transform: uppercase;
      margin-bottom: 6px;
    }

    .paytable-payouts { font-size: 11px; color: #d8c3a5; line-height: 1.4; text-align: left; }

    .btn-modal-close {
      position: absolute; top: 15px; right: 15px;
      background: transparent; border: none; color: #a98; font-size: 24px; cursor: pointer;
    }
    .btn-modal-close:hover { color: #fff; }

    .btn-primary {
      background: var(--gold);
      color: #3a0f0f;
      font-family: 'Cinzel', serif;
      font-weight: 900;
      padding: 12px 28px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      margin-top: 20px;
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 6px 15px var(--gold); }

    .sim-modal {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(26, 5, 5, 0.98);
      border: 3px solid var(--gold);
      padding: 30px; border-radius: 20px; z-index: 100;
      max-width: 500px; width: 90%; max-height: 85vh; overflow-y: auto;
      box-shadow: 0 0 50px rgba(0,0,0,1), 0 0 30px var(--gold-glow);
    }

    .sim-modal h2 { font-family: 'Cinzel', serif; color: var(--gold); margin-bottom: 20px; text-align: center; font-size: 24px; }

    .sim-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 25px; }

    .stat-box {
      background: rgba(255,255,255,0.05);
      padding: 15px;
      border-radius: 10px;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.1);
    }

    .stat-label { font-size: 12px; color: #c9a97a; display: block; margin-bottom: 5px; text-transform: uppercase; }
    .stat-value { font-size: 18px; font-weight: bold; color: #fff; }

    .btn-close-sim {
      width: 100%; padding: 12px; background: var(--gold); border: none; color: #3a0f0f;
      font-weight: bold; border-radius: 8px; cursor: pointer;
    }
    .btn-close-sim:hover { transform: scale(1.05); }
  </style>
</head>
<body>

  <div class="cabinet-container">

    <header>
      <div class="title-logo">LUCKY <span>FRUITS</span></div>
      <div class="top-controls">
        <button id="btn-paytable" class="btn-icon">📋 Paytable</button>
        <button id="btn-mute" class="btn-icon">🔊 Sound ON</button>
      </div>
    </header>

    <div class="game-viewport">
      <div id="game-ticker" class="game-ticker">IDLE</div>
      <canvas id="game-canvas"></canvas>
    </div>

    <div class="dashboard">
      <div class="dashboard-panel">
        <div class="bet-container">
          <span class="dashboard-label">Balance</span>
          <span id="display-balance" class="dashboard-value">$1,000.00</span>
        </div>
      </div>

      <div class="dashboard-panel">
        <div class="bet-container">
          <span class="dashboard-label">Bet Per Line</span>
          <div class="bet-adjuster">
            <button id="bet-minus" class="btn-adjust">-</button>
            <span id="bet-value" class="bet-display-value">1</span>
            <button id="bet-plus" class="btn-adjust">+</button>
          </div>
        </div>
      </div>

      <div class="spin-section">
        <button id="btn-spin" class="btn-spin">SPIN</button>
      </div>

      <div class="aux-controls-container">
        <button id="btn-turbo" class="btn-icon">⚡ Turbo</button>
        <button id="btn-auto" class="btn-icon">🔄 Auto</button>
      </div>
    </div>

    <div class="top-controls" style="position: fixed; bottom: 20px; right: 20px; z-index: 100; display: flex; gap: 10px;">
      <button id="btn-tune" class="btn-icon btn-sim-btn">TUNE FREQUENCIES</button>
      <button id="btn-sim" class="btn-icon btn-sim-btn">RUN SIMULATION</button>
    </div>

  </div>

  <!-- Paytable Modal -->
  <div id="modal-paytable" class="modal-overlay">
    <div class="modal-content">
      <button class="btn-modal-close">×</button>
      <h2 style="font-family: 'Cinzel', serif; color: var(--gold); margin-bottom: 10px;">PAYTABLE</h2>
      <p style="font-size: 13px; color: #d8c3a5;">3 in a row pays left-to-right. Star and Strawberry only appear on the last reel and act as wilds.</p>

      <div class="paytable-grid" id="paytable-grid-content">
        <!-- Rendered dynamically in game.js -->
      </div>

      <h3 style="font-family: 'Cinzel', serif; color: #fff; font-size: 14px; margin: 15px 0 10px 0;">ACTIVE PAYLINES (5 LINES)</h3>
      <div style="display: flex; gap: 4px; justify-content: center; flex-wrap: wrap;" id="paylines-preview">
        <!-- Rendered dynamically in game.js -->
      </div>

      <button id="btn-paytable-ok" class="btn-primary">CLOSE</button>
    </div>
  </div>

  <!-- Simulation Results Modal -->
  <div id="sim-modal" class="sim-modal" style="display: none;">
    <button class="btn-modal-close">×</button>
    <h2>Simulation Results</h2>
    <div id="sim-stats" class="sim-stats">
      <div class="stat-box">
        <span class="stat-label">Return to Player (RTP)</span>
        <div id="sim-rtp" class="stat-value">-</div>
      </div>
      <div class="stat-box">
        <span class="stat-label">Total Spins</span>
        <div id="sim-total-spins" class="stat-value">-</div>
      </div>
      <div class="stat-box">
        <span class="stat-label">Max Win</span>
        <div id="sim-max-win" class="stat-value">-</div>
      </div>
      <div class="stat-box">
        <span class="stat-label">Free Spins Triggered</span>
        <div id="sim-free-spins" class="stat-value">0 (n/a)</div>
      </div>
    </div>
    <button id="btn-close-sim" class="btn-close-sim">CLOSE</button>
  </div>

  <!-- Core Javascript modules -->
  <script type="module" src="./game.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add games/fruitmachine/index.html
git commit -m "feat: add games/fruitmachine/index.html"
```

---

### Task 10: Create `games/fruitmachine/game.js`

**Files:**
- Create: `games/fruitmachine/game.js`

**Interfaces:**
- Consumes: `SlotEngine` (Task 3), `checkWildLineWins`/`generateReel` (Task 2 / unchanged), `runSimulationAndRender`/`openTuneFrequenciesPanel` (Task 6), the DOM IDs from Task 9's `index.html`, tile config from `games/fruitmachine/assets/fruitmachine_1/fruitmachine_1.tiles.json` (already present).

- [ ] **Step 1: Create the file**

Create `games/fruitmachine/game.js`:

```js
// Game Coordinator for the classic fruit machine
import { SlotEngine } from '../../core/SlotEngine.js';
import { checkWildLineWins, generateReel } from '../../core/SlotMath.js';
import { runSimulationAndRender, openTuneFrequenciesPanel } from '../../core/SimulationPanel.js';

// Grid/reel parameters shared by the live game, RUN SIMULATION, and TUNE FREQUENCIES.
const REELS_COUNT = 3;
const ROWS_COUNT = 3;
const REEL_LENGTH = 300;
const REEL_SEEDS = [1234, 567, 89];
const BET_PER_LINE = 1;
const LINES_COUNT = 5;

// 3 horizontal lines, then the two diagonals (upper-left to bottom-right, bottom-left to
// upper-right). Row index per reel, 0=top, 1=middle, 2=bottom.
const PAYLINES = [
  [0, 0, 0], // top
  [1, 1, 1], // middle
  [2, 2, 2], // bottom
  [0, 1, 2], // diagonal, upper-left to bottom-right
  [2, 1, 0], // diagonal, bottom-left to upper-right
];

// Frequencies tuned (via an offline run of the same tuning approach TUNE FREQUENCIES
// uses) to land near 96% RTP. bar is the sole 'premium' symbol - marking it that way
// (rather than 'regular') is what lets TUNE FREQUENCIES' premium/other reallocation
// actually move the needle: with no scatter symbol in this paytable, uniformly scaling
// every symbol's frequency together has no effect on the reel's relative composition,
// so a premium/other split is required for the tuner to do anything useful here.
const PAYTABLE = {
  bar:        { payout: [0, 0, 10],          frequency: 35.643, type: 'premium', friendlyName: 'Bar' },
  clover:     { payout: [0, 0, 4],   wildPenalty: 1, frequency: 3.611,  type: 'regular', friendlyName: 'Clover' },
  pear:       { payout: [0, 0, 3],           frequency: 4.814,  type: 'regular', friendlyName: 'Pear' },
  melon:      { payout: [0, 0, 3],           frequency: 4.814,  type: 'regular', friendlyName: 'Watermelon' },
  grapes:     { payout: [0, 0, 2],   wildPenalty: 1, frequency: 6.018,  type: 'regular', friendlyName: 'Grapes' },
  plum:       { payout: [0, 0, 2],           frequency: 6.018,  type: 'regular', friendlyName: 'Plum' },
  orange:     { payout: [0, 0, 1.60],        frequency: 8.425,  type: 'regular', friendlyName: 'Orange' },
  cherries:   { payout: [0.40, 0.80, 1.60],  frequency: 12.036, type: 'regular', friendlyName: 'Cherries' },
  star:       { payout: [0, 0, 0], wild: true, wildExcludes: ['cherries'], frequency: 3.611, type: 'wild', friendlyName: 'Star' },
  strawberry: { payout: [0, 0, 0], wild: true, wildOnly: ['cherries'], aloneBonus: 0.80, frequency: 3.009, type: 'wild', friendlyName: 'Strawberry' },
};

// star and strawberry are restricted to the last reel only - checkWildLineWins assumes
// a wild can only ever complete an already-matching pair in the last position, which
// only holds if reels 1 and 2 never contain them.
const REEL_STRIPS = REEL_SEEDS.map((seed, i) =>
  generateReel(PAYTABLE, REEL_LENGTH, seed, i < REELS_COUNT - 1 ? ['star', 'strawberry'] : [])
);

// UI DOM Selectors - initialized in the load handler
let canvas, btnSpin, btnAuto, btnTurbo, btnMute, btnPaytable, btnPaytableOk;
let displayBalance, betValue, betMinus, betPlus, gameTicker;
let btnSim, btnTune, simModal, btnCloseSim, simStats;
let simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay;
let modalPaytable;

let engine = null;

// 1. Initialize game on window load
window.addEventListener('load', () => {
  canvas = document.getElementById('game-canvas');
  btnSpin = document.getElementById('btn-spin');
  btnAuto = document.getElementById('btn-auto');
  btnTurbo = document.getElementById('btn-turbo');
  btnMute = document.getElementById('btn-mute');
  btnPaytable = document.getElementById('btn-paytable');
  btnPaytableOk = document.getElementById('btn-paytable-ok');
  displayBalance = document.getElementById('display-balance');
  betValue = document.getElementById('bet-value');
  betMinus = document.getElementById('bet-minus');
  betPlus = document.getElementById('bet-plus');
  gameTicker = document.getElementById('game-ticker');

  btnSim = document.getElementById('btn-sim');
  btnTune = document.getElementById('btn-tune');
  simModal = document.getElementById('sim-modal');
  btnCloseSim = document.getElementById('btn-close-sim');
  simStats = document.getElementById('sim-stats');

  simRtpDisplay = document.getElementById('sim-rtp');
  simTotalSpinsDisplay = document.getElementById('sim-total-spins');
  simMaxWinDisplay = document.getElementById('sim-max-win');
  simFreeSpinsDisplay = document.getElementById('sim-free-spins');

  modalPaytable = document.getElementById('modal-paytable');

  loadThemeAssets().then((themeAssets) => {
    if (!themeAssets) {
      alert('Error loading assets!');
      return;
    }

    engine = new SlotEngine(canvas, {
      reelsCount: REELS_COUNT,
      rowsCount: ROWS_COUNT,
      paytable: PAYTABLE,
      reelStrips: REEL_STRIPS,
      paylines: PAYLINES,
      winEvaluator: checkWildLineWins,
      symbolsConfig: themeAssets.symbolsConfig,
      spritesheetUrl: themeAssets.spritesheetUrl,
      linesCount: LINES_COUNT,

      onStateChange: (state) => handleStateChange(state),
      onWin: (winInfo) => handleWin(winInfo),
    });
    engine.linesCount = LINES_COUNT;
    engine.updateBet();

    updateUI();
    setupUIHandlers();
    buildPaytableContent();
  });
});

async function loadThemeAssets() {
  try {
    const response = await fetch('./assets/fruitmachine_1/fruitmachine_1.tiles.json');
    const data = await response.json();

    const symbolsConfig = {};
    data.tiles.forEach(tile => {
      symbolsConfig[tile.name] = { x: tile.x, y: tile.y, w: tile.w, h: tile.h };
    });

    return { spritesheetUrl: `./assets/fruitmachine_1/${data.sheet}`, symbolsConfig };
  } catch (error) {
    console.error('Failed to fetch fruit machine tile config', error);
    return null;
  }
}

function updateUI() {
  if (!engine) return;
  displayBalance.textContent = `$${engine.balance.toFixed(0)}`;
  betValue.textContent = engine.betPerLine;
}

function handleStateChange(state) {
  updateUI();

  if (state === 'spinning') {
    btnSpin.textContent = 'STOP';
    btnSpin.className = 'btn-spin spinning';
    gameTicker.textContent = 'SPINNING...';
  } else if (state === 'stopping') {
    btnSpin.textContent = 'STOP';
    btnSpin.className = 'btn-spin spinning';
    gameTicker.textContent = 'STOPPING...';
  } else {
    btnSpin.textContent = 'SPIN';
    btnSpin.className = 'btn-spin';

    if (state === 'showing_wins') {
      gameTicker.textContent = `WIN: $${engine.lastWin.toFixed(0)}!`;
    } else {
      gameTicker.textContent = 'IDLE';
    }
  }
}

function handleWin(winInfo) {
  updateUI();
}

function setupUIHandlers() {
  btnSpin.addEventListener('click', () => {
    engine.requestSpin();
  });

  betMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.betPerLine > 1) {
      engine.betPerLine--;
      engine.updateBet();
      updateUI();
    }
  });

  betPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newBetPerLine = engine.betPerLine + 1;
    const newTotalBet = newBetPerLine * engine.linesCount;
    if (newBetPerLine <= 100 && engine.balance >= newTotalBet) {
      engine.betPerLine = newBetPerLine;
      engine.updateBet();
      updateUI();
    }
  });

  btnAuto.addEventListener('click', () => {
    engine.autoPlay = !engine.autoPlay;
    btnAuto.classList.toggle('active', engine.autoPlay);
    if (engine.autoPlay && engine.state === 'idle') {
      engine.spin();
    }
  });

  btnTurbo.addEventListener('click', () => {
    engine.turboMode = !engine.turboMode;
    btnTurbo.classList.toggle('active', engine.turboMode);
  });

  btnMute.addEventListener('click', () => {
    const isMuted = engine.audio.toggleMute();
    btnMute.textContent = isMuted ? '🔇 Sound OFF' : '🔊 Sound ON';
    btnMute.classList.toggle('active', isMuted);
  });

  btnPaytable.addEventListener('click', () => {
    modalPaytable.classList.add('active');
  });

  const closePaytable = () => modalPaytable.classList.remove('active');
  btnPaytableOk.addEventListener('click', closePaytable);
  modalPaytable.querySelector('.btn-modal-close').addEventListener('click', closePaytable);

  if (btnSim) {
    btnSim.addEventListener('click', () => {
      runSimulationAndRender({
        engine,
        paytable: PAYTABLE,
        betPerLine: BET_PER_LINE,
        linesCount: LINES_COUNT,
        numSpins: 1000000,
        domRefs: { btnSim, simModal, simStats, simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay },
      });
    });
  }
  if (btnTune) {
    btnTune.addEventListener('click', () => {
      openTuneFrequenciesPanel({
        paytable: PAYTABLE,
        tuneConfig: {
          reelsCount: REELS_COUNT,
          rowsCount: ROWS_COUNT,
          paylines: PAYLINES,
          winEvaluator: checkWildLineWins,
          reelSeeds: REEL_SEEDS,
          betPerLine: BET_PER_LINE,
          linesCount: LINES_COUNT,
          reelLength: REEL_LENGTH,
        },
        domRefs: { simModal, simStats },
      });
    });
  }
  if (btnCloseSim) {
    btnCloseSim.addEventListener('click', () => {
      simModal.style.display = 'none';
    });
  }
}

// Render the paytable modal content dynamically from PAYTABLE/PAYLINES
function buildPaytableContent() {
  const container = document.getElementById('paytable-grid-content');
  container.innerHTML = '';

  for (const [symbol, data] of Object.entries(PAYTABLE)) {
    const item = document.createElement('div');
    item.className = 'paytable-item';

    const title = document.createElement('span');
    title.className = 'paytable-symbol-name';
    title.textContent = data.friendlyName || symbol;
    item.appendChild(title);

    const payLines = document.createElement('div');
    payLines.className = 'paytable-payouts';

    let content = '';
    if (data.wild) {
      content += `<strong>WILD</strong> - last reel only<br>`;
      if (data.wildOnly) content += `Substitutes only for: ${data.wildOnly.join(', ')}<br>`;
      if (data.wildExcludes) content += `Substitutes for anything except: ${data.wildExcludes.join(', ')}<br>`;
      if (data.aloneBonus) content += `Pays ${data.aloneBonus.toFixed(2)}x alone<br>`;
    } else {
      for (let hits = 3; hits >= 1; hits--) {
        if (data.payout[hits - 1] > 0) {
          content += `<strong>${hits} in a row:</strong> ${data.payout[hits - 1].toFixed(2)}x<br>`;
        }
      }
      if (data.wildPenalty) {
        content += `<em style="color:#ffd23f; font-size:10px;">-${data.wildPenalty.toFixed(2)}x when completed by Star</em><br>`;
      }
    }

    payLines.innerHTML = content;
    item.appendChild(payLines);
    container.appendChild(item);
  }

  const linesPreview = document.getElementById('paylines-preview');
  linesPreview.innerHTML = '';
  PAYLINES.forEach((path, idx) => {
    const div = document.createElement('div');
    div.style.cssText = `
      width: 34px;
      height: 30px;
      border: 1px solid rgba(255,210,63,0.4);
      background: #0d0202;
      border-radius: 4px;
      display: flex;
      padding: 3px;
      position: relative;
    `;
    div.title = `Line ${idx + 1}`;

    let innerHtml = '<div style="display:flex; justify-content:space-between; height:100%; width:100%;">';
    for (let c = 0; c < REELS_COUNT; c++) {
      innerHtml += '<div style="display:flex; flex-direction:column; justify-content:space-between; height:100%; width: 5px;">';
      for (let r = 0; r < ROWS_COUNT; r++) {
        const active = (path[c] === r);
        innerHtml += `<div style="width:5px; height:5px; border-radius:50%; background: ${active ? '#ffd23f' : '#3a2020'};"></div>`;
      }
      innerHtml += '</div>';
    }
    innerHtml += '</div>';

    div.innerHTML = innerHtml;
    linesPreview.appendChild(div);
  });
}
```

- [ ] **Step 2: Manual verification via the `run` skill**

Use the `run` skill to launch `games/fruitmachine/index.html`. Confirm:
- The page loads with no console errors, reels show the fruit machine art (`bar`, `clover`, `pear`, `melon`, `grapes`, `plum`, `orange`, `cherries`, `star`, `strawberry` tiles from `fruitmachine_1.png`).
- SPIN works; wins highlight the correct line shape (top/middle/bottom/either diagonal).
- Manually spin repeatedly (or use autoplay) until at least one of each observed: a natural 3-of-a-kind win, a star-completed win, a strawberry "alone" 0.80 payout on a losing line, a cherries partial-match win.
- Bet +/-, turbo, mute, autoplay all work.
- Paytable modal opens, shows all 10 symbols with correct payouts/wild descriptions, and 5 payline preview swatches matching the shapes above.
- RUN SIMULATION shows an RTP near 96% and a "Regular"/"Premium"/"Wild" sectioned win breakdown (from `core/SimulationPanel.js`'s type-grouping).
- TUNE FREQUENCIES opens and runs without error.

- [ ] **Step 3: Commit**

```bash
git add games/fruitmachine/game.js
git commit -m "feat: add games/fruitmachine/game.js"
```

---

### Task 11: Add a fruit machine entry to the root portal page

**Files:**
- Modify: `index.html`

**Interfaces:** none (static HTML change).

- [ ] **Step 1: Add a second game card**

In `index.html`, find:

```html
    <a href="games/bookbookbook/index.html" class="btn-play">ENTER THE TEMPLE</a>

    <footer>
      SlotMaster Engine Core v1.0.0 • Powered by HTML5 Canvas & Web Audio API
    </footer>
```

Replace with:

```html
    <div style="display: flex; gap: 16px; justify-content: center; flex-wrap: wrap;">
      <a href="games/bookbookbook/index.html" class="btn-play">ENTER THE TEMPLE</a>
      <a href="games/fruitmachine/index.html" class="btn-play">PLAY LUCKY FRUITS</a>
    </div>

    <footer>
      SlotMaster Engine Core v1.0.0 • Powered by HTML5 Canvas & Web Audio API
    </footer>
```

- [ ] **Step 2: Manual verification via the `run` skill**

Launch the app at the root `index.html`, confirm both buttons render side by side and each navigates to its respective game.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: link the fruit machine game from the root portal page"
```

---

## Self-Review

**Spec coverage:**
- §1 Paylines move out of core → Task 1 (core removal), Task 5 (bookbookbook local const). ✓
- §2 SlotEngine payline-agnostic + renderWinEffects/forceWinResult fixes → Task 3. ✓
- §3 Grid & paylines (3x3, 5 lines) → Task 10's `PAYLINES` const. ✓
- §4 `checkWildLineWins` + all 7 worked examples → Task 2, verified by `verify-wildlinewins.mjs` (7 examples + 2 extra edge cases). ✓
- §5 Paytable & reel composition (exclude star/strawberry from reels 1-2) → Task 10. ✓
- §6 `core/SimulationPanel.js` + type-grouping + field-agnostic formatter → Task 6, wired in Tasks 7 and 10. ✓
- §7 `SpinSimulator.js` paylines/winEvaluator options → Task 4. ✓
- §8 UI scope (kept/removed features) → Task 9/10 (no free-spins panel, no book-reveal, no theme switcher, no scatter/expanding cheats). ✓
- Testing/verification bullets → baseline capture folded into Task 5, all four ad hoc script checks map to Tasks 1/2/4/5, manual in-browser checks in Tasks 5, 7, 10, 11. ✓
- Migration notes → covered by Tasks 1, 3, 4, 5, 7. ✓

**Placeholder scan:** No `TBD`/`TODO`/`...` remain in code blocks — Task 8's script was actually executed while writing this plan and its real output values are hardcoded into Task 10's `PAYTABLE`.

**Type consistency:** `checkWildLineWins(grid, paytable, paylines, activeLinesCount)` signature matches across Task 2's implementation, Task 4's regression test, Task 8's offline copy, and Task 10's usage. `SlotEngine` config field names (`paylines`, `wildSymbol`, `scatterSymbol`, `winEvaluator`) match across Tasks 3, 5, and 10. `SimulationPanel.js` export names (`runSimulationAndRender`, `openTuneFrequenciesPanel`, `formatPaytableForCopy`) and their argument shapes match across Tasks 6, 7, and 10.
