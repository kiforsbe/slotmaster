// Pluggable free-spins payout modes for CoreSlotEngine (core/engine/CoreSlotEngine.js), cascade
// games only. A mode is a plain object of lifecycle hooks the engine calls without knowing which
// concrete mode is active - config.freeSpinsMode picks one for a given game; a future mode (for
// this game or a future cascade game) just needs to implement this same shape, no CoreSlotEngine
// changes required. A mode owns any visuals it needs entirely itself (see renderOverlay below) -
// CoreSlotEngine only ever hands it `engine` (for ctx/geometry/config) and its own state.
//
// Hooks:
//   createState(engine) -> any
//     Builds this mode's own working state. Called once when free spins begin
//     (CoreSlotEngine.enterFreeSpins) and again the instant they end (exitFreeSpins) - so a
//     mode with persistent per-tile state (like multiplier tiles) always starts fresh at the
//     top of a bonus round and is fully cleared the moment it's over, never leaking into the
//     base game or a later bonus round.
//   wrapWinEvaluator(baseEvaluator, state, engine) -> (grid) => results
//     Only ever called while inFreeSpins (see CoreSlotEngine._buildWinEvaluatorForSpin). Wraps
//     the game's own win evaluator so every cluster's payout - and the step's
//     totalPayoutMultiplier - already reflects this mode's bonus by the time
//     resolveCascadeSequence finishes resolving the whole spin. CoreSlotEngine's own money
//     code (_finishSpin/CascadeDropAnimator's popups/spin log) trusts these numbers as-is and
//     never applies anything else on top.
//   onClusterCleared(cluster, state, engine)
//     Called once per cluster, only while inFreeSpins, at the exact moment the active
//     SpinAnimator (CascadeDropAnimator) starts playing that cluster's own clear animation - a
//     mode with visible per-tile state updates it here, in step with the animation, not all at
//     once back when the whole spin was precomputed.
//   renderOverlay(state, engine)
//     Called once per frame from render(). Called every frame regardless of inFreeSpins; a
//     mode's state is reset to "nothing to show" the instant free spins end, so this
//     naturally draws nothing outside a bonus round without needing its own check.
//   renderOverlayOrder: 'behind' | 'front' (optional property, not a function; default
//     'front' if omitted)
//     Whether renderOverlay draws before or after the grid's symbols that same frame. Candy
//     sprite art is essentially opaque, so a 'behind' overlay is only ever visible on a cell
//     with no symbol drawn over it yet (e.g. mid-cascade, before that cell's new symbol has
//     landed) - not wrong, just a different look than 'front', which stays legible on a
//     landed tile too. Each mode picks whichever fits its own visual.

/**
 * The original/default rule: every free-spins win simply pays `multiplier`x. No per-tile
 * state, no visual overlay.
 */
export function createFlatMultiplierMode(multiplier = 2) {
  return {
    name: 'flatMultiplier',
    createState() {
      return null;
    },
    wrapWinEvaluator(baseEvaluator) {
      return (grid) => {
        const results = baseEvaluator(grid);
        if (results.totalPayoutMultiplier <= 0) return results;
        return {
          ...results,
          clusterWins: results.clusterWins.map(w => ({ ...w, payout: w.payout * multiplier })),
          totalPayoutMultiplier: results.totalPayoutMultiplier * multiplier,
        };
      };
    },
    onClusterCleared() {},
    renderOverlay() {},
  };
}

// A big, translucent tint + number filling most of the cell - reads as a background wash
// rather than a UI chip. Drawn last (see renderOverlay's doc above) so it's actually visible
// over the sprite, at reduced alpha so the candy underneath still shows through it.
function drawBackgroundBadge(engine, cx, cy, value) {
  const ctx = engine.ctx;
  const centerX = cx + engine.symbolWidth / 2;
  const centerY = cy + engine.symbolHeight / 2;

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = 'rgba(255, 110, 199, 0.35)';
  ctx.fillRect(cx + 2, cy + 2, engine.symbolWidth - 4, engine.symbolHeight - 4);

  ctx.globalAlpha = 1;
  ctx.font = `bold ${Math.floor(engine.symbolHeight * 0.5)}px Outfit, Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(45, 16, 48, 0.8)';
  ctx.strokeText(`${value}x`, centerX, centerY);
  ctx.fillStyle = 'rgba(255, 233, 74, 0.95)';
  ctx.fillText(`${value}x`, centerX, centerY);
  ctx.restore();
}

// A small solid chip in the cell's top-right corner - lower-key alternative to
// drawBackgroundBadge, doesn't wash over the symbol art at all.
function drawCornerBadge(engine, cx, cy, value) {
  const ctx = engine.ctx;
  const radius = engine.symbolWidth * 0.2;
  const bx = cx + engine.symbolWidth - radius - 3;
  const by = cy + radius + 3;

  ctx.save();
  ctx.beginPath();
  ctx.arc(bx, by, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe94a';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
  ctx.shadowBlur = 4;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#2d1030';
  ctx.stroke();

  ctx.fillStyle = '#2d1030';
  ctx.font = `bold ${Math.floor(radius * 1.05)}px Outfit, Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${value}x`, bx, by + 1);
  ctx.restore();
}

/**
 * Candy Frenzy's main free-spins mode: every tile a winning cluster occupies gets (or
 * doubles) a persistent multiplier - untouched tiles are 1x (never drawn), a tile's first win
 * sets it to 2x, and each subsequent win there doubles it again. A later cluster overlapping
 * one or more of these tiles has their values summed and applied to its own payout.
 * @param {Object} [options]
 * @param {'background'|'corner'} [options.badgeStyle='background'] - how a marked tile's
 *   multiplier is drawn (see drawBackgroundBadge/drawCornerBadge above).
 * @param {'front'|'behind'} [options.renderOrder='front'] - whether that badge draws before
 *   or after the tile's own symbol that frame (see renderOverlayOrder's doc up top). 'front'
 *   is the only choice that stays visible once a symbol has landed on the tile; 'behind' is
 *   still offered for a game/theme whose sprite art isn't fully opaque, or that just wants
 *   the badge to only show through on an as-yet-empty cell.
 */
export function createMultiplierTilesMode({ badgeStyle = 'background', renderOrder = 'front' } = {}) {
  const drawBadge = badgeStyle === 'corner' ? drawCornerBadge : drawBackgroundBadge;

  return {
    name: 'multiplierTiles',
    renderOverlayOrder: renderOrder,
    createState(engine) {
      return {
        grid: Array.from({ length: engine.config.reelsCount }, () => new Array(engine.config.rowsCount).fill(1)),
      };
    },
    wrapWinEvaluator(baseEvaluator, state) {
      // A scratch copy: resolveCascadeSequence resolves every cascade step of this spin
      // upfront, synchronously - this needs to see the tile grid evolve step-by-step exactly
      // as onClusterCleared will later replay it against the real, rendered state.grid, just
      // all at once here instead of animated.
      const scratch = state.grid.map(col => col.slice());

      return (grid) => {
        const results = baseEvaluator(grid);
        if (results.totalPayoutMultiplier <= 0) return results;

        let totalPayoutMultiplier = 0;
        const clusterWins = results.clusterWins.map(w => {
          // Sum only the tiles this cluster actually overlaps that already carry a
          // multiplier (>1x) - an untouched tile (1x, the "no marker" baseline) contributes
          // nothing, so a cluster entirely over plain tiles pays its normal amount.
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
    },
    onClusterCleared(cluster, state) {
      cluster.winningPositions.forEach(([col, row]) => {
        state.grid[col][row] = state.grid[col][row] <= 1 ? 2 : state.grid[col][row] * 2;
      });
    },
    renderOverlay(state, engine) {
      for (let col = 0; col < engine.config.reelsCount; col++) {
        for (let row = 0; row < engine.config.rowsCount; row++) {
          const value = state.grid[col][row];
          if (value <= 1) continue;
          const cx = engine.reelsX + col * engine.symbolWidth;
          const cy = engine.reelsY + row * engine.symbolHeight;
          drawBadge(engine, cx, cy, value);
        }
      }
    },
  };
}
