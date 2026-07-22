# Action Plan - core/SpinSimulator.js

## File Overview
Pure functional simulator for slot machine game logic. Runs spins without visual or audio effects to calculate RTP (Return to Player) and other statistics. 125 lines.

## Current Status: 🟡 MEDIUM - Functional but Needs Fixes

## High Priority Issues

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 1 | Dead loop body - free spin results not used | Lines 31-42 | Results lost | 🟠 HIGH |
| 2 | Scatter payout multiplier inconsistency | Lines 89-90, 97 | Different from engine | 🟠 HIGH |
| 3 | Hardcoded expanding symbol | Line 109 | Inflexible | 🟠 HIGH |
| 4 | Hardcoded free spins count | Line 32 | Inflexible | 🟠 HIGH |

### Fix Details

**Issue #1 - Dead loop body:**
```javascript
// Lines 31-42:
if (result.winData.scatterWin && result.winData.scatterWin.triggerFreeSpins) {
  for (let j = 0; j < 10; j++) {
    const freeSpinResult = _runSingleSpin(true);
    // Accumulate free spin results - but this was commented as "never used"
    // Actually, the stats ARE updated inside _runSingleSpin via side effects
  }
}

// The code actually works - freeSpinResult updates results object via side effects
// But it's confusing and fragile

// Fix: Make it explicit and clearer:
if (result.winData.scatterWin && result.winData.scatterWin.triggerFreeSpins) {
  const freeSpinsCount = 10; // Or make configurable
  for (let j = 0; j < freeSpinsCount; j++) {
    const freeSpinResult = _runSingleSpin(true);
    // Free spin results are accumulated into the results object by _runSingleSpin
    // This works but consider returning the results instead
  }
}

// Better fix: Have _runSingleSpin return the result and accumulate explicitly:
// In simulateSpins function:
if (result.winData.scatterWin && result.winData.scatterWin.triggerFreeSpins) {
  const freeSpinsCount = config.freeSpinsCount || 10;
  for (let j = 0; j < freeSpinsCount; j++) {
    const freeSpinResult = _runSingleSpin(true);
    // Accumulate explicitly:
    results.totalWins += freeSpinResult.spinWin;
    results.totalSimulatedSpins++;
    if (freeSpinResult.spinWin > results.maxWin) results.maxWin = freeSpinResult.spinWin;
    if (freeSpinResult.spinWin < results.minWin) results.minWin = freeSpinResult.spinWin;
    results.winDistribution[freeSpinResult.spinWin] = (results.winDistribution[freeSpinResult.spinWin] || 0) + 1;
  }
}
```

**Issue #2 - Scatter payout multiplier inconsistency:**
```javascript
// Lines 89-90, 97:
// Base spin:
spinWin += winData.scatterWin.payout * (isFreeSpin ? linesCount : betPerLine);
// Line wins:
spinWin += winData.totalLinePayoutMultiplier * (isFreeSpin ? linesCount : betPerLine);

// In SlotEngine.js evaluateSpinResult (line 626):
// Scatter: payoutAmount += results.scatterWin.payout * this.totalBet;
// Line: payoutAmount += results.totalLinePayoutMultiplier * this.betPerLine;

// Inconsistency:
// - Simulator: scatter uses betPerLine, line uses betPerLine
// - Engine: scatter uses totalBet, line uses betPerLine

// Correct behavior:
// - Line wins: payout * betPerLine * number of lines hit (handled in checkWins)
// - Scatter wins: payout * totalBet (totalBet = betPerLine * linesCount)

// Fix in SpinSimulator.js:
// Line 90 (scatter):
spinWin += winData.scatterWin.payout * totalBet;  // Not betPerLine
// Where totalBet = betPerLine * linesCount (available as simConfig.totalBet)

// Also line 97 (line wins) - this is correct as-is
// checkWins returns totalLinePayoutMultiplier which is sum of all line payouts
// So totalLinePayoutMultiplier * betPerLine is correct
```

**Issue #3 - Hardcoded expanding symbol:**
```javascript
// Line 109:
const currentExpandingSymbol = 'anubis';

// This should be configurable or passed as parameter

// Fix:
// Add to config:
// config.expandingSymbol || 'anubis'

// In simulateSpins function:
const expandingSymbol = config.expandingSymbol || 'anubis';

// Then pass to checkExpandingWins:
const expandingResults = checkExpandingWins(
  targetGrid, 
  expandingSymbol, 
  simConfig.paytable, 
  linesCount
);
```

**Issue #4 - Hardcoded free spins count:**
```javascript
// Line 32:
for (let j = 0; j < 10; j++) {

// Should be configurable

// Fix:
// Add to config:
const freeSpinsCount = config.freeSpinsCount || 10;

// In simulateSpins:
const freeSpinsCount = simConfig.freeSpinsCount || 10;
// ...
for (let j = 0; j < freeSpinsCount; j++) {
```

## Medium Priority Issues

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 5 | Config mutation | Line 19 | Side effects | 🟡 MEDIUM |
| 6 | No input validation | Function parameters | Robustness | 🟡 MEDIUM |
| 7 | Magic numbers | Multiple | Maintainability | 🟡 MEDIUM |

**Issue #5 - Config mutation:**
```javascript
// Line 19:
const simConfig = { ...config };
// This is GOOD - creates a copy

// But then lines 20-22 mutate simConfig:
simConfig.linesCount = linesCount;
simConfig.betPerLine = betPerLine;
simConfig.totalBet = betPerLine * linesCount;

// This is fine because simConfig is a local copy
// But could be clearer

// Fix: Document that config is copied and extended:
// "Note: config is shallow-copied to avoid mutating the original"
```

**Issue #6 - No input validation:**
```javascript
// Function parameters not validated:
// - config: should have reelStrips, paytable, reelsCount, rowsCount
// - numBaseSpins: should be positive integer
// - betPerLine: should be positive number
// - linesCount: should be positive integer

// Fix: Add validation:
export function simulateSpins(config, numBaseSpins = 100000, betPerLine = 1, linesCount = 10) {
  // Validate
  if (!config || !config.reelStrips || !config.paytable) {
    throw new Error('Invalid config: reelStrips and paytable required');
  }
  if (numBaseSpins <= 0 || betPerLine <= 0 || linesCount <= 0) {
    throw new Error('All numeric parameters must be positive');
  }
  
  // Rest of function...
}
```

**Issue #7 - Magic numbers:**
```javascript
// Line 32: 10 free spins (Issue #4)
// Line 109: 'anubis' expanding symbol (Issue #3)

// Also consider:
// Default numBaseSpins = 100000 - this is good for accuracy but slow
// Could make it configurable with smaller defaults for quick testing

// Fix: Already covered by Issues #3-4
```

## Low Priority Enhancements

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 8 | No JSDoc comments | Function | Documentation | 🟢 LOW |
| 9 | No progress callbacks | Function | UX | 🟢 LOW |
| 10 | Hardcoded scatter trigger logic | Line 101-103 | Maintainability | 🟢 LOW |

**Issue #8 - No JSDoc comments:**
```javascript
// Add JSDoc:
/**
 * Simulates multiple spins and returns statistical analysis.
 * @param {Object} config - Slot machine configuration
 * @param {number} numBaseSpins - Number of base spins to simulate (default 100000)
 * @param {number} betPerLine - Bet per line (default 1)
 * @param {number} linesCount - Number of active paylines (default 10)
 * @returns {Object} Simulation results including RTP, win distribution, etc.
 */
export function simulateSpins(config, numBaseSpins = 100000, betPerLine = 1, linesCount = 10) {
```

**Issue #9 - No progress callbacks:**
```javascript
// For 100,000 spins, simulation takes noticeable time
// No way to show progress or cancel

// Fix: Add optional callback:
export function simulateSpins(config, numBaseSpins = 100000, betPerLine = 1, linesCount = 10, onProgress) {
  // ...
  for (let i = 0; i < numBaseSpins; i++) {
    if (onProgress && i % 1000 === 0) {
      onProgress({ current: i, total: numBaseSpins, percent: (i / numBaseSpins * 100).toFixed(1) });
    }
    // ...
  }
}
```

**Issue #10 - Hardcoded scatter trigger logic:**
```javascript
// Lines 101-103:
if (scatterCount >= 2) {
  triggerFreeSpins = true;
}

// This duplicates logic from SlotMath.js
// Should use the same threshold

// Fix: Pass scatterTriggerCount as parameter or use from config:
const scatterTriggerCount = config.scatterTriggerCount || 2;  // Or 3?
// Then in simulateSpins, pass it to checkWins or handle it here
```

## Code Quality Analysis

### Strengths
✅ Pure functional approach - no side effects  
✅ Well-structured simulation logic  
✅ Good reuse of existing math functions (checkWins, checkExpandingWins)  
✅ Returns comprehensive statistics  
✅ Config is copied to avoid mutation (mostly)  

### Areas for Improvement
⚠️ Inconsistencies with engine behavior  
⚠️ Hardcoded values  
⚠️ No input validation  
⚠️ Side-effect-based accumulation is confusing  

## Recommended Actions

### Immediate (Next Sprint - High)
1. Fix Issue #1: Make free spin accumulation explicit (not side-effect based)
2. Fix Issue #2: Standardize scatter payout calculation with engine
3. Fix Issue #3: Make expanding symbol configurable
4. Fix Issue #4: Make free spins count configurable

### Short Term (1-2 weeks - Medium)
5. Add input validation
6. Add JSDoc comments
7. Consider progress callbacks for long simulations

### Long Term (1+ month - Low)
8. Add unit tests for simulation accuracy
9. Consider adding more statistics (volatility, hit frequency)
10. Add retry logic for failed simulations

## Files to Update
- `core/SpinSimulator.js` - All fixes and improvements

## Dependencies
- Scatter payout fix (Issue #2) requires coordination with:
  - `core/SlotEngine.js` (line 626)
  - `core/SlotMath.js` (for understanding of payout structure)
- Config changes may require updates to callers

## Estimated Time to Complete
- **High priority fixes**: 2-3 hours
- **Medium priority fixes**: 2-3 hours
- **Low priority improvements**: 2-4 hours
- **Total for production-ready**: ~4-6 hours

---

*Generated: 2026-07-22*  
*Reviewed by: Code Review Process*
