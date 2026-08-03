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

test('computeGridLayout with cellAspectRatio 1 (default) behaves exactly as before', () => {
  const withDefault = computeGridLayout(900, 900, 1, 7, 7);
  const withExplicit = computeGridLayout(900, 900, 1, 7, 7, 0.05, 0.08, 1);
  assert.equal(withDefault.cellWidth, withExplicit.cellWidth);
  assert.equal(withDefault.cellWidth, withDefault.cellHeight);
  assert.equal(withDefault.cellWidth, withDefault.cellSize);
});

test('computeGridLayout with cellAspectRatio 2 produces cells twice as wide as tall', () => {
  const layout = computeGridLayout(2000, 1000, 1, 5, 5, 0.05, 0.08, 2);
  assert.ok(Math.abs(layout.cellWidth - layout.cellHeight * 2) < 1e-9);
  assert.ok(Math.abs(layout.reelsWidth - layout.cellWidth * 5) < 1e-9);
  assert.ok(Math.abs(layout.reelsHeight - layout.cellHeight * 5) < 1e-9);
});

test('computeGridLayout with cellAspectRatio 2 still fits inside the available box, centered', () => {
  const layout = computeGridLayout(2000, 1000, 1, 5, 5, 0.05, 0.08, 2);
  const marginX = 2000 * 0.05;
  const marginY = 1000 * 0.08;
  const availW = 2000 - 2 * marginX;
  const availH = 1000 - 2 * marginY;
  assert.ok(layout.reelsWidth <= availW + 1e-6);
  assert.ok(layout.reelsHeight <= availH + 1e-6);
  assert.ok(layout.reelsX >= marginX - 1e-6);
  assert.ok(layout.reelsY >= marginY - 1e-6);
});
