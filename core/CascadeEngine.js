// Stateful cascade engine: canvas rendering + a state machine that animates playback of an
// already fully-resolved spin (see core/CascadeMath.js's resolveCascadeSequence) - mirroring
// how SlotEngine precomputes targetGrid and then animates reels catching up to it. Knows
// nothing about clusters or paylines: config.winEvaluator is a single-argument closure the
// game supplies (e.g. games/candyfrenzy/game.js wraps checkClusterWins), so this file is
// reusable by any future cascading-grid game, not just cluster-pays ones.
import { computeGridLayout } from './GridLayout.js';
import { drawSpriteSymbol } from './SpriteDrawer.js';
import { ParticleSystem } from './ParticleSystem.js';
import { resolveCascadeSequence } from './CascadeMath.js';
import { createCascadeSpinLogEntry } from './SpinLog.js';
import { audio } from './SlotAudio.js';

const SPIN_LOG_MAX_ENTRIES = 20000;

// A cleared symbol randomly picks one of these vanish styles (see _applyClearTransform) so a
// whole cluster popping doesn't look like one uniform stamp repeated across every cell.
const CLEAR_VARIANTS = ['scaleFade', 'stretch', 'jump', 'spin'];

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
    this._forceScatterNextSpin = false;

    // Previous spin's leftover grid (dropping_out state): falls out the bottom before the new
    // spin's grid starts falling in, with a brief empty-reel gap between the two (empty_gap
    // state). Null whenever there's nothing exiting.
    this.outgoingGrid = null;
    this.outgoingOffsets = null;
    this._gapUntil = 0;

    // Floating per-cluster win-amount popups. Kept on their own timeline (not tied to
    // clearDuration/the state machine) so they can outlive a fast "clearing" phase and
    // still be readable, even overlapping across rapid-fire cascade steps.
    this.activePopups = [];

    this.particleSystem = new ParticleSystem();
    this.audio = audio;

    this.spinLog = [];

    this.init();
  }

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

    if (this.state === 'dropping_out') {
      // The previous spin's leftover grid falls out the bottom, same speed/wave stagger as a
      // normal drop-in but in reverse (offset grows from 0 up to rowsCount instead of
      // shrinking to 0), so it reads as the same motion applied to symbols leaving instead of
      // arriving.
      const speed = this.turboMode ? 0.6 : 0.055;
      const columnStagger = this.turboMode ? 20 : 70;
      let allExited = true;
      for (let col = 0; col < this.config.reelsCount; col++) {
        const columnStarted = now - this.stepStartTime >= col * columnStagger;
        for (let row = 0; row < this.config.rowsCount; row++) {
          if (this.outgoingOffsets[col][row] < this.config.rowsCount) {
            allExited = false;
            if (columnStarted) {
              this.outgoingOffsets[col][row] = Math.min(this.config.rowsCount, this.outgoingOffsets[col][row] + speed);
            }
          }
        }
      }
      if (allExited) {
        this.outgoingGrid = null;
        this.outgoingOffsets = null;
        this._gapUntil = now + (this.turboMode ? 80 : 220);
        this.state = 'empty_gap';
        this.config.onStateChange(this.state);
      }
    } else if (this.state === 'empty_gap') {
      // A brief pause with a visibly empty reel before the new grid starts dropping in.
      if (now >= this._gapUntil) this._beginDropIn();
    } else if (this.state === 'dropping_in' || this.state === 'falling') {
      const speed = this.turboMode ? 0.6 : 0.055; // rows per frame
      // Reels start falling one after another, left to right, instead of all at once - a
      // "wave" cascading across the grid rather than a flat drop.
      const columnStagger = this.turboMode ? 20 : 70; // ms between each successive reel starting
      let allLanded = true;
      for (let col = 0; col < this.config.reelsCount; col++) {
        const columnStarted = now - this.stepStartTime >= col * columnStagger;
        for (let row = 0; row < this.config.rowsCount; row++) {
          if (this.cellOffsets[col][row] > 0) {
            allLanded = false;
            if (columnStarted) {
              this.cellOffsets[col][row] = Math.max(0, this.cellOffsets[col][row] - speed);
            }
          }
        }
      }
      if (allLanded) this._onStepLanded();
    } else if (this.state === 'clearing') {
      const clearDuration = this.turboMode ? 150 : 380;
      if (now - this.clearStartTime >= clearDuration) this._advanceToNextStep();
    }

    if (this.pendingSpinRequest && (this.state === 'idle' || this.state === 'showing_wins')) {
      this.pendingSpinRequest = false;
      this.startNextSpin();
    }
  }

  _onStepLanded() {
    const step = this.cascadeSequence.cascadeSteps[this.stepIndex];
    if (step.clusterWins.length > 0) {
      this.state = 'clearing';
      this.clearStartTime = Date.now();
      this.currentClearPositions = step.clusterWins.flatMap(w => w.winningPositions);
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
      this._spawnClusterWinPopups(step.clusterWins);
      audio.playWin(step.payout);
      this.config.onStateChange(this.state);
    } else {
      this._finishSpin();
    }
  }

  _spawnClusterWinPopups(clusterWins) {
    const freeSpinsMultiplier = this.inFreeSpins ? 2 : 1;
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
    this.stepStartTime = Date.now();
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
    const freeSpinsMultiplier = this.inFreeSpins ? 2 : 1;
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
      this.config.onScatterTrigger(scatterWin.count, this.inFreeSpins);
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
      this.config.reelStrips, this.config.rowsCount, spinSeed, this.config.winEvaluator
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

    // If a previous spin left symbols on the grid, they fall out the bottom first (with a
    // brief empty-reel gap after) before this spin's grid starts dropping in - see
    // _beginDropIn(). The very first spin ever (grid still all-null) skips straight to it.
    const hasExistingGrid = this.grid.some(col => col.some(cell => cell !== null));
    if (hasExistingGrid) {
      this.outgoingGrid = this.grid;
      this.outgoingOffsets = Array.from({ length: this.config.reelsCount }, () => new Array(this.config.rowsCount).fill(0));
      this.stepStartTime = Date.now();
      this.state = 'dropping_out';
      this.config.onStateChange(this.state);
    } else {
      this._beginDropIn();
    }
  }

  _beginDropIn() {
    this.stepIndex = 0;
    const firstStep = this.cascadeSequence.cascadeSteps[0];
    this.grid = firstStep.grid;
    this.cellOffsets = firstStep.fallOffsets.map(col => col.slice());
    this.currentClearPositions = [];

    this.stepStartTime = Date.now();
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

    this._renderOutgoingGridSymbols();
    // During dropping_out/empty_gap, this.grid still holds the previous spin's settled
    // contents (not yet overwritten - see _beginDropIn) - it's outgoingGrid's job to draw
    // those symbols as they exit, so skip the normal draw entirely here to avoid a duplicate.
    if (this.state !== 'dropping_out' && this.state !== 'empty_gap') {
      this._renderGridSymbols();
    }

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
    const isClearing = this.state === 'clearing';
    const clearDuration = this.turboMode ? 150 : 380;
    const clearProgress = isClearing ? Math.min((Date.now() - this.clearStartTime) / clearDuration, 1) : null;

    for (let col = 0; col < this.config.reelsCount; col++) {
      for (let row = 0; row < this.config.rowsCount; row++) {
        const symbol = this.grid[col][row];
        if (!symbol) continue;

        const offsetRows = this.cellOffsets[col][row] || 0;
        const cx = this.reelsX + col * this.symbolWidth;
        const cy = this.reelsY + (row - offsetRows) * this.symbolHeight;
        const tile = this.symbolsConfig[symbol];

        const clearInfo = isClearing ? this.currentClearVariants.get(`${col},${row}`) : null;

        this.ctx.save();
        if (clearInfo) {
          this._applyClearTransform(clearInfo, clearProgress, cx, cy);
        }
        drawSpriteSymbol(this.ctx, this.spritesheet, tile, cx, cy, this.symbolWidth, this.symbolHeight, 0);
        this.ctx.restore();
      }
    }
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

  // The previous spin's leftover grid, falling out the bottom during dropping_out (see
  // spin()/update()). Positive outgoingOffsets move a symbol DOWN from its original row
  // (opposite sign convention from cellOffsets, which move a symbol up into place).
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
