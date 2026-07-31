// A skeleton, not a monolith: owns the state machine and animation loop only. Every other
// concern - grid resolution, animation style, drawing, particles, audio, free-spins payout
// rules, spin logging - is a component plugged in through config, each its own file. See
// docs/superpowers/specs/2026-07-28-core-modularization-design.md.
import { computeGridLayout } from '../rendering/GridLayout.js';
import { audio } from '../audio/SlotAudio.js';
import { createSeededRng } from '../math/SlotMath.js';
import { simulateSpins } from '../SpinSimulator.js';
import { AssetLoader } from '../assets/AssetLoader.js';

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

    this.assetLoader = config.assetLoader ?? new AssetLoader();
    this.assetManifest = config.assetManifest ?? null;
    // AssetLoader returns the canonical asset map. Renderers consume assets.symbols directly;
    // there is no second game-specific asset representation.
    this.assets = config.assets ?? {};

    // Per-game-state theme music (e.g. { main, freespins }), configured via config.music - a
    // game that sets nothing never touches the audio engine's music subsystem at all. Wired here
    // in the constructor rather than init() since init() does browser-only setup (window resize
    // listeners) that isn't safe to call in tests; setMusicTracks/setMusicState are themselves
    // no-ops until a real AudioContext exists, so calling them eagerly is safe.
    this.musicConfig = config.music || null;
    if (this.musicConfig) {
      this._configureMusic(this.musicConfig);
    }

    // Duck-on-effect and the master compressor are on by default (matching this file's original
    // fixed behavior); a game can disable either (`false`) or tune its parameters (an object) -
    // see SlotAudio.setDuckingConfig/setCompressionConfig for the accepted shapes. Applied
    // unconditionally, independent of whether `music` is configured - compression affects every
    // SFX regardless, and an unconfigured duck target is simply inert.
    audio.setDuckingConfig(config.ducking);
    audio.setCompressionConfig(config.compression);

    // Direct singleton access for auxiliary controls outside the spin lifecycle (mute toggle) -
    // matches SlotEngine.js's/CascadeEngine.js's own exposed `this.audio`. audioController
    // (above) is for lifecycle hooks CoreSlotEngine itself calls; this is for a game's own UI
    // wiring (e.g. a mute button calling engine.audio.toggleMute() directly).
    this.audio = audio;

    this.state = 'idle';
    this.balance = 1000;
    this.betPerLine = this.config.betPerLine;
    this.linesCount = this.config.linesCount;
    this.betAmount = this.config.betAmount;
    this.totalBet = this.betAmount ?? (this.betPerLine * this.linesCount);
    this.lastWin = 0;

    this.inFreeSpins = false;
    this.freeSpinsRemaining = 0;
    this.freeSpinsTotal = 0;
    this.freeSpinsAccumulatedWin = 0;
    this.freeSpinsModeState = null;
    this.freeSpinsIntroPending = false;

    this.spinSequence = null;
    this.stepIndex = 0;
    this.grid = null;
    this.lastSpinSeed = null;

    this.turboMode = false;
    this.autoPlay = false;
    this.pendingSpinRequest = false;
    this.autoPlayTimer = null;
    this._forcedGrid = null;
    this._forceScatterNextSpin = false;
    this._spinInProgress = false;

    // Win-presentation state a Renderer reads (see core/rendering/SlotRenderer.js's
    // drawWinEffects). winCycleIndex is fixed at -1 ("show every active win at once") rather
    // than cycling through them one at a time on a timer - a deliberate, disclosed
    // simplification versus SlotEngine.js's original winCycleTimer behavior, revisited if it
    // turns out to matter visually.
    this.winData = null;
    this.expandingWinData = null;
    this.winCycleIndex = -1;
    this.activeWinLineIndex = -1;

    // Asset/layout state - populated by loadAssets()/resize(), read by a Renderer/SpinAnimator.
    this.assetsLoaded = false;
    this.symbolWidth = 0;
    this.symbolHeight = 0;
    this.reelsX = 0;
    this.reelsY = 0;
    this.reelsWidth = 0;
    this.reelsHeight = 0;
  }

  // A game calls this once after construction (deliberately not automatic, unlike
  // SlotEngine.js's/CascadeEngine.js's constructors - keeps plain construction free of
  // browser-only side effects, e.g. window.addEventListener, so CoreSlotEngine is constructible
  // in tests with a stub canvas and no DOM).
  init() {
    this.setupResize();
    const assetsReady = this.loadAssets();
    // Decorative-only, not a real spin: matches SlotEngine.js's/CascadeEngine.js's own eager
    // initial-fill call from their constructor-invoked init(), so the game never shows a blank
    // playfield before the player's first spin. Optional - an animator that has nothing
    // decorative to show (or is under test with a stub) simply skips this.
    this.animator?.showIdle?.(this);
    this.animate();
    return assetsReady;
  }

  _configureMusic(tracks) {
    this.musicConfig = tracks;
    audio.setMusicTracks(tracks);
    audio.setMusicState('main');
  }

  loadAssets() {
    this.assetsLoaded = false;
    const load = this.assetManifest
      ? this.assetLoader.loadAll(this.assetManifest).then(assets => { this.assets = assets; })
      : Promise.resolve(this.assets);
    this.assetLoadPromise = load.then(() => {
      if (!this.musicConfig && this.assets.music) {
        const track = this.assets.music.audio || this.assets.music.url;
        if (track) this._configureMusic({ main: track });
      }
      this.assetsLoaded = true;
      if (this.canvas?.parentElement) this.resize();
      return this.assets;
    }).catch(error => {
      console.error(`CoreSlotEngine: failed to load assets: ${error.message}`);
      throw error;
    });
    return this.assetLoadPromise;
  }

  setupResize() {
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.resize(), 100);
    });
    this.resize();
  }

  // GridLayout.computeGridLayout now sizes the canvas to fill `.game-viewport` (this.canvas's
  // direct parent) exactly - no letterboxing - so the canvas and its DOM container are always
  // the same size; any leftover space around the reels' own aspect-fit grid stays inside the
  // canvas for drawCabinet/drawViewportBackground to paint into.
  resize() {
    const parentRect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const layout = computeGridLayout(parentRect.width, parentRect.height, dpr, this.config.reelsCount, this.config.rowsCount);

    this.canvas.style.width = `${layout.cssWidth}px`;
    this.canvas.style.height = `${layout.cssHeight}px`;
    this.canvas.width = layout.canvasWidth;
    this.canvas.height = layout.canvasHeight;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);

    this.symbolWidth = layout.cellSize;
    this.symbolHeight = layout.cellSize;
    this.reelsWidth = layout.reelsWidth;
    this.reelsHeight = layout.reelsHeight;
    this.reelsX = layout.reelsX;
    this.reelsY = layout.reelsY;
  }

  get layout() {
    return {
      reelsX: this.reelsX, reelsY: this.reelsY,
      reelsWidth: this.reelsWidth, reelsHeight: this.reelsHeight,
      symbolWidth: this.symbolWidth, symbolHeight: this.symbolHeight,
    };
  }

  // Read-only view onto the plugged-in SpinLogRecorder's own buffer, matching
  // SlotEngine.js's/CascadeEngine.js's own `engine.spinLog` property - ui/dev/SpinLogPanel.js
  // (and a game's own DOM wiring) read this directly, with no idea a SpinLogRecorder component
  // exists underneath. Empty, not undefined, when no recorder is configured (a game that never
  // wires SPIN LOG can still safely read engine.spinLog.length).
  get spinLog() {
    return this.spinLogRecorder?.entries ?? [];
  }

  // Runs continuously for the engine's whole lifetime (idle reels, particle decay, win-effect
  // presentation), not just during an active spin - matching SlotEngine.js's/CascadeEngine.js's
  // own animate(). A spin's own physics/timing is driven separately, inside the active
  // SpinAnimator's playEntrance/playTransition call (see _playStep) - this loop only ever issues
  // draw calls and advances the particle system, it never decides game state.
  animate() {
    this.particleSystem?.update();
    this.renderer?.draw(this, this.ctx);
    requestAnimationFrame(() => this.animate());
  }

  _setState(next) {
    this.state = next;
    this.config.onStateChange(next);
  }

  updateBet() {
    this.totalBet = this.betAmount ?? (this.betPerLine * this.linesCount);
  }

  requestSpin() {
    // A scatter-triggered intro owns the game until the player has explicitly entered
    // free spins. Do not queue a click from the still-visible base-game controls.
    if (this.freeSpinsIntroPending || this.state === 'free_spins_intro') return;
    if (this.state !== 'idle' && this.state !== 'showing_wins' && this.state !== 'game_over') {
      this.pendingSpinRequest = true;
      return;
    }
    this.spin();
  }

  async spin(seed = Math.floor(Math.random() * 0xFFFFFFFF)) {
    // Re-entrancy guard. spin() is async and genuinely suspends across multiple
    // requestAnimationFrame-driven animation steps (unlike SlotEngine.js's own spin(), which
    // sets up reel timers and returns immediately, doing its actual waiting via a separately
    // polled update() loop) - two overlapping calls here would interleave and corrupt shared
    // state like this.grid/this.spinSequence mid-flight, not just "last write wins" the way the
    // original's synchronous setup did. This can genuinely happen: a free-spins auto-progression
    // timer (handleAutoPlay) and a debug forceWinResult() click, or two rapid legitimate
    // requestSpin() calls, can both observe a valid starting state and both call spin() before
    // either one's animation has finished.
    if (this._spinInProgress) return;
    this._spinInProgress = true;
    try {
      await this._spin(seed);
    } finally {
      this._spinInProgress = false;
    }
  }

  async _spin(seed) {
    this._stopRequested = false;
    this.updateBet();
    if (!this.inFreeSpins) {
      // SlotEngine.js showed a blocking alert() here; dropped since it isn't safe for
      // browser-automation flows (Playwright) and a game can watch engine.balance/totalBet
      // itself to disable its own spin button before this is ever reached.
      if (this.balance < this.totalBet) {
        this.pendingSpinRequest = false;
        this.autoPlay = false;
        return;
      }
      this.balance -= this.totalBet;
      this.lastWin = 0;
    }

    this.lastSpinSeed = seed;
    this._setState('spinning');
    this.audioController?.onSpinStart();

    const result = this.mechanic.resolveLiveSpin({
      reelStrips: this.config.reelStrips,
      rowsCount: this.config.rowsCount,
      seed,
      config: this.config,
      linesCount: this.linesCount,
      winEvaluator: this._buildWinEvaluatorForSpin(),
      maxCascadeSteps: this.config.maxCascadeSteps,
      forcedGrid: this._forcedGrid,
    });
    this._forcedGrid = null;

    // Cascade-only cheat path (mirrors CascadeEngine.js's forceScatterResult): a cascade spin
    // can't be forced via a seeded starting grid the way a line-pay spin can (its outcome
    // resolves progressively, step by step), so this rewrites the LAST step's grid and injects
    // a scatterWin directly, after the mechanic has already resolved the whole sequence.
    if (this._forceScatterNextSpin && result.steps.length && 'clusterWins' in result.steps[0]) {
      this._forceScatterNextSpin = false;
      const scatterSym = this.config.scatterSymbol;
      const lastStep = result.steps[result.steps.length - 1];
      const positions = [
        [0, 0],
        [Math.floor(this.config.reelsCount / 2), Math.floor(this.config.rowsCount / 2)],
        [this.config.reelsCount - 1, this.config.rowsCount - 1],
      ];
      positions.forEach(([c, r]) => { lastStep.grid[c][r] = scatterSym; });
      result.scatterWin = { symbol: scatterSym, count: 3, positions, triggerFreeSpins: true, payout: 0 };
    }

    this.spinSequence = result.steps;
    this.stepIndex = 0;
    this._lastScatterWin = result.scatterWin;
    this.winData = null;
    this.expandingWinData = null;

    await this._playStep(this.stepIndex);

    const firstStep = this.spinSequence[0];
    if (firstStep && 'lineWins' in firstStep) {
      this.winData = { lineWins: firstStep.lineWins || [], scatterWin: firstStep.scatterWin || null };
    }

    if (result.scatterWin && result.scatterWin.triggerFreeSpins) {
      this.config.onScatterTrigger(result.scatterWin.count, this.inFreeSpins);
      this.audioController?.onScatterTrigger();
    }

    if (this.inFreeSpins && this.config.expandingSymbol && this.mechanic.evaluateExpandingWin) {
      const expandingResult = this.mechanic.evaluateExpandingWin(
        this.grid, this.config.expandingSymbol, this.config, this.linesCount,
      );
      // checkExpandingWins (core/math/SlotMath.js) returns null, not a zero-payout object, when
      // the expanding symbol doesn't land enough reels to pay anything - a real, expected
      // outcome (most spins), not an error case.
      //
      // Only plays the reveal when it actually pays - a disclosed simplification versus
      // SlotEngine.js, which enters 'expanding' whenever evaluateExpandingWin runs at all
      // (even with zero matching reels). Skipping a reveal animation for zero expanded columns
      // is a no-op either way; this just also skips it for a non-winning expansion.
      if (expandingResult && expandingResult.totalPayoutMultiplier > 0) {
        this.expandingWinData = expandingResult;
        this._setState('expanding');
        this.audioController?.onExpand();
        if (this.animator.playExpandingReveal) {
          await new Promise((resolve) => this.animator.playExpandingReveal(this, this.config.expandingSymbol, expandingResult.expandingReels, resolve));
        }
        // betPerLine, not totalBet - matches SlotEngine.js's own expanding-win math.
        this.lastWin += expandingResult.totalPayoutMultiplier * this.betPerLine;
      }
    }

    this._finishSpin();
  }

  _buildWinEvaluatorForSpin() {
    if (!this.inFreeSpins || !this.freeSpinsMode) {
      return this.config.winEvaluator;
    }
    return this.freeSpinsMode.wrapWinEvaluator(this.config.winEvaluator, this.freeSpinsModeState, this);
  }

  // playEntrance plays exactly once per spin, for the very first step (index is always 0 at the
  // call site below) - every later cascade step is reached exclusively through _advanceCascadeSteps'
  // playTransition chain. Calling playEntrance again for a later step (the original recursive
  // design here did, by having this method call itself) reintroduces a real bug: by the time
  // that call happens, playTransition's own fall phase has already correctly landed the grid, so
  // CascadeDropAnimator sees an already-correct board and mistakes it for a stale "outgoing" one
  // to animate away, while an identical copy re-enters from above - a visible double-drop (and,
  // mid-cascade, a moment where an already-cleared cluster's symbols flash back before vanishing
  // again) before things settle back to the very state that was already correct.
  async _playStep(index) {
    console.log(`CoreSlotEngine: playing step ${index + 1}/${this.spinSequence.length}`);
    const step = this.spinSequence[index];
    this.grid = step.grid;
    await new Promise((resolve) => this.animator.playEntrance(this, step, resolve));
    await this._advanceCascadeSteps(index);
  }

  async _advanceCascadeSteps(index) {
    if (index + 1 >= this.spinSequence.length) return;
    console.log(`CoreSlotEngine: advancing to cascade step ${index + 2}/${this.spinSequence.length}`);
    const step = this.spinSequence[index];
    this.stepIndex = index + 1;
    const nextStep = this.spinSequence[this.stepIndex];
    await new Promise((resolve) => this.animator.playTransition(this, step, nextStep, resolve));
    this.grid = nextStep.grid;
    await this._advanceCascadeSteps(this.stepIndex);
  }

  _finishSpin() {
    this._setState('evaluating');
    // Each step's payout is already an already-monetized dollar amount (see
    // LineMechanic.resolveLiveSpin/CascadeSpinMechanic.resolveLiveSpin's own docs) - summing
    // needs no further bet scaling here, deliberately, since only the mechanic knows its own bet
    // model (per-line vs. flat).
    const totalPayout = this.spinSequence.reduce((sum, step) => sum + (step.payout || 0), 0);
    this.lastWin += totalPayout;
    this.balance += this.lastWin;

    if (this.inFreeSpins) {
      this.freeSpinsAccumulatedWin += this.lastWin;
    }

    if (this.spinLogRecorder) {
      this.spinLogRecorder.record({
        sequence: this.spinSequence,
        scatterWin: this._lastScatterWin,
        seed: this.lastSpinSeed,
        timestamp: Date.now(),
        phase: this.inFreeSpins ? 'free' : 'base',
        chargedBet: this.inFreeSpins ? 0 : this.totalBet,
        expandingWinData: this.expandingWinData,
        expandingSymbol: this.config.expandingSymbol,
      });
    }

    if (this.lastWin > 0) {
      this.config.onWin({ amount: this.lastWin });
      this.audioController?.onWin(this.lastWin);
      this._setState('showing_wins');
    } else {
      this._setState('idle');
    }

    if (this.pendingSpinRequest) {
      this.pendingSpinRequest = false;
      this.requestSpin();
    }

    // Always run, matching SlotEngine.js's own evaluateSpinResult() - this is what chains free
    // spins forward automatically (spinFreeSpins() below) and continues base-game autoplay.
    this.handleAutoPlay();
  }

  stopSpin() {
    // Ask the active animator to enter its normal landing/deceleration path at accelerated
    // timing. The resolved outcome is never changed; only the presentation is shortened.
    if (this.state === 'spinning' || this.state === 'dropping_in' || this.state === 'falling' || this.state === 'clearing') {
      this._stopRequested = true;
      this._setState('stopping');
    }
  }

  // Debug/cheat helper - forces the next spin's grid to contain a given outcome. Builds the
  // grid itself (ported verbatim from SlotEngine.js's own forceWinResult) and hands it to the
  // mechanic via spin()'s forcedGrid param; only meaningful for LineMechanic (a mechanic that
  // ignores forcedGrid, e.g. CascadeSpinMechanic, just spins normally).
  forceWinResult(winType) {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;
    this._forcedGrid = this._buildForcedGrid(winType);
    this.spin();
  }

  // Debug/cheat helper for cascade games (mirrors CascadeEngine.js's forceScatterResult) -
  // forces this game's next spin to land 3 bonus symbols on the final grid, for testing the
  // free-spins trigger. See spin()'s _forceScatterNextSpin handling for how it's applied.
  forceScatterResult() {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;
    this._forceScatterNextSpin = true;
    this.spin();
  }

  _buildForcedGrid(winType) {
    const grid = [];
    const randomSymbol = (strip) => strip[Math.floor(Math.random() * strip.length)];

    if (winType === 'scatter') {
      const scatterSym = this.config.scatterSymbol || 'book';
      const reelsCount = this.config.reelsCount;
      const midRow = Math.floor(this.config.rowsCount / 2);
      const triggerCols = [0, Math.floor(reelsCount / 2), reelsCount - 1];
      for (let col = 0; col < reelsCount; col++) {
        const strip = this.config.reelStrips[col];
        const colSymbols = [];
        for (let row = 0; row < this.config.rowsCount; row++) colSymbols.push(randomSymbol(strip));
        if (triggerCols.includes(col)) colSymbols[midRow] = scatterSym;
        grid.push(colSymbols);
      }
    } else if (winType === 'expanding') {
      const sym = this.config.expandingSymbol || 'tut';
      for (let col = 0; col < 5; col++) {
        const strip = this.config.reelStrips[col];
        const colSymbols = [randomSymbol(strip), randomSymbol(strip), randomSymbol(strip)];
        if (col === 0 || col === 2 || col === 3) colSymbols[Math.floor(Math.random() * 3)] = sym;
        grid.push(colSymbols);
      }
    } else if (winType === 'bigwin') {
      const firstLineSymbol = randomSymbol(this.config.reelStrips[0]);
      for (let col = 0; col < this.config.reelsCount; col++) {
        grid.push(Array(this.config.rowsCount).fill(firstLineSymbol));
      }
    }
    return grid;
  }

  // Schedules the next base-game autoplay spin, or the next free-spins round's spin - matches
  // SlotEngine.js's own handleAutoPlay(). Called unconditionally at the end of every resolved
  // spin (see _finishSpin), which is what makes free spins actually progress: without it, a
  // free-spins round would stall after its first spin with nothing left to trigger the next one.
  handleAutoPlay() {
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }

    // The trigger callback runs before the current spin finishes its bookkeeping. The
    // callback may put the engine in this state while autoplay is still enabled; never
    // schedule another base spin while the free-spins intro modal is waiting for entry.
    if (this.freeSpinsIntroPending || this.state === 'free_spins_intro') return;

    if (this.inFreeSpins) {
      this.autoPlayTimer = setTimeout(() => {
        this.spinFreeSpins();
      }, this.turboMode ? 800 : 1800);
    } else if (this.autoPlay) {
      this.autoPlayTimer = setTimeout(() => {
        if (this.autoPlay && (this.state === 'idle' || this.state === 'showing_wins')) {
          this.spin();
        }
      }, this.turboMode ? 300 : 1000);
    }
  }

  spinFreeSpins() {
    if (this.freeSpinsRemaining <= 0) {
      this.exitFreeSpins();
      return;
    }
    this.freeSpinsRemaining--;
    this.spin();
  }

  enterFreeSpinsIntro() {
    this.freeSpinsIntroPending = true;
    this.pendingSpinRequest = false;
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    this._setState('free_spins_intro');
  }

  enterFreeSpins(spinsCount, expandingSymbol = null) {
    this.freeSpinsIntroPending = false;
    this.pendingSpinRequest = false;
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    this.inFreeSpins = true;
    this.freeSpinsRemaining = spinsCount;
    this.freeSpinsTotal = spinsCount;
    this.freeSpinsAccumulatedWin = 0;
    this.config.expandingSymbol = expandingSymbol;
    if (this.freeSpinsMode) {
      this.freeSpinsModeState = this.freeSpinsMode.createState(this);
    }
    if (this.musicConfig) audio.setMusicState('freespins');
    this._setState('idle');
    this.spinFreeSpins();
  }

  retriggerFreeSpins(spinsCount) {
    this.freeSpinsRemaining += spinsCount;
    this.freeSpinsTotal += spinsCount;
  }

  // Deliberately does NOT reset freeSpinsRemaining/freeSpinsTotal/freeSpinsAccumulatedWin -
  // matches SlotEngine.js's own exitFreeSpins() exactly. A game's game_over handler (fired by
  // the _setState below) reads freeSpinsAccumulatedWin to show the round's total win in a
  // summary modal; resetting it here would zero it out before that handler ever runs.
  // enterFreeSpins() is what resets these fields, at the start of the *next* round.
  exitFreeSpins() {
    this.freeSpinsIntroPending = false;
    this.inFreeSpins = false;
    this.config.expandingSymbol = null;
    if (this.freeSpinsMode) {
      this.freeSpinsModeState = this.freeSpinsMode.createState(this);
    }
    if (this.musicConfig) audio.setMusicState('main');
    this._setState('game_over');
  }

  returnToIdle() {
    this._setState('idle');
  }

  // Thin wrapper around simulateSpins using this engine's own live config, so a simulation
  // always measures exactly what the running game would actually pay - matches
  // SlotEngine.js's/CascadeEngine.js's own runSimulation(). `this.config` already carries
  // `mechanic`/`freeSpinsMode` (passed straight through from the constructor's config, same
  // object `this.mechanic`/`this.freeSpinsMode` were pulled from), so simulateSpins dispatches
  // to the right mechanic without CoreSlotEngine needing to pass it separately.
  runSimulation(numBaseSpins = 100000, betPerLine = this.betPerLine, linesCount = this.linesCount, options = {}) {
    const { seed = null, logSpins = false } = options;
    const rng = seed != null ? createSeededRng(seed) : Math.random;
    return simulateSpins({ ...this.config, logSpins }, numBaseSpins, betPerLine, linesCount, rng);
  }
}
