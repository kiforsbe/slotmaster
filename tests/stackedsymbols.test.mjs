import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStackedSymbolTileName } from '../core/rendering/StackedSymbols.js';

const VARIANTS = {
  surfer_yellow: ['surfer_yellow_1', 'surfer_yellow_2', 'surfer_yellow_3', 'surfer_yellow_4', 'surfer_yellow_5'],
};

test('a full column of one stacked-eligible symbol resolves to its per-row variant tile', () => {
  const column = ['surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 0, VARIANTS), 'surfer_yellow_1');
  assert.equal(resolveStackedSymbolTileName(column, 4, VARIANTS), 'surfer_yellow_5');
});

test('a partial column (not every row the same symbol) resolves to the plain symbol name', () => {
  const column = ['surfer_yellow', 'surfer_yellow', 'ace', 'surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 0, VARIANTS), 'surfer_yellow');
  assert.equal(resolveStackedSymbolTileName(column, 3, VARIANTS), 'surfer_yellow');
});

test('a symbol with no stackedSymbols entry always resolves to itself', () => {
  const column = ['ace', 'ace', 'ace', 'ace', 'ace'];
  assert.equal(resolveStackedSymbolTileName(column, 2, VARIANTS), 'ace');
});

test('a column shorter than the variant set never stacks, even if uniform', () => {
  const column = ['surfer_yellow', 'surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 1, VARIANTS), 'surfer_yellow');
});

test('a column taller than the variant set uses variants for the first N rows and the plain tile after', () => {
  const shortVariants = { x: ['x_1', 'x_2'] };
  const column = ['x', 'x', 'x'];
  assert.equal(resolveStackedSymbolTileName(column, 0, shortVariants), 'x_1');
  assert.equal(resolveStackedSymbolTileName(column, 1, shortVariants), 'x_2');
  assert.equal(resolveStackedSymbolTileName(column, 2, shortVariants), 'x');
});

test('missing stackedSymbols map (games that opt out) never throws and always resolves to the plain symbol', () => {
  const column = ['ace', 'ace'];
  assert.equal(resolveStackedSymbolTileName(column, 0, undefined), 'ace');
});

test('with strip context, a full-height run stopped partly off-screen still resolves to its true-position variant', () => {
  // True run is 5 long (strip positions 2-6); the reel stopped with only positions 4-6 (the
  // bottom 3 of the run) inside the visible window.
  const strip = ['filler', 'filler', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'filler'];
  const column = ['surfer_yellow', 'surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 0, VARIANTS, strip, 4), 'surfer_yellow_3');
  assert.equal(resolveStackedSymbolTileName(column, 1, VARIANTS, strip, 4), 'surfer_yellow_4');
  assert.equal(resolveStackedSymbolTileName(column, 2, VARIANTS, strip, 4), 'surfer_yellow_5');
});

test('with strip context, a run shorter than the full variant count stays plain even off-screen', () => {
  // Only a 2-long run (positions 3-4) - not a full 5-tall stack, so no variant tiles even
  // though strip context is available.
  const strip = ['filler', 'filler', 'filler', 'surfer_yellow', 'surfer_yellow', 'filler'];
  const column = ['surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 0, VARIANTS, strip, 3), 'surfer_yellow');
  assert.equal(resolveStackedSymbolTileName(column, 1, VARIANTS, strip, 3), 'surfer_yellow');
});

test('with strip context, a run wrapping around the end of the strip resolves correctly', () => {
  // The 5-tall run wraps: strip positions 6, 7, 0, 1, 2 (circular). Visible window covers
  // positions 0 and 1 (the middle of the run), stopIndex 0.
  const strip = ['surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'filler', 'filler', 'filler', 'surfer_yellow', 'surfer_yellow'];
  const column = ['surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 0, VARIANTS, strip, 0), 'surfer_yellow_3');
  assert.equal(resolveStackedSymbolTileName(column, 1, VARIANTS, strip, 0), 'surfer_yellow_4');
});

test('with strip context but no stopIndex, falls back to the whole-visible-column rule', () => {
  const strip = ['surfer_yellow', 'surfer_yellow', 'surfer_yellow'];
  const column = ['surfer_yellow', 'surfer_yellow'];
  assert.equal(resolveStackedSymbolTileName(column, 0, VARIANTS, strip, undefined), 'surfer_yellow');
});
