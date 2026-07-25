import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWins, checkExpandingWins, checkWildLineWins, generateReel } from '../core/SlotMath.js';

test('generateReel never places a symbol whose frequency is explicitly 0', () => {
  const paytable = {
    common:  { frequency: 10 },
    rare:    { frequency: 1 },
    never:   { frequency: 0 },
  };
  const reel = generateReel(paytable, 200, 42);
  assert.ok(!reel.includes('never'), 'a symbol with frequency: 0 must never appear on the reel');
  assert.ok(reel.includes('common'));
  assert.ok(reel.includes('rare'));
});

test('checkWins accepts arbitrary grid shapes (3x3)', () => {
  const grid3x3 = [
    ['a', 'a', 'a'],
    ['a', 'a', 'a'],
    ['a', 'a', 'a'],
  ];
  const paylines3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
  const paytable3 = { a: { payout: [0, 0, 5], paymode: 'line' } };

  const result = checkWins(grid3x3, paytable3, paylines3, 3, null, null);
  assert.equal(result.lineWins.length, 3);
  assert.equal(result.totalLinePayoutMultiplier, 15);
});

test('checkWins preserves original 5-reel behavior', () => {
  const grid5x3 = [
    ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a']
  ];
  const paylines5 = [[1, 1, 1, 1, 1]];
  const paytable5 = { a: { payout: [0, 0, 0, 0, 20], paymode: 'line' } };
  const result = checkWins(grid5x3, paytable5, paylines5, 1, null, null);
  assert.equal(result.totalLinePayoutMultiplier, 20);
});

test('checkExpandingWins accepts non-5-reel, non-3-row grids', () => {
  const expPaytable = { x: { payout: [0, 50, 500] } };
  const paylines3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
  const gridExp = [
    ['x', 'b', 'b'], ['x', 'b', 'b'], ['b', 'b', 'b']
  ];
  const expResult = checkExpandingWins(gridExp, 'x', expPaytable, paylines3, 3);
  assert.equal(expResult.expandingReels.length, 2);
  assert.equal(expResult.expandedPositions.length, 6);
});

test('checkWildLineWins - reel-restricted dual-wild rules', () => {
  const PAYTABLE = {
    bar:        { payout: [0, 0, 10] },
    clover:     { payout: [0, 0, 4], wildPenalty: 1 },
    pear:       { payout: [0, 0, 3] },
    grapes:     { payout: [0, 0, 2], wildPenalty: 1 },
    cherries:   { payout: [0.40, 0.80, 1.60] },
    star:       { payout: [0, 0, 0], wild: true, wildExcludes: ['cherries'] },
    strawberry: { payout: [0, 0, 0], wild: true, wildOnly: ['cherries'], aloneBonus: 0.80 },
  };

  function payoutFor(symbols) {
    const grid = [[symbols[0]], [symbols[1]], [symbols[2]]];
    const result = checkWildLineWins(grid, PAYTABLE, [[0, 0, 0]], 1);
    return result.totalLinePayoutMultiplier;
  }

  const cases = [
    [['bar', 'bar', 'bar'], 10],
    [['grapes', 'grapes', 'star'], 1],
    [['pear', 'pear', 'star'], 3],
    [['cherries', 'cherries', 'star'], 0.80],
    [['cherries', 'cherries', 'strawberry'], 1.60],
    [['bar', 'bar', 'strawberry'], 0.80],
    [['cherries', 'bar', 'strawberry'], 1.20],
    [['pear', 'clover', 'strawberry'], 0.80],
    [['bar', 'clover', 'bar'], 0],
  ];

  for (const [symbols, expected] of cases) {
    const actual = payoutFor(symbols);
    assert.ok(Math.abs(actual - expected) < 1e-9, `${symbols.join(',')} -> ${actual} (expected ${expected})`);
  }
});
