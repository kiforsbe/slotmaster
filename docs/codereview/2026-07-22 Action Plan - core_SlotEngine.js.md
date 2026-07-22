# Action Plan - core/SlotEngine.js

## File Overview
Core slot machine engine handling rendering, physics, game state, and win evaluation. 1190 lines, the largest and most complex file in the codebase.

## Current Status: 🔴 CRITICAL - Contains Runtime Errors

## Critical Bugs (Must Fix Immediately)

| # | Bug | Location | Impact | Severity |
|---|-----|----------|--------|----------|
| 1 | **Orphaned `this.ctx.beginPath()`** | Line 696 | Syntax error, crashes engine | 🔴 CRITICAL |
| 2 | **`this.frameCount` undefined** | Line 303 | TypeError every frame, crashes game loop | 🔴 CRITICAL |
| 3 | **`this.ctx` used in evaluateSpinResult line 608** | Line 608 | `this.ctx.beginPath()` appears as orphaned statement | 🔴 CRITICAL |

### Fix Details

**Bug #1 & #3 - Orphaned beginPath() calls:**
```javascript
// Current (BROKEN):
this.config.onStateChange(this.state);

    this.ctx.beginPath();  // ORPHANED - not in any function!
}

// Fix:
// Remove the orphaned line. It appears to be debug code left in.
// Search for all instances of standalone `this.ctx.beginPath()` outside of function bodies.
```

**Bug #2 - Undefined frameCount:**
```javascript
// Current (BROKEN):
if (r === 0 && this.frameCount % 60 === 0) {  // Line 303

// Fix:
// In constructor, add:
this.frameCount = 0;

// In update() function, increment at start:
this.frameCount++;
```

## High Priority Issues

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 4 | Debug console.log statements | Multiple locations | Production logging | 🟠 HIGH |
| 5 | State machine unreachable states | Lines 27, 645-697 | Engine can get stuck | 🟠 HIGH |
| 6 | Config mutation | Lines 96-97 | Side effects on caller | 🟠 HIGH |
| 7 | Particle explosion performance | Lines 1147-1164 | FPS drops on big wins | 🟠 HIGH |
| 8 | `Date.now()` called per-frame | Line 204 | Minor performance hit | 🟠 HIGH |
| 9 | No requestAnimationFrame throttling for resize | Line 142 | Performance on resize | 🟠 HIGH |

### Fix Details

**Issue #4 - Debug logging:**
```javascript
// Lines to remove or gate:
// Line 263: console.log(`[Debug] Reel ${r} transitioning to stopping at ${now}`);
// Line 303-304: console.log(...)
// Line 307: console.log(...)
// Line 333: console.log(...)
// Line 341: console.log(...)
// Line 491: console.log(`[Debug] stopSpin called...`)
// Line 504: console.log(...)
// Line 529: console.log(...)
// Line 594, 597: console.log(...)
// Line 604: console.log(...)
// Line 1189-1190: console.log in state logging

// Fix: Add debug flag:
this.debugMode = false; // In constructor
// Then wrap all console.log calls with: if (this.debugMode) console.log(...)
```

**Issue #5 - State machine unreachable states:**
States `'free_spins_intro'`, `'game_over'`, `'evaluating'` are set but update() doesn't handle them.
```javascript
// Fix: In update(), add handling:
// After line 423, add:
if (this.state === 'free_spins_intro') {
  // Handle free spins intro state
  // Transition to spinning or idle as appropriate
}
if (this.state === 'game_over') {
  // Allow transition back to idle
  // Maybe auto-transition after a delay
  if (now - this.stateChangeTime > 3000) {
    this.state = 'idle';
    this.config.onStateChange(this.state);
  }
}
if (this.state === 'evaluating') {
  // This state is set in evaluateSpinResult but never processed
  // Remove it or add processing logic
}
```

**Issue #6 - Config mutation:**
```javascript
// Lines 96-97 mutate the passed-in config object
this.config.spritesheetUrl = spritesheetUrl;
this.config.symbolsConfig = symbolsConfig;

// Fix:
// In constructor, create shallow copy:
this.config = { ...config };
// Then in loadAssets:
this.config.spritesheetUrl = spritesheetUrl;
this.config.symbolsConfig = symbolsConfig;
// This is now safe because it's our own copy
```

**Issue #7 - Particle explosion performance:**
```javascript
// Lines 1147-1164: 20 particles per winning position
// A big win with 10 lines × 5 positions = 1000 particles

// Fix:
// Add max particle limit:
const MAX_PARTICLES = 200; // Or 500

// In spawnWinParticles():
if (this.particles.length >= MAX_PARTICLES) return;

// Or cap total created:
const particlesToCreate = Math.min(spots.length * 20, MAX_PARTICLES);
```

**Issue #8 - Date.now() per-frame:**
```javascript
// Line 204: const now = Date.now();
// Used ~15 times in update()

// Fix: Cache once at top of update() - already done!
// But ensure it's only called once per frame
// Current code is actually fine - now is cached at line 204
```

**Issue #9 - Resize handler throttling:**
```javascript
// Line 142: window.addEventListener('resize', () => this.resize());

// Fix:
// Add debounce:
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => this.resize(), 100);
});
```

## Medium Priority Issues

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 10 | Magic numbers throughout | Multiple locations | Reduced maintainability | 🟡 MEDIUM |
| 11 | No input validation on reel strips | Line 112 | Potential runtime errors | 🟡 MEDIUM |
| 12 | Memory leak in particle system | Lines 225-231 | Particles not cleaned up | 🟡 MEDIUM |

**Issue #10 - Magic numbers:**
```javascript
// Examples to extract:
// Line 151-152: marginXFrac = 0.05, marginYFrac = 0.08
// Line 277: maxSpeed = 50 (or 80 in turbo)
// Line 276: minSpeed = 8
// Line 242-243: acceleration = 3
// Line 55: spinDuration = 2000
// Line 57: reelDelay = 150
// Line 67: winCycleDuration = 1000
// Line 74: bounceMax = this.symbolHeight * 0.12
// Line 320: speed = bounceMax / 4
// Line 922: reelExpandDuration = 900
// Line 1086: pulse calculation

// Fix: Add constants section at top of class:
static DEFAULT_SPIN_DURATION = 2000;
static REEL_DELAY = 150;
static MAX_SPEED = 50;
static MAX_SPEED_TURBO = 80;
static MIN_SPEED = 8;
static ACCELERATION = 3;
// etc.
```

**Issue #11 - No input validation:**
```javascript
// Line 112: const strip = this.config.reelStrips[r] || ['jack', 'queen', 'king', 'ace'];
// This is good - fallback provided

// But check in constructor:
// Ensure config.reelStrips exists and has correct length
// Ensure config.reelsCount matches reelStrips.length
// Ensure config.rowsCount is valid

// Fix: Add validation in constructor:
if (!config.reelStrips || config.reelStrips.length !== config.reelsCount) {
  throw new Error('reelStrips must be provided and match reelsCount');
}
```

**Issue #12 - Memory leak in particles:**
```javascript
// Lines 225-231: Particles filtered but not limited
// Particles can accumulate indefinitely in theory

// Fix: Add max particles constant and check in filter:
// Or use a particle pool pattern
```

## Low Priority Enhancements

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 13 | Typo in comment | Line 158 | Minor | 🟢 LOW |
| 14 | No JSDoc for most methods | Multiple | Documentation | 🟢 LOW |
| 15 | Hardcoded colors | Multiple | Themability | 🟢 LOW |
| 16 | No error handling for canvas operations | Multiple | Robustness | 🟢 LOW |

## Code Quality Issues

1. **Duplicate code**: Similar logic in multiple places (reel matching, state transitions)
2. **Long methods**: `update()` is very long (200+ lines), `render()` is long
3. **Mixed concerns**: Engine handles both game logic and rendering

## Detailed Analysis by Section

### Constructor (Lines 6-80)
- **Status**: Good structure
- **Issues**: Config mutation (Issue #6)
- **Recommendation**: Add input validation

### Reel Setup (Lines 109-134)
- **Status**: Good
- **Issues**: Magic numbers in reel initialization (3 extra symbols)
- **Recommendation**: Extract constants

### Update Loop (Lines 203-431)
- **Status**: Contains critical bugs
- **Issues**: Bugs #1, #2, #4, #8, #9
- **Recommendation**: Major refactor needed

### Spin Controllers (Lines 447-606)
- **Status**: Functional but could be cleaner
- **Issues**: State management scattered
- **Recommendation**: Extract state machine to separate concern

### Win Evaluation (Lines 608-697)
- **Status**: Good logic
- **Issues**: Orphaned beginPath() (Bug #1)
- **Recommendation**: Clean up debug code

### Rendering (Lines 759-1180)
- **Status**: Good
- **Issues**: Hardcoded colors, magic numbers
- **Recommendation**: Extract color constants, add theming support

## Recommended Actions

### Immediate (Next Sprint - Critical)
1. Fix Bug #1: Remove orphaned `this.ctx.beginPath()` calls
2. Fix Bug #2: Initialize `this.frameCount` and increment in update()
3. Remove all debug console.log statements or gate behind debug flag

### Short Term (1-2 weeks - High)
4. Fix state machine unreachable states
5. Fix config mutation issue
6. Add particle limit to prevent performance issues
7. Add debounce to resize handler
8. Extract magic numbers to constants

### Medium Term (2-4 weeks - Medium)
9. Add input validation for config
10. Implement particle pool for better performance
11. Fix memory leak in particle system

### Long Term (1+ month - Low)
12. Add JSDoc comments for all public methods
13. Extract color constants for theming
14. Add error handling for canvas operations
15. Consider separating rendering from game logic
16. Add unit tests for core functionality

## Files to Update
- `core/SlotEngine.js` - All fixes and improvements

## Estimated Time to Complete
- **Critical fixes (Bugs #1-2)**: 1 hour
- **High priority fixes**: 4-6 hours
- **Medium priority fixes**: 2-3 hours
- **Low priority improvements**: 4-8 hours
- **Total for production-ready**: ~8-10 hours

---

*Generated: 2026-07-22*  
*Reviewed by: Code Review Process*
