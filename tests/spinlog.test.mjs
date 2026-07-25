import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpinLogEntry, applyExpandingWinToSpinLogEntry, summarizeSpinWins, createCascadeSpinLogEntry } from '../core/SpinLog.js';

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
  assert.equal(summary, 'S:book:3:20|L4:ace:3:5:W|X:tut:2:30');

  const WIN_RE = /(S|X|L\d+):([^:|]+):(\d+):(-?[\d.]+)(?::([WA]+))?/g;
  const matches = [...summary.matchAll(WIN_RE)];
  assert.equal(matches.length, 3, 'the parsing regex documented on summarizeSpinWins must find exactly one match per win');
  assert.deepEqual(matches.map(m => m[1]), ['S', 'L4', 'X'], 'each win type token must round-trip through the regex');
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

test('createCascadeSpinLogEntry scales cluster payouts by betAmount and freeSpinsMultiplier, folding them into totalWin', () => {
  const cascadeSteps = [
    { clusterWins: [] }, // the initial fill - no wins yet
    { clusterWins: [{ symbol: 'mint', count: 7, payout: 0.20 }] },
    { clusterWins: [{ symbol: 'cottoncandy', count: 5, payout: 0.25 }] },
    { clusterWins: [] }, // terminal step - no more wins
  ];
  const entry = createCascadeSpinLogEntry({
    spinIndex: 1,
    phase: 'free',
    betAmount: 2,
    chargedBet: 0, // free spins cost nothing to spin
    freeSpinsMultiplier: 2,
    cascadeSteps,
    scatterSymbol: 'bonus',
    scatterWin: null,
  });

  assert.equal(entry.totalBet, 0);
  assert.equal(entry.cascadeStepCount, 4);
  assert.equal(entry.clusterWins.length, 2);
  assert.equal(entry.clusterWins[0].cascadeStep, 1);
  assert.equal(entry.clusterWins[0].payout, 0.20 * 2 * 2, 'multiplier * betAmount * freeSpinsMultiplier');
  assert.equal(entry.clusterWins[1].cascadeStep, 2);
  assert.equal(entry.clusterWins[1].payout, 0.25 * 2 * 2);
  assert.equal(entry.totalWin, (0.20 * 2 * 2) + (0.25 * 2 * 2));
  assert.equal(entry.scatterCount, 0);
  assert.equal(entry.scatterSymbol, null, 'no scatter hit -> not recorded, even though one is configured');
});

test('createCascadeSpinLogEntry records a scatter hit without a cash payout', () => {
  const entry = createCascadeSpinLogEntry({
    spinIndex: 2,
    phase: 'base',
    betAmount: 1,
    chargedBet: 1,
    freeSpinsMultiplier: 1,
    cascadeSteps: [{ clusterWins: [] }],
    scatterSymbol: 'bonus',
    scatterWin: { count: 3, triggerFreeSpins: true },
  });
  assert.equal(entry.scatterSymbol, 'bonus');
  assert.equal(entry.scatterCount, 3);
  assert.equal(entry.totalWin, 0);
});

test('summarizeSpinWins serializes clusterWins additively, without disturbing line/scatter output', () => {
  const lineEntry = { scatterCount: 0, lineWins: [], expandingReels: 0 };
  assert.equal(summarizeSpinWins(lineEntry), '', 'an entry with no clusterWins field behaves exactly as before');

  const cascadeEntry = {
    scatterCount: 0,
    lineWins: [],
    expandingReels: 0,
    clusterWins: [{ cascadeStep: 1, symbol: 'mint', count: 7, payout: 0.8 }],
  };
  assert.equal(summarizeSpinWins(cascadeEntry), 'K1:mint:7:0.8');
});
