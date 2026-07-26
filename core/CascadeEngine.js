// Stateful cascade engine: canvas rendering + a state machine that animates playback of an
// already fully-resolved spin (see core/CascadeMath.js's resolveCascadeSequence) - mirroring
// how SlotEngine precomputes targetGrid and then animates reels catching up to it. Knows
// nothing about clusters or paylines: config.winEvaluator is a single-argument closure the
// game supplies (e.g. games/candyfrenzy/game.js wraps checkClusterWins), so this file is
// reusable by any future cascading-grid game, not just cluster-pays ones.
import { computeGridLayout } from './GridLayout.js';
import { drawSpriteSymbol } from './SpriteDrawer.js';
import { ParticleSystem } from './ParticleSystem.js';
import { resolveCascadeSequence, applyCascade } from './CascadeMath.js';
import { createCascadeSpinLogEntry } from './SpinLog.js';
import { audio } from './SlotAudio.js';

const SPIN_LOG_MAX_ENTRIES = 20000;

// A cleared symbol randomly picks one of these vanish styles (see _applyClearTransform) so a
// whole cluster popping doesn't look like one uniform stamp repeated across every cell.
const CLEAR_VARIANTS = ['scaleFade', 'stretch', 'jump', 'spin'];

// How long the "clearing" state (a winning cluster's vanish animation + glow) lingers before
// the next cascade step's grid appears.
const CLEAR_DURATION_MS = { normal: 760, turbo: 300 };

export class CascadeEngine {
  constructor(canvas, config = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.config = {
      reelsCount: 7,
      rowsCount: 7,
      paytable: {},
      reelStrips: [],
      winEvaluator: () => ({ clusterWins: [], totalPayoutMultiplier: 0, scatterWin: null }),
      scatterSymbol: null,
      // Free-spins payout mode: false (default) keeps the flat 2x-every-win rule (see
      // _freeSpinsFlatMultiplier). true switches to persistent per-tile multipliers instead -
      // a tile a winning cluster touches starts/doubles a multiplier that a later cluster
      // overlapping that same position then benefits from (see multiplierGrid below).
      useMultiplierTiles: false,
      onStateChange: () => {},
      onScatterTrigger: (scatterCount, isInFreeSpins) => {},
      onWin: () => {},
      ...config,
    };

    this.spritesheetUrl = config.spritesheetUrl || '';
    this.symbolsConfig = config.symbolsConfig || {};

    // idle -> dropping_in -> (clearing -> falling)* -> showing_wins -> idle, plus
    // free_spins_intro/game_over - same naming convention as SlotEngine.state.
    this.state = 'idle';
    this.balance = 1000;
    this.betAmount = config.betAmount ?? 1;
    this.lastWin = 0;

    this.inFreeSpins = false;
    this.freeSpinsRemaining = 0;
    this.freeSpinsTotal = 0;
    this.freeSpinsAccumulatedWin = 0;

    this.spritesheet = new Image();
    this.assetsLoaded = false;

    this.symbolWidth = 0;
    this.symbolHeight = 0;
    this.reelsX = 0;
    this.reelsY = 0;
    this.reelsWidth = 0;
    this.reelsHeight = 0;

    this.turboMode = false;
    this.autoPlay = false;
    this.pendingSpinRequest = false;
    this.autoPlayTimer = null;

    // This spin's fully precomputed outcome (set once per spin() call) and where playback
    // currently is within it.
    this.cascadeSequence = null;
    this.stepIndex = 0;
    this.grid = Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(null));
    this.cellOffsets = Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(0));
    this.clearStartTime = 0;
    this.stepStartTime = 0;
    this.currentClearPositions = [];
    this.currentClearVariants = new Map();
    // The current cascade step's cluster wins, animated one at a time (see _beginClusterClear/
    // update()'s 'clearing' branch) rather than all bursting simultaneously.
    this.currentClusterWins = [];
    this.currentClusterIndex = 0;
    this._forceScatterNextSpin = false;

    // Previous spin's leftover grid: falls out the bottom, one reel at a time. The moment a
    // given reel finishes exiting, that same reel's new symbols start dropping in immediately
    // (columnOutgoingDone/columnEnterStartTime below track this per column, independently -
    // there's no global "wait for every reel" barrier). outgoingGrid is null whenever nothing
    // is currently exiting.
    this.outgoingGrid = null;
    this.outgoingOffsets = null;
    this.columnOutgoingDone = new Array(this.config.reelsCount).fill(true);
    this.columnEnterStartTime = new Array(this.config.reelsCount).fill(null);

    // Per-cell timestamp of when it last landed (offset hit 0), purely for the brief visual
    // "impact" squash-bounce in _applyLandingBounce - not used for any gameplay timing.
    this.cellBounceStartTime = Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(-Infinity));

    // Floating per-cluster win-amount popups. Kept on their own timeline (not tied to
    // clearDuration/the state machine) so they can outlive a fast "clearing" phase and
    // still be readable, even overlapping across rapid-fire cascade steps.
    this.activePopups = [];

    // Per-cell persistent win multiplier (config.useMultiplierTiles mode only) - 1 everywhere
    // means "no tile", never rendered. Only ever holds anything other than 1 during free spins;
    // reset on enterFreeSpins, cleared again on exitFreeSpins (see those methods).
    this.multiplierGrid = this._createMultiplierGrid();

    this.particleSystem = new ParticleSystem();
    this.audio = audio;

    this.spinLog = [];

    this.init();
  }

  init() {
    this._fillInitialGrid();
    this.setupResize();
    this.loadAssets();
    this.animate();
  }

  _createMultiplierGrid() {
    return Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(1));
  }

  // The flat "every win pays double" free-spins rule - only active when useMultiplierTiles is
  // off. In tile mode, each cluster's bonus is already baked into its own payout individually
  // (see _buildWinEvaluatorForSpin), so applying this on top too would double-dip.
  _freeSpinsFlatMultiplier() {
    return this.inFreeSpins && !this.config.useMultiplierTiles ? 2 : 1;
  }

  // Populates the grid with a decorative, non-winning-evaluated fill before any real spin has
  // happened, so the game never shows a blank reel on load. Uses the same reel-strip/cursor
  // mechanics as a real spin (applyCascade), just without running the win evaluator or costing
  // a bet - the very first real spin() still treats this as an "existing grid" and animates it
  // falling out first, same as any other spin's leftover grid.
  _fillInitialGrid() {
    if (!this.config.reelStrips.length) return;
    const cursorStateByColumn = this.config.reelStrips.map(strip => ({ index: Math.floor(Math.random() * strip.length) }));
    const emptyGrid = Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(null));
    const allCleared = [];
    for (let col = 0; col < this.config.reelsCount; col++) {
      for (let row = 0; row < this.config.rowsCount; row++) allCleared.push([col, row]);
    }
    const { grid } = applyCascade(emptyGrid, cursorStateByColumn, this.config.reelStrips, allCleared);
    this.grid = grid;
    this.cellOffsets = Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(0));
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
      console.error('CascadeEngine: failed to load spritesheet from ' + spritesheetUrl);
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

  // --- Game loop ---
  animate() {
    this.update();
    this.render();
    requestAnimationFrame(() => this.animate());
  }

  update() {
    const now = Date.now();
    this.particleSystem.update();
    this.activePopups = this.activePopups.filter(p => now - p.startTime < p.duration);

    if (this.state === 'dropping_in' || this.state === 'falling') {
      const speed = this.turboMode ? 0.19 : 0.095; // rows per frame
      const rampDuration = this.turboMode ? 120 : 240; // ms to ease from a standstill up to full speed
      let allDone = true;

      for (let col = 0; col < this.config.reelsCount; col++) {
        if (!this.columnOutgoingDone[col]) {
          // This reel's leftover symbols are still exiting - advance that first. The moment
          // it finishes, its own entry starts immediately (no added gap) via
          // columnEnterStartTime below; reels further right, which started exiting later,
          // naturally follow a little after, preserving the left-to-right wave without ever
          // waiting on a "have all reels finished exiting" global barrier.
          allDone = false;
          const exitStartAt = this.stepStartTime + this._columnStartDelay(col);
          const effectiveSpeed = this._rampSpeed(speed, now - exitStartAt, rampDuration);
          let colFinishedExiting = true;
          for (let row = 0; row < this.config.rowsCount; row++) {
            if (this.outgoingOffsets[col][row] < this.config.rowsCount) {
              colFinishedExiting = false;
              if (effectiveSpeed > 0) {
                this.outgoingOffsets[col][row] = Math.min(this.config.rowsCount, this.outgoingOffsets[col][row] + effectiveSpeed);
              }
            }
          }
          if (colFinishedExiting) {
            this.columnOutgoingDone[col] = true;
            this.columnEnterStartTime[col] = now;
          }
          continue;
        }

        const enterStartAt = this.columnEnterStartTime[col];
        const effectiveSpeed = enterStartAt == null ? 0 : this._rampSpeed(speed, now - enterStartAt, rampDuration);
        let columnJustLanded = false;
        for (let row = 0; row < this.config.rowsCount; row++) {
          if (this.cellOffsets[col][row] > 0) {
            allDone = false;
            if (effectiveSpeed > 0) {
              const after = Math.max(0, this.cellOffsets[col][row] - effectiveSpeed);
              this.cellOffsets[col][row] = after;
              if (after === 0) {
                this.cellBounceStartTime[col][row] = now;
                columnJustLanded = true;
              }
            }
          }
        }
        // One thud per reel per landing moment, not per cell - a whole spawned/surviving
        // group in a column typically lands in the same frame, so this fires once for that
        // group rather than stuttering out several near-simultaneous copies of the same sound.
        if (columnJustLanded) audio.playReelStop(col);
      }

      if (this.outgoingGrid && this.columnOutgoingDone.every(Boolean)) {
        this.outgoingGrid = null;
        this.outgoingOffsets = null;
      }

      if (allDone) this._onStepLanded();
    } else if (this.state === 'clearing') {
      const clearDuration = this.turboMode ? CLEAR_DURATION_MS.turbo : CLEAR_DURATION_MS.normal;
      if (now - this.clearStartTime >= clearDuration) {
        this.currentClusterIndex++;
        if (this.currentClusterIndex < this.currentClusterWins.length) {
          this._beginClusterClear();
        } else {
          this._advanceToNextStep();
        }
      }
    }

    if (this.pendingSpinRequest && (this.state === 'idle' || this.state === 'showing_wins')) {
      this.pendingSpinRequest = false;
      this.startNextSpin();
    }
  }

  // A column's effective fall speed at this instant: 0 before its own local start time, then
  // easing up to `baseSpeed` via a sine ramp instead of snapping straight to full speed - this
  // (plus each column's staggered/chained start time) is what makes the motion read as a wave
  // rippling across the grid rather than a mechanical, uniform drop.
  _rampSpeed(baseSpeed, localElapsedMs, rampDurationMs) {
    if (localElapsedMs <= 0) return 0;
    const t = Math.min(localElapsedMs / rampDurationMs, 1);
    return baseSpeed * Math.sin(t * (Math.PI / 2));
  }

  // How long after a step begins the col-th reel starts (exiting or entering). Ease-out
  // rather than a flat per-reel delay: the gap between the first couple of reels starting is
  // biggest, then shrinks reel by reel - the wave starts slow and gathers momentum, instead of
  // ticking across the grid at one constant, metronome-even interval.
  _columnStartDelay(col) {
    const reelsCount = this.config.reelsCount;
    if (reelsCount <= 1) return 0;
    const totalSpan = (reelsCount - 1) * (this.turboMode ? 20 : 70);
    const t = col / (reelsCount - 1);
    const eased = 1 - Math.pow(1 - t, 2);
    return eased * totalSpan;
  }

  _onStepLanded() {
    const step = this.cascadeSequence.cascadeSteps[this.stepIndex];
    if (step.clusterWins.length > 0) {
      // Clusters animate one at a time, not all at once - _beginClusterClear plays the first;
      // update()'s 'clearing' branch advances currentClusterIndex through the rest before
      // finally moving on to the next cascade step (_advanceToNextStep).
      this.currentClusterWins = step.clusterWins;
      this.currentClusterIndex = 0;
      this._beginClusterClear();
    } else {
      this._finishSpin();
    }
  }

  // Plays the vanish animation for exactly one cluster (this.currentClusterWins at
  // currentClusterIndex) - glow, per-symbol vanish variants, particles, its own floating win
  // popup, and its own ding. Called once per cluster in a step, in sequence.
  _beginClusterClear() {
    const cluster = this.currentClusterWins[this.currentClusterIndex];
    this.state = 'clearing';
    this.clearStartTime = Date.now();
    this.currentClearPositions = cluster.winningPositions;
    // Each cleared symbol gets its own random vanish style, so a whole cluster popping
    // doesn't look like one uniform stamp - variety over identical repetition.
    this.currentClearVariants = new Map();
    this.currentClearPositions.forEach(([col, row]) => {
      this.currentClearVariants.set(`${col},${row}`, {
        variant: CLEAR_VARIANTS[Math.floor(Math.random() * CLEAR_VARIANTS.length)],
        spinDirection: Math.random() < 0.5 ? -1 : 1,
      });
    });
    this._spawnClearParticles(this.currentClearPositions);
    this._spawnClusterWinPopups([cluster]);
    audio.playClusterWin(cluster.payout);

    // The tiles this cluster just won on start (1x -> 2x) or double (2x -> 4x -> ...) their
    // persistent multiplier now, in step with THIS cluster's own clear animation - not all at
    // once back when the whole spin was precomputed. _buildWinEvaluatorForSpin already used a
    // scratch copy of this same progression to get this cluster's payout right; this replays
    // the identical update rule against the real, rendered grid.
    if (this.config.useMultiplierTiles && this.inFreeSpins) {
      this.currentClearPositions.forEach(([col, row]) => {
        this.multiplierGrid[col][row] = this.multiplierGrid[col][row] <= 1 ? 2 : this.multiplierGrid[col][row] * 2;
      });
    }

    this.config.onStateChange(this.state);
  }

  _spawnClusterWinPopups(clusterWins) {
    const freeSpinsMultiplier = this._freeSpinsFlatMultiplier();
    const now = Date.now();
    const duration = this.turboMode ? 500 : 1100;
    clusterWins.forEach(w => {
      const centroidCol = w.winningPositions.reduce((sum, [c]) => sum + c, 0) / w.winningPositions.length;
      const centroidRow = w.winningPositions.reduce((sum, [, r]) => sum + r, 0) / w.winningPositions.length;
      this.activePopups.push({
        symbol: w.symbol,
        count: w.count,
        amount: w.payout * this.betAmount * freeSpinsMultiplier,
        x: this.reelsX + (centroidCol + 0.5) * this.symbolWidth,
        y: this.reelsY + (centroidRow + 0.5) * this.symbolHeight,
        startTime: now,
        duration,
      });
    });
  }

  _advanceToNextStep() {
    this.stepIndex++;
    const step = this.cascadeSequence.cascadeSteps[this.stepIndex];
    this.grid = step.grid;
    this.cellOffsets = step.fallOffsets.map(col => col.slice());
    this.currentClearPositions = [];

    // A mid-spin cascade refill has no "leftover grid to exit" concept - every column is
    // immediately free to enter, staggered left-to-right same as always.
    this.stepStartTime = Date.now();
    this.columnOutgoingDone = new Array(this.config.reelsCount).fill(true);
    this.columnEnterStartTime = this.columnEnterStartTime.map((_, col) => this.stepStartTime + this._columnStartDelay(col));

    this.state = 'falling';
    this.config.onStateChange(this.state);
  }

  _spawnClearParticles(positions) {
    const points = positions.map(([col, row]) => ({
      x: this.reelsX + (col * this.symbolWidth) + (this.symbolWidth / 2),
      y: this.reelsY + (row * this.symbolHeight) + (this.symbolHeight / 2),
    }));
    this.particleSystem.spawn(points);
  }

  _finishSpin() {
    const freeSpinsMultiplier = this._freeSpinsFlatMultiplier();
    const payoutAmount = this.cascadeSequence.totalPayoutMultiplier * this.betAmount * freeSpinsMultiplier;
    this.lastWin = payoutAmount;
    this.balance += payoutAmount;
    if (this.inFreeSpins) this.freeSpinsAccumulatedWin += payoutAmount;

    this._pushSpinLogEntry(freeSpinsMultiplier);

    if (payoutAmount > 0) {
      this.config.onWin({ amount: payoutAmount });
    }

    const scatterWin = this.cascadeSequence.scatterWin;
    if (scatterWin && scatterWin.triggerFreeSpins) {
      audio.playScatterTrigger();

      if (this.inFreeSpins) {
        // Retrigger: don't pause the free-spins loop, just add spins and let it keep going -
        // same state/autoplay handling as any other spin finishing. Critically, this.state
        // MUST move off 'falling'/'dropping_in' here (as below) - leaving it unchanged made
        // update()'s "allDone" check re-fire _onStepLanded -> _finishSpin every single frame,
        // which re-triggered the scatter callback (and so retriggerFreeSpins) every frame too.
        this.state = payoutAmount > 0 ? 'showing_wins' : 'idle';
        this.config.onScatterTrigger(scatterWin.count, this.inFreeSpins);
        this.handleAutoPlay();
        this.config.onStateChange(this.state);
      } else {
        // First-time trigger (base game -> free spins): pause on a stable state - game.js
        // shows the trigger modal and only resumes once the player confirms (enterFreeSpins()).
        this.state = 'idle';
        this.config.onScatterTrigger(scatterWin.count, this.inFreeSpins);
        this.config.onStateChange(this.state);
      }
      return;
    }

    this.state = payoutAmount > 0 ? 'showing_wins' : 'idle';
    this.handleAutoPlay();
    this.config.onStateChange(this.state);
  }

  _pushSpinLogEntry(freeSpinsMultiplier) {
    const entry = createCascadeSpinLogEntry({
      spinIndex: this.spinLog.length + 1,
      phase: this.inFreeSpins ? 'free' : 'base',
      betAmount: this.betAmount,
      chargedBet: this.inFreeSpins ? 0 : this.betAmount,
      freeSpinsMultiplier,
      cascadeSteps: this.cascadeSequence.cascadeSteps,
      scatterSymbol: this.config.scatterSymbol,
      scatterWin: this.cascadeSequence.scatterWin,
      seed: this.lastSpinSeed,
      timestamp: Date.now(),
    });
    this.spinLog.push(entry);
    if (this.spinLog.length > SPIN_LOG_MAX_ENTRIES) this.spinLog.shift();
    return entry;
  }

  // --- Spin controllers ---

  requestSpin() {
    if (this.state === 'idle' || this.state === 'showing_wins') {
      this.startNextSpin();
      return;
    }
    this.pendingSpinRequest = true;
  }

  startNextSpin() {
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    if (this.inFreeSpins) {
      this.spinFreeSpins();
    } else {
      this.spin();
    }
  }

  // In useMultiplierTiles mode, wraps config.winEvaluator so each cascade step's cluster
  // payouts already include this spin's tile-multiplier bonuses - resolveCascadeSequence calls
  // the returned closure once per cascade step, synchronously, in chronological order, so a
  // scratch copy of multiplierGrid mutated step-by-step here sees exactly the same progression
  // _beginClusterClear will later replay against the real grid, just all at once instead of
  // animated. Kept as its own scratch copy (not multiplierGrid itself) so the tile numbers
  // rendered on screen only advance in step with each cluster's own clear animation, not the
  // instant the whole spin gets resolved.
  _buildWinEvaluatorForSpin() {
    const baseEvaluator = this.config.winEvaluator;
    if (!this.config.useMultiplierTiles || !this.inFreeSpins) return baseEvaluator;

    const scratch = this.multiplierGrid.map(col => col.slice());

    return (grid) => {
      const results = baseEvaluator(grid);
      if (results.totalPayoutMultiplier <= 0) return results;

      let totalPayoutMultiplier = 0;
      const clusterWins = results.clusterWins.map(w => {
        // Sum only the tiles this cluster actually overlaps that already carry a multiplier
        // (>1x) - an untouched tile (1x, the "no marker" baseline) contributes nothing, so a
        // cluster over entirely plain tiles pays its normal amount, not an inflated one.
        let tileMultiplier = 0;
        w.winningPositions.forEach(([c, r]) => {
          if (scratch[c][r] > 1) tileMultiplier += scratch[c][r];
        });
        if (tileMultiplier === 0) tileMultiplier = 1;

        const payout = w.payout * tileMultiplier;
        totalPayoutMultiplier += payout;

        w.winningPositions.forEach(([c, r]) => {
          scratch[c][r] = scratch[c][r] <= 1 ? 2 : scratch[c][r] * 2;
        });

        return { ...w, payout };
      });

      return { ...results, clusterWins, totalPayoutMultiplier };
    };
  }

  spin(seed) {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;
    audio.stopBGM();

    if (!this.inFreeSpins) {
      if (this.balance < this.betAmount) {
        alert('Insufficient Balance!');
        this.autoPlay = false;
        return;
      }
      this.balance -= this.betAmount;
      this.lastWin = 0;
    }

    const spinSeed = seed !== undefined ? seed : ((Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0);
    this.lastSpinSeed = spinSeed;
    this.cascadeSequence = resolveCascadeSequence(
      this.config.reelStrips, this.config.rowsCount, spinSeed, this._buildWinEvaluatorForSpin()
    );

    if (this._forceScatterNextSpin) {
      this._forceScatterNextSpin = false;
      const scatterSym = this.config.scatterSymbol;
      const lastStep = this.cascadeSequence.cascadeSteps[this.cascadeSequence.cascadeSteps.length - 1];
      const positions = [[0, 0], [Math.floor(this.config.reelsCount / 2), Math.floor(this.config.rowsCount / 2)], [this.config.reelsCount - 1, this.config.rowsCount - 1]];
      positions.forEach(([c, r]) => { lastStep.grid[c][r] = scatterSym; });
      this.cascadeSequence.finalGrid = lastStep.grid;
      this.cascadeSequence.scatterWin = { symbol: scatterSym, count: 3, positions, triggerFreeSpins: true, payout: 0 };
    }

    audio.playSpin();

    // If a previous spin (or the decorative initial fill) left symbols on the grid, each reel's
    // leftover symbols fall out the bottom before that SAME reel's new symbols drop in (see
    // update()'s columnOutgoingDone/columnEnterStartTime handling) - no reel waits on its
    // neighbors to finish exiting first.
    const hasExistingGrid = this.grid.some(col => col.some(cell => cell !== null));
    this.stepStartTime = Date.now();
    if (hasExistingGrid) {
      this.outgoingGrid = this.grid;
      this.outgoingOffsets = Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(0));
      this.columnOutgoingDone = new Array(this.config.reelsCount).fill(false);
      this.columnEnterStartTime = new Array(this.config.reelsCount).fill(null);
    } else {
      this.outgoingGrid = null;
      this.outgoingOffsets = null;
      this.columnOutgoingDone = new Array(this.config.reelsCount).fill(true);
      this.columnEnterStartTime = Array.from({ length: this.config.reelsCount }, (_, col) => this.stepStartTime + this._columnStartDelay(col));
    }

    this.stepIndex = 0;
    const firstStep = this.cascadeSequence.cascadeSteps[0];
    this.grid = firstStep.grid;
    this.cellOffsets = firstStep.fallOffsets.map(col => col.slice());
    this.currentClearPositions = [];

    this.state = 'dropping_in';
    this.config.onStateChange(this.state);
  }

  // Debug/cheat helper (mirrors SlotEngine.forceWinResult('scatter')): forces this game's
  // next spin to land 3 bonus symbols on the final grid, for testing the free-spins trigger.
  forceScatterResult() {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;
    this._forceScatterNextSpin = true;
    this.spin();
  }

  handleAutoPlay() {
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }

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

  enterFreeSpins(spinsCount) {
    this.inFreeSpins = true;
    this.freeSpinsTotal = spinsCount;
    this.freeSpinsRemaining = spinsCount;
    this.freeSpinsAccumulatedWin = 0;
    // Multiplier tiles (if this game uses that mode) always start fresh at the top of a
    // free-spins bonus, never carried over from a previous one.
    this.multiplierGrid = this._createMultiplierGrid();

    audio.startBGM();

    this.state = 'idle';
    this.config.onStateChange(this.state);

    this.spinFreeSpins();
  }

  retriggerFreeSpins(spinsCount) {
    this.freeSpinsRemaining += spinsCount;
    this.freeSpinsTotal += spinsCount;
  }

  enterFreeSpinsIntro() {
    this.state = 'free_spins_intro';
    this.config.onStateChange(this.state);
  }

  returnToIdle() {
    this.state = 'idle';
    this.config.onStateChange(this.state);
  }

  exitFreeSpins() {
    this.inFreeSpins = false;
    // Multiplier tiles (if used) are a free-spins-only bonus - removed the moment the bonus
    // round ends, not carried into the base game.
    this.multiplierGrid = this._createMultiplierGrid();
    audio.stopBGM();

    this.state = 'game_over';
    this.config.onStateChange(this.state);
  }

  // --- Rendering ---
  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.assetsLoaded) {
      this._renderLoading();
      return;
    }

    this._renderCabinet();

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(this.reelsX, this.reelsY, this.reelsWidth, this.reelsHeight);
    this.ctx.clip();

    // Drawn as its own full-board pass, before anything else in the clip - a tile's
    // multiplier belongs to the fixed board position, not to whatever symbol currently
    // occupies it, so it must stay visible underneath every phase of the animation
    // (leftover grid still exiting, new grid still entering, mid-cascade, all of it), never
    // just while that one column happens to be showing its settled live grid.
    this._renderTileMultiplierGrid();
    this._renderOutgoingGridSymbols();
    this._renderGridSymbols();

    this.ctx.restore();

    this._renderGridBorders();
    this.renderParticles();
    this._renderClusterWinPopups();
  }

  _renderLoading() {
    this.ctx.fillStyle = '#2a0e2e';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = '#ff6ec7';
    this.ctx.font = 'bold 24px Outfit, Inter, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText('LOADING CANDY...', this.canvas.width / (2 * (window.devicePixelRatio || 1)), this.canvas.height / (2 * (window.devicePixelRatio || 1)));
  }

  _renderCabinet() {
    const rx = this.reelsX, ry = this.reelsY, rw = this.reelsWidth, rh = this.reelsHeight;
    const gradient = this.ctx.createRadialGradient(rx + rw / 2, ry + rh / 2, rh * 0.2, rx + rw / 2, ry + rh / 2, rw * 0.7);
    gradient.addColorStop(0, '#3a1440');
    gradient.addColorStop(1, '#140518');
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, rx * 2 + rw, ry * 2 + rh);

    this.ctx.strokeStyle = '#ff6ec7';
    this.ctx.lineWidth = 4;
    this.ctx.shadowColor = '#ff6ec7';
    this.ctx.shadowBlur = 10;
    this.ctx.strokeRect(rx - 2, ry - 2, rw + 4, rh + 4);
    this.ctx.shadowBlur = 0;
  }

  _renderGridSymbols() {
    const now = Date.now();
    const isClearing = this.state === 'clearing';
    const clearDuration = this.turboMode ? CLEAR_DURATION_MS.turbo : CLEAR_DURATION_MS.normal;
    const clearProgress = isClearing ? Math.min((now - this.clearStartTime) / clearDuration, 1) : null;
    const bounceDuration = this.turboMode ? 140 : 260;

    for (let col = 0; col < this.config.reelsCount; col++) {
      // While this reel's leftover symbols are still exiting, _renderOutgoingGridSymbols draws
      // them - skip the new grid's content here to avoid showing both at once.
      if (!this.columnOutgoingDone[col]) continue;

      for (let row = 0; row < this.config.rowsCount; row++) {
        const symbol = this.grid[col][row];
        if (!symbol) continue;

        const offsetRows = this.cellOffsets[col][row] || 0;
        const cx = this.reelsX + col * this.symbolWidth;
        const cy = this.reelsY + (row - offsetRows) * this.symbolHeight;
        const tile = this.symbolsConfig[symbol];

        const clearInfo = isClearing ? this.currentClearVariants.get(`${col},${row}`) : null;
        const bounceElapsed = now - this.cellBounceStartTime[col][row];
        const isBouncing = !clearInfo && offsetRows === 0 && bounceElapsed >= 0 && bounceElapsed < bounceDuration;

        // Drawn underneath, fixed to the cell's actual grid position (not the vanish
        // animation's moving/scaling one) - a stable "this tile is part of the winning
        // cluster" marker regardless of what its symbol is doing on top of it.
        if (clearInfo) this._renderClearGlow(cx, cy, clearProgress);

        this.ctx.save();
        if (clearInfo) {
          this._applyClearTransform(clearInfo, clearProgress, cx, cy);
        } else if (isBouncing) {
          this._applyLandingBounce(bounceElapsed / bounceDuration, cx, cy);
        }
        drawSpriteSymbol(this.ctx, this.spritesheet, tile, cx, cy, this.symbolWidth, this.symbolHeight, 0);
        this.ctx.restore();
      }
    }
  }

  // A brief, decaying squash-and-stretch when a symbol lands (offset hits 0) - it reads as
  // compressing on impact against the grid's bottom (or the stack of symbols already resting
  // below it) and springing back, rather than abruptly stopping. Pivots on the cell's bottom
  // edge, not its center, so the squash reads as pressing down rather than floating in place.
  _applyLandingBounce(progress, cx, cy) {
    const decay = Math.exp(-progress * 6);
    const wobble = Math.sin(progress * Math.PI * 3) * decay;
    const squashX = 1 + wobble * 0.15;
    const squashY = 1 - wobble * 0.25;
    const centerX = cx + this.symbolWidth / 2;
    const bottomY = cy + this.symbolHeight;
    this.ctx.translate(centerX, bottomY);
    this.ctx.scale(squashX, squashY);
    this.ctx.translate(-centerX, -bottomY);
  }

  // Every board position's multiplier badge, at its fixed on-screen cell - independent of
  // cellOffsets/columnOutgoingDone/clearing entirely, so it reads as a permanent overlay on
  // the board itself rather than something attached to any particular falling/exiting symbol.
  _renderTileMultiplierGrid() {
    for (let col = 0; col < this.config.reelsCount; col++) {
      for (let row = 0; row < this.config.rowsCount; row++) {
        const value = this.multiplierGrid[col][row];
        if (value <= 1) continue;
        const cx = this.reelsX + col * this.symbolWidth;
        const cy = this.reelsY + row * this.symbolHeight;
        this._renderTileMultiplier(cx, cy, value);
      }
    }
  }

  // A tile's persistent win multiplier (useMultiplierTiles mode), drawn as a big faint number
  // filling the cell so it still peeks out from behind the symbol's own art (a sprite tile
  // isn't a full opaque square - candy art has transparent padding around the shape). 1x (no
  // multiplier yet) is the overwhelmingly common case and intentionally never drawn.
  _renderTileMultiplier(cx, cy, value) {
    if (value <= 1) return;
    const centerX = cx + this.symbolWidth / 2;
    const centerY = cy + this.symbolHeight / 2;

    this.ctx.save();
    this.ctx.globalAlpha = 0.9;
    this.ctx.fillStyle = 'rgba(255, 110, 199, 0.18)';
    this.ctx.fillRect(cx + 2, cy + 2, this.symbolWidth - 4, this.symbolHeight - 4);

    this.ctx.font = `bold ${Math.floor(this.symbolHeight * 0.5)}px Outfit, Inter, sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.lineWidth = 3;
    this.ctx.strokeStyle = 'rgba(45, 16, 48, 0.7)';
    this.ctx.strokeText(`${value}x`, centerX, centerY);
    this.ctx.fillStyle = 'rgba(255, 233, 74, 0.85)';
    this.ctx.fillText(`${value}x`, centerX, centerY);
    this.ctx.restore();
  }

  // A glowing outline around a cell that's part of the cluster currently being cleared, so
  // it's obvious at a glance which tiles just won even before/while their symbol animates
  // away. Pulses in quickly, then fades out alongside the rest of the clear animation.
  _renderClearGlow(cx, cy, progress) {
    const pulseIn = Math.sin(Math.min(progress * 3, 1) * (Math.PI / 2));
    const alpha = pulseIn * (1 - progress * 0.6);
    if (alpha <= 0) return;

    const inset = 2;
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.strokeStyle = '#ffe94a';
    this.ctx.lineWidth = 3;
    this.ctx.shadowColor = '#ffe94a';
    this.ctx.shadowBlur = 14;
    this.ctx.strokeRect(cx + inset, cy + inset, this.symbolWidth - inset * 2, this.symbolHeight - inset * 2);
    this.ctx.restore();
  }

  // Applies one of a few random per-symbol "vanish" animations to a cleared cell (see
  // CLEAR_VARIANTS) so a whole cluster popping doesn't look like one uniform stamp repeated
  // across every cell. All variants pivot around the cell's own center.
  _applyClearTransform(clearInfo, progress, cx, cy) {
    const centerX = cx + this.symbolWidth / 2;
    const centerY = cy + this.symbolHeight / 2;
    this.ctx.globalAlpha = Math.max(0, 1 - progress);
    this.ctx.translate(centerX, centerY);

    switch (clearInfo.variant) {
      case 'stretch': {
        // Taffy-pull squish: narrows while stretching tall, fitting the candy theme.
        this.ctx.scale(1 - progress * 0.5, 1 + progress * 0.9);
        break;
      }
      case 'jump': {
        const hop = -Math.sin(Math.min(progress, 1) * Math.PI) * this.symbolHeight * 0.6;
        this.ctx.translate(0, hop);
        const scale = 1 - progress * 0.3;
        this.ctx.scale(scale, scale);
        break;
      }
      case 'spin': {
        this.ctx.rotate(progress * Math.PI * 2 * clearInfo.spinDirection);
        const scale = 1 - progress * 0.5;
        this.ctx.scale(scale, scale);
        break;
      }
      case 'scaleFade':
      default: {
        const scale = 1 + progress * 0.4;
        this.ctx.scale(scale, scale);
        break;
      }
    }

    this.ctx.translate(-centerX, -centerY);
  }

  // The previous spin's leftover grid, falling out the bottom one reel at a time (see
  // spin()/update()'s columnOutgoingDone handling). Positive outgoingOffsets move a symbol
  // DOWN from its original row (opposite sign convention from cellOffsets, which move a
  // symbol up into place). A column whose offsets have all reached rowsCount is fully exited
  // and simply has nothing left to draw here - no separate per-column flag needed.
  _renderOutgoingGridSymbols() {
    if (!this.outgoingGrid) return;
    for (let col = 0; col < this.config.reelsCount; col++) {
      for (let row = 0; row < this.config.rowsCount; row++) {
        const symbol = this.outgoingGrid[col][row];
        if (!symbol) continue;
        const offsetRows = this.outgoingOffsets[col][row] || 0;
        if (offsetRows >= this.config.rowsCount) continue; // fully exited - nothing to draw
        const cx = this.reelsX + col * this.symbolWidth;
        const cy = this.reelsY + (row + offsetRows) * this.symbolHeight;
        const tile = this.symbolsConfig[symbol];
        drawSpriteSymbol(this.ctx, this.spritesheet, tile, cx, cy, this.symbolWidth, this.symbolHeight, 0);
      }
    }
  }

  _renderGridBorders() {
    const rx = this.reelsX, ry = this.reelsY, rw = this.reelsWidth, rh = this.reelsHeight;
    this.ctx.strokeStyle = '#2d1030';
    this.ctx.lineWidth = 6;
    this.ctx.strokeRect(rx, ry, rw, rh);

    this.ctx.strokeStyle = 'rgba(255, 110, 199, 0.25)';
    this.ctx.lineWidth = 1;
    for (let c = 1; c < this.config.reelsCount; c++) {
      const cx = rx + c * this.symbolWidth;
      this.ctx.beginPath();
      this.ctx.moveTo(cx, ry);
      this.ctx.lineTo(cx, ry + rh);
      this.ctx.stroke();
    }
    for (let r = 1; r < this.config.rowsCount; r++) {
      const cy = ry + r * this.symbolHeight;
      this.ctx.beginPath();
      this.ctx.moveTo(rx, cy);
      this.ctx.lineTo(rx + rw, cy);
      this.ctx.stroke();
    }
  }

  renderParticles() {
    this.particleSystem.render(this.ctx);
  }

  // Floating "+$X.XX" / "Nx symbol" text centered over each cluster's centroid (see
  // _spawnClusterWinPopups), rendered outside the grid's clip region since a popup may rise
  // above the cell it started in.
  _renderClusterWinPopups() {
    const now = Date.now();
    this.activePopups.forEach(p => {
      const progress = Math.min((now - p.startTime) / p.duration, 1);
      const rise = this.symbolHeight * 0.9 * progress;
      const y = p.y - rise;
      const scale = progress < 0.15 ? 0.5 + (0.5 * (progress / 0.15)) : 1;
      const alpha = progress < 0.6 ? 1 : Math.max(0, 1 - (progress - 0.6) / 0.4);

      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.ctx.translate(p.x, y);
      this.ctx.scale(scale, scale);
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.lineWidth = 4;
      this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';

      this.ctx.font = "bold 20px Outfit, sans-serif";
      const amountText = `+$${p.amount.toFixed(2)}`;
      this.ctx.strokeText(amountText, 0, -8);
      this.ctx.fillStyle = '#ffe94a';
      this.ctx.fillText(amountText, 0, -8);

      this.ctx.font = "600 12px Outfit, sans-serif";
      const detailText = `${p.count}x ${p.symbol}`;
      this.ctx.strokeText(detailText, 0, 12);
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillText(detailText, 0, 12);

      this.ctx.restore();
    });
  }
}
