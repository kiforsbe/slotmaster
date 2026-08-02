import assert from 'node:assert/strict';
import test from 'node:test';
import { applyNoRefillCascade } from '../core/math/CascadeMath.js';
import { applyPopFeature, applyPopRushVariant, POP_FEATURES, POP_RUSH_VARIANTS } from '../games/lemonpop/LemonPopFeatures.js';
import { checkStraightLineWins } from '../core/math/StraightLineMath.js';
import { LemonPopSpinMechanic } from '../games/lemonpop/LemonPopSpinMechanic.js';
import { resolveMechanic, resolveWinEvaluator } from '../core/simulation/workerMechanicRegistry.js';
import { createSeededRng } from '../core/math/SlotMath.js';
import { PAYTABLE, REEL_STRIPS, REELS_COUNT, ROWS_COUNT, WILD_SYMBOL } from '../games/lemonpop/game.js';

const gridFromRows = rows => Array.from({ length: rows[0].length }, (_, col) => rows.map(row => row[col]));
const blank = () => gridFromRows(Array.from({ length: 5 }, () => Array(5).fill(null)));
const winsFor = (rows, wildMultipliers = null) => checkStraightLineWins(gridFromRows(rows), PAYTABLE, { wildSymbol: WILD_SYMBOL, wildMultipliers });

test('Lemon Pop pays maximal 3/4/5 horizontal and vertical runs and a cross once per direction', () => {
  const three = winsFor([
    ['lemonwedge', WILD_SYMBOL, 'lemonwedge', null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null],
  ]).clusterWins;
  assert.equal(three.length, 1);
  assert.equal(three[0].count, 3);
  assert.equal(three[0].payout, PAYTABLE.lemonwedge.linePayout[0]);
  assert.deepEqual(three[0].wildSpawnPosition, [1, 0]);

  const four = winsFor([
    ['pinkpop', 'pinkfizz', 'pinkpop', 'pinkfizz', null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null],
  ]).clusterWins[0];
  assert.equal(four.count, 4);
  assert.equal(four.mixed, true);
  assert.deepEqual(four.wildSpawnPosition, [1, 0]);

  const five = winsFor([
    [null, null, 'lemonice', null, null], [null, null, 'lemonice', null, null], [null, null, WILD_SYMBOL, null, null], [null, null, 'lemonice', null, null], [null, null, 'lemonice', null, null],
  ]).clusterWins;
  assert.equal(five.length, 1);
  assert.equal(five[0].orientation, 'vertical');
  assert.equal(five[0].count, 5);
  assert.deepEqual(five[0].wildSpawnPosition, [2, 2]);

  const cross = winsFor([
    [null, null, 'pinkfizz', null, null], [null, null, 'pinkfizz', null, null], ['pinkfizz', 'pinkfizz', 'pinkfizz', 'pinkfizz', 'pinkfizz'], [null, null, 'pinkfizz', null, null], [null, null, 'pinkfizz', null, null],
  ]).clusterWins;
  assert.equal(cross.length, 2);
  assert.deepEqual(cross.map(win => win.orientation).sort(), ['horizontal', 'vertical']);
});

test('Lemon Pop valuation honors natural, mixed premium, mixed regular, all-wild, and 2x rules', () => {
  const natural = winsFor([
    ['pinkpop', WILD_SYMBOL, 'pinkpop', null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null],
  ]).clusterWins[0];
  assert.equal(natural.payout, PAYTABLE.pinkpop.linePayout[0]);
  assert.equal(natural.symbol, 'pinkpop');

  const mixedPremium = winsFor([
    ['pinkpop', 'lemonice', 'pinkfizz', null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null],
  ]).clusterWins[0];
  assert.equal(mixedPremium.symbol, 'lemonice');
  assert.equal(mixedPremium.payout, PAYTABLE.lemonice.linePayout[0] * 0.5);
  assert.equal(winsFor([
    ['lemonwedge', 'gumdrop', 'heart', null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null],
  ]).clusterWins.length, 0);

  const allWildMultipliers = Array.from({ length: 5 }, () => Array(5).fill(1));
  allWildMultipliers[2][0] = 2;
  const allWild = winsFor([
    [WILD_SYMBOL, WILD_SYMBOL, WILD_SYMBOL, null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null],
  ], allWildMultipliers).clusterWins[0];
  assert.equal(allWild.payout, PAYTABLE[WILD_SYMBOL].linePayout[0] * 2);
  assert.equal(allWild.multiplier, 2);
});

test('no-refill gravity preserves spawned cans and their multiplier while leaving the top empty', () => {
  const grid = gridFromRows([
    ['a', null, null, null, null], ['b', null, null, null, null], ['c', null, null, null, null], ['d', null, null, null, null], ['e', null, null, null, null],
  ]);
  const result = applyNoRefillCascade(grid, [[0, 1], [0, 3]], [{ position: [0, 1], symbol: WILD_SYMBOL, multiplier: 2 }]);
  assert.deepEqual(result.grid[0], [null, 'a', WILD_SYMBOL, 'c', 'e']);
  assert.deepEqual(result.wildMultipliers[0], [1, 1, 2, 1, 1]);
  assert.deepEqual(result.fallOffsets[0], [0, 1, 1, 1, 0]);

  const consumed = applyNoRefillCascade(gridFromRows([[WILD_SYMBOL, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null], [null, null, null, null, null]]), [[0, 0]], [], [[2, 1, 1, 1, 1]]);
  assert.equal(consumed.grid[0][4], null);
  assert.equal(consumed.wildMultipliers[0][4], 1);
});

test('each seeded Pop Rush variant applies deterministically and Citrus Cross creates its specified cans', () => {
  const base = gridFromRows([
    ['lemonice', 'lemonice', 'gumdrop', 'heart', 'lemoncandy'], ['pinkpop', 'pinkpop', 'gumdrop', 'heart', 'lemoncandy'], ['pinkfizz', 'pinkfizz', 'gumdrop', 'heart', 'lemoncandy'], ['lemonice', 'lemonice', 'gumdrop', 'heart', 'lemoncandy'], ['pinkpop', 'pinkpop', 'gumdrop', 'heart', 'lemoncandy'],
  ]);
  const mults = Array.from({ length: 5 }, () => Array(5).fill(1));
  POP_RUSH_VARIANTS.forEach(variant => {
    const first = applyPopRushVariant({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, variant, rng: createSeededRng(77) });
    const again = applyPopRushVariant({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, variant, rng: createSeededRng(77) });
    assert.deepEqual(first, again, `${variant} must be seeded and repeatable`);
  });
  const cross = applyPopRushVariant({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, variant: 'citrus-cross', rng: createSeededRng(1) });
  [[2, 2], [1, 2], [3, 2], [2, 1], [2, 3]].forEach(([col, row]) => assert.equal(cross.grid[col][row], WILD_SYMBOL));
  assert.equal(cross.wildMultipliers[2][2], 2);
  const rush = applyPopRushVariant({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, variant: 'pop-rush', rng: createSeededRng(1) });
  assert.ok(rush.wildMultipliers.flat().filter(value => value === 2).length >= 3);
  const remix = applyPopRushVariant({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, variant: 'flavor-remix', rng: createSeededRng(1) });
  assert.ok(remix.grid.flat().filter(symbol => PAYTABLE[symbol]?.type === 'premium').length > base.flat().filter(symbol => PAYTABLE[symbol]?.type === 'premium').length);
  const storm = applyPopRushVariant({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, variant: 'soda-storm', rng: createSeededRng(1) });
  assert.ok(storm.grid.flat().filter(symbol => symbol === WILD_SYMBOL).length >= 5);
});

test('each Pop charge effect is seeded, makes a bounded board change, and preserves no-refill gravity', () => {
  const base = gridFromRows([
    [null, null, null, null, null], ['lemonice', 'pinkpop', 'pinkfizz', 'gumdrop', 'heart'], ['lemonwedge', 'gumdrop', 'heart', 'lemoncandy', 'lemonice'], ['pinkpop', 'pinkfizz', 'lemonwedge', 'gumdrop', 'heart'], ['lemoncandy', 'lemonice', 'pinkpop', 'pinkfizz', 'lemonwedge'],
  ]);
  const mults = Array.from({ length: 5 }, () => Array(5).fill(1));
  POP_FEATURES.forEach(feature => {
    const first = applyPopFeature({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, feature, rng: createSeededRng(51) });
    const again = applyPopFeature({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, feature, rng: createSeededRng(51) });
    assert.deepEqual(first, again, `${feature} must be seeded and repeatable`);
    assert.equal(first.feature, feature);
    first.grid.forEach(column => {
      const firstSymbol = column.findIndex(symbol => symbol != null);
      if (firstSymbol >= 0) assert.ok(column.slice(0, firstSymbol).every(symbol => symbol == null));
    });
  });
  const splash = applyPopFeature({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, feature: 'wild-splash', rng: createSeededRng(1) });
  assert.ok(splash.grid.flat().filter(symbol => symbol === WILD_SYMBOL).length >= 1);
  const shift = applyPopFeature({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, feature: 'flavor-shift', rng: createSeededRng(2) });
  assert.ok(shift.affectedPositions.length > 1);
  const shiftedSymbols = new Set(shift.affectedPositions.map(([col, row]) => shift.grid[col][row]));
  assert.deepEqual([...shiftedSymbols], [shift.transformedSymbol]);
  const burst = applyPopFeature({ grid: base, wildMultipliers: mults, paytable: PAYTABLE, wildSymbol: WILD_SYMBOL, feature: 'bubble-burst', rng: createSeededRng(2) });
  assert.ok(burst.grid.flat().filter(symbol => symbol != null).length < base.flat().filter(symbol => symbol != null).length);
});

test('settling at one wild or fewer triggers Pop Rush without needing the meter filled', () => {
  const makeEvaluator = () => {
    let calls = 0;
    return () => {
      calls += 1;
      if (calls <= 15) return {
        clusterWins: [{ kind: 'straight-line', orientation: 'horizontal', symbol: 'lemon', count: 3, payout: 1, winningPositions: [[0, 0], [1, 0], [2, 0]], wildSpawnPosition: [1, 0] }],
        totalPayoutMultiplier: 1, wildSymbol: WILD_SYMBOL,
      };
      return { clusterWins: [], totalPayoutMultiplier: 0, wildSymbol: WILD_SYMBOL };
    };
  };
  const oneWildGrid = blank();
  oneWildGrid[2][2] = WILD_SYMBOL;
  const oneWildMultipliers = Array.from({ length: 5 }, () => Array(5).fill(1));
  const args = { reelStrips: Array.from({ length: 5 }, () => ['lemon', 'mint']), rowsCount: 5, seed: 9,
    config: {
      paytable: PAYTABLE,
      wildSymbol: WILD_SYMBOL,
      linesPerPop: 5,
      popsToRush: 99,
      betAmount: 1,
      popFeatures: ['wild-splash'],
      applyPopFeature: ({ feature }) => ({
        grid: oneWildGrid.map(column => column.slice()),
        wildMultipliers: oneWildMultipliers.map(column => column.slice()),
        fallOffsets: oneWildGrid.map(column => column.map(() => 0)),
        feature,
        affectedPositions: [],
      }),
      popRushVariants: ['pop-rush'],
      applyPopRushVariant: ({ grid, wildMultipliers }) => ({ grid, wildMultipliers }),
    } };
  const result = LemonPopSpinMechanic.resolveLiveSpin({ ...args, winEvaluator: makeEvaluator() });
  const replay = LemonPopSpinMechanic.resolveLiveSpin({ ...args, winEvaluator: makeEvaluator() });
  const rushTriggerStep = result.steps.find(step => (step.popSettleDebug?.action ?? step.popDebug?.action) === 'pop-rush-triggered');
  const rushTriggerDebug = rushTriggerStep?.popSettleDebug || rushTriggerStep?.popDebug;
  assert.equal(result.triggeredPopRush, true);
  assert.ok(rushTriggerStep);
  assert.ok(rushTriggerDebug.wildsRemaining <= 1);
  assert.ok(rushTriggerDebug.bankedChargeLines < 5 * 99, 'Pop Rush should trigger long before the meter is full');
  assert.equal(replay.popProgress.totalLines, result.popProgress.totalLines);
  assert.equal(LemonPopSpinMechanic.name, 'lemonPopCascade');
  assert.equal(resolveMechanic('line').name, 'line');
  const rebuilt = resolveWinEvaluator('checkStraightLineWins', PAYTABLE, null, 3, null, null, WILD_SYMBOL);
  const board = blank(); board[0][0] = board[1][0] = board[2][0] = 'lemon';
  assert.deepEqual(rebuilt(board, null), checkStraightLineWins(board, PAYTABLE, { wildSymbol: WILD_SYMBOL, wildMultipliers: null }));
});

test('a fully cleared board triggers Pop Rush and awards the 25x total-bet bonus', () => {
  const makeEvaluator = () => {
    let calls = 0;
    return () => {
      calls += 1;
      if (calls <= 5) {
        const row = calls - 1;
        return {
          clusterWins: [{ kind: 'straight-line', orientation: 'horizontal', symbol: 'lemon', count: 3, payout: 1, winningPositions: [[0, row], [1, row], [2, row]], wildSpawnPosition: [1, row] }],
          totalPayoutMultiplier: 1, wildSymbol: WILD_SYMBOL,
        };
      }
      return { clusterWins: [], totalPayoutMultiplier: 0, wildSymbol: WILD_SYMBOL };
    };
  };
  const clearGrid = blank();
  const clearMultipliers = Array.from({ length: 5 }, () => Array(5).fill(1));
  const result = LemonPopSpinMechanic.resolveLiveSpin({
    reelStrips: Array.from({ length: 5 }, () => ['lemon', 'mint']),
    rowsCount: 5,
    seed: 9,
    config: {
      paytable: PAYTABLE,
      wildSymbol: WILD_SYMBOL,
      linesPerPop: 5,
      popsToRush: 99,
      betAmount: 1,
      popFeatures: ['wild-splash'],
      applyPopFeature: ({ feature }) => ({
        grid: clearGrid.map(column => column.slice()),
        wildMultipliers: clearMultipliers.map(column => column.slice()),
        fallOffsets: clearGrid.map(column => column.map(() => 0)),
        feature,
        affectedPositions: [],
      }),
      popRushVariants: ['pop-rush'],
      applyPopRushVariant: ({ grid, wildMultipliers }) => ({ grid, wildMultipliers }),
    },
    winEvaluator: makeEvaluator(),
  });
  const bonusStep = result.steps.find(step => (step.popSettleDebug?.fullClearBonusMultiplier ?? step.popDebug?.fullClearBonusMultiplier) === 25);
  assert.equal(result.triggeredPopRush, true);
  assert.ok(bonusStep);
  assert.equal(bonusStep.payout, 25);
});

test('Lemon Pop uses a 5x5 reel shape, includes every configured paying symbol, and never puts the wild can on strips', () => {
  assert.equal(REEL_STRIPS.length, REELS_COUNT);
  REEL_STRIPS.forEach(strip => {
    assert.equal(strip.length > ROWS_COUNT, true);
    assert.equal(strip.includes(WILD_SYMBOL), false);
  });
  const landedSymbols = new Set(REEL_STRIPS.flat());
  Object.keys(PAYTABLE).filter(symbol => symbol !== WILD_SYMBOL).forEach(symbol => assert.ok(landedSymbols.has(symbol), `${symbol} should be on a strip`));
});