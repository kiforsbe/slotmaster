# Action Plan - core/SlotMath.js

## File Overview
Core mathematics engine for slot machine win evaluation. Handles payline checking, scatter evaluation, and expanding symbol wins. 202 lines, well-structured.

## Current Status: 🟡 MEDIUM - Minor Issues, No Critical Bugs

## High Priority Issues

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 1 | Scatter trigger logic - potential double-counting | Lines 19-20, 99-103 | Incorrect game rules | 🟠 HIGH |
| 2 | Scatter payout multiplier inconsistency | Lines 89-97, 106-115 | Different calculations between engine and simulator | 🟠 HIGH |
| 3 | Expanding wins double-counts on paylines | Lines 175-192 | Potential design issue | 🟠 HIGH |

### Fix Details

**Issue #1 - Scatter trigger logic:**
```javascript
// Line 101-103:
if (scatterCount >= 2) {
  triggerFreeSpins = true;
}

// Most Book of Dead-style games require 3+ scatters
// Current logic triggers on 2+ which may be intentional but worth verifying

// Fix: Make scatter trigger count configurable:
export function checkWins(grid, paytable, activeLinesCount = 10, wildSymbol = 'book', scatterSymbol = 'book', scatterTriggerCount = 3) {
  // ...
  if (scatterCount >= scatterTriggerCount) {
    triggerFreeSpins = true;
  }

// Or verify with game design docs if 2+ is intentional
```

**Issue #2 - Scatter payout multiplier inconsistency:**
```javascript
// In SlotMath.js checkWins (this file):
// Scatter payouts use totalBet multiplier (line 108)
const payout = scatterPayouts[scatterCount];

// In SpinSimulator.js (line 90):
spinWin += winData.scatterWin.payout * (isFreeSpin ? linesCount : betPerLine);

// In SlotEngine.js evaluateSpinResult (line 626):
payoutAmount += results.scatterWin.payout * this.totalBet;

// Inconsistency: simulator uses betPerLine, engine uses totalBet
// totalBet = betPerLine * linesCount
// So simulator underpays scatter by factor of linesCount

// Fix: Standardize on totalBet for scatter payouts
// In SpinSimulator.js line 90:
spinWin += winData.scatterWin.payout * this.totalBet;  // Not betPerLine
```

**Issue #3 - Expanding wins double-counts:**
```javascript
// Lines 178-192:
for (let lineIdx = 0; lineIdx < Math.min(activeLinesCount, PAYLINES.length); lineIdx++) {
  wins.push({...});
  totalPayout += payoutPerLine;  // Adds per-line
}

// This means a 3-reel expansion pays `payout × 10` (all lines)
// This may be intentional (Book of Dead style) but should be documented

// Fix: Add comment clarifying this is intentional design
// Or make it configurable:
// Option A: Pay per reel (totalPayout = payoutPerLine, not multiplied by lines)
// Option B: Keep current but document clearly

// Recommendation: Verify with game design. If intentional, add:
// "Note: Expanding symbol pays on ALL active paylines, so 3 expanding reels
// pays payout * numActiveLines. This is Book of Dead style behavior."
```

## Medium Priority Issues

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 4 | Wild-only line wins blocked too aggressively | Lines 71-84 | Confusing logic | 🟡 MEDIUM |
| 5 | No input validation | Function parameters | Robustness | 🟡 MEDIUM |

**Issue #4 - Wild-only line wins:**
```javascript
// Lines 71-74:
if (targetSymbol && targetSymbol !== wildSymbol) {
  // Only pay if target is not wild
}

// This prevents paying for wild-only lines (e.g., Book, Book, Book)
// The comment explains: "A wild-only run...must NOT be paid as a line win:
// the wild here doubles as the scatter symbol, which is already paid separately"

// This logic is CORRECT for Book of Dead where Book is both Wild and Scatter
// However, the implementation is confusing because:
// - If first symbol is wild and rest are wild, targetSymbol becomes first non-wild or stays wild
// - The condition `targetSymbol !== wildSymbol` blocks the payout

// Fix: Add clearer comment and consider renaming:
// "Wild symbols that are also scatter symbols are paid only as scatter wins,
// not as line wins, to avoid double-counting."
// The current implementation is correct but the variable naming is confusing.
```

**Issue #5 - No input validation:**
```javascript
// Function parameters not validated:
// - grid: should be 5 cols × 3 rows
// - paytable: should have expected symbols
// - activeLinesCount: should be <= PAYLINES.length
// - wildSymbol, scatterSymbol: should exist in paytable

// Fix: Add validation at start of functions:
export function checkWins(grid, paytable, activeLinesCount = 10, wildSymbol = 'book', scatterSymbol = 'book') {
  // Validate grid
  if (!grid || grid.length !== 5 || grid[0].length !== 3) {
    throw new Error('Grid must be 5 columns × 3 rows');
  }
  
  // Validate paytable
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('Invalid paytable');
  }
  
  // Validate line count
  activeLinesCount = Math.min(activeLinesCount, PAYLINES.length);
  
  // Rest of function...
}
```

## Low Priority Enhancements

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 6 | Magic numbers in PAYLINES | Lines 3-14 | Reduced maintainability | 🟢 LOW |
| 7 | Hardcoded symbol names | Lines 20, 140 | Flexibility | 🟢 LOW |
| 8 | No JSDoc comments | Multiple | Documentation | 🟢 LOW |

**Issue #6 - Magic numbers in PAYLINES:**
```javascript
// PAYLINES array has magic numbers 0, 1, 2 for rows
// This is fine - rows are 0-indexed (top, middle, bottom)
// But could be more readable with constants:

const ROW = {
  TOP: 0,
  MIDDLE: 1,
  BOTTOM: 2
};

export const PAYLINES = [
  [ROW.MIDDLE, ROW.MIDDLE, ROW.MIDDLE, ROW.MIDDLE, ROW.MIDDLE], // Line 1
  [ROW.TOP, ROW.TOP, ROW.TOP, ROW.TOP, ROW.TOP], // Line 2
  // ... etc
];

// However, this adds overhead without much benefit
// Recommendation: Keep as-is, or add comments:
// Line 1: Horizontal Middle Row
// Line 2: Horizontal Top Row  
// etc. (Already done!)
```

**Issue #7 - Hardcoded symbol names:**
```javascript
// Lines 20, 140: wildSymbol = 'book', scatterSymbol = 'book'
// These are parameters with defaults, so they're configurable
// But 'book' appears in default parameters

// Fix: Could extract to constants:
const DEFAULT_WILD_SYMBOL = 'book';
const DEFAULT_SCATTER_SYMBOL = 'book';

// But this is minor - current approach is fine
```

**Issue #8 - No JSDoc comments:**
```javascript
// Add JSDoc for exported functions:

/**
 * Payline definitions for 5-reel, 3-row slot machine.
 * Each array defines the row index (0=top, 1=middle, 2=bottom) for each column.
 * @type {Array<Array<number>>}
 */
export const PAYLINES = [
  // ...
];

/**
 * Evaluates line wins and scatter wins for a given grid.
 * @param {Array<Array<string>>} grid - 5x3 grid of symbol names
 * @param {Object} paytable - Maps symbol names to payout arrays (indexed by hit count)
 * @param {number} activeLinesCount - Number of active paylines (default 10)
 * @param {string} wildSymbol - Symbol that acts as wild (default 'book')
 * @param {string} scatterSymbol - Symbol that acts as scatter (default 'book')
 * @param {number} scatterTriggerCount - Minimum scatter count to trigger free spins (default 3)
 * @returns {Object} Object containing lineWins, scatterWin, and total payouts
 */
export function checkWins(grid, paytable, activeLinesCount = 10, wildSymbol = 'book', scatterSymbol = 'book', scatterTriggerCount = 3) {
```

## Code Quality Analysis

### Strengths
✅ Clean separation of concerns - pure math, no side effects  
✅ Well-structured algorithms  
✅ Good variable naming  
✅ Comprehensive payline definitions  
✅ Handles both line wins and scatters correctly  
✅ Supports expanding symbol mechanics  

### Areas for Improvement
⚠️ Input validation missing  
⚠️ Some magic numbers (but mostly acceptable)  
⚠️ No JSDoc comments  
⚠️ Inconsistency with other modules on scatter payout calculation  

## Recommended Actions

### Immediate (Next Sprint - High)
1. Fix Issue #1: Verify scatter trigger count (2 vs 3) with game design
2. Fix Issue #2: Standardize scatter payout calculation across modules
3. Fix Issue #3: Document expanding wins behavior clearly

### Short Term (1-2 weeks - Medium)
4. Add input validation to functions
5. Improve wild-only line win comments for clarity

### Long Term (1+ month - Low)
6. Add JSDoc comments for all exported functions
7. Extract symbol constants if needed for theming
8. Add unit tests for win calculation logic

## Files to Update
- `core/SlotMath.js` - All fixes and improvements

## Dependencies
- Fixes to scatter payout (Issue #2) require changes to:
  - `core/SpinSimulator.js` (line 90)
- Input validation improvements may require updates to callers

## Estimated Time to Complete
- **High priority fixes**: 1-2 hours
- **Medium priority fixes**: 2-3 hours  
- **Low priority improvements**: 2-4 hours
- **Total for production-ready**: ~4-6 hours

---

*Generated: 2026-07-22*  
*Reviewed by: Code Review Process*
