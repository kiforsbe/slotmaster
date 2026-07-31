// Sprite-atlas blit with optional motion blur, extracted from SlotEngine.drawSymbol() so
// CascadeEngine can draw its own grid's symbols with identical visuals.
import { SpriteAnimation, SpriteAnimationPlayback } from '../assets/AssetLoader.js';

/**
 * Draws one sprite-atlas tile at a destination rect, optionally with a vertical
 * motion-blur stretch (used while a symbol is moving fast - reel spin, or a cascading fall).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{image:HTMLImageElement,type?:string,animations?:object}|HTMLImageElement} asset
 *   loaded tilemap/sprite asset, or a legacy image
 * @param {object|string|undefined} sprite - tile, animation, playback, or named animation;
 *   a no-op if undefined (matches SlotEngine.drawSymbol's own defensive `if (!tile) return`).
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} [blurSpeed=0] - 0 draws crisp; > 0 draws a stretched, alpha-blended blur
 *   whose intensity scales with this value (SlotEngine passes reel speed here).
 */
export function drawSpriteSymbol(ctx, asset, sprite, x, y, width, height, blurSpeed = 0) {
  if (!sprite) return;

  const spritesheet = asset?.image || asset;
  let tile = typeof sprite === 'string' ? asset?.animations?.[sprite] : sprite;
  if (!tile) return;

  // A tilemap entry is normalized as a one-frame animation. Sprite descriptors use the same
  // shape, so the renderer has one drawing contract for static tiles and animated sprites.
  if (tile instanceof SpriteAnimationPlayback || tile instanceof SpriteAnimation) tile = tile.frameAt();
  else if (Array.isArray(tile.frames)) {
    const animation = new SpriteAnimation(tile);
    const playback = animation.play(tile.startTime);
    tile = tile.progress != null ? playback.frameAtProgress(tile.progress) : playback.frameAt();
  }

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
