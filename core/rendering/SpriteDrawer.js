// Sprite-atlas blit with optional motion blur, extracted from SlotEngine.drawSymbol() so
// CascadeEngine can draw its own grid's symbols with identical visuals.

/**
 * Draws one sprite-atlas tile at a destination rect, optionally with a vertical
 * motion-blur stretch (used while a symbol is moving fast - reel spin, or a cascading fall).
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement} spritesheet
 * @param {{x:number,y:number,w:number,h:number}|undefined} tile - this symbol's atlas rect;
 *   a no-op if undefined (matches SlotEngine.drawSymbol's own defensive `if (!tile) return`).
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} [blurSpeed=0] - 0 draws crisp; > 0 draws a stretched, alpha-blended blur
 *   whose intensity scales with this value (SlotEngine passes reel speed here).
 */
export function drawSpriteSymbol(ctx, spritesheet, tile, x, y, width, height, blurSpeed = 0) {
  if (!tile) return;

  const destX = x;
  const destY = y;
  const destW = width;
  const destH = height;

  ctx.save();

  if (blurSpeed > 0) {
    const stretch = Math.min(2.0, 1 + (blurSpeed / 50));
    const blurCount = 3;

    ctx.globalAlpha = 0.35;
    for (let i = 0; i < blurCount; i++) {
      const offset = (i - (blurCount - 1) / 2) * (blurSpeed * 0.15);
      ctx.drawImage(
        spritesheet,
        tile.x, tile.y, tile.w, tile.h,
        destX, destY + offset - (destH * (stretch - 1) / 2), destW, destH * stretch
      );
    }
  } else {
    ctx.drawImage(
      spritesheet,
      tile.x, tile.y, tile.w, tile.h,
      destX, destY, destW, destH
    );
  }

  ctx.restore();
}
