// Draw-call primitives extracted verbatim (parameters substituted for `this.xxx`, no logic
// changed) from SlotEngine.js's and CascadeEngine.js's render()-and-below - the shared drawing
// toolkit core/engine/CoreSlotEngine.js's animator components call into per frame. Holds no game
// state of its own. Reel-position math (SlotEngine.js's renderReelsSymbols) and the
// bookbookbook-only expanding-symbol overlay (renderExpandingAnimation) are deliberately not
// extracted here - see docs/superpowers/plans/2026-07-28-core-modularization.md, Tasks 11/16.
//
// Where SlotEngine.js and CascadeEngine.js drew the "same" concern differently - one hardcoded,
// the other theme-driven via config.playfield - the methods below take the union of both,
// defaulting to whichever hardcoded values SlotEngine.js used, so a line-pay game passing no
// theme renders exactly as it did before this extraction, and a cascade game passing its own
// theme renders exactly as CascadeEngine.js did.
import { drawSpriteSymbol } from './SpriteDrawer.js';

// How far outside the grid a payline's numbered tag sits - matches both engines' own
// LINE_TAG_OFFSET constant, so the line runs tag to tag either way.
const LINE_TAG_OFFSET = 15;

// One per payline, cycled if a game declares more - CascadeEngine.js's own LINE_COLORS, used by
// drawWinLine (a cascade game's payline win, e.g. Mayan Tumble). SlotEngine.js's own line-pay
// coloring (getNeonColorForLine) is a different, longer palette - kept separate below rather
// than unified, since changing either game's existing win-line colors is not this refactor's job.
const CASCADE_LINE_COLORS = [
  '#ff003c', '#00ff66', '#00d2ff', '#ffcc00', '#ff00ff',
  '#ff6600', '#00ffff', '#9933ff', '#d4af37', '#33ff33',
];

const DEFAULT_THEME = {
  backdropInner: '#1a1405',
  backdropOuter: '#07070b',
  outline: '#d4af37',
  outlineGlow: 10,
  frame: '#2d2510',
  gridLines: 'rgba(212, 175, 55, 0.3)',
  loadingBackground: '#0f0f13',
  loadingColor: '#d4af37',
  // SlotEngine.js's renderLoading hardcoded this text (a bookbookbook-specific string baked into
  // the shared engine) - kept as the default here so bookbookbook's appearance doesn't change
  // until it migrates and passes its own theme explicitly (see Task 16).
  loadingText: 'LOADING SACRED SCROLLS...',
};

export class SlotRenderer {
  drawLoading(ctx, canvasWidth, canvasHeight, theme = {}) {
    const t = { ...DEFAULT_THEME, ...theme };
    ctx.fillStyle = t.loadingBackground;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    ctx.fillStyle = t.loadingColor;
    ctx.font = 'bold 24px Outfit, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.shadowColor = t.loadingColor;
    ctx.shadowBlur = 15;
    ctx.fillText(t.loadingText, canvasWidth / (2 * (window.devicePixelRatio || 1)), canvasHeight / (2 * (window.devicePixelRatio || 1)));
    ctx.shadowBlur = 0;
  }

  drawCabinet(ctx, layout, theme = {}) {
    const t = { ...DEFAULT_THEME, ...theme };
    const { reelsX: rx, reelsY: ry, reelsWidth: rw, reelsHeight: rh } = layout;

    const gradient = ctx.createRadialGradient(
      rx + rw / 2, ry + rh / 2, rh * 0.2,
      rx + rw / 2, ry + rh / 2, rw * 0.7,
    );
    gradient.addColorStop(0, t.backdropInner);
    gradient.addColorStop(1, t.backdropOuter);

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, rx * 2 + rw, ry * 2 + rh);

    ctx.strokeStyle = t.outline;
    ctx.lineWidth = 4;
    ctx.shadowColor = t.outline;
    ctx.shadowBlur = t.outlineGlow;
    ctx.strokeRect(rx - 2, ry - 2, rw + 4, rh + 4);
    ctx.shadowBlur = 0;
  }

  drawReelsBackground(ctx, layout, reelsCount) {
    const { reelsX, reelsY, reelsWidth, reelsHeight, symbolWidth } = layout;
    ctx.fillStyle = 'rgba(10, 10, 15, 0.85)';
    ctx.fillRect(reelsX, reelsY, reelsWidth, reelsHeight);

    ctx.strokeStyle = 'rgba(212, 175, 55, 0.15)';
    ctx.lineWidth = 1;
    for (let c = 1; c < reelsCount; c++) {
      const cx = reelsX + (c * symbolWidth);
      ctx.beginPath();
      ctx.moveTo(cx, reelsY);
      ctx.lineTo(cx, reelsY + reelsHeight);
      ctx.stroke();
    }
  }

  drawSymbol(ctx, spritesheet, symbolsConfig, name, x, y, width, height, blurSpeed = 0) {
    drawSpriteSymbol(ctx, spritesheet, symbolsConfig[name], x, y, width, height, blurSpeed);
  }

  // Extracted from SlotEngine.js's renderReelsSymbols - draws each reel's rolling symbol window
  // (see ReelScrollAnimator, which owns the `reels` array's physics/state) at its current
  // scroll offset, with motion blur while spinning fast.
  drawReelsSymbols(ctx, spritesheet, symbolsConfig, layout, reelsCount, reels) {
    const { reelsX, reelsY, symbolWidth, symbolHeight } = layout;
    for (let col = 0; col < reelsCount; col++) {
      const reel = reels[col];
      const cx = reelsX + (col * symbolWidth);

      for (let s = 0; s < reel.symbols.length; s++) {
        const symbol = reel.symbols[s];
        const cy = reelsY + ((s - 1) * symbolHeight) + reel.offsetY;
        const isSpinningFast = reel.state === 'spinning' && reel.speed > 30;
        this.drawSymbol(ctx, spritesheet, symbolsConfig, symbol, cx, cy, symbolWidth, symbolHeight, isSpinningFast ? reel.speed : 0);
      }
    }
  }

  // NOTE on fidelity: SlotEngine.js's own renderGridBorders drew only horizontal row separators
  // here (lineWidth 2), with vertical column separators drawn earlier/underneath by a separate
  // step (drawReelsBackground, lineWidth 1, a dimmer color, always on). CascadeEngine.js's
  // _renderGridBorders instead drew both horizontal AND vertical lines here in one theme-gated
  // pass (lineWidth 1). This method draws both axes at lineWidth 2 when `gridLines` is set (the
  // union of both engines' capability), which is not a pixel-identical reproduction of either
  // engine's exact prior look - this line is genuinely unverified until a real game exercises it
  // (Task 14 for line-pay, Task 17/18 for cascade); revisit then if it looks wrong.
  drawGridBorders(ctx, layout, rowsCount, reelsCount, theme = {}) {
    const t = { ...DEFAULT_THEME, ...theme };
    const { reelsX: rx, reelsY: ry, reelsWidth: rw, reelsHeight: rh, symbolWidth, symbolHeight } = layout;

    ctx.strokeStyle = t.frame;
    ctx.lineWidth = 6;
    ctx.strokeRect(rx, ry, rw, rh);

    // A cluster game wants its cells ruled - a cluster IS a set of cells, and the grid is what
    // makes its shape legible. A themed line-pay game does not, and ruling it anyway makes the
    // playfield look like a spreadsheet with art in it. `gridLines: null` omits them entirely.
    if (!t.gridLines) return;
    ctx.strokeStyle = t.gridLines;
    ctx.lineWidth = 2;
    for (let c = 1; c < reelsCount; c++) {
      const cx = rx + c * symbolWidth;
      ctx.beginPath();
      ctx.moveTo(cx, ry);
      ctx.lineTo(cx, ry + rh);
      ctx.stroke();
    }
    for (let r = 1; r < rowsCount; r++) {
      const cy = ry + r * symbolHeight;
      ctx.beginPath();
      ctx.moveTo(rx, cy);
      ctx.lineTo(rx + rw, cy);
      ctx.stroke();
    }
  }

  // winState = { winData, expandingWinData, winCycleIndex, activeWinLineIndex } - SlotEngine.js's
  // line-pay win presentation (win lines + glowing highlight boxes), unchanged from renderWinEffects.
  drawWinEffects(ctx, state, winState, layout, paylines, reelsCount) {
    const { winData, expandingWinData, winCycleIndex, activeWinLineIndex } = winState;
    if (state !== 'showing_wins' || !winData) return;

    const totalWins = (expandingWinData ? expandingWinData.wins : winData.lineWins) || [];
    const hasScatter = winData.scatterWin && winData.scatterWin.payout > 0;
    const { reelsX, reelsY, reelsWidth, symbolWidth, symbolHeight } = layout;

    totalWins.forEach((win, idx) => {
      const isActive = (winCycleIndex === -1) || (idx === winCycleIndex && activeWinLineIndex === win.lineIndex);
      if (!isActive) return;

      const path = paylines[win.lineIndex];
      ctx.save();
      ctx.strokeStyle = this.getNeonColorForLine(win.lineIndex);
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 12;

      const lastReel = reelsCount - 1;
      const startY = reelsY + (path[0] * symbolHeight) + (symbolHeight / 2);
      const endY = reelsY + (path[lastReel] * symbolHeight) + (symbolHeight / 2);
      const leftTagX = reelsX - LINE_TAG_OFFSET;
      const rightTagX = reelsX + reelsWidth + LINE_TAG_OFFSET;

      ctx.beginPath();
      ctx.moveTo(leftTagX, startY);
      for (let col = 0; col < reelsCount; col++) {
        const row = path[col];
        const cx = reelsX + (col * symbolWidth) + (symbolWidth / 2);
        const cy = reelsY + (row * symbolHeight) + (symbolHeight / 2);
        ctx.lineTo(cx, cy);
      }
      ctx.lineTo(rightTagX, endY);
      ctx.stroke();

      this.drawTag(ctx, win.lineIndex + 1, leftTagX, startY, ctx.strokeStyle);
      this.drawTag(ctx, win.lineIndex + 1, rightTagX, endY, ctx.strokeStyle);

      ctx.restore();
    });

    let activeWinsToHighlight = [];
    if (winCycleIndex === -1) {
      totalWins.forEach(w => activeWinsToHighlight.push(...w.winningPositions));
      if (hasScatter) {
        activeWinsToHighlight.push(...winData.scatterWin.winningPositions);
      }
    } else {
      if (winCycleIndex < totalWins.length) {
        activeWinsToHighlight.push(...totalWins[winCycleIndex].winningPositions);
      } else if (hasScatter) {
        activeWinsToHighlight.push(...winData.scatterWin.winningPositions);
      }
    }

    const uniquePositions = [];
    activeWinsToHighlight.forEach(pos => {
      if (!uniquePositions.some(p => p[0] === pos[0] && p[1] === pos[1])) {
        uniquePositions.push(pos);
      }
    });

    uniquePositions.forEach(([col, row]) => {
      const cx = reelsX + (col * symbolWidth);
      const cy = reelsY + (row * symbolHeight);

      ctx.save();
      ctx.strokeStyle = '#d4af37';
      ctx.lineWidth = 3;

      const pulse = 5 + Math.sin(Date.now() / 100) * 4;
      ctx.shadowColor = '#d4af37';
      ctx.shadowBlur = pulse;

      ctx.fillStyle = 'rgba(212, 175, 55, 0.15)';
      ctx.fillRect(cx + 4, cy + 4, symbolWidth - 8, symbolHeight - 8);
      ctx.strokeRect(cx + 4, cy + 4, symbolWidth - 8, symbolHeight - 8);

      ctx.restore();
    });
  }

  drawTag(ctx, num, x, y, color) {
    ctx.save();
    ctx.fillStyle = '#0f0f13';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Outfit, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(num, x, y);
    ctx.restore();
  }

  getNeonColorForLine(lineIdx) {
    const colors = [
      '#ff003c', '#00ff66', '#00d2ff', '#ffcc00', '#ff00ff',
      '#ff6600', '#00ffff', '#9933ff', '#d4af37', '#33ff33',
    ];
    return colors[lineIdx % colors.length];
  }

  // --- Cascade-specific (extracted from CascadeEngine.js) ---

  // A fixed grain across the playfield, drawn behind the symbols. Generated once into an
  // offscreen canvas and cached by the caller (see CascadeDropAnimator, which owns the
  // this._noiseCanvas-equivalent cache - this method is pure, given a theme and a size).
  buildPlayfieldNoise(width, height, noiseConfig) {
    if (!noiseConfig) return null;
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));

    const scale = noiseConfig.scale ?? 3;
    const cols = Math.ceil(w / scale), rows = Math.ceil(h / scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const noiseCtx = canvas.getContext('2d');

    let seed = noiseConfig.seed ?? 1337;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

    const [r, g, b] = noiseConfig.color ?? [255, 255, 255];
    const strength = noiseConfig.strength ?? 0.05;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const t = rand() ** 2;
        noiseCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(t * strength).toFixed(4)})`;
        noiseCtx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
    return canvas;
  }

  drawPlayfieldNoise(ctx, noiseCanvas, layout) {
    if (!noiseCanvas) return;
    ctx.drawImage(noiseCanvas, layout.reelsX, layout.reelsY);
  }

  // Draws the live grid plus any cell mid-clear-vanish (clearInfo) or mid-landing-bounce
  // (isBouncing) - extracted from CascadeEngine.js's _renderGridSymbols/_applyLandingBounce/
  // _renderClearGlow/_applyClearTransform. `gridState` bundles the per-cell animation info the
  // original methods read off `this`: { grid, cellOffsets, currentClearVariants (Map keyed
  // "col,row"), cellBounceStartTime, clearProgress (0..1 or null), bounceDuration, now }.
  drawGridSymbols(ctx, spritesheet, symbolsConfig, layout, reelsCount, rowsCount, gridState) {
    const { grid, cellOffsets, currentClearVariants, cellBounceStartTime, clearProgress, bounceDuration, now } = gridState;
    const { reelsX, reelsY, symbolWidth, symbolHeight } = layout;

    for (let col = 0; col < reelsCount; col++) {
      for (let row = 0; row < rowsCount; row++) {
        const symbol = grid[col][row];
        if (!symbol) continue;

        const offsetRows = cellOffsets[col][row] || 0;
        const cx = reelsX + col * symbolWidth;
        const cy = reelsY + (row - offsetRows) * symbolHeight;
        const tile = symbolsConfig[symbol];

        const clearInfo = clearProgress != null ? currentClearVariants.get(`${col},${row}`) : null;
        const bounceElapsed = now - cellBounceStartTime[col][row];
        const isBouncing = !clearInfo && offsetRows === 0 && bounceElapsed >= 0 && bounceElapsed < bounceDuration;

        if (clearInfo) this._drawClearGlow(ctx, cx, cy, layout, clearProgress);

        ctx.save();
        if (clearInfo) {
          this._applyClearTransform(ctx, clearInfo, clearProgress, cx, cy, layout);
        } else if (isBouncing) {
          this._applyLandingBounce(ctx, bounceElapsed / bounceDuration, cx, cy, layout);
        }
        drawSpriteSymbol(ctx, spritesheet, tile, cx, cy, symbolWidth, symbolHeight, 0);
        ctx.restore();
      }
    }
  }

  _applyLandingBounce(ctx, progress, cx, cy, layout) {
    const decay = Math.exp(-progress * 6);
    const wobble = Math.sin(progress * Math.PI * 3) * decay;
    const squashX = 1 + wobble * 0.15;
    const squashY = 1 - wobble * 0.25;
    const centerX = cx + layout.symbolWidth / 2;
    const bottomY = cy + layout.symbolHeight;
    ctx.translate(centerX, bottomY);
    ctx.scale(squashX, squashY);
    ctx.translate(-centerX, -bottomY);
  }

  _drawClearGlow(ctx, cx, cy, layout, progress) {
    const pulseIn = Math.sin(Math.min(progress * 3, 1) * (Math.PI / 2));
    const alpha = pulseIn * (1 - progress * 0.6);
    if (alpha <= 0) return;

    const inset = 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#ffe94a';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#ffe94a';
    ctx.shadowBlur = 14;
    ctx.strokeRect(cx + inset, cy + inset, layout.symbolWidth - inset * 2, layout.symbolHeight - inset * 2);
    ctx.restore();
  }

  _applyClearTransform(ctx, clearInfo, progress, cx, cy, layout) {
    const centerX = cx + layout.symbolWidth / 2;
    const centerY = cy + layout.symbolHeight / 2;
    ctx.globalAlpha = Math.max(0, 1 - progress);
    ctx.translate(centerX, centerY);

    switch (clearInfo.variant) {
      case 'stretch': {
        ctx.scale(1 - progress * 0.5, 1 + progress * 0.9);
        break;
      }
      case 'jump': {
        const hop = -Math.sin(Math.min(progress, 1) * Math.PI) * layout.symbolHeight * 0.6;
        ctx.translate(0, hop);
        const scale = 1 - progress * 0.3;
        ctx.scale(scale, scale);
        break;
      }
      case 'spin': {
        ctx.rotate(progress * Math.PI * 2 * clearInfo.spinDirection);
        const scale = 1 - progress * 0.5;
        ctx.scale(scale, scale);
        break;
      }
      case 'scaleFade':
      default: {
        const scale = 1 + progress * 0.4;
        ctx.scale(scale, scale);
        break;
      }
    }

    ctx.translate(-centerX, -centerY);
  }

  // The previous spin's leftover grid, falling out the bottom one reel at a time. Positive
  // offsets move a symbol DOWN from its original row (opposite sign convention from
  // drawGridSymbols' cellOffsets, which move a symbol up into place).
  drawOutgoingGridSymbols(ctx, spritesheet, symbolsConfig, layout, reelsCount, rowsCount, outgoingGrid, outgoingOffsets) {
    if (!outgoingGrid) return;
    const { reelsX, reelsY, symbolWidth, symbolHeight } = layout;
    for (let col = 0; col < reelsCount; col++) {
      for (let row = 0; row < rowsCount; row++) {
        const symbol = outgoingGrid[col][row];
        if (!symbol) continue;
        const offsetRows = outgoingOffsets[col][row] || 0;
        if (offsetRows >= rowsCount) continue;
        const cx = reelsX + col * symbolWidth;
        const cy = reelsY + (row + offsetRows) * symbolHeight;
        const tile = symbolsConfig[symbol];
        drawSpriteSymbol(ctx, spritesheet, tile, cx, cy, symbolWidth, symbolHeight, 0);
      }
    }
  }

  // A cascade win's payline path (line-pay-over-cascade games, e.g. Mayan Tumble) - a no-op for
  // any win with no lineIndex (a cluster win), so a cluster game (Candy Frenzy) never draws this.
  drawWinLine(ctx, engineState, layout, paylines, reelsCount) {
    const { state, currentClusterWins, currentClusterIndex } = engineState;
    if (state !== 'clearing' || !paylines) return;
    const win = currentClusterWins?.[currentClusterIndex];
    if (!win || win.lineIndex == null) return;
    const path = paylines[win.lineIndex];
    if (!path) return;

    const { reelsX, reelsY, reelsWidth, symbolWidth, symbolHeight } = layout;
    const color = CASCADE_LINE_COLORS[win.lineIndex % CASCADE_LINE_COLORS.length];
    const lastReel = reelsCount - 1;
    const centerOf = (col) => ({
      x: reelsX + (col + 0.5) * symbolWidth,
      y: reelsY + (path[col] + 0.5) * symbolHeight,
    });
    const leftTagX = reelsX - LINE_TAG_OFFSET;
    const rightTagX = reelsX + reelsWidth + LINE_TAG_OFFSET;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(leftTagX, centerOf(0).y);
    for (let col = 0; col < reelsCount; col++) {
      const { x, y } = centerOf(col);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(rightTagX, centerOf(lastReel).y);
    ctx.stroke();
    ctx.restore();

    const label = win.lineIndex + 1;
    this.drawLineTag(ctx, label, leftTagX, centerOf(0).y, color);
    this.drawLineTag(ctx, label, rightTagX, centerOf(lastReel).y, color);
  }

  drawLineTag(ctx, num, x, y, color) {
    this.drawTag(ctx, num, x, y, color);
  }

  // Floating "+$X.XX" / "Nx symbol" text centered over each cluster's centroid.
  drawClusterWinPopups(ctx, popups, symbolHeight, now = Date.now()) {
    popups.forEach(p => {
      const progress = Math.min((now - p.startTime) / p.duration, 1);
      const rise = symbolHeight * 0.9 * progress;
      const y = p.y - rise;
      const scale = progress < 0.15 ? 0.5 + (0.5 * (progress / 0.15)) : 1;
      const alpha = progress < 0.6 ? 1 : Math.max(0, 1 - (progress - 0.6) / 0.4);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, y);
      ctx.scale(scale, scale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';

      ctx.font = "bold 20px Outfit, sans-serif";
      const amountText = `+$${p.amount.toFixed(2)}`;
      ctx.strokeText(amountText, 0, -8);
      ctx.fillStyle = '#ffe94a';
      ctx.fillText(amountText, 0, -8);

      ctx.font = "600 12px Outfit, sans-serif";
      const detailText = `${p.count}x ${p.symbol}`;
      ctx.strokeText(detailText, 0, 12);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(detailText, 0, 12);

      ctx.restore();
    });
  }

  // --- Top-level per-frame orchestration ---
  //
  // Called every frame by CoreSlotEngine.animate() (continuous, regardless of spin state - see
  // its own doc). Mirrors SlotEngine.js's render() call sequence for a line-pay engine
  // (engine.mechanic.name === 'line'); a cascade engine's own sequence
  // (engine.mechanic.name === 'cascade') is added once CascadeDropAnimator's extraction lands
  // (Task 17) - until then this method only knows how to draw a line-pay engine, which is all
  // that's wired up through Task 14.
  draw(engine, ctx) {
    ctx.clearRect(0, 0, engine.canvas.width, engine.canvas.height);

    const theme = engine.config.playfield || {};

    if (!engine.assetsLoaded) {
      this.drawLoading(ctx, engine.canvas.width, engine.canvas.height, theme);
      return;
    }

    const layout = engine.layout;
    this.drawCabinet(ctx, layout, theme);

    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.reelsX, layout.reelsY, layout.reelsWidth, layout.reelsHeight);
    ctx.clip();

    this.drawReelsBackground(ctx, layout, engine.config.reelsCount);
    if (engine.animator?.reels) {
      this.drawReelsSymbols(ctx, engine.spritesheet, engine.symbolsConfig, layout, engine.config.reelsCount, engine.animator.reels);
    }

    ctx.restore();

    this.drawGridBorders(ctx, layout, engine.config.rowsCount, engine.config.reelsCount, theme);
    this.drawWinEffects(
      ctx, engine.state,
      { winData: engine.winData, expandingWinData: engine.expandingWinData, winCycleIndex: engine.winCycleIndex, activeWinLineIndex: engine.activeWinLineIndex },
      layout, engine.config.paylines, engine.config.reelsCount,
    );
    engine.particleSystem?.render(ctx);
  }
}
