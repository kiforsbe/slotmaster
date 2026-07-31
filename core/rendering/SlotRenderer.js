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
import { SpriteAnimation } from '../assets/AssetLoader.js';
import { resolveAnimatedValue } from '../animation/AnimatedValue.js';
import { ClusterOutlineRenderer } from './ClusterOutlineRenderer.js';

// How far outside the grid a payline's numbered tag sits - matches both engines' own
// LINE_TAG_OFFSET constant, so the line runs tag to tag either way.
const LINE_TAG_OFFSET = 15;

// A cluster win popup stays fully opaque for this fraction of its post-breakdown segment (the
// portion after any "$base x{multiplier}" hold - see CascadeDropAnimator's breakdownHoldMs),
// then fades linearly over the remaining (1 - this) fraction. A plain popup with no breakdown
// at all has its whole duration as that "post-breakdown segment", so this is the only fade rule
// there is - not a breakdown-specific quirk.
const POPUP_FADE_START_FRACTION = 0.6;

const DEFAULT_THEME = {
  backdropInner: '#1a1405',
  backdropOuter: '#07070b',
  outline: '#d4af37',
  outlineGlow: 10,
  outlineWidth: 4,
  outlineGlowIntensity: 1,
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
  constructor({ clusterOutlineRenderer = new ClusterOutlineRenderer() } = {}) {
    this.clusterOutlineRenderer = clusterOutlineRenderer;
  }

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

  // `skipBackdropFill`: the radial-gradient wash below and drawViewportBackground (see its own
  // doc) both fill the same area behind the reels - when a game configures a real
  // viewportBackground, that wash would just opaquely paint over it every frame.
  // The outline/glow itself is NOT drawn here - see drawCabinetGlow below for why it has to be
  // drawn later, after drawGridBorders.
  drawCabinet(ctx, layout, theme = {}, { skipBackdropFill = false } = {}) {
    if (skipBackdropFill) return;
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
  }

  // The reels' own glow border. By default drawn LAST (see _drawLine's/_drawCascade's own
  // callers), after drawGridBorders' `frame` stroke and grid lines, not alongside drawCabinet's
  // backdrop fill above - drawGridBorders' frame stroke sits at almost the exact same radius as
  // this one (rx,ry,rw,rh vs this method's own inset rect, only a couple px apart), so drawing
  // the glow first let the later, wider `frame` stroke paint straight over it, silently erasing
  // it every frame. It only went unnoticed because the old backdrop wash was dark enough that a
  // missing glow line didn't stand out - a bright/busy viewportBackground made it obvious.
  // `theme.outlineBehindSymbols` (default false/in-front) flips this: true calls this right after
  // drawCabinet instead, before the reels are drawn at all, so the glow sits under the grid/
  // symbols rather than over them - a game whose grid isn't fully opaque up to its own edge (or
  // that just wants the glow to read as ambient light behind the reels rather than a frame in
  // front of them) can pick that look instead.
  drawCabinetGlow(ctx, layout, theme = {}) {
    const t = { ...DEFAULT_THEME, ...theme };
    const { reelsX: rx, reelsY: ry, reelsWidth: rw, reelsHeight: rh } = layout;

    // ctx.shadowBlur on a thin stroke has very little rendered "ink" to diffuse - even a large
    // blur radius stays faint, so the crisp strokes underneath visually dominate and it reads as
    // a hard line, not a glow. ctx.filter's actual gaussian blur operates on the rendered pixels
    // themselves instead, which produces a real soft spread. Each layer below is drawn at
    // increasing physical thickness (more source "ink") and increasing blur (more spread),
    // building up a true falloff the way a neon sign's glow actually looks; the final pass has no
    // filter at all, so the core line stays crisp.
    // Inset scales with outlineWidth (half of it, same as the old fixed "2" was half of the old
    // fixed lineWidth 4) so the stroke stays centered on the reels' own edge at any width instead
    // of drifting inward/outward as outlineWidth changes.
    const inset = t.outlineWidth / 2;
    const glowRect = [rx - inset, ry - inset, rw + inset * 2, rh + inset * 2];

    ctx.save();
    // The blur layers' visual spread reaches well past outlineWidth/outlineGlow's own numbers
    // (a gaussian blur's footprint is several times its blur radius) - without this, that inward
    // bleed covers the outermost ring of symbols, in front-of-grid mode as much as behind-it
    // mode (drawn behind still bleeds over the grid's own margin before the animator's symbols
    // paint over it, which does nothing for the reels' own inner cells). Punching the reels' own
    // rect out of the clip (evenodd: outer canvas rect + inner reels rect) means the glow can only
    // ever be visible in the margin OUTSIDE the reels - however wide the blur gets, it's masked
    // the instant it would cross into grid territory.
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.rect(rx, ry, rw, rh);
    ctx.clip('evenodd');

    ctx.strokeStyle = t.outline;
    // outlineGlowIntensity independently scales how OPAQUE/saturated the glow reads, separate
    // from outlineGlow (spread) and outlineWidth (thickness) - a busy or similarly-hued backdrop
    // (a pink outline over a pink-toned viewportBackground image, say) needs more of THIS to
    // still read as a glow at all, not more blur or width. A single pass's opacity caps at 1
    // (globalAlpha can't exceed that), so >1 repeats each layer's full-alpha pass that many times
    // instead - normal alpha-over compositing stacks each repeat on the last, building up
    // brightness a single pass structurally cannot reach. <1 just fades the one pass, same as
    // before.
    const passes = Math.max(1, Math.ceil(t.outlineGlowIntensity));
    const perPassScale = t.outlineGlowIntensity / passes;
    [
      { blurPx: t.outlineGlow * 2, width: t.outlineWidth * 5, alpha: 0.5 },
      { blurPx: t.outlineGlow * 1.2, width: t.outlineWidth * 3, alpha: 0.75 },
      { blurPx: t.outlineGlow * 0.5, width: t.outlineWidth * 1.75, alpha: 1 },
    ].forEach(layer => {
      ctx.filter = `blur(${layer.blurPx}px)`;
      ctx.lineWidth = layer.width;
      for (let i = 0; i < passes; i++) {
        ctx.globalAlpha = Math.min(1, layer.alpha * perPassScale);
        ctx.strokeRect(...glowRect);
      }
    });
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.lineWidth = t.outlineWidth;
    ctx.strokeRect(...glowRect);
    ctx.restore();
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

  drawSymbol(ctx, asset, symbolsConfig, name, x, y, width, height, blurSpeed = 0) {
    drawSpriteSymbol(ctx, asset, symbolsConfig[name], x, y, width, height, blurSpeed);
  }

  // Book-of-Dead-style expanding-wild reveal overlay - extracted from SlotEngine.js's
  // renderExpandingAnimation. Reel columns expand one at a time (reelExpandDuration ms each,
  // staggered per ReelScrollAnimator.playExpandingReveal's own start-time schedule); each
  // column grows outward from its center row while fading in a neon aura, then draws the
  // expanding symbol scaled up across all three rows once far enough along.
  drawExpandingAnimation(ctx, layout, asset, symbolsConfig, expandingSymbol, expansionReelsToAnimate, expansionReelStartTimes) {
    const tile = symbolsConfig[expandingSymbol];
    if (!tile) return;

    const { reelsX, reelsY, symbolWidth, symbolHeight } = layout;
    const reelExpandDuration = 900;

    expansionReelsToAnimate.forEach((colIdx, i) => {
      const cx = reelsX + (colIdx * symbolWidth);
      const reelStartTime = expansionReelStartTimes[i];
      const elapsed = Date.now() - reelStartTime;
      const reelProgress = Math.min(elapsed / reelExpandDuration, 1);

      if (reelProgress <= 0) return;

      const centerRowY = reelsY + (1 * symbolHeight);

      ctx.save();
      ctx.globalAlpha = reelProgress * 0.9;

      const fullH = symbolHeight * 3;
      const animH = fullH * reelProgress;
      const animY = centerRowY + (symbolHeight / 2) - (animH / 2);

      ctx.fillStyle = 'rgba(212, 175, 55, 0.2)';
      ctx.fillRect(cx, animY, symbolWidth, animH);

      ctx.shadowColor = '#d4af37';
      ctx.shadowBlur = 20;
      ctx.strokeStyle = '#d4af37';
      ctx.lineWidth = 3;
      ctx.strokeRect(cx + 2, animY, symbolWidth - 4, animH);
      ctx.shadowBlur = 0;

      for (let r = 0; r < 3; r++) {
        const finalY = reelsY + (r * symbolHeight);

        if (finalY + (symbolHeight / 2) >= animY && finalY + (symbolHeight / 2) <= animY + animH) {
          const scale = 0.5 + (0.5 * reelProgress);

          ctx.save();
          ctx.translate(cx + symbolWidth / 2, finalY + symbolHeight / 2);
          ctx.scale(scale, scale);

          ctx.drawImage(
            asset.image || asset,
            tile.x, tile.y, tile.w, tile.h,
            -symbolWidth / 2, -symbolHeight / 2,
            symbolWidth, symbolHeight,
          );

          ctx.restore();
        }
      }

      ctx.restore();
    });
  }

  // Extracted from SlotEngine.js's renderReelsSymbols - draws each reel's rolling symbol window
  // (see ReelScrollAnimator, which owns the `reels` array's physics/state) at its current
  // scroll offset, with motion blur while spinning fast.
  drawReelsSymbols(ctx, asset, symbolsConfig, layout, reelsCount, reels) {
    const { reelsX, reelsY, symbolWidth, symbolHeight } = layout;
    for (let col = 0; col < reelsCount; col++) {
      const reel = reels[col];
      const cx = reelsX + (col * symbolWidth);

      for (let s = 0; s < reel.symbols.length; s++) {
        const symbol = reel.symbols[s];
        const cy = reelsY + ((s - 1) * symbolHeight) + reel.offsetY;
        const isSpinningFast = reel.state === 'spinning' && reel.speed > 30;
        this.drawSymbol(ctx, asset, symbolsConfig, symbol, cx, cy, symbolWidth, symbolHeight, isSpinningFast ? reel.speed : 0);
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

  // Full-viewport background: same descriptor shape as drawPlayfieldBackground below (color/
  // noise/image), but covering the whole canvas rather than just the reels rect - drawn first,
  // so drawCabinet/drawReelsBackground/everything else layers on top of it same as before.
  // Two ways to give the viewport a background, picked per game by whichever's more convenient:
  //   - `{ type: 'color' | 'noise' | 'image', ... }` paints it directly into the canvas here.
  //   - omit config.viewportBackground entirely (or pass `{ type: 'css' }`) and this draws
  //     nothing - the canvas is already cleared to transparent this frame (see _drawLine's/
  //     _drawCascade's own ctx.clearRect call above), so a CSS `background` set on `.game-viewport`
  //     (which GridLayout now sizes the canvas to fill exactly - see its own doc) shows through
  //     pixel-for-pixel instead.
  drawViewportBackground(ctx, canvasWidth, canvasHeight, background) {
    if (!background || background.type === 'css' || background.type === 'transparent') return;
    if (background.type === 'color') {
      ctx.fillStyle = background.color;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    } else if (background.type === 'noise') {
      if (!this._viewportNoiseCanvas || this._viewportNoiseCanvasW !== canvasWidth || this._viewportNoiseCanvasH !== canvasHeight) {
        this._viewportNoiseCanvas = this.buildPlayfieldNoise(canvasWidth, canvasHeight, background);
        this._viewportNoiseCanvasW = canvasWidth;
        this._viewportNoiseCanvasH = canvasHeight;
      }
      if (this._viewportNoiseCanvas) ctx.drawImage(this._viewportNoiseCanvas, 0, 0);
    } else if (background.type === 'image') {
      if (!this._viewportBackgroundImage || this._viewportBackgroundImageSrc !== background.image) {
        this._viewportBackgroundImage = new Image();
        this._viewportBackgroundImage.src = background.image;
        this._viewportBackgroundImageSrc = background.image;
      }
      const img = this._viewportBackgroundImage;
      // "Cover" fit, not stretch: scale uniformly so the image's own aspect ratio is preserved
      // and it fills canvasWidth x canvasHeight completely, cropping whatever overflows on the
      // shorter axis instead of distorting a photographic background to the canvas's own shape.
      if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
        const scale = Math.max(canvasWidth / img.naturalWidth, canvasHeight / img.naturalHeight);
        const drawWidth = img.naturalWidth * scale;
        const drawHeight = img.naturalHeight * scale;
        ctx.drawImage(img, (canvasWidth - drawWidth) / 2, (canvasHeight - drawHeight) / 2, drawWidth, drawHeight);
      }
    }
  }

  // Playfield background: a flat/alpha color ('color' type - e.g. a translucent hex8 or rgba()
  // wash, drawn UNDER drawReelsBackground's own fixed rgba(10,10,15,0.85) tint and everything
  // else within the same reels-rect clip, so it blends with - and is deliberately never fully
  // hidden by - whatever's beneath it (drawCabinet's backdrop, or drawViewportBackground when a
  // game sets one), a generated noise texture ('noise' type - buildPlayfieldNoise/
  // drawPlayfieldNoise above, cached per size), or a static image ('image' type, cached per src),
  // all stretched to fill just the reels area (not the full canvas - see drawViewportBackground
  // above for that). Read from the single top-level `config.playfieldBackground` - see
  // Read from `config.playfield.background` - see _drawLine's/_drawCascade's own callers - the
  // same key for both a line-pay and a cascade game.
  // Ported from CascadeEngine.js's/SlotEngine.js's own _renderPlayfieldBackground()/
  // renderPlayfieldBackground() - added to both engines after this refactor's worktree branched,
  // so this is a forward-port, not an extraction.
  drawPlayfieldBackground(ctx, layout, background) {
    if (!background) return;
    if (background.type === 'color') {
      ctx.fillStyle = background.color;
      ctx.fillRect(layout.reelsX, layout.reelsY, layout.reelsWidth, layout.reelsHeight);
    } else if (background.type === 'noise') {
      if (!this._noiseCanvas || this._noiseCanvasW !== layout.reelsWidth || this._noiseCanvasH !== layout.reelsHeight) {
        this._noiseCanvas = this.buildPlayfieldNoise(layout.reelsWidth, layout.reelsHeight, background);
        this._noiseCanvasW = layout.reelsWidth;
        this._noiseCanvasH = layout.reelsHeight;
      }
      this.drawPlayfieldNoise(ctx, this._noiseCanvas, layout);
    } else if (background.type === 'image') {
      if (!this._backgroundImage || this._backgroundImageSrc !== background.image) {
        this._backgroundImage = new Image();
        this._backgroundImage.src = background.image;
        this._backgroundImageSrc = background.image;
      }
      if (this._backgroundImage) ctx.drawImage(this._backgroundImage, layout.reelsX, layout.reelsY, layout.reelsWidth, layout.reelsHeight);
    }
  }

  // Draws the live grid plus any cell mid-clear-vanish (clearInfo) or mid-landing-bounce
  // (isBouncing) - extracted from CascadeEngine.js's _renderGridSymbols/_applyLandingBounce/
  // _renderClearGlow/_applyClearTransform. `gridState` bundles the per-cell animation info the
  // original methods read off `this`: { grid, cellOffsets, currentClearVariants (Map keyed
  // "col,row"), cellBounceStartTime, clearProgress (0..1 or null), bounceDuration, now }.
  // `clearCellHighlight` preserves the original per-tile gold glow by default, but lets a
  // cluster visualizer replace that busy cell-by-cell treatment with one clean silhouette.
  drawGridSymbols(ctx, asset, symbolsConfig, layout, reelsCount, rowsCount, gridState) {
    const { grid, cellOffsets, currentClearVariants, cellBounceStartTime, clearProgress, bounceDuration, now, clearEffect, clearCellHighlight = true } = gridState;
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

        if (clearInfo && clearCellHighlight) this._drawClearGlow(ctx, cx, cy, layout, clearProgress);

        ctx.save();
        if (clearInfo) {
          this._applyClearTransform(ctx, clearInfo, clearProgress, cx, cy, layout, clearEffect);
        } else if (isBouncing) {
          this._applyLandingBounce(ctx, bounceElapsed / bounceDuration, cx, cy, layout);
        }
        drawSpriteSymbol(ctx, asset, tile, cx, cy, symbolWidth, symbolHeight, 0);
        ctx.restore();

        if (clearInfo && clearEffect?.spriteAsset?.image && clearEffect.animation) {
          this._drawClearSpriteEffect(ctx, clearEffect, cx, cy, layout, clearProgress);
        }
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

  _applyClearTransform(ctx, clearInfo, progress, cx, cy, layout, clearEffect = null) {
    const centerX = cx + layout.symbolWidth / 2;
    const centerY = cy + layout.symbolHeight / 2;
    const shrinkFade = clearEffect?.shrinkFade;
    ctx.globalAlpha = shrinkFade ? Math.pow(Math.max(0, 1 - progress), shrinkFade.fadePower ?? 1.5) : Math.max(0, 1 - progress);
    ctx.translate(centerX, centerY);

    if (shrinkFade) {
      const scale = Math.max(shrinkFade.minimumScale ?? 0, 1 - progress * (1 - (shrinkFade.minimumScale ?? 0)));
      ctx.scale(scale, scale);
      ctx.translate(-centerX, -centerY);
      return;
    }

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

  _drawClearSpriteEffect(ctx, clearEffect, cx, cy, layout, progress) {
    const descriptor = typeof clearEffect.animation === 'string'
      ? clearEffect.spriteAsset.animations?.[clearEffect.animation]
      : clearEffect.animation;
    if (!descriptor) return;
    const animation = descriptor instanceof SpriteAnimation
      ? descriptor.play(clearEffect.startTime)
      : new SpriteAnimation(descriptor).play(clearEffect.startTime);
    const effectProgress = Math.min(1, progress * (clearEffect.progressMultiplier ?? 1.35));
    const scale = (clearEffect.startScale ?? 0.55)
      + ((clearEffect.endScale ?? 1.25) - (clearEffect.startScale ?? 0.55)) * effectProgress;
    const width = layout.symbolWidth * scale;
    const height = layout.symbolHeight * scale;
    const alpha = Math.min(1, progress * (clearEffect.fadeInMultiplier ?? 8))
      * Math.max(0, 1 - progress * (clearEffect.fadeOutMultiplier ?? 0.25));

    ctx.save();
    ctx.globalAlpha = alpha;
    drawSpriteSymbol(
      ctx,
      clearEffect.spriteAsset,
      animation,
      cx + (layout.symbolWidth - width) / 2,
      cy + (layout.symbolHeight - height) / 2,
      width,
      height,
    );
    ctx.restore();
  }

  // The previous spin's leftover grid, falling out the bottom one reel at a time. Positive
  // offsets move a symbol DOWN from its original row (opposite sign convention from
  // drawGridSymbols' cellOffsets, which move a symbol up into place).
  drawOutgoingGridSymbols(ctx, asset, symbolsConfig, layout, reelsCount, rowsCount, outgoingGrid, outgoingOffsets) {
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
        drawSpriteSymbol(ctx, asset, tile, cx, cy, symbolWidth, symbolHeight, 0);
      }
    }
  }

  // The amount line's text at a given moment - a plain "+$total" for an ordinary cluster win
  // (p.breakdownHoldMs is 0 - no tileMultiplier at all, e.g. base game, or the config turned
  // the breakdown off), or - when a free-spins mode enriched this win with
  // baseAmount/tileMultiplier (see CascadeDropAnimator._spawnClusterWinPopups) - a 2-stage
  // reveal making the base_symbol_value x total_multiplier math legible instead of jumping
  // straight to the final number: "$base x{multiplier}" held for the full breakdownHoldMs,
  // then poofs to "+$total".
  _clusterAmountText(p, elapsedMs) {
    if (elapsedMs < p.breakdownHoldMs) {
      return `$${p.baseAmount.toFixed(2)} X${p.tileMultiplier}`;
    }
    return `$${p.amount.toFixed(2)}`;
  }

  // Floating "+$X.XX" / "Nx symbol" text centered over each cluster's centroid. Every animatable
  // property (font sizes, rise) comes from p.popupConfig - a { default, animation } descriptor
  // per property, resolved fresh each frame via resolveAnimatedValue (see
  // core/animation/AnimatedValue.js) - rather than bespoke tween math per property here.
  drawClusterWinPopups(ctx, popups, symbolHeight, now = Date.now()) {
    popups.forEach(p => {
      const cfg = p.popupConfig;
      const elapsedMs = now - p.startTime;
      // Fade only applies to the post-breakdown segment (see POPUP_FADE_START_FRACTION's doc) -
      // a popup with no breakdown at all (breakdownHoldMs 0) just fades over its whole duration,
      // same as always.
      const breakdownHoldMs = p.breakdownHoldMs ?? 0;
      const postBreakdownElapsed = Math.max(0, elapsedMs - breakdownHoldMs);
      const postBreakdownDuration = p.duration - breakdownHoldMs;
      const postBreakdownProgress = Math.min(postBreakdownElapsed / postBreakdownDuration, 1);
      const alpha = postBreakdownProgress < POPUP_FADE_START_FRACTION
        ? 1
        : Math.max(0, 1 - (postBreakdownProgress - POPUP_FADE_START_FRACTION) / (1 - POPUP_FADE_START_FRACTION));

      // position's `to` is a multiplier of symbolHeight, not an absolute px rise, so it scales
      // sanely across games with different cell sizes; its duration falls back to this popup's
      // own on-screen duration (turbo-dependent) when the config doesn't set one explicitly.
      const riseMultiplier = resolveAnimatedValue(cfg.position, elapsedMs, p.duration);
      const y = p.y - riseMultiplier * symbolHeight;
      // Uniform scale on top of whatever fontSize each line resolves to below - independent of
      // (and composable with) per-line fontSize animation, see DEFAULT_POPUP_CONFIG.scale's doc.
      const scale = resolveAnimatedValue(cfg.scale, elapsedMs, p.duration);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, y);
      ctx.scale(scale, scale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#000000';

      // Split above/below (-8/+12) when both lines show; a lone line centers on 0 instead of
      // sitting offset toward the other (now-empty) line's spot.
      const amountY = cfg.detail.show ? -8 : 0;
      const detailY = cfg.amount.show ? 12 : 0;

      if (cfg.amount.show) {
        const amountFontSize = resolveAnimatedValue(cfg.amount.fontSize, elapsedMs, p.duration);
        ctx.font = `bold ${amountFontSize}px Outfit, sans-serif`;
        const amountText = this._clusterAmountText(p, elapsedMs);
        ctx.strokeText(amountText, 0, amountY);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(amountText, 0, amountY);
      }

      if (cfg.detail.show) {
        const detailFontSize = resolveAnimatedValue(cfg.detail.fontSize, elapsedMs, p.duration);
        ctx.font = `600 ${detailFontSize}px Outfit, sans-serif`;
        const detailText = `${p.count}x ${p.symbol}`;
        ctx.strokeText(detailText, 0, detailY);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(detailText, 0, detailY);
      }

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
    if (engine.mechanic?.name === 'cascade') {
      this._drawCascade(engine, ctx);
    } else {
      this._drawLine(engine, ctx);
    }
  }

  _drawLine(engine, ctx) {
    ctx.clearRect(0, 0, engine.canvas.width, engine.canvas.height);
    this.drawViewportBackground(ctx, engine.canvas.width, engine.canvas.height, engine.config.viewportBackground);

    const theme = engine.config.playfield || {};

    if (!engine.assetsLoaded) {
      this.drawLoading(ctx, engine.canvas.width, engine.canvas.height, theme);
      return;
    }

    const layout = engine.layout;
    const symbols = engine.assets.symbols || engine.assets.tilemap;
    this.drawCabinet(ctx, layout, theme, { skipBackdropFill: !!engine.config.viewportBackground });
    if (theme.outlineBehindSymbols) this.drawCabinetGlow(ctx, layout, theme);

    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.reelsX, layout.reelsY, layout.reelsWidth, layout.reelsHeight);
    ctx.clip();

    this.drawPlayfieldBackground(ctx, layout, theme.background);
    this.drawReelsBackground(ctx, layout, engine.config.reelsCount);
    if (engine.animator?.reels) {
      this.drawReelsSymbols(ctx, symbols, symbols?.tiles || {}, layout, engine.config.reelsCount, engine.animator.reels);
    }
    if (engine.state === 'expanding' && engine.animator?.expansionReelsToAnimate) {
      this.drawExpandingAnimation(
        ctx, layout, symbols, symbols?.tiles || {}, engine.config.expandingSymbol,
        engine.animator.expansionReelsToAnimate, engine.animator.expansionReelStartTimes,
      );
    }

    ctx.restore();

    this.drawGridBorders(ctx, layout, engine.config.rowsCount, engine.config.reelsCount, theme);
    if (!theme.outlineBehindSymbols) this.drawCabinetGlow(ctx, layout, theme);
    this.drawWinEffects(
      ctx, engine.state,
      { winData: engine.winData, expandingWinData: engine.expandingWinData, winCycleIndex: engine.winCycleIndex, activeWinLineIndex: engine.activeWinLineIndex },
      layout, engine.config.paylines, engine.config.reelsCount,
    );
    engine.particleSystem?.render(ctx);
  }

  _drawCascade(engine, ctx) {
    ctx.clearRect(0, 0, engine.canvas.width, engine.canvas.height);
    this.drawViewportBackground(ctx, engine.canvas.width, engine.canvas.height, engine.config.viewportBackground);

    const theme = engine.config.playfield || {};

    if (!engine.assetsLoaded) {
      this.drawLoading(ctx, engine.canvas.width, engine.canvas.height, theme);
      return;
    }

    const layout = engine.layout;
    const symbols = engine.assets.symbols || engine.assets.tilemap;
    this.drawCabinet(ctx, layout, theme, { skipBackdropFill: !!engine.config.viewportBackground });
    if (theme.outlineBehindSymbols) this.drawCabinetGlow(ctx, layout, theme);

    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.reelsX, layout.reelsY, layout.reelsWidth, layout.reelsHeight);
    ctx.clip();

    this.drawPlayfieldBackground(ctx, layout, theme.background);

    const animator = engine.animator;
    const mode = engine.freeSpinsMode;
    const overlayBehind = mode && mode.renderOverlayOrder === 'behind';
    if (overlayBehind && engine.inFreeSpins) mode.renderOverlay(engine.freeSpinsModeState, engine);

    if (animator?.outgoingGrid) {
      this.drawOutgoingGridSymbols(ctx, symbols, symbols?.tiles || {}, layout, engine.config.reelsCount, engine.config.rowsCount, animator.outgoingGrid, animator.outgoingOffsets);
    }
    if (animator?.grid) {
      const isClearing = animator.currentClearPositions && animator.currentClearPositions.length > 0;
      const clearDuration = engine.turboMode ? animator.turboClearDurationMs : animator.normalClearDurationMs;
      const clearProgress = isClearing
        ? Math.min((Date.now() - animator._clearStartTime) / clearDuration, 1)
        : null;
      this.drawGridSymbols(ctx, symbols, symbols?.tiles || {}, layout, engine.config.reelsCount, engine.config.rowsCount, {
        grid: animator.grid,
        cellOffsets: animator.cellOffsets,
        currentClearVariants: animator.currentClearVariants,
        cellBounceStartTime: animator.cellBounceStartTime || Array.from({ length: engine.config.reelsCount }, () => new Array(engine.config.rowsCount).fill(-Infinity)),
        clearProgress,
        clearEffect: engine.config.clearEffect
          ? {
            ...engine.config.clearEffect,
            startTime: animator._clearStartTime,
            spriteAsset: engine.assets[engine.config.clearEffect.asset],
          }
          : null,
        // Keep legacy games visually unchanged unless they explicitly choose a cluster-level
        // visualization instead of one highlight rectangle per clearing cell.
        clearCellHighlight: engine.config.clearCellHighlight !== false,
        bounceDuration: engine.turboMode ? 140 : 260,
        now: Date.now(),
      });
    }
    if (!overlayBehind && mode && engine.inFreeSpins) mode.renderOverlay(engine.freeSpinsModeState, engine);

    ctx.restore();

    this.drawGridBorders(ctx, layout, engine.config.rowsCount, engine.config.reelsCount, theme);
    if (!theme.outlineBehindSymbols) this.drawCabinetGlow(ctx, layout, theme);
    const cascadeVisualizer = engine.config.clusterVisualizer === true ? {} : (engine.config.clusterVisualizer || {});
    this.clusterOutlineRenderer.render(ctx, {
      currentClusterWins: animator?.currentClusterWins,
      currentClusterIndex: animator?.currentClusterIndex,
      layout,
      paylines: engine.config.paylines,
      reelsCount: engine.config.reelsCount,
      visualizer: cascadeVisualizer,
      drawClusterOutline: !!engine.config.clusterVisualizer,
    });
    engine.particleSystem?.render(ctx);
    if (animator?.activePopups) {
      const now = Date.now();
      animator.activePopups = animator.activePopups.filter(p => now - p.startTime < p.duration);
      this.drawClusterWinPopups(ctx, animator.activePopups, layout.symbolHeight, now);
    }
  }
}
