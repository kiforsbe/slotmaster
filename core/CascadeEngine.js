// Stateful cascade engine: canvas rendering + a state machine that animates playback of an
// already fully-resolved spin (see core/CascadeMath.js's resolveCascadeSequence) - mirroring
// how SlotEngine precomputes targetGrid and then animates reels catching up to it. Knows
// nothing about clusters or paylines: config.winEvaluator is a single-argument closure the
// game supplies (e.g. games/candyfrenzy/game.js wraps checkClusterWins), so this file is
// reusable by any future cascading-grid game, not just cluster-pays ones.
import { computeGridLayout } from './GridLayout.js';
import { drawSpriteSymbol } from './SpriteDrawer.js';
import { ParticleSystem } from './ParticleSystem.js';
import { applyCascade } from './CascadeMath.js';
import { createCascadeSpinLogEntry } from './SpinLog.js';
import { createSeededRng } from './SlotMath.js';
import { audio } from './SlotAudio.js';
import { createFlatMultiplierMode } from './FreeSpinsModes.js';
import { CascadeSpinMechanic } from './CascadeSpinMechanic.js';
import { simulateSpins } from './SpinSimulator.js';

const SPIN_LOG_MAX_ENTRIES = 20000;

// A cleared symbol randomly picks one of these vanish styles (see _applyClearTransform) so a
// whole cluster popping doesn't look like one uniform stamp repeated across every cell.
const CLEAR_VARIANTS = ['scaleFade', 'stretch', 'jump', 'spin'];

// How long the "clearing" state (a winning cluster's vanish animation + glow) lingers before
// the next cascade step's grid appears.
const CLEAR_DURATION_MS = { normal: 760, turbo: 300 };

// One per payline, cycled if a game declares more. Only used by a line-pay cascade game (see
// _renderWinLine); a cluster game never reaches this.
const LINE_COLORS = [
  '#ff003c', '#00ff66', '#00d2ff', '#ffcc00', '#ff00ff',
  '#ff6600', '#00ffff', '#9933ff', '#d4af37', '#33ff33',
];

// How far outside the grid a payline's numbered tag sits - and therefore where its line starts
// and ends, since the line runs tag to tag.
const LINE_TAG_OFFSET = 15;

// How the playfield itself is drawn - everything behind and around the symbols. These were
// hardcoded to Candy Frenzy's pink-on-purple, which is why Mayan Tumble's stone-and-jade art sat
// on a synthwave cabinet: one engine, two games, one palette. The defaults below ARE the Candy
// Frenzy look, so a game that passes nothing is unchanged.
//
// `gridLines` is a real choice rather than a colour: a cluster game reads better with cells marked
// out, because a cluster IS a set of cells and the grid is what makes its shape legible. A themed
// line-pay game does not need them, and drawing them anyway is what makes a playfield look like a
// spreadsheet. `noise` replaces them with a fixed grain - texture where the ruling used to be.
const DEFAULT_PLAYFIELD_THEME = {
  backdropInner: '#3a1440',
  backdropOuter: '#140518',
  outline: '#ff6ec7',
  outlineGlow: 10,
  frame: '#2d1030',
  gridLines: 'rgba(255, 110, 199, 0.25)',
  background: null,
  loadingBackground: '#2a0e2e',
  loadingColor: '#ff6ec7',
  loadingText: 'LOADING CANDY...',
};

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
      // Pluggable free-spins payout mode (see core/FreeSpinsModes.js for the hook contract) -
      // defaults to the original flat "every win pays double" rule; a game passes its own
      // mode instance (e.g. createMultiplierTilesMode()) to use something else instead. Only
      // ever consulted while inFreeSpins - the base game always uses winEvaluator unwrapped.
      freeSpinsMode: createFlatMultiplierMode(),
      // The "get symbols for the playfield" component (core/CascadeSpinMechanic.js) - shared
      // with core/SpinSimulator.js's batch simulation/tuning, so a live spin and a simulated
      // one resolve identically. A future gameplay mechanic (e.g. a line-win cascade solver)
      // plugs in here without any CascadeEngine changes.
      mechanic: CascadeSpinMechanic,
      onStateChange: () => {},
      onScatterTrigger: (scatterCount, isInFreeSpins) => {},
      onWin: () => {},
      ...config,
      // Merged rather than replaced, so a game can restyle one thing (drop the grid lines, say)
      // without restating the whole playfield.
      playfield: { ...DEFAULT_PLAYFIELD_THEME, ...(config.playfield ?? {}) },
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

    // The active free-spins mode's own working state (see core/FreeSpinsModes.js) - rebuilt
    // fresh on enterFreeSpins and cleared again on exitFreeSpins, so nothing a mode tracks
    // (e.g. multiplier tiles) ever leaks between bonus rounds or into the base game.
    this.freeSpinsModeState = this.config.freeSpinsMode.createState(this);

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

    // Let the active free-spins mode react to this cluster's win now, in step with THIS
    // cluster's own clear animation - not all at once back when the whole spin was
    // precomputed (see core/FreeSpinsModes.js's onClusterCleared doc).
    if (this.inFreeSpins) this.config.freeSpinsMode.onClusterCleared(cluster, this.freeSpinsModeState, this);

    this.config.onStateChange(this.state);
  }

  _spawnClusterWinPopups(clusterWins) {
    const now = Date.now();
    const duration = this.turboMode ? 750 : 1500;
    clusterWins.forEach(w => {
      const centroidCol = w.winningPositions.reduce((sum, [c]) => sum + c, 0) / w.winningPositions.length;
      const centroidRow = w.winningPositions.reduce((sum, [, r]) => sum + r, 0) / w.winningPositions.length;
      this.activePopups.push({
        symbol: w.symbol,
        count: w.count,
        amount: w.payout * this.betAmount,
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
    // cascadeSequence.totalPayoutMultiplier already reflects the active free-spins mode's
    // bonus (see FreeSpinsModes.js's wrapWinEvaluator) - nothing further to apply here.
    const payoutAmount = this.cascadeSequence.totalPayoutMultiplier * this.betAmount;
    this.lastWin = payoutAmount;
    this.balance += payoutAmount;
    if (this.inFreeSpins) this.freeSpinsAccumulatedWin += payoutAmount;

    this._pushSpinLogEntry();

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

  _pushSpinLogEntry() {
    const entry = createCascadeSpinLogEntry({
      spinIndex: this.spinLog.length + 1,
      phase: this.inFreeSpins ? 'free' : 'base',
      betAmount: this.betAmount,
      chargedBet: this.inFreeSpins ? 0 : this.betAmount,
      // No freeSpinsMultiplier passed - cascadeSteps[i].clusterWins[j].payout is already fully
      // mode-adjusted (see above), so createCascadeSpinLogEntry's default of 1 is correct here.
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

  // Batch-simulates numBaseSpins base spins (plus any free spins they trigger) via
  // core/SpinSimulator.js's simulateSpins, reusing this instance's own reelStrips/paytable/
  // winEvaluator/scatterSymbol/freeSpinsMode - the same free-spins mode a real bonus round
  // uses, so a simulated free-spins round's economics (e.g. Candy Frenzy's persistent
  // multiplier tiles) match live play exactly, not a flat approximation. Same 4-arg shape as
  // SlotEngine.runSimulation (so core/SimulationPanel.js can call either engine identically) -
  // `linesCount` is accepted only for that parity and always forced to 1 internally (cascade
  // games have no per-line betting concept - see CascadeSpinMechanic's own doc).
  runSimulation(numBaseSpins = 100000, betAmount = this.betAmount, linesCount = 1, options = {}) {
    const { seed = null, logSpins = false } = options;
    const rng = seed != null ? createSeededRng(seed) : Math.random;
    return simulateSpins({ ...this.config, logSpins }, numBaseSpins, betAmount, 1, rng);
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

  // Lets the active free-spins mode (config.freeSpinsMode, see core/FreeSpinsModes.js) wrap
  // config.winEvaluator so every cascade step's cluster payouts already include this spin's
  // bonus - resolveCascadeSequence calls the returned closure once per cascade step,
  // synchronously, in chronological order. Outside free spins (or for the base game
  // generally) the evaluator is used completely unwrapped.
  _buildWinEvaluatorForSpin() {
    const baseEvaluator = this.config.winEvaluator;
    if (!this.inFreeSpins) return baseEvaluator;
    return this.config.freeSpinsMode.wrapWinEvaluator(baseEvaluator, this.freeSpinsModeState, this);
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
    this.cascadeSequence = this.config.mechanic.resolveSequence(
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
    // The active mode's state always starts fresh at the top of a free-spins bonus, never
    // carried over from a previous one.
    this.freeSpinsModeState = this.config.freeSpinsMode.createState(this);

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
    // Whatever the active mode was tracking is a free-spins-only bonus - removed the moment
    // the bonus round ends, not carried into the base game.
    this.freeSpinsModeState = this.config.freeSpinsMode.createState(this);
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

    // The active free-spins mode's own overlay (if any) draws either before or after the grid
    // symbols, per that mode's own renderOverlayOrder ('behind' or 'front', default 'front') -
    // a mode's call, not a fixed engine rule, since which one looks right depends on that
    // mode's own visual (candy sprite art is essentially opaque, so a 'behind' overlay is only
    // ever visible on a cell with no symbol drawn over it yet - still a legitimate choice for
    // some visuals, just not for one meant to stay legible on a landed tile). Called every
    // frame regardless of inFreeSpins - a mode's own state is reset to "nothing to show" the
    // instant free spins end (see exitFreeSpins), so this is a no-op outside a bonus round
    // without needing its own check.
    const mode = this.config.freeSpinsMode;
    const overlayBehind = mode.renderOverlayOrder === 'behind';

    // Behind everything inside the grid - it is the playfield's surface, not an effect over it.
    this._renderPlayfieldBackground();

    if (overlayBehind) mode.renderOverlay(this.freeSpinsModeState, this);
    this._renderOutgoingGridSymbols();
    this._renderGridSymbols();
    if (!overlayBehind) mode.renderOverlay(this.freeSpinsModeState, this);

    this.ctx.restore();

    this._renderGridBorders();
    // Outside the clip, like the popups: a payline's number tags sit just beyond the grid edge.
    this._renderWinLine();
    this.renderParticles();
    this._renderClusterWinPopups();
  }

  // The payline currently being paid, drawn across the grid with its number at both ends.
  //
  // A cascade engine has no concept of paylines - a win is a set of cells and that is normally the
  // whole story. It stops being the whole story for a line-pay cascade game (Mayan Tumble): three
  // matching symbols on a 5x3 grid sit on several paylines at once, so the cells alone do not tell
  // a player which line they were actually paid for, and the payout differs per line. Any win that
  // carries a `lineIndex` gets its path drawn; a cluster win carries none and this is a no-op, so
  // no cluster game pays for the feature.
  //
  // Only the cluster being cleared right now, because that is already how this engine presents a
  // multi-win spin: one win at a time, in sequence, each with its own glow, particles and popup.
  // Drawing every line at once would be a different presentation from the one the rest of the
  // spin uses, and on ten paylines it is an unreadable tangle.
  _renderWinLine() {
    if (this.state !== 'clearing') return;
    const paylines = this.config.paylines;
    if (!paylines) return;
    const win = this.currentClusterWins?.[this.currentClusterIndex];
    if (!win || win.lineIndex == null) return;
    const path = paylines[win.lineIndex];
    if (!path) return;

    const color = LINE_COLORS[win.lineIndex % LINE_COLORS.length];
    const lastReel = this.config.reelsCount - 1;
    const centerOf = (col) => ({
      x: this.reelsX + (col + 0.5) * this.symbolWidth,
      y: this.reelsY + (path[col] + 0.5) * this.symbolHeight,
    });
    // The tags are where the line begins and ends, not decorations parked beside it - so the
    // stroke runs from one tag's center to the other, through every cell between. Stopping it at
    // the outer cells instead left the numbers floating unattached to the line they label.
    const leftTagX = this.reelsX - LINE_TAG_OFFSET;
    const rightTagX = this.reelsX + this.reelsWidth + LINE_TAG_OFFSET;

    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 4;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.shadowColor = color;
    this.ctx.shadowBlur = 12;
    this.ctx.beginPath();
    this.ctx.moveTo(leftTagX, centerOf(0).y);
    for (let col = 0; col < this.config.reelsCount; col++) {
      const { x, y } = centerOf(col);
      this.ctx.lineTo(x, y);
    }
    this.ctx.lineTo(rightTagX, centerOf(lastReel).y);
    this.ctx.stroke();
    this.ctx.restore();

    // Drawn after the stroke, so each tag's opaque disc caps the end it sits on.
    // 1-based, because a paytable and a player both count lines from 1.
    const label = win.lineIndex + 1;
    this._renderLineTag(label, leftTagX, centerOf(0).y, color);
    this._renderLineTag(label, rightTagX, centerOf(lastReel).y, color);
  }

  _renderLineTag(num, x, y, color) {
    this.ctx.save();
    this.ctx.fillStyle = '#0f0f13';
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(x, y, 12, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();

    this.ctx.fillStyle = '#fff';
    this.ctx.font = 'bold 11px Outfit, Inter, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(num, x, y);
    this.ctx.restore();
  }

  _renderLoading() {
    const theme = this.config.playfield;
    this.ctx.fillStyle = theme.loadingBackground;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = theme.loadingColor;
    this.ctx.font = 'bold 24px Outfit, Inter, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(theme.loadingText, this.canvas.width / (2 * (window.devicePixelRatio || 1)), this.canvas.height / (2 * (window.devicePixelRatio || 1)));
  }

  _renderCabinet() {
    const theme = this.config.playfield;
    const rx = this.reelsX, ry = this.reelsY, rw = this.reelsWidth, rh = this.reelsHeight;
    const gradient = this.ctx.createRadialGradient(rx + rw / 2, ry + rh / 2, rh * 0.2, rx + rw / 2, ry + rh / 2, rw * 0.7);
    gradient.addColorStop(0, theme.backdropInner);
    gradient.addColorStop(1, theme.backdropOuter);
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, rx * 2 + rw, ry * 2 + rh);

    this.ctx.strokeStyle = theme.outline;
    this.ctx.lineWidth = 4;
    this.ctx.shadowColor = theme.outline;
    this.ctx.shadowBlur = theme.outlineGlow;
    this.ctx.strokeRect(rx - 2, ry - 2, rw + 4, rh + 4);
    this.ctx.shadowBlur = 0;
  }

  /**
   * A fixed grain across the playfield, drawn behind the symbols.
   *
   * Generated ONCE into an offscreen canvas and blitted every frame: regenerating per frame would
   * make the whole playfield crawl, which reads as a rendering fault rather than as texture. It is
   * also seeded, so the grain is the same on every load - a backdrop that reshuffles each time the
   * page opens is a backdrop the player notices.
   *
   * Rebuilt whenever the grid is resized, since it is sized to the grid.
   */
  _generatePlayfieldNoise() {
    const noise = this.config.playfield.noise;
    if (!noise) return null;
    const w = Math.max(1, Math.ceil(this.reelsWidth));
    const h = Math.max(1, Math.ceil(this.reelsHeight));
    if (this._noiseCanvas && this._noiseCanvas.width === w && this._noiseCanvas.height === h) {
      return this._noiseCanvas;
    }

    const scale = noise.scale ?? 3;
    const cols = Math.ceil(w / scale), rows = Math.ceil(h / scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // A tiny LCG rather than Math.random, for the "same grain every load" promise above.
    let seed = noise.seed ?? 1337;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

    const [r, g, b] = noise.color ?? [255, 255, 255];
    const strength = noise.strength ?? 0.05;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // Squared, so most cells are nearly invisible and a few carry the texture - flat uniform
        // noise just raises the backdrop's brightness and reads as a gray wash.
        const t = rand() ** 2;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(t * strength).toFixed(4)})`;
        ctx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
    this._noiseCanvas = canvas;
    return canvas;
  }

  _renderPlayfieldBackground() {
    const background = this.config.playfield.background;

    if (background) {
      if (background.type === 'noise') {
        const noise = this._generatePlayfieldNoise();
        if (noise) this.ctx.drawImage(noise, this.reelsX, this.reelsY);
      } else if (background.type === 'image') {
        // load image defined by path in background.image, then draw it to the canvas at reelsX, reelsY
        if (!this._backgroundImage) {
          this._backgroundImage = new Image();
          this._backgroundImage.src = background.image;
        }
        if (this._backgroundImage) this.ctx.drawImage(this._backgroundImage, this.reelsX, this.reelsY, this.reelsWidth, this.reelsHeight);
      }
    }
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
    const theme = this.config.playfield;
    const rx = this.reelsX, ry = this.reelsY, rw = this.reelsWidth, rh = this.reelsHeight;
    this.ctx.strokeStyle = theme.frame;
    this.ctx.lineWidth = 6;
    this.ctx.strokeRect(rx, ry, rw, rh);

    // A cluster game wants its cells ruled - a cluster IS a set of cells, and the grid is what
    // makes its shape legible. A themed line-pay game does not, and ruling it anyway makes the
    // playfield look like a spreadsheet with art in it.
    if (!theme.gridLines) return;
    this.ctx.strokeStyle = theme.gridLines;
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
