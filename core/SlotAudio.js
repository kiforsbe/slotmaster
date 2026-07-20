// Core Slot Audio Synth Engine using Web Audio API

class SlotAudio {
  constructor() {
    this.ctx = null;
    this.bgmNode = null;
    this.bgmGain = null;
    this.isMuted = false;
    this.globalVolume = 0.3; // Default master volume
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

    // Simple rhythmic synth loop
    const playNote = (freq, time, duration, type = 'triangle') => {
      if (!this.bgmGain) return;
      const osc = this.ctx.createOscillator();
      const noteGain = this.ctx.createGain();

      osc.connect(noteGain);
      noteGain.connect(this.bgmGain);

      osc.type = type;
      osc.frequency.setValueAtTime(freq, time);

      noteGain.gain.setValueAtTime(0, time);
      noteGain.gain.linearRampToValueAtTime(1.0, time + 0.05);
      noteGain.gain.exponentialRampToValueAtTime(0.001, time + duration - 0.02);

      osc.start(time);
      osc.stop(time + duration);
    };

    let beat = 0;
    const bpm = 120;
    const stepTime = 60 / bpm / 2; // eighth notes

    // Spooky minor progression: A, C, B, E
    const melody = [
      220.00, 220.00, 261.63, 220.00,
      246.94, 246.94, 329.63, 246.94,
      220.00, 261.63, 329.63, 392.00,
      440.00, 392.00, 329.63, 246.94
    ];

    const scheduler = () => {
      if (!this.bgmGain) return;
      const nextTime = this.ctx.currentTime + 0.1;
      
      // Schedule next 4 beats
      for (let i = 0; i < 8; i++) {
        const noteIdx = (beat + i) % melody.length;
        const noteTime = nextTime + i * stepTime;
        const freq = melody[noteIdx];
        
        // Bass note on beat 0 and 4
        if ((beat + i) % 4 === 0) {
          playNote(freq / 2, noteTime, stepTime * 1.8, 'sawtooth');
        }
        
        // Melody note
        playNote(freq, noteTime, stepTime * 0.9, 'triangle');
      }

      beat += 8;
      // Schedule next batch in 2 seconds
      this.bgmInterval = setTimeout(scheduler, stepTime * 8 * 1000);
    };

    scheduler();
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
