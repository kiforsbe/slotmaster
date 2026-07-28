// Cascade drop-in/clear/fall entrance and transition (CascadeEngine.js's default today): the
// initial grid drops in column by column (playEntrance); between cascade steps, a winning
// cluster's cells clear one cluster at a time, then the vacated cells' replacements fall in
// (playTransition).
//
// Ported faithfully from CascadeEngine.js's own update()/_rampSpeed()/_columnStartDelay()/
// _onStepLanded()/_beginClusterClear()/_spawnClusterWinPopups()/_advanceToNextStep()/
// _spawnClearParticles() (formulas kept identical), restructured from a continuously-polled
// engine-owned update() loop into self-contained tween loops scoped to one playEntrance/
// playTransition call. Owns its own persistent visual state (grid/cellOffsets/outgoingGrid/...)
// separately from CoreSlotEngine's own `engine.grid` (the logical, already-resolved grid for
// the step in progress) - SlotRenderer's cascade draw path reads this animator's state directly
// (engine.animator.grid, not engine.grid) because it tracks in-progress fall/clear
// interpolation, not just the final resolved position. Mirrors ReelScrollAnimator owning
// `this.reels` separately from `engine.grid` for the same reason.
const CLEAR_VARIANTS = ['scaleFade', 'stretch', 'jump', 'spin'];

export class CascadeDropAnimator {
  constructor(renderer, particleSystem, { normalClearDurationMs = 760, turboClearDurationMs = 300 } = {}) {
    this.renderer = renderer;
    this.particleSystem = particleSystem;
    this.normalClearDurationMs = normalClearDurationMs;
    this.turboClearDurationMs = turboClearDurationMs;

    this.grid = null;
    this.cellOffsets = null;
    this.outgoingGrid = null;
    this.outgoingOffsets = null;
    this.columnOutgoingDone = null;
    this.columnEnterStartTime = null;
    this.cellBounceStartTime = null;
    this.currentClearPositions = [];
    this.currentClearVariants = new Map();
    this.activePopups = [];
  }

  _rampSpeed(baseSpeed, localElapsedMs, rampDurationMs) {
    if (localElapsedMs <= 0) return 0;
    const t = Math.min(localElapsedMs / rampDurationMs, 1);
    return baseSpeed * Math.sin(t * (Math.PI / 2));
  }

  _columnStartDelay(reelsCount, turboMode, col) {
    if (reelsCount <= 1) return 0;
    const totalSpan = (reelsCount - 1) * (turboMode ? 20 : 70);
    const t = col / (reelsCount - 1);
    const eased = 1 - Math.pow(1 - t, 2);
    return eased * totalSpan;
  }

  // Drives one "grid falls in" phase (per-column exit-then-enter, staggered) until every column
  // has landed on `targetGrid`/`targetOffsets`. Shared by playEntrance (may have an outgoing
  // grid to exit first) and playTransition's fall half (never does - a mid-spin refill has
  // nothing to exit).
  _runFallPhase(engine, targetGrid, targetOffsets, hasOutgoing, onDone) {
    const reelsCount = engine.config.reelsCount;
    const rowsCount = engine.config.rowsCount;
    const turbo = engine.turboMode;
    const speed = turbo ? 0.19 : 0.095;
    const rampDuration = turbo ? 120 : 240;
    const stepStartTime = Date.now();

    this.grid = targetGrid;
    this.cellOffsets = targetOffsets.map(col => col.slice());

    if (hasOutgoing) {
      this.columnOutgoingDone = new Array(reelsCount).fill(false);
      this.columnEnterStartTime = new Array(reelsCount).fill(null);
    } else {
      this.outgoingGrid = null;
      this.outgoingOffsets = null;
      this.columnOutgoingDone = new Array(reelsCount).fill(true);
      this.columnEnterStartTime = Array.from({ length: reelsCount }, (_, col) => stepStartTime + this._columnStartDelay(reelsCount, turbo, col));
    }
    if (!this.cellBounceStartTime) {
      this.cellBounceStartTime = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(-Infinity));
    }

    const tick = () => {
      const now = Date.now();
      let allDone = true;

      for (let col = 0; col < reelsCount; col++) {
        if (!this.columnOutgoingDone[col]) {
          allDone = false;
          const exitStartAt = stepStartTime + this._columnStartDelay(reelsCount, turbo, col);
          const effectiveSpeed = this._rampSpeed(speed, now - exitStartAt, rampDuration);
          let colFinishedExiting = true;
          for (let row = 0; row < rowsCount; row++) {
            if (this.outgoingOffsets[col][row] < rowsCount) {
              colFinishedExiting = false;
              if (effectiveSpeed > 0) {
                this.outgoingOffsets[col][row] = Math.min(rowsCount, this.outgoingOffsets[col][row] + effectiveSpeed);
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
        for (let row = 0; row < rowsCount; row++) {
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
        if (columnJustLanded) engine.audioController?.onReelStop(col);
      }

      if (this.outgoingGrid && this.columnOutgoingDone.every(Boolean)) {
        this.outgoingGrid = null;
        this.outgoingOffsets = null;
      }

      if (allDone) {
        onDone();
        return;
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  playEntrance(engine, step, onDone) {
    const reelsCount = engine.config.reelsCount;
    const rowsCount = engine.config.rowsCount;
    const hasExistingGrid = this.grid && this.grid.some(col => col.some(cell => cell !== null));

    if (hasExistingGrid) {
      this.outgoingGrid = this.grid;
      this.outgoingOffsets = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(0));
    }
    this.currentClearPositions = [];

    this._runFallPhase(engine, step.grid, step.fallOffsets, hasExistingGrid, onDone);
  }

  playTransition(engine, prevStep, nextStep, onDone) {
    if (prevStep.clusterWins.length === 0) {
      this._runFallPhase(engine, nextStep.grid, nextStep.fallOffsets, false, onDone);
      return;
    }

    const clusterWins = prevStep.clusterWins;
    let clusterIndex = 0;

    this.currentClusterWins = clusterWins;

    const clearNextCluster = () => {
      const cluster = clusterWins[clusterIndex];
      this.currentClusterIndex = clusterIndex;
      const clearDuration = engine.turboMode ? this.turboClearDurationMs : this.normalClearDurationMs;
      this._clearStartTime = Date.now();

      this.currentClearPositions = cluster.winningPositions;
      this.currentClearVariants = new Map();
      this.currentClearPositions.forEach(([col, row]) => {
        this.currentClearVariants.set(`${col},${row}`, {
          variant: CLEAR_VARIANTS[Math.floor(Math.random() * CLEAR_VARIANTS.length)],
          spinDirection: Math.random() < 0.5 ? -1 : 1,
        });
      });
      this._spawnClearParticles(engine, this.currentClearPositions);
      this._spawnClusterWinPopups(engine, [cluster]);
      engine.audioController?.onClusterWin?.(cluster.payout);
      if (engine.inFreeSpins && engine.freeSpinsMode) {
        engine.freeSpinsMode.onClusterCleared(cluster, engine.freeSpinsModeState, engine);
      }

      const waitForClear = () => {
        if (Date.now() - this._clearStartTime < clearDuration) {
          requestAnimationFrame(waitForClear);
          return;
        }
        clusterIndex++;
        if (clusterIndex < clusterWins.length) {
          clearNextCluster();
        } else {
          this.currentClearPositions = [];
          this.currentClusterWins = null;
          this._runFallPhase(engine, nextStep.grid, nextStep.fallOffsets, false, onDone);
        }
      };
      requestAnimationFrame(waitForClear);
    };

    clearNextCluster();
  }

  _spawnClearParticles(engine, positions) {
    const points = positions.map(([col, row]) => ({
      x: engine.reelsX + (col * engine.symbolWidth) + (engine.symbolWidth / 2),
      y: engine.reelsY + (row * engine.symbolHeight) + (engine.symbolHeight / 2),
    }));
    this.particleSystem?.spawn(points);
  }

  _spawnClusterWinPopups(engine, clusterWins) {
    const now = Date.now();
    const duration = engine.turboMode ? 750 : 1500;
    const betAmount = engine.betAmount ?? 1;
    clusterWins.forEach(w => {
      const centroidCol = w.winningPositions.reduce((sum, [c]) => sum + c, 0) / w.winningPositions.length;
      const centroidRow = w.winningPositions.reduce((sum, [, r]) => sum + r, 0) / w.winningPositions.length;
      this.activePopups.push({
        symbol: w.symbol,
        count: w.count,
        amount: w.payout * betAmount,
        x: engine.reelsX + (centroidCol + 0.5) * engine.symbolWidth,
        y: engine.reelsY + (centroidRow + 0.5) * engine.symbolHeight,
        startTime: now,
        duration,
      });
    });
  }
}
