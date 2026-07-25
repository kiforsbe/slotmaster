import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpinLogEntry, applyExpandingWinToSpinLogEntry, summarizeSpinWins } from '../core/SpinLog.js';

test('createSpinLogEntry reports zeroed win fields for a losing spin', () => {
  const entry = createSpinLogEntry({
    spinIndex: 1,
    phase: 'base',
    betPerLine: 1,
    linesCount: 10,
    chargedBet: 10,
    scatterBetBase: 10,
    winData: { lineWins: [], scatterWin: null, totalLinePayoutMultiplier: 0 },
    scatterSymbol: 'book'
  });

  assert.equal(entry.totalBet, 10);
  assert.equal(entry.totalWin, 0);
  assert.equal(entry.scatterSymbol, null, 'no scatter hit -> no scatter symbol recorded, even though one is configured');
  assert.equal(entry.scatterCount, 0);
  assert.deepEqual(entry.lineWins, []);
  assert.equal(entry.expandingSymbol, null);
  assert.equal(entry.expandingWin, 0);
});

test('createSpinLogEntry scales scatter pay by scatterBetBase and line pay by betPerLine, folding both into totalWin', () => {
  const winData = {
    lineWins: [
      { lineIndex: 0, symbol: 'ace', count: 3, payout: 5, wildUsed: false },
      { lineIndex: 2, symbol: 'star', count: 3, payout: 8, wildUsed: true }
    ],
    scatterWin: { count: 3, payout: 2 },
    totalLinePayoutMultiplier: 13
  };
  const entry = createSpinLogEntry({
    spinIndex: 5,
    phase: 'free',
    betPerLine: 2,
    linesCount: 10,
    chargedBet: 0, // free spins cost nothing to spin
    scatterBetBase: 20, // betPerLine(2) * linesCount(10), unaffected by chargedBet being 0
    winData,
    scatterSymbol: 'book'
  });

  assert.equal(entry.totalBet, 0, 'free spins are logged as costing nothing');
  assert.equal(entry.scatterSymbol, 'book');
  assert.equal(entry.scatterCount, 3);
  assert.equal(entry.scatterWin, 2 * 20, 'scatter payout scales by scatterBetBase, not chargedBet');
  assert.equal(entry.lineWins.length, 2);
  assert.equal(entry.lineWins[0].payout, 5 * 2, 'line payout scales by betPerLine');
  assert.equal(entry.lineWins[1].wildUsed, true);
  assert.equal(entry.totalWin, (2 * 20) + (13 * 2), 'totalWin = scatter payout + totalLinePayoutMultiplier * betPerLine');
});

test('applyExpandingWinToSpinLogEntry mutates the entry in place and folds the amount into totalWin', () => {
  const entry = createSpinLogEntry({
    spinIndex: 2,
    phase: 'free',
    betPerLine: 1,
    linesCount: 10,
    chargedBet: 0,
    scatterBetBase: 10,
    winData: { lineWins: [], scatterWin: null, totalLinePayoutMultiplier: 0 }
  });
  const before = entry.totalWin;

  const returned = applyExpandingWinToSpinLogEntry(entry, { expandingSymbol: 'tut', expandingReels: 3, expandingWin: 45 });

  assert.equal(returned, entry, 'mutates and returns the same object, not a copy');
  assert.equal(entry.expandingSymbol, 'tut');
  assert.equal(entry.expandingReels, 3);
  assert.equal(entry.expandingWin, 45);
  assert.equal(entry.totalWin, before + 45, 'expanding win is added on top of whatever totalWin already held');
});

test('summarizeSpinWins renders scatter, line, and expanding wins into one readable string', () => {
  const entry = createSpinLogEntry({
    spinIndex: 1,
    phase: 'base',
    betPerLine: 1,
    linesCount: 10,
    chargedBet: 10,
    scatterBetBase: 10,
    winData: {
      lineWins: [{ lineIndex: 4, symbol: 'ace', count: 3, payout: 5, wildUsed: true }],
      scatterWin: { count: 3, payout: 2 },
      totalLinePayoutMultiplier: 5
    },
    scatterSymbol: 'book'
  });
  applyExpandingWinToSpinLogEntry(entry, { expandingSymbol: 'tut', expandingReels: 2, expandingWin: 30 });

  const summary = summarizeSpinWins(entry);
  assert.match(summary, /scatter:book/);
  assert.match(summary, /line4:ace/);
  assert.match(summary, /expanding:tut/);
});

test('summarizeSpinWins returns an empty string for a losing spin', () => {
  const entry = createSpinLogEntry({
    spinIndex: 1,
    phase: 'base',
    betPerLine: 1,
    linesCount: 10,
    chargedBet: 10,
    scatterBetBase: 10,
    winData: { lineWins: [], scatterWin: null, totalLinePayoutMultiplier: 0 }
  });
  assert.equal(summarizeSpinWins(entry), '');
});
