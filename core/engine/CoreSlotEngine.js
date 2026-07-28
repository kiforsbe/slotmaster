// A skeleton, not a monolith: owns the state machine and animation loop only. Every other
// concern - grid resolution, animation style, drawing, particles, audio, free-spins payout
// rules, spin logging - is a component plugged in through config, each its own file. See
// docs/superpowers/specs/2026-07-28-core-modularization-design.md.
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

    this.state = 'idle';
    this.balance = 1000;
    this.betPerLine = this.config.betPerLine;
    this.linesCount = this.config.linesCount;
    this.betAmount = this.config.betAmount;
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
  }

  _setState(next) {
    this.state = next;
    this.config.onStateChange(next);
  }

  requestSpin() {
    if (this.state !== 'idle' && this.state !== 'showing_wins' && this.state !== 'game_over') {
      this.pendingSpinRequest = true;
      return;
    }
    this.spin();
  }

  async spin(seed = Math.floor(Math.random() * 0xFFFFFFFF)) {
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

    await this._playStep(this.stepIndex);

    if (result.scatterWin && result.scatterWin.triggerFreeSpins) {
      this.config.onScatterTrigger(result.scatterWin.count, this.inFreeSpins);
      this.audioController?.onScatterTrigger();
    }

    if (this.inFreeSpins && this.config.expandingSymbol && this.mechanic.evaluateExpandingWin) {
      const expandingResult = this.mechanic.evaluateExpandingWin(
        this.grid, this.config.expandingSymbol, this.config, this.linesCount,
      );
      if (expandingResult.totalPayoutMultiplier > 0) {
        const betAmount = this.betAmount ?? (this.betPerLine * this.linesCount);
        this.lastWin += expandingResult.totalPayoutMultiplier * betAmount;
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
    await new Promise((resolve) => this.animator.playEntrance(step, this.ctx, resolve));
    if (index + 1 < this.spinSequence.length) {
      this.stepIndex = index + 1;
      const nextStep = this.spinSequence[this.stepIndex];
      await new Promise((resolve) => this.animator.playTransition(step, nextStep, this.ctx, resolve));
      await this._playStep(this.stepIndex);
    }
  }

  _finishSpin() {
    this._setState('evaluating');
    const totalPayout = this.spinSequence.reduce((sum, step) => sum + (step.payout || 0), 0);
    const betAmount = this.betAmount ?? (this.betPerLine * this.linesCount);
    this.lastWin += totalPayout * betAmount;
    this.balance += this.lastWin;

    if (this.spinLogRecorder) {
      this.spinLogRecorder.record({
        sequence: this.spinSequence,
        scatterWin: this._lastScatterWin,
        seed: this.lastSpinSeed,
        timestamp: Date.now(),
        phase: this.inFreeSpins ? 'free' : 'base',
        chargedBet: this.inFreeSpins ? 0 : betAmount,
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
}
