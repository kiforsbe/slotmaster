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
import { applyCascade } from '../../math/CascadeMath.js';

const CLEAR_VARIANTS = ['scaleFade', 'stretch', 'jump', 'spin'];

// Cluster win popup ("+$X.XX" / "Nx symbol") defaults. Every numeric property here is either a
// plain static value, or a { default, animation: { to, duration, easing } } descriptor resolved
// per-frame by core/animation/AnimatedValue.js - see that module's doc for the "crude CSS
// transition" mental model. A game overrides only the sub-keys it cares about, but the merge
// below is shallow (per section, not deep) - a property that defaults to animated (position)
// stays animated unless the override explicitly sets `animation: false` (or `null`); merely
// omitting `animation` from the override does NOT clear the inherited default's animation.
const DEFAULT_POPUP_CONFIG = {
  // showMultiplierBreakdown: when a cluster carries a tile multiplier (baseAmount/tileMultiplier
  // set - see CascadeDropAnimator._spawnClusterWinPopups), the amount line holds on
  // "$base x{multiplier}" for breakdownHoldMs, then poofs to the final "+$total" - legible
  // proof that the win is base_symbol_value x total_multiplier, not just a bigger number out
  // of nowhere. Set false to always show just the final total immediately (the only behavior
  // a base-game cluster - no tileMultiplier at all - ever gets, regardless of this flag).
  // breakdownHoldMs is a hard floor, not a fraction of the popup's normal on-screen duration -
  // extends the popup's own lifetime (see CascadeDropAnimator._spawnClusterWinPopups) so the
  // breakdown is never cut short by the popup's own fade-out.
  amount: { show: true, fontSize: { default: 26 }, showMultiplierBreakdown: true, breakdownHoldMs: 2000 },
  detail: { show: true, fontSize: { default: 16 } },
  // Rise, as a multiplier of symbolHeight (0 = no rise, 0.9 = the popup's original rise
  // distance). No `duration` here on purpose - it falls back to the popup's own on-screen
  // duration (turbo-dependent), matching the original "rises over its whole life" behavior,
  // instead of every game having to know/repeat that duration itself.
  position: { default: 0, animation: { to: 0.9, easing: 'linear' } },
  // Overall scale multiplier (1 = no-op), applied via ctx.scale to amount+detail together - a
  // second, independent way to animate size besides each line's own fontSize: fontSize changes
  // the text's actual point size (reflows independently per line), scale is a uniform transform
  // on top of whatever fontSize each line resolves to (both lines grow/shrink in lockstep,
  // cheaper, and composes with fontSize animation rather than replacing it). Static by default.
  scale: { default: 1 },
};

export class CascadeDropAnimator {
  constructor(renderer, particleSystem, {
    normalClearDurationMs = 760,
    turboClearDurationMs = 300,
    popup = {},
  } = {}) {
    this.renderer = renderer;
    this.particleSystem = particleSystem;
    this.normalClearDurationMs = normalClearDurationMs;
    this.turboClearDurationMs = turboClearDurationMs;
    this.popupConfig = {
      amount: { ...DEFAULT_POPUP_CONFIG.amount, ...popup.amount },
      detail: { ...DEFAULT_POPUP_CONFIG.detail, ...popup.detail },
      position: { ...DEFAULT_POPUP_CONFIG.position, ...popup.position },
      scale: { ...DEFAULT_POPUP_CONFIG.scale, ...popup.scale },
    };

    this.grid = null;
    this.wildMultipliers = null;
    this.cellOffsets = null;
    this.outgoingGrid = null;
    this.outgoingOffsets = null;
    this.columnOutgoingDone = null;
    this.columnEnterStartTime = null;
    this.cellBounceStartTime = null;
    this.currentClearPositions = [];
    this.currentClearDurationMs = null;
    this.currentClearVariants = new Map();
    this.currentSpawnPreviews = [];
    this.activePopups = [];
  }

  // Populates a decorative, non-winning-evaluated grid before any real spin has happened, so
  // the game never shows a blank playfield on load - called once from CoreSlotEngine.init().
  // Ported from CascadeEngine.js's own _fillInitialGrid: uses a throwaway cursor per column
  // (not the real seeded one resolveCascadeSequence builds for an actual spin), so this never
  // consumes/desyncs any spin's own randomness - the first real spin() still treats this as an
  // "existing grid" and animates it falling out first, same as any other spin's leftover grid.
  showIdle(engine) {
    if (this.grid || !engine.config.reelStrips.length) return;
    const { reelStrips, reelsCount, rowsCount } = engine.config;
    const cursorStateByColumn = reelStrips.map(strip => ({ index: Math.floor(Math.random() * strip.length) }));
    const emptyGrid = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(null));
    const allCleared = [];
    for (let col = 0; col < reelsCount; col++) for (let row = 0; row < rowsCount; row++) allCleared.push([col, row]);

    const { grid } = applyCascade(emptyGrid, cursorStateByColumn, reelStrips, allCleared);
    this.grid = grid;
    this.wildMultipliers = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(1));
    this.cellOffsets = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(0));
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
  _runFallPhase(engine, targetGrid, targetOffsets, hasOutgoing, onDone, targetWildMultipliers = null) {
    const reelsCount = engine.config.reelsCount;
    const rowsCount = engine.config.rowsCount;
    const turbo = engine.turboMode;
    const speed = (turbo ? 0.19 : 0.095) * (engine._stopRequested ? 4 : 1);
    const rampDuration = turbo ? 120 : 240;
    const stepStartTime = Date.now();

    this.grid = targetGrid;
    this.wildMultipliers = targetWildMultipliers?.map(column => column.slice())
      || Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(1));
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
    this.currentClearDurationMs = null;
    this.currentSpawnPreviews = [];

    this._runFallPhase(engine, step.grid, step.fallOffsets, hasExistingGrid, onDone, step.wildMultipliers);
  }

  playTransition(engine, prevStep, nextStep, onDone) {
    if (prevStep.clusterWins.length === 0) {
      if ((nextStep.popFeatures?.length ?? 0) > 0) {
        this._playFeatureTransition(engine, prevStep, nextStep, onDone);
        return;
      }
      this._runFallPhase(engine, nextStep.grid, nextStep.fallOffsets, false, onDone, nextStep.wildMultipliers);
      return;
    }

    if (engine.config.cascadeWinClearMode === 'all-at-once') {
      this._playAllAtOnceWinTransition(engine, prevStep, nextStep, onDone);
      return;
    }

    // A fresh copy, not prevStep.grid itself - each cluster's cells get nulled out below as its
    // poof finishes, and prevStep.grid must stay untouched (SpinLogRecorder/replay reads the
    // original resolved grid for every step after the spin completes, not this animator's
    // transient display state).
    this.grid = prevStep.grid.map(col => col.slice());
    this.wildMultipliers = prevStep.wildMultipliers?.map(column => column.slice())
      || this.grid.map(column => new Array(column.length).fill(1));

    const clusterWins = prevStep.clusterWins;
    let clusterIndex = 0;

    this.currentClusterWins = clusterWins;

    const clearNextCluster = () => {
      const cluster = clusterWins[clusterIndex];
      this.currentClusterIndex = clusterIndex;
      const clearDuration = engine.turboMode ? this.turboClearDurationMs : this.normalClearDurationMs;
      this._clearStartTime = Date.now();
      this.currentClearDurationMs = clearDuration;

      this.currentClearPositions = cluster.winningPositions;
      this.currentClearVariants = new Map();
      this.currentSpawnPreviews = cluster.wildSpawnPosition
        ? [{ position: cluster.wildSpawnPosition, multiplier: 1 }]
        : [];
      this.currentClearPositions.forEach(([col, row]) => {
        this.currentClearVariants.set(`${col},${row}`, {
          variant: cluster.wildSpawnPosition ? 'gravitate' : CLEAR_VARIANTS[Math.floor(Math.random() * CLEAR_VARIANTS.length)],
          spinDirection: Math.random() < 0.5 ? -1 : 1,
          targetPosition: cluster.wildSpawnPosition || null,
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
        // Poof finished: actually remove this cluster's symbols now, so they stay gone once
        // clearNextCluster rebuilds currentClearVariants for the next cluster below (otherwise
        // this cluster's cells fall out of that map and momentarily redraw at full opacity -
        // the "cluster 1 reappears" bug).
        cluster.winningPositions.forEach(([col, row]) => {
          this.grid[col][row] = null;
          this.wildMultipliers[col][row] = 1;
        });
        clusterIndex++;
        if (clusterIndex < clusterWins.length) {
          clearNextCluster();
        } else {
          this.currentClearPositions = [];
          this.currentClearDurationMs = null;
          this.currentSpawnPreviews = [];
          this.currentClusterWins = null;
          this._runFallPhase(engine, nextStep.grid, nextStep.fallOffsets, false, onDone, nextStep.wildMultipliers);
        }
      };
      requestAnimationFrame(waitForClear);
    };

    clearNextCluster();
  }

  _playFeatureTransition(engine, prevStep, nextStep, onDone) {
    const reelsCount = engine.config.reelsCount;
    const rowsCount = engine.config.rowsCount;
    this.grid = nextStep.grid.map(col => col.slice());
    this.wildMultipliers = nextStep.wildMultipliers?.map(column => column.slice())
      || this.grid.map(column => new Array(column.length).fill(1));
    this.cellOffsets = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(0));

    const changedPositions = [];
    for (let col = 0; col < reelsCount; col++) {
      for (let row = 0; row < rowsCount; row++) {
        const prevSymbol = prevStep.grid?.[col]?.[row] ?? null;
        const nextSymbol = nextStep.grid?.[col]?.[row] ?? null;
        const prevMultiplier = prevStep.wildMultipliers?.[col]?.[row] ?? 1;
        const nextMultiplier = nextStep.wildMultipliers?.[col]?.[row] ?? 1;
        if (prevSymbol !== nextSymbol || prevMultiplier !== nextMultiplier) {
          changedPositions.push([col, row]);
        }
      }
    }
    nextStep.popFeatures.forEach(feature => {
      (feature.affectedPositions || []).forEach(position => {
        if (!changedPositions.some(([col, row]) => col === position[0] && row === position[1])) {
          changedPositions.push(position);
        }
      });
    });

    if (changedPositions.length === 0) {
      onDone();
      return;
    }

    const clearDuration = engine._stopRequested
      ? Math.min(3200, engine.turboMode ? 600 : 1000)
      : 3200;
    this._clearStartTime = Date.now();
    this.currentClearDurationMs = clearDuration;
    this.currentClearPositions = changedPositions;
    this.currentClearVariants = new Map();
    changedPositions.forEach(([col, row]) => {
      this.currentClearVariants.set(`${col},${row}`, {
        variant: 'spin',
        spinDirection: 1,
      });
    });
    this._spawnClearParticles(engine, changedPositions);
    engine.audioController?.onExpand?.();

    const waitForFeatureClear = () => {
      if (Date.now() - this._clearStartTime < clearDuration) {
        requestAnimationFrame(waitForFeatureClear);
        return;
      }

      this.currentClearPositions = [];
      this.currentClearDurationMs = null;
      this.currentClearVariants = new Map();
      onDone();
    };
    requestAnimationFrame(waitForFeatureClear);
  }

  // Payline cascades show each winning path in turn, but all of the lines belong to one
  // evaluation of the same grid. Keep that grid intact while the paths are previewed, then
  // clear the union of every winning position in one shared explode phase. Cluster games keep
  // the branch above, where each cluster gets its own visual clear.
  _playAllAtOnceWinTransition(engine, prevStep, nextStep, onDone) {
    this.grid = prevStep.grid.map(col => col.slice());
    this.wildMultipliers = prevStep.wildMultipliers?.map(column => column.slice())
      || this.grid.map(column => new Array(column.length).fill(1));

    const wins = prevStep.clusterWins;
    const lineWins = wins.filter(win => win.lineIndex != null || win.kind === 'straight-line');
    this.currentClusterWins = lineWins;
    this.currentClusterIndex = 0;

    const previewDuration = engine.config.cascadeWinPreviewDurationMs ?? 500;
    const previewStartTime = Date.now();

    const beginCombinedClear = () => {
      this.currentClusterWins = null;
      this.currentClusterIndex = -1;

      const clearPositions = [];
      wins.forEach(win => {
        win.winningPositions.forEach(position => {
          if (!clearPositions.some(([col, row]) => col === position[0] && row === position[1])) {
            clearPositions.push(position);
          }
        });
      });

      const clearDuration = engine.turboMode ? this.turboClearDurationMs : this.normalClearDurationMs;
      this._clearStartTime = Date.now();
      this.currentClearDurationMs = clearDuration;
      this.currentClearPositions = clearPositions;
      this.currentClearVariants = new Map();
      this.currentSpawnPreviews = wins
        .filter(win => Array.isArray(win.wildSpawnPosition))
        .reduce((previews, win) => {
          if (!previews.some(item => item.position[0] === win.wildSpawnPosition[0] && item.position[1] === win.wildSpawnPosition[1])) {
            previews.push({ position: win.wildSpawnPosition, multiplier: 1 });
          }
          return previews;
        }, []);
      clearPositions.forEach(([col, row]) => {
        const owner = wins.find(win => win.winningPositions.some(position => position[0] === col && position[1] === row));
        this.currentClearVariants.set(`${col},${row}`, {
          variant: owner?.wildSpawnPosition ? 'gravitate' : CLEAR_VARIANTS[Math.floor(Math.random() * CLEAR_VARIANTS.length)],
          spinDirection: Math.random() < 0.5 ? -1 : 1,
          targetPosition: owner?.wildSpawnPosition || null,
        });
      });

      this._spawnClearParticles(engine, clearPositions);
      this._spawnClusterWinPopups(engine, wins);
      wins.forEach(win => engine.audioController?.onClusterWin?.(win.payout));
      if (engine.inFreeSpins && engine.freeSpinsMode) {
        wins.forEach(win => engine.freeSpinsMode.onClusterCleared(win, engine.freeSpinsModeState, engine));
      }

      const waitForClear = () => {
        const effectiveClearDuration = engine._stopRequested
          ? Math.min(clearDuration, engine.turboMode ? 80 : 180)
          : clearDuration;
        if (Date.now() - this._clearStartTime < effectiveClearDuration) {
          requestAnimationFrame(waitForClear);
          return;
        }
        clearPositions.forEach(([col, row]) => {
          this.grid[col][row] = null;
          this.wildMultipliers[col][row] = 1;
        });
        this.currentClearPositions = [];
        this.currentClearDurationMs = null;
        this.currentSpawnPreviews = [];
        this._runFallPhase(engine, nextStep.grid, nextStep.fallOffsets, false, onDone, nextStep.wildMultipliers);
      };
      requestAnimationFrame(waitForClear);
    };

    if (lineWins.length === 0) {
      beginCombinedClear();
      return;
    }

    const showNextLine = () => {
      const lineIndex = Math.floor((Date.now() - previewStartTime) / previewDuration);
      if (lineIndex >= lineWins.length) {
        beginCombinedClear();
        return;
      }
      this.currentClusterIndex = lineIndex;
      requestAnimationFrame(showNextLine);
    };
    requestAnimationFrame(showNextLine);
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
    const plainDuration = engine.turboMode ? 1000 : 2000;
    const betAmount = engine.betAmount ?? 1;
    clusterWins.forEach(w => {
      const centroidCol = w.winningPositions.reduce((sum, [c]) => sum + c, 0) / w.winningPositions.length;
      const centroidRow = w.winningPositions.reduce((sum, [, r]) => sum + r, 0) / w.winningPositions.length;

      const hasMultiplier = (w.tileMultiplier ?? 1) > 1;
      const showBreakdown = hasMultiplier && this.popupConfig.amount.showMultiplierBreakdown;
      // breakdownHoldMs is a floor UNDER the popup's total lifetime, not a fraction carved out
      // of it - plainDuration (the normal turbo/non-turbo lifetime) still runs in full AFTER
      // the poof, so "+$total" gets the same visible-then-fade treatment a plain popup would,
      // instead of the breakdown eating into (and shortening) that time.
      const breakdownHoldMs = showBreakdown ? this.popupConfig.amount.breakdownHoldMs : 0;
      const duration = breakdownHoldMs + plainDuration;

      this.activePopups.push({
        symbol: w.symbol,
        count: w.count,
        amount: w.payout * betAmount,
        // Only present when a free-spins mode (e.g. multiplier tiles) enriched this cluster
        // win - undefined for a plain base-game cluster, so the popup falls back to just
        // showing `amount` (see SlotRenderer.drawClusterWinPopups).
        baseAmount: w.basePayout != null ? w.basePayout * betAmount : undefined,
        tileMultiplier: w.tileMultiplier,
        breakdownHoldMs,
        x: engine.reelsX + (centroidCol + 0.5) * engine.symbolWidth,
        y: engine.reelsY + (centroidRow + 0.5) * engine.symbolHeight,
        startTime: now,
        duration,
        // Shared reference (not copied per-field) - this.popupConfig never mutates after
        // construction, and SlotRenderer.drawClusterWinPopups resolves each property fresh
        // every frame from it via resolveAnimatedValue.
        popupConfig: this.popupConfig,
      });
    });
  }
}
