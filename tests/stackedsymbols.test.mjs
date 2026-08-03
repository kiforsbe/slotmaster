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
