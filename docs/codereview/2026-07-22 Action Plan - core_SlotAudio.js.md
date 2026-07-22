# Action Plan - core/SlotAudio.js

## File Overview
Web Audio API-based sound synthesizer for slot machine. Generates all sounds procedurally (reel spin, stops, wins, scatter triggers, BGM). 326 lines.

## Current Status: 🟡 MEDIUM - Functional but Needs Refactoring

## High Priority Issues

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 1 | **BGM scheduler completely broken** | Lines 197-305 | Notes don't play, syntax errors | 🔴 CRITICAL |
| 2 | Oscillator memory leak on mute | Lines 41-52 | Memory leak | 🟠 HIGH |
| 3 | BGM scheduler drift over time | Original code replaced | BGM falls out of sync | 🟠 HIGH |

### Fix Details

**Issue #1 - BGM scheduler completely broken:**
```javascript
// Lines 197-305: The startBGM() method is completely broken:

// Problems identified:
// 1. Line 209: `1.0 / bpm * 8` - bpm is used before definition (line 252)
// 2. Line 210: `playNote` function defined but never called correctly
// 3. Line 256: `function scheduleBatch` - never called or invoked
// 4. Line 275: `melody` is empty array `[]`
// 5. Lines 258-304: Schedule logic is completely garbled
// 6. Line 304: melody declared after being referenced
// 7. Line 308: this.bgmNode set to true (boolean) instead of interval ID
// 8. Line 309: Missing closing brace for startBGM function
// 9. Lines 273-274: No melody defined - array is empty

// The entire BGM implementation needs to be rewritten.

// Fix: Replace broken BGM with working implementation:

startBGM() {
  this.resume();
  if (!this.ctx || this.isMuted || this.bgmNode) return;

  this.bgmGain = this.ctx.createGain();
  this.bgmGain.gain.setValueAtTime(this.globalVolume * 0.35, this.ctx.currentTime);
  this.bgmGain.connect(this.ctx.destination);

  // Spooky Egyptian melody - A minor progression
  const melody = [
    220.00, 261.63, 293.66, 329.63,  // A2, C3, D3, E3
    392.00, 440.00, 392.00, 329.63,  // G3, A3, G3, E3
    261.63, 293.66, 329.63, 392.00,  // C3, D3, E3, G3
    440.00, 392.00, 329.63, 293.66   // A3, G3, E3, D3
  ];

  const bpm = 120;
  const beatDuration = 60 / bpm; // seconds per quarter note
  const notesPerBeat = 2; // Eighth notes
  const noteDuration = beatDuration / notesPerBeat;

  // Web Audio API lookahead scheduler
  const scheduleLookahead = 0.1; // 100ms lookahead
  const scheduleInterval = 0.05; // 50ms scheduling interval

  let currentNoteIndex = 0;
  let nextNoteTime = this.ctx.currentTime + 0.1; // Start 100ms from now

  const melodyLength = melody.length;

  function scheduleNotes() {
    if (!this.bgmGain) return;
    
    const now = this.ctx.currentTime;
    
    // Schedule notes for the next lookahead period
    while (nextNoteTime < now + scheduleLookahead) {
      const freq = melody[currentNoteIndex % melodyLength];
      
      // Create oscillator for this note
      const osc = this.ctx.createOscillator();
      const noteGain = this.ctx.createGain();
      
      osc.connect(noteGain);
      noteGain.connect(this.bgmGain);
      
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, nextNoteTime);
      
      // Note envelope: quick attack, sustain, quick release
      noteGain.gain.setValueAtTime(0, nextNoteTime);
      noteGain.gain.linearRampToValueAtTime(0.7, nextNoteTime + 0.01);
      noteGain.gain.exponentialRampToValueAtTime(0.001, nextNoteTime + noteDuration - 0.01);
      
      osc.start(nextNoteTime);
      osc.stop(nextNoteTime + noteDuration);
      
      // Every 4 notes, add a bass note (octave lower)
      if (currentNoteIndex % 4 === 0) {
        const bassOsc = this.ctx.createOscillator();
        const bassGain = this.ctx.createGain();
        
        bassOsc.connect(bassGain);
        bassGain.connect(this.bgmGain);
        
        bassOsc.type = 'sine';
        bassOsc.frequency.setValueAtTime(freq / 2, nextNoteTime);
        
        bassGain.gain.setValueAtTime(0, nextNoteTime);
        bassGain.gain.linearRampToValueAtTime(0.5, nextNoteTime + 0.01);
        bassGain.gain.exponentialRampToValueAtTime(0.001, nextNoteTime + noteDuration * 2 - 0.01);
        
        bassOsc.start(nextNoteTime);
        bassOsc.stop(nextNoteTime + noteDuration * 2);
      }
      
      currentNoteIndex++;
      nextNoteTime += noteDuration;
    }
    
    // Schedule next batch
    this.bgmInterval = setTimeout(scheduleNotes, scheduleInterval * 1000);
  }
  
  // Store bound reference
  this.bgmScheduler = scheduleNotes.bind(this);
  this.bgmScheduler();
  this.bgmNode = true; // Mark as active
}
```

**Issue #2 - Oscillator memory leak on mute:**
```javascript
// Lines 41-52: createSynthChannel returns null when muted
// But oscillators already playing are not tracked or stopped

// Fix: Track active oscillators and stop them on mute:
constructor() {
  // ... existing code
  this.activeOscillators = [];
}

setMute(mute) {
  this.isMuted = mute;
  if (mute) {
    // Stop all active oscillators
    this.activeOscillators.forEach(osc => {
      try {
        osc.stop();
      } catch (e) {}
    });
    this.activeOscillators = [];
    this.stopBGM();
  }
}

createSynthChannel(duration) {
  this.resume();
  if (!this.ctx || this.isMuted) return null;

  const osc = this.ctx.createOscillator();
  const gain = this.ctx.createGain();
  
  // Track oscillator
  this.activeOscillators.push(osc);
  
  osc.connect(gain);
  gain.connect(this.ctx.destination);
  
  // Auto-remove from tracking when stopped
  osc.onended = () => {
    const idx = this.activeOscillators.indexOf(osc);
    if (idx !== -1) {
      this.activeOscillators.splice(idx, 1);
    }
  };
  
  return { osc, gain, time: this.ctx.currentTime };
}
```

**Issue #3 - BGM scheduler drift:**
This is superseded by Issue #1 - the entire BGM is broken. Fixing Issue #1 resolves this.

## Medium Priority Issues

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 4 | No volume control per sound type | Multiple | Limited flexibility | 🟡 MEDIUM |
| 5 | Hardcoded frequencies and timings | Multiple | Reduced configurability | 🟡 MEDIUM |
| 6 | No error handling for Web Audio API | Multiple | Robustness | 🟡 MEDIUM |

**Issue #4 - No per-sound-type volume control:**
```javascript
// All sounds use this.globalVolume
// Can't adjust spin volume vs win volume separately

// Fix: Add volume multipliers per sound type:
constructor() {
  this.volume = {
    master: 0.3,
    spin: 1.0,
    reelStop: 1.0,
    win: 1.0,
    scatter: 1.0,
    expand: 1.0,
    bgm: 0.35
  };
}

// Then in each play method:
playSpin() {
  // ... existing code
  gain.gain.setValueAtTime(this.volume.master * this.volume.spin * 0.4, time);
  // ...
}
```

**Issue #5 - Hardcoded frequencies:**
```javascript
// Lines 61, 78, 98-100, 136-142, 166, 185-186, etc.
// Frequencies are hardcoded magic numbers

// Fix: Extract to constants:
const NOTES = {
  C2: 65.41,
  C3: 130.81,
  C4: 261.63,
  C5: 523.25,
  E3: 164.81,
  E4: 329.63,
  E5: 659.25,
  G3: 196.00,
  G4: 392.00,
  G5: 783.99,
  // etc.
};

// Then use: NOTES.C4 instead of 261.63
```

**Issue #6 - No error handling:**
```javascript
// Lines 15-18: try/catch exists for AudioContext creation
// But other audio operations lack error handling

// Fix: Wrap audio operations in try/catch:
playSpin() {
  try {
    const channel = this.createSynthChannel();
    if (!channel) return;
    // ...
  } catch (e) {
    console.warn('Audio play failed:', e);
  }
}
```

## Low Priority Enhancements

| # | Issue | Location | Impact | Severity |
|---|-------|----------|--------|----------|
| 7 | Debug logging | Lines 17, 94, 154 | Minor | 🟢 LOW |
| 8 | No JSDoc comments | Multiple | Documentation | 🟢 LOW |
| 9 | Magic numbers in timings | Multiple | Maintainability | 🟢 LOW |

**Issue #7 - Debug logging:**
```javascript
// Lines with console.warn:
// Line 17: console.warn("Web Audio API not supported", e);
// This is fine - should stay

// Other console.log/console.warn should be gated:
setMute(mute) { this.isMuted = mute; if (mute) { this.stopBGM(); } }
// No logging needed for normal mute operation
```

**Issue #8 - No JSDoc comments:**
```javascript
// Add JSDoc for all public methods:

/**
 * Slot Machine Audio Synthesizer
 * Generates all game sounds procedurally using Web Audio API
 */
class SlotAudio {
  /**
   * Initialize audio context
   */
  init() { ... }
  
  /**
   * Resume suspended audio context (required for user interaction)
   */
  resume() { ... }
  
  // etc.
}
```

**Issue #9 - Magic numbers in timings:**
```javascript
// Line 65: gain.gain.linearRampToValueAtTime(0.01, time + 0.8);
// Line 85: gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
// Line 122-123: Various timings

// These are fine as they're sound design decisions
// Could extract to constants if adjustment is needed:
// SPIN_SOUND_DURATION = 0.8, etc.
```

## Code Quality Analysis

### Strengths
✅ Excellent use of Web Audio API - no external audio files needed  
✅ Procedural sound design is elegant and flexible  
✅ Good separation from game logic  
✅ Singleton pattern with `audio` export  
✅ Resume handling for browser autoplay restrictions  

### Areas for Improvement
⚠️ **BGM implementation is completely broken** - needs full rewrite  
⚠️ Memory management for oscillators  
⚠️ No per-sound volume control  
⚠️ Hardcoded sound design values  
⚠️ Limited error handling  

## Recommended Actions

### Immediate (Next Sprint - Critical)
1. **Fix Issue #1**: Rewrite the BGM scheduler completely (currently broken)
2. **Fix Issue #2**: Track oscillators and stop them on mute

### Short Term (1-2 weeks - High)
3. Add per-sound-type volume controls
4. Add error handling for audio operations

### Medium Term (2-4 weeks - Medium)
5. Extract note frequencies to constants
6. Add input validation for audio methods

### Long Term (1+ month - Low)
7. Add JSDoc comments
8. Consider adding sound presets/theming
9. Add audio test page for sound design

## Files to Update
- `core/SlotAudio.js` - Complete BGM rewrite, memory fixes, volume controls

## Dependencies
- BGM fix may require testing with game integration
- Volume controls may need UI updates in game.js

## Estimated Time to Complete
- **Critical fixes (BGM rewrite)**: 4-6 hours
- **High priority fixes (memory, volume)**: 2-3 hours
- **Medium priority fixes**: 2-3 hours
- **Low priority improvements**: 2-4 hours
- **Total for production-ready**: ~8-12 hours

---

*Generated: 2026-07-22*  
*Reviewed by: Code Review Process*
