// Core Slot Audio Synth Engine using Web Audio API

class SlotAudio {
  constructor() {
    this.ctx = null;
    this.bgmNode = null;
    this.bgmGain = null;
    this.bgmInterval = null;
    this.isMuted = false;
    this.globalVolume = 0.3; // Default master volume
    this.activeOscillators = [];
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn("Web Audio API not supported", e);
    }
  }

  resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setMute(mute) {
    this.isMuted = mute;
    if (mute) {
      // Stop all active oscillators to prevent memory leak
      this.activeOscillators.forEach(osc => {
        try {
          osc.stop();
        } catch (e) {
          // Ignore errors from already-stopped oscillators
        }
      });
      this.activeOscillators = [];
      this.stopBGM();
    }
  }

  toggleMute() {
    this.setMute(!this.isMuted);
    return this.isMuted;
  }

  // Create standard helper to configure a gain node and connect to output
  createSynthChannel(duration) {
    this.resume();
    if (!this.ctx || this.isMuted) return null;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    // Track oscillator for cleanup on mute
    this.activeOscillators.push(osc);
    
    // Auto-remove from tracking when oscillator ends
    osc.onended = () => {
      const idx = this.activeOscillators.indexOf(osc);
      if (idx !== -1) {
        this.activeOscillators.splice(idx, 1);
      }
    };
    
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    
    return { osc, gain, time: this.ctx.currentTime };
  }

  // 1. Reel spinning sound (low hum/click loop)
  playSpin() {
    const channel = this.createSynthChannel();
    if (!channel) return;
    const { osc, gain, time } = channel;

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(45, time); // low frequency
    osc.frequency.exponentialRampToValueAtTime(30, time + 0.5);

    gain.gain.setValueAtTime(this.globalVolume * 0.4, time);
    gain.gain.linearRampToValueAtTime(0.01, time + 0.8);

    osc.start(time);
    osc.stop(time + 0.8);
  }

  // 2. Reel stops with a mechanical thud / clunk
  playReelStop(reelIndex) {
    const channel = this.createSynthChannel();
    if (!channel) return;
    const { osc, gain, time } = channel;

    // Pitch increases slightly for subsequent reels
    const baseFreq = 80 + reelIndex * 15;
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(baseFreq, time);
    osc.frequency.setValueAtTime(baseFreq * 0.6, time + 0.05);

    gain.gain.setValueAtTime(this.globalVolume * 0.8, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);

    osc.start(time);
    osc.stop(time + 0.16);
  }

  // 3. Highlight win sound (retro chime / arpeggio)
  playWin(payoutMultiplier) {
    this.resume();
    if (!this.ctx || this.isMuted) return;

    // Scale win sound duration and excitement based on payout size
    const isBigWin = payoutMultiplier >= 50;
    const notes = isBigWin 
      ? [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50, 1318.51] // C major scale up to C6
      : [261.63, 329.63, 392.00, 523.25]; // C major triad + octave
    
    const noteLength = isBigWin ? 0.08 : 0.12;
    const time = this.ctx.currentTime;

    notes.forEach((freq, idx) => {
      const noteTime = time + idx * noteLength;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, noteTime);
      
      // Add vibrato
      osc.frequency.setValueAtTime(freq, noteTime);
      osc.frequency.linearRampToValueAtTime(freq + 5, noteTime + noteLength * 0.5);
      osc.frequency.linearRampToValueAtTime(freq - 5, noteTime + noteLength);

      gain.gain.setValueAtTime(0, noteTime);
      gain.gain.linearRampToValueAtTime(this.globalVolume * 0.6, noteTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, noteTime + noteLength * 1.5);

      osc.start(noteTime);
      osc.stop(noteTime + noteLength * 1.6);
    });

    if (isBigWin) {
      // Add an extra bass synth to ground the big win
      setTimeout(() => this.playBigWinSubBass(), 100);
    }
  }

  playBigWinSubBass() {
    const channel = this.createSynthChannel();
    if (!channel) return;
    const { osc, gain, time } = channel;

    osc.type = 'square';
    osc.frequency.setValueAtTime(65.41, time); // C2
    osc.frequency.linearRampToValueAtTime(130.81, time + 1.0); // C3

    gain.gain.setValueAtTime(this.globalVolume * 0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 1.2);

    osc.start(time);
    osc.stop(time + 1.2);
  }

  // 4. Scatter alarm (rings when 3 books land)
  playScatterTrigger() {
    this.resume();
    if (!this.ctx || this.isMuted) return;

    const time = this.ctx.currentTime;
    // Fast osc alarm
    for (let i = 0; i < 6; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.connect(gain);
      gain.connect(this.ctx.destination);

      const noteTime = time + i * 0.15;
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(523.25, noteTime); // C5
      osc.frequency.linearRampToValueAtTime(783.99, noteTime + 0.1); // G5

      gain.gain.setValueAtTime(0, noteTime);
      gain.gain.linearRampToValueAtTime(this.globalVolume * 0.8, noteTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.14);

      osc.start(noteTime);
      osc.stop(noteTime + 0.15);
    }
  }

  // 5. Symbol expanding sound effect (whoosh / build-up)
  playExpand() {
    const channel = this.createSynthChannel();
    if (!channel) return;
    const { osc, gain, time } = channel;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(900, time + 0.6);

    gain.gain.setValueAtTime(0.01, time);
    gain.gain.linearRampToValueAtTime(this.globalVolume * 0.8, time + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.7);

    osc.start(time);
    osc.stop(time + 0.7);
  }

  // 6. Free Spins Background Loop (spooky Egyptian/adventure vibe synth)
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
    const playNote = (freq, time, duration, type = 'triangle') => {
      if (!this.bgmGain) return;
      
      const osc = this.ctx.createOscillator();
      const noteGain = this.ctx.createGain();

      osc.connect(noteGain);
      noteGain.connect(this.bgmGain);

      osc.type = type;
      
      // Prevent frequency values of 0 or negative
      if (!isFinite(freq) || freq <= 0) { 
        return; 
      }

      const tStart = Math.max(time, this.ctx.currentTime + 0.01);

      noteGain.gain.setValueAtTime(0, tStart);
      noteGain.linearRampToValueAtTime(0.7, tStart + 0.01);
      noteGain.exponentialRampToValueAtTime(0.001, tStart + duration - 0.01);

      const oscStartTime = Math.max(tStart, this.ctx.currentTime);
      
      try {
        osc.start(oscStartTime);
        osc.stop(tStart + duration);
      } catch (e) {
        // Ignore errors from stopped oscillators
      }
    };

    const scheduleNotes = () => {
      if (!this.bgmGain) return;
      
      const now = this.ctx.currentTime;
      
      // Schedule notes for the next lookahead period
      while (nextNoteTime < now + scheduleLookahead) {
        const freq = melody[currentNoteIndex % melodyLength];
        
        // Create oscillator for this note
        playNote(freq, nextNoteTime, noteDuration, 'triangle');
        
        // Every 4 notes, add a bass note (octave lower)
        if (currentNoteIndex % 4 === 0) {
          playNote(freq / 2, nextNoteTime, noteDuration * 2, 'sine');
        }
        
        currentNoteIndex++;
        nextNoteTime += noteDuration;
      }
      
      // Schedule next batch
      this.bgmInterval = setTimeout(scheduleNotes, scheduleInterval * 1000);
    };
    
    // Store bound reference
    this.bgmScheduler = scheduleNotes.bind(this);
    this.bgmScheduler();
    this.bgmNode = true; // Mark as active
  }

  stopBGM() {
    if (this.bgmInterval) {
      clearTimeout(this.bgmInterval);
      this.bgmInterval = null;
    }
    if (this.bgmGain) {
      try {
        this.bgmGain.disconnect();
      } catch (e) {}
      this.bgmGain = null;
    }
    this.bgmNode = null;
  }
}

export const audio = new SlotAudio();
