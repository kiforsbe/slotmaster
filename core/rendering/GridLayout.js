// Pure canvas/grid layout math, extracted from SlotEngine.resize() so CascadeEngine (a
// different grid shape/shape of animation entirely) can compute the same square-cell,
// centered-in-parent layout without duplicating the formula.

/**
 * Sizes the canvas to fill its parent box exactly (no letterboxing - any leftover space around
 * the reels stays inside the canvas itself, for drawCabinet/drawViewportBackground to paint into,
 * rather than showing as bare DOM behind it), then fits a reelsCount x rowsCount grid of square
 * cells into that box preserving aspect ratio, centered within a small margin.
 * @param {number} parentWidth - CSS pixels.
 * @param {number} parentHeight - CSS pixels.
 * @param {number} dpr - devicePixelRatio, for sizing the canvas's backing buffer.
 * @param {number} reelsCount
 * @param {number} rowsCount
 * @param {number} [marginXFrac=0.05] - horizontal margin as a fraction of the canvas box.
 * @param {number} [marginYFrac=0.08] - vertical margin as a fraction of the canvas box.
 * @param {number} [cellAspectRatio=1] - cell width / height. Default 1 keeps every existing
 *   game's square cells; a game with wide art (e.g. 256x128 tiles) passes 2.
 * @returns {{ cssWidth: number, cssHeight: number, canvasWidth: number, canvasHeight: number,
 *   cellSize: number, cellWidth: number, cellHeight: number, reelsWidth: number,
 *   reelsHeight: number, reelsX: number, reelsY: number }}
 */
export function computeGridLayout(parentWidth, parentHeight, dpr, reelsCount, rowsCount, marginXFrac = 0.05, marginYFrac = 0.08, cellAspectRatio = 1) {
  const cssWidth = parentWidth;
  const cssHeight = parentHeight;

  const marginX = cssWidth * marginXFrac;
  const marginY = cssHeight * marginYFrac;
  const availW = cssWidth - (2 * marginX);
  const availH = cssHeight - (2 * marginY);
  const cellHeight = Math.min(availW / (reelsCount * cellAspectRatio), availH / rowsCount);
  const cellWidth = cellHeight * cellAspectRatio;
  const reelsWidth = cellWidth * reelsCount;
  const reelsHeight = cellHeight * rowsCount;

  return {
    cssWidth,
    cssHeight,
    canvasWidth: cssWidth * dpr,
    canvasHeight: cssHeight * dpr,
    cellSize: cellHeight,
    cellWidth,
    cellHeight,
    reelsWidth,
    reelsHeight,
    reelsX: marginX + (availW - reelsWidth) / 2,
    reelsY: marginY + (availH - reelsHeight) / 2,
  };
}
