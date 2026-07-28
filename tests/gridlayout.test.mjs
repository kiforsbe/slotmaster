import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGridLayout } from '../core/rendering/GridLayout.js';

test('computeGridLayout fills the parent exactly (no letterboxing) and fits the grid to the narrower dimension, centered within it', () => {
  const layout = computeGridLayout(1000, 400, 1, 5, 3);
  assert.equal(layout.cssWidth, 1000);
  assert.equal(layout.cssHeight, 400);
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
