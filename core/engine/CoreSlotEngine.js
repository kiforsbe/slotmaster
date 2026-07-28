// A skeleton, not a monolith: owns the state machine and animation loop only. Every other
// concern - grid resolution, animation style, drawing, particles, audio, free-spins payout
// rules, spin logging - is a component plugged in through config, each its own file. See
// docs/superpowers/specs/2026-07-28-core-modularization-design.md.
import { computeGridLayout } from '../rendering/GridLayout.js';
import { audio } from '../audio/SlotAudio.js';
import { createSeededRng } from '../math/SlotMath.js';
import { simulateSpins } from '../SpinSimulator.js';

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

    this.spritesheetUrl = config.spritesheetUrl || '';
    this.symbolsConfig = config.symbolsConfig || {};

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

    this.spinSequence = null;
    this.stepIndex = 0;
    this.grid = null;
    this.lastSpinSeed = null;

    this.turboMode = false;
    this.autoPlay = false;
    this.pendingSpinRequest = false;

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
    this.spritesheet = typeof Image !== 'undefined' ? new Image() : null;
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
    this.loadAssets();
    this.animate();
  }

  loadAssets(spritesheetUrl = this.spritesheetUrl, symbolsConfig = this.symbolsConfig) {
    this.assetsLoaded = false;
    this.spritesheetUrl = spritesheetUrl;
    this.symbolsConfig = symbolsConfig;

    this.spritesheet.src = spritesheetUrl;
    this.spritesheet.onload = () => {
      this.assetsLoaded = true;
      this.resize();
    };
    this.spritesheet.onerror = () => {
      console.error('CoreSlotEngine: failed to load spritesheet from: ' + spritesheetUrl);
    };
  }

  setupResize() {
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.resize(), 100);
    });
    this.resize();
  }

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
    if (this.state !== 'idle' && this.state !== 'showing_wins' && this.state !== 'game_over') {
      this.pendingSpinRequest = true;
      return;
    }
    this.spin();
  }

  async spin(seed = Math.floor(Math.random() * 0xFFFFFFFF)) {
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
    });

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
      if (expandingResult.totalPayoutMultiplier > 0) {
        // betPerLine, not totalBet - matches SlotEngine.js's own expanding-win math.
        this.lastWin += expandingResult.totalPayoutMultiplier * this.betPerLine;
        this.audioController?.onExpand();
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

  async _playStep(index) {
    const step = this.spinSequence[index];
    this.grid = step.grid;
    await new Promise((resolve) => this.animator.playEntrance(this, step, resolve));
    if (index + 1 < this.spinSequence.length) {
      this.stepIndex = index + 1;
      const nextStep = this.spinSequence[this.stepIndex];
      await new Promise((resolve) => this.animator.playTransition(this, step, nextStep, resolve));
      await this._playStep(this.stepIndex);
    }
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

    if (this.spinLogRecorder) {
      this.spinLogRecorder.record({
        sequence: this.spinSequence,
        scatterWin: this._lastScatterWin,
        seed: this.lastSpinSeed,
        timestamp: Date.now(),
        phase: this.inFreeSpins ? 'free' : 'base',
        chargedBet: this.inFreeSpins ? 0 : this.totalBet,
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
  }

  stopSpin() {
    // Turbo/skip hook - a real animator's playEntrance/playTransition should resolve immediately
    // when this is set; the skeleton just exposes the flag components read.
    this._skipAnimation = true;
  }

  enterFreeSpinsIntro() {
    this._setState('free_spins_intro');
  }

  enterFreeSpins(spinsCount, expandingSymbol = null) {
    this.inFreeSpins = true;
    this.freeSpinsRemaining = spinsCount;
    this.freeSpinsTotal = spinsCount;
    this.freeSpinsAccumulatedWin = 0;
    this.config.expandingSymbol = expandingSymbol;
    if (this.freeSpinsMode) {
      this.freeSpinsModeState = this.freeSpinsMode.createState(this);
    }
    this._setState('spinning');
  }

  retriggerFreeSpins(spinsCount) {
    this.freeSpinsRemaining += spinsCount;
    this.freeSpinsTotal += spinsCount;
  }

  exitFreeSpins() {
    this.inFreeSpins = false;
    this.freeSpinsRemaining = 0;
    this.freeSpinsTotal = 0;
    this.freeSpinsAccumulatedWin = 0;
    this.config.expandingSymbol = null;
    if (this.freeSpinsMode) {
      this.freeSpinsModeState = this.freeSpinsMode.createState(this);
    }
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
