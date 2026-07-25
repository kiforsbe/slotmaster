// Pure canvas/grid layout math, extracted from SlotEngine.resize() so CascadeEngine (a
// different grid shape/shape of animation entirely) can compute the same square-cell,
// centered-in-parent layout without duplicating the formula.

/**
 * Fits a reelsCount x rowsCount grid of square cells into a parent box, preserving aspect
 * ratio (never stretching/letterboxing), and centers it within a small margin.
 * @param {number} parentWidth - CSS pixels.
 * @param {number} parentHeight - CSS pixels.
 * @param {number} dpr - devicePixelRatio, for sizing the canvas's backing buffer.
 * @param {number} reelsCount
 * @param {number} rowsCount
 * @param {number} [marginXFrac=0.05] - horizontal margin as a fraction of the canvas box.
 * @param {number} [marginYFrac=0.08] - vertical margin as a fraction of the canvas box.
 * @returns {{ cssWidth: number, cssHeight: number, canvasWidth: number, canvasHeight: number,
 *   cellSize: number, reelsWidth: number, reelsHeight: number, reelsX: number, reelsY: number }}
 */
export function computeGridLayout(parentWidth, parentHeight, dpr, reelsCount, rowsCount, marginXFrac = 0.05, marginYFrac = 0.08) {
  const targetAspect =
    (reelsCount * (1 - 2 * marginYFrac)) /
    (rowsCount * (1 - 2 * marginXFrac));

  let cssWidth = parentWidth;
  let cssHeight = parentWidth / targetAspect;
  if (cssHeight > parentHeight) {
    cssHeight = parentHeight;
    cssWidth = parentHeight * targetAspect;
  }

  const marginX = cssWidth * marginXFrac;
  const marginY = cssHeight * marginYFrac;
  const availW = cssWidth - (2 * marginX);
  const availH = cssHeight - (2 * marginY);
  const cellSize = Math.min(availW / reelsCount, availH / rowsCount);
  const reelsWidth = cellSize * reelsCount;
  const reelsHeight = cellSize * rowsCount;

  return {
    cssWidth,
    cssHeight,
    canvasWidth: cssWidth * dpr,
    canvasHeight: cssHeight * dpr,
    cellSize,
    reelsWidth,
    reelsHeight,
    reelsX: marginX + (availW - reelsWidth) / 2,
    reelsY: marginY + (availH - reelsHeight) / 2,
  };
}
