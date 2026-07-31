// Core Slot Audio Synth Engine using Web Audio API

const MUSIC_BASE_SCALE = 0.5; // musicGain's baseline level, relative to globalVolume

const DEFAULT_DUCK_AMOUNT = 0.35; // how far music dips under an effect, relative to its own base level
const DEFAULT_DUCK_ATTACK = 0.05; // seconds to reach the ducked level
const DEFAULT_DUCK_RELEASE = 0.4; // seconds to recover back to base level after the attack

const DEFAULT_COMPRESSION = { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 };

class SlotAudio {
  constructor() {
    this.ctx = null;
    this.masterBus = null; // all synthesized SFX connect here
    this.compressor = null; // masterBus + musicGain both feed this before destination, if enabled
    this.isMuted = false;
    // Music is opt-in globally; sound effects remain enabled by default.
    this.musicMuted = true;
    this.globalVolume = 0.3; // Default master volume
    this.activeOscillators = [];

    // Background music (per-game theme tracks, configured via CoreSlotEngine's `music` config).
    this.musicTracks = {}; // state name -> URL or preloaded HTMLAudioElement
    this.musicState = 'main';
    this.musicEl = null; // HTMLAudioElement currently playing, or null
    this.musicSource = null; // its MediaElementAudioSourceNode
    this.musicGain = null; // GainNode feeding the compressor; ducked by _duckMusic
    this.musicBaseLevel = 0;
    this.currentMusicUrl = null;

    // Per-game tunable via CoreSlotEngine's `ducking` config (setDuckingConfig) - defaults match
    // this file's original fixed behavior so a game that sets nothing is unaffected.
    this.duckingEnabled = true;
    this.duckAmount = DEFAULT_DUCK_AMOUNT;
    this.duckAttack = DEFAULT_DUCK_ATTACK;
    this.duckRelease = DEFAULT_DUCK_RELEASE;

    // Per-game tunable via CoreSlotEngine's `compression` config (setCompressionConfig) - same
    // defaults-preserve-original-behavior rule as ducking above.
    this.compressionEnabled = true;
    this.compressionSettings = { ...DEFAULT_COMPRESSION };
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();

      this.masterBus = this.ctx.createGain();
      this.masterBus.gain.setValueAtTime(1, this.ctx.currentTime);

      this.musicBaseLevel = this.globalVolume * MUSIC_BASE_SCALE;
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.setValueAtTime(this.musicBaseLevel, this.ctx.currentTime);

      // Single shared mastering stage: every SFX gain node and the music bed both connect here,
      // rather than straight to destination, so one compressor keeps synthesized effects and a
      // real music file at consistent levels together instead of just each being self-normalized.
      // A game can opt out entirely (config.compression === false), in which case both buses
      // just connect straight to destination instead.
      if (this.compressionEnabled) {
        const { threshold, knee, ratio, attack, release } = this.compressionSettings;
        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.setValueAtTime(threshold, this.ctx.currentTime);
        this.compressor.knee.setValueAtTime(knee, this.ctx.currentTime);
        this.compressor.ratio.setValueAtTime(ratio, this.ctx.currentTime);
        this.compressor.attack.setValueAtTime(attack, this.ctx.currentTime);
        this.compressor.release.setValueAtTime(release, this.ctx.currentTime);
        this.compressor.connect(this.ctx.destination);

        this.masterBus.connect(this.compressor);
        this.musicGain.connect(this.compressor);
      } else {
        this.masterBus.connect(this.ctx.destination);
        this.musicGain.connect(this.ctx.destination);
      }
    } catch (e) {
      console.warn("Web Audio API not supported", e);
    }
  }

  // config is `false` (disable), `true`/undefined (enable with defaults), or a partial
  // `{ amount, attack, release }` overriding one or more defaults. Must be called before the
  // first sound plays (CoreSlotEngine calls it from its constructor) since init() reads these
  // settings once when it creates the ducking-adjacent nodes.
  setDuckingConfig(config) {
    if (config === false) {
      this.duckingEnabled = false;
      return;
    }
    this.duckingEnabled = true;
    const overrides = (config && typeof config === 'object') ? config : {};
    this.duckAmount = overrides.amount ?? DEFAULT_DUCK_AMOUNT;
    this.duckAttack = overrides.attack ?? DEFAULT_DUCK_ATTACK;
    this.duckRelease = overrides.release ?? DEFAULT_DUCK_RELEASE;
  }

  // config is `false` (disable), `true`/undefined (enable with defaults), or a partial
  // `{ threshold, knee, ratio, attack, release }` overriding one or more defaults. Must be
  // called before init() first runs (CoreSlotEngine calls it from its constructor) - the
  // compressor node and the bus wiring around it are only ever built once, inside init().
  setCompressionConfig(config) {
    if (config === false) {
      this.compressionEnabled = false;
      return;
    }
    this.compressionEnabled = true;
    const overrides = (config && typeof config === 'object') ? config : {};
    this.compressionSettings = {
      threshold: overrides.threshold ?? DEFAULT_COMPRESSION.threshold,
      knee: overrides.knee ?? DEFAULT_COMPRESSION.knee,
      ratio: overrides.ratio ?? DEFAULT_COMPRESSION.ratio,
      attack: overrides.attack ?? DEFAULT_COMPRESSION.attack,
      release: overrides.release ?? DEFAULT_COMPRESSION.release,
    };
  }

  resume() {
    this.init();
    const contextReady = this.ctx?.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
    // Browsers block <audio> playback until a user gesture. Wait for the Web Audio context to
    // finish resuming before retrying the media element; calling both synchronously can leave a
    // browser with a suspended source and a rejected play() promise.
    const tryPlayMusic = () => {
      if (this.musicEl && this.musicEl.paused && !this.isMuted && !this.musicMuted) {
        this.musicEl.play().catch(error => console.warn(
          `SlotAudio: music playback failed (${this.musicEl.src || 'no source'})`, error,
        ));
      }
    };
    // Keep one attempt synchronous while still inside the click/tap handler (the browser's
    // transient user activation may not survive a promise continuation), then retry once the
    // context is fully resumed.
    tryPlayMusic();
    Promise.resolve(contextReady).then(tryPlayMusic);
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
      this.musicEl?.pause();
    } else {
      if (!this.musicMuted) this.musicEl?.play().catch(() => {});
    }
  }

  toggleMute() {
    this.setMute(!this.isMuted);
    return this.isMuted;
  }

  setMusicMute(mute) {
    this.musicMuted = mute;
    if (mute) this.musicEl?.pause();
    else if (!this.isMuted) this.musicEl?.play().catch(() => {});
  }

  toggleMusicMute() {
    this.setMusicMute(!this.musicMuted);
    return this.musicMuted;
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
    gain.connect(this.masterBus);

    return { osc, gain, time: this.ctx.currentTime };
  }

  // Ramps musicGain down and back up around a sound effect, so effects stay audible over the
  // music bed without needing per-sound manual balancing. cancelScheduledValues + a fresh
  // setValueAtTime(current value) before ramping again means overlapping effects just extend the
  // dip instead of fighting a previous ramp or stacking multiple simultaneous target values.
  _duckMusic() {
    if (!this.duckingEnabled || !this.musicGain || !this.ctx || this.isMuted) return;
    const now = this.ctx.currentTime;
    const duckedLevel = this.musicBaseLevel * this.duckAmount;

    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(duckedLevel, now + this.duckAttack);
    this.musicGain.gain.linearRampToValueAtTime(this.musicBaseLevel, now + this.duckAttack + this.duckRelease);
  }

  // Configures which theme-music URL plays for each game state (e.g. { main, freespins }).
  // Called once by CoreSlotEngine with a game's `music` config; a game that sets nothing never
  // calls this at all, so no music subsystem is touched.
  setMusicTracks(tracks) {
    this.musicTracks = tracks || {};
  }

  // Switches the active music track to whatever's configured for `state`. If nothing is
  // configured for this state, this is a no-op - whatever track is already playing keeps
  // playing uninterrupted, rather than going silent or falling back to another track.
  setMusicState(state) {
    this.musicState = state;
    const url = this.musicTracks[state];
    if (!url || url === this.currentMusicUrl) return;
    this._playMusicTrack(url);
  }

  // Hard-cuts to a new track: no crossfade: the old element stops and the new one starts
  // immediately. Simpler than a crossfade and fine since games don't yet define more than one
  // distinct track each.
  _playMusicTrack(track) {
    this.init();
    if (!this.ctx) return;

    this._stopMusic();
    this.currentMusicUrl = track;

    const el = typeof track === 'string' ? new Audio(track) : track;
    if (!el) return;
    el.loop = true;
    el.preload = 'auto';
    this.musicEl = el;
    this.musicSource = this.ctx.createMediaElementSource(el);
    this.musicSource.connect(this.musicGain);

    if (!this.isMuted && !this.musicMuted) {
      // May be rejected by autoplay policy before the first user gesture; resume() retries after
      // the first user gesture and after the AudioContext has resumed.
      el.play().catch(() => {});
    }
  }

  _stopMusic() {
    if (this.musicEl) {
      try { this.musicEl.pause(); } catch (e) {}
      this.musicEl.src = '';
      this.musicEl = null;
    }
    if (this.musicSource) {
      try { this.musicSource.disconnect(); } catch (e) {}
      this.musicSource = null;
    }
    this.currentMusicUrl = null;
  }

  // 1. Reel spinning sound (low hum/click loop)
  playSpin() {
    this._duckMusic();
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
    this._duckMusic();
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
    this._duckMusic();
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
      gain.connect(this.masterBus);

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

  // Bright, percussive two/three-note "ding-ding!" bell chime - used by Candy Frenzy for its
  // per-cascade-step cluster win instead of playWin's rising arpeggio (built for payline-style
  // games). A bell timbre (fast attack, quick decay, faint octave-up shimmer, no vibrato) reads
  // more like a cheerful "you won!" ding than a musical phrase.
  playClusterWin(payoutMultiplier) {
    this._duckMusic();
    this.resume();
    if (!this.ctx || this.isMuted) return;

    const isBigWin = payoutMultiplier >= 5;
    const notes = isBigWin ? [1318.51, 1567.98, 2093.00] : [1318.51, 1567.98]; // E6, G6, (C7)
    const noteSpacing = 0.14;

    notes.forEach((freq, idx) => {
      const delay = idx * noteSpacing;
      this._playBellTone(freq, delay, 0.7);
      this._playBellTone(freq * 2, delay, 0.22); // faint octave-up shimmer for a bell-like timbre
    });
  }

  // One percussive bell-like tone: fast attack, exponential decay, no vibrato - reads as a
  // sharp "ding" rather than a sung note.
  _playBellTone(freq, delaySeconds, volumeScale) {
    const channel = this.createSynthChannel();
    if (!channel) return;
    const { osc, gain, time } = channel;
    const startTime = time + delaySeconds;
    const duration = 0.5;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(this.globalVolume * volumeScale, startTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
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
    this._duckMusic();
    this.resume();
    if (!this.ctx || this.isMuted) return;

    const time = this.ctx.currentTime;
    // Fast osc alarm
    for (let i = 0; i < 6; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.connect(gain);
      gain.connect(this.masterBus);

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
    this._duckMusic();
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
}

export const audio = new SlotAudio();
