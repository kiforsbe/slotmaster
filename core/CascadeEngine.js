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
    this.currentClearPositions = [];
    this._forceScatterNextSpin = false;

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

    if (this.state === 'dropping_in' || this.state === 'falling') {
      const speed = this.turboMode ? 0.6 : 0.28; // rows per frame
      let allLanded = true;
      for (let col = 0; col < this.config.reelsCount; col++) {
        for (let row = 0; row < this.config.rowsCount; row++) {
          if (this.cellOffsets[col][row] > 0) {
            this.cellOffsets[col][row] = Math.max(0, this.cellOffsets[col][row] - speed);
            allLanded = false;
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
      this._spawnClearParticles(this.currentClearPositions);
      audio.playWin(step.payout);
      this.config.onStateChange(this.state);
    } else {
      this._finishSpin();
    }
  }

  _advanceToNextStep() {
    this.stepIndex++;
    const step = this.cascadeSequence.cascadeSteps[this.stepIndex];
    this.grid = step.grid;
    this.cellOffsets = step.fallOffsets.map(col => col.slice());
    this.currentClearPositions = [];
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

    this.stepIndex = 0;
    const firstStep = this.cascadeSequence.cascadeSteps[0];
    this.grid = firstStep.grid;
    this.cellOffsets = firstStep.fallOffsets.map(col => col.slice());
    this.currentClearPositions = [];

    this.state = 'dropping_in';
    audio.playSpin();
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

    this._renderGridSymbols();

    this.ctx.restore();

    this._renderGridBorders();
    this.renderParticles();
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

        const isBeingCleared = isClearing && this.currentClearPositions.some(([c, r]) => c === col && r === row);

        this.ctx.save();
        if (isBeingCleared) {
          this.ctx.globalAlpha = 1 - clearProgress;
          const scale = 1 + clearProgress * 0.4;
          const centerX = cx + this.symbolWidth / 2;
          const centerY = cy + this.symbolHeight / 2;
          this.ctx.translate(centerX, centerY);
          this.ctx.scale(scale, scale);
          this.ctx.translate(-centerX, -centerY);
        }
        drawSpriteSymbol(this.ctx, this.spritesheet, tile, cx, cy, this.symbolWidth, this.symbolHeight, 0);
        this.ctx.restore();
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
}
