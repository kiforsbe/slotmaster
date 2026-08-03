import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fullyStackedColor, detectBonusTrigger, detectJackpot, evaluateBeachPartyWin,
  PAYTABLE, PAYLINES, WILD_SYMBOL, JACKPOT_MULTIPLIER,
} from '../games/beachparty/game.js';

function plainGrid() {
  // 5 reels x 5 rows, no surfers/wild/bonus anywhere - just cards.
  return [
    ['ten', 'jack', 'queen', 'king', 'ace'],
    ['ten', 'jack', 'queen', 'king', 'ace'],
    ['ten', 'jack', 'queen', 'king', 'ace'],
    ['ten', 'jack', 'queen', 'king', 'ace'],
    ['ten', 'jack', 'queen', 'king', 'ace'],
  ];
}

test('fullyStackedColor returns the color when a whole column is one surfer color', () => {
  const grid = plainGrid();
  grid[0] = ['surfer_blue', 'surfer_blue', 'surfer_blue', 'surfer_blue', 'surfer_blue'];
  assert.equal(fullyStackedColor(grid, 0), 'surfer_blue');
});

test('fullyStackedColor returns null for a partial column or a non-surfer symbol', () => {
  const grid = plainGrid();
  grid[0] = ['surfer_blue', 'surfer_blue', 'ace', 'surfer_blue', 'surfer_blue'];
  assert.equal(fullyStackedColor(grid, 0), null);
  assert.equal(fullyStackedColor(grid, 1), null, 'reel 1 is all cards, not a surfer color');
});

test('detectBonusTrigger reports triggerFreeSpins only when reels 1, 3, and 5 all show bonus', () => {
  const grid = plainGrid();
  grid[0][2] = 'bonus';
  grid[2][0] = 'bonus';
  grid[4][4] = 'bonus';
  const trigger = detectBonusTrigger(grid);
  assert.equal(trigger.count, 3);
  assert.equal(trigger.triggerFreeSpins, true);
  assert.equal(trigger.winningPositions.length, 3);
});

test('detectBonusTrigger does not trigger with only 2 of the 3 required reels', () => {
  const grid = plainGrid();
  grid[0][0] = 'bonus';
  grid[2][0] = 'bonus';
  const trigger = detectBonusTrigger(grid);
  assert.equal(trigger.count, 2);
  assert.equal(trigger.triggerFreeSpins, false);
});

test('detectJackpot is true only when all 4 surfer colors are fully stacked at once', () => {
  const grid = plainGrid();
  grid[0] = Array(5).fill('surfer_blue');
  grid[1] = Array(5).fill('surfer_green');
  grid[2] = Array(5).fill('surfer_pink');
  grid[3] = Array(5).fill('surfer_yellow');
  assert.equal(detectJackpot(grid), true, 'all 4 colors present across reels 0-3');

  const missingOne = plainGrid();
  missingOne[0] = Array(5).fill('surfer_blue');
  missingOne[1] = Array(5).fill('surfer_green');
  missingOne[2] = Array(5).fill('surfer_pink');
  assert.equal(detectJackpot(missingOne), false, 'only 3 of 4 colors present');
});

test('evaluateBeachPartyWin does not substitute stacked reels as wild in the base game', () => {
  const grid = plainGrid();
  grid[0] = Array(5).fill('surfer_blue');
  grid[1] = Array(5).fill('surfer_blue');
  const result = evaluateBeachPartyWin(grid, PAYTABLE, PAYLINES, PAYLINES.length, WILD_SYMBOL, null, { inFreeSpins: false });
  // Row 0 payline ([0,0,0,0,0]) sees surfer_blue, surfer_blue, ten, ten, ten - only a 2-match
  // (no payout defined for 2-of-a-kind), so this line should NOT pay via wild substitution.
  const rowZeroWin = result.lineWins.find(w => w.lineIndex === 0);
  assert.equal(rowZeroWin, undefined, 'without free-spins wild substitution, this line does not complete a paying run');
});

test('evaluateBeachPartyWin substitutes a fully-stacked reel as wild only while inFreeSpins', () => {
  const grid = plainGrid();
  // Every reel's row 0 is surfer_blue, but only reels 0 and 1 are FULLY stacked (all 5 rows);
  // reels 2-4 keep their card rows on rows 1-4, so only reels 0/1 qualify as full stacks.
  for (let col = 0; col < 5; col++) grid[col][0] = 'surfer_blue';
  grid[0] = Array(5).fill('surfer_blue');
  grid[1] = Array(5).fill('surfer_blue');

  const result = evaluateBeachPartyWin(grid, PAYTABLE, PAYLINES, PAYLINES.length, WILD_SYMBOL, null, { inFreeSpins: true });
  const rowZeroWin = result.lineWins.find(w => w.lineIndex === 0);
  assert.ok(rowZeroWin, 'reels 0 and 1 count as wild, extending the surfer_blue run on row 0 to at least 3');
  assert.equal(rowZeroWin.symbol, 'surfer_blue');
  assert.ok(rowZeroWin.count >= 3);
});

test('evaluateBeachPartyWin pays the jackpot multiplier via scatterWin only while inFreeSpins and all 4 colors are stacked', () => {
  const grid = plainGrid();
  grid[0] = Array(5).fill('surfer_blue');
  grid[1] = Array(5).fill('surfer_green');
  grid[2] = Array(5).fill('surfer_pink');
  grid[3] = Array(5).fill('surfer_yellow');

  const inBonus = evaluateBeachPartyWin(grid, PAYTABLE, PAYLINES, PAYLINES.length, WILD_SYMBOL, null, { inFreeSpins: true });
  assert.equal(inBonus.scatterWin.jackpot, true);
  assert.equal(inBonus.scatterWin.payout, JACKPOT_MULTIPLIER);

  const inBase = evaluateBeachPartyWin(grid, PAYTABLE, PAYLINES, PAYLINES.length, WILD_SYMBOL, null, { inFreeSpins: false });
  assert.equal(inBase.scatterWin, null, 'the jackpot never fires in the base game, only during Beach Bonus');
});
