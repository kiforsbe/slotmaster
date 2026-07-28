import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGridLayout } from '../core/rendering/GridLayout.js';

test('computeGridLayout fits the grid to the narrower dimension and centers it, matching a 5x3 grid at a wide parent', () => {
  const layout = computeGridLayout(1000, 400, 1, 5, 3);
  // Hand-computed from the original inline formula (marginXFrac=0.05, marginYFrac=0.08 defaults):
  // targetAspect = (5 * (1 - 0.16)) / (3 * (1 - 0.10)) = (5*0.84)/(3*0.90) = 4.2/2.7
  const targetAspect = (5 * (1 - 2 * 0.08)) / (3 * (1 - 2 * 0.05));
  let expectedW = 1000;
  let expectedH = 1000 / targetAspect;
  if (expectedH > 400) { expectedH = 400; expectedW = 400 * targetAspect; }
  assert.ok(Math.abs(layout.cssWidth - expectedW) < 1e-9);
  assert.ok(Math.abs(layout.cssHeight - expectedH) < 1e-9);
  assert.equal(layout.canvasWidth, layout.cssWidth * 1);
  assert.equal(layout.canvasHeight, layout.cssHeight * 1);
});

test('computeGridLayout scales canvas pixel dimensions by dpr but not css dimensions', () => {
  const layout = computeGridLayout(800, 800, 2, 7, 7);
  assert.equal(layout.canvasWidth, layout.cssWidth * 2);
  assert.equal(layout.canvasHeight, layout.cssHeight * 2);
});

test('computeGridLayout produces square cells that exactly tile reelsWidth/reelsHeight', () => {
  const layout = computeGridLayout(900, 900, 1, 7, 7);
  assert.ok(Math.abs(layout.reelsWidth - layout.cellSize * 7) < 1e-9);
  assert.ok(Math.abs(layout.reelsHeight - layout.cellSize * 7) < 1e-9);
  assert.ok(layout.reelsX > 0 && layout.reelsY > 0, 'grid is inset from the canvas edge by the margin');
});
