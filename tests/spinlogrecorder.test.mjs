import test from 'node:test';
import assert from 'node:assert/strict';
import { SpinLogRecorder } from '../core/engine/SpinLogRecorder.js';

test('record() appends an entry built from a line-pay spin sequence', () => {
  const recorder = new SpinLogRecorder({ betPerLine: 1, linesCount: 10, scatterSymbol: 'scatter' });
  const sequence = [{ grid: [['a']], lineWins: [], scatterWin: null, payout: 0 }];

  recorder.record({ sequence, scatterWin: null, seed: 42, timestamp: 1000, phase: 'base', chargedBet: 10 });

  assert.equal(recorder.entries.length, 1);
  assert.equal(recorder.entries[0].seed, 42);
  assert.equal(recorder.entries[0].totalBet, 10);
});

test('record() computes totalLinePayoutMultiplier from the step\'s own lineWins', () => {
  const recorder = new SpinLogRecorder({ betPerLine: 2, linesCount: 5, scatterSymbol: null });
  const sequence = [{
    grid: [['a']],
    lineWins: [{ lineIndex: 0, symbol: 'a', count: 3, payout: 4, wildUsed: false, alone: false }],
    scatterWin: null,
    payout: 4,
  }];

  const entry = recorder.record({ sequence, scatterWin: null, seed: 1, timestamp: 1, phase: 'base', chargedBet: 10 });

  assert.equal(entry.totalWin, 4 * 2); // payout multiplier * betPerLine
});

test('record() builds a cascade entry from cascade-shaped steps', () => {
  const recorder = new SpinLogRecorder({ betAmount: 1, scatterSymbol: 'bonus' });
  const sequence = [
    { grid: [['a']], fallOffsets: [[0]], clusterWins: [{ symbol: 'a', count: 5, payout: 2 }], payout: 2 },
  ];

  const entry = recorder.record({ sequence, scatterWin: null, seed: 9, timestamp: 5, phase: 'base', chargedBet: 1 });

  assert.equal(entry.totalWin, 2); // clusterWin.payout * betAmount
});

test('record() trims the oldest entry once maxEntries is exceeded', () => {
  const recorder = new SpinLogRecorder({ betPerLine: 1, linesCount: 1, scatterSymbol: null, maxEntries: 3 });
  const sequence = [{ grid: [['a']], lineWins: [], scatterWin: null, payout: 0 }];

  for (let i = 0; i < 5; i++) {
    recorder.record({ sequence, scatterWin: null, seed: i, timestamp: i, phase: 'base', chargedBet: 1 });
  }

  assert.equal(recorder.entries.length, 3);
  assert.equal(recorder.entries[0].seed, 2); // entries for seed 0 and 1 were trimmed
});
