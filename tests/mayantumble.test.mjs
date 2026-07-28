import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins } from '../core/SpinSimulator.js';
import { createSeededRng } from '../core/math/SlotMath.js';
import { CascadeSpinMechanic } from '../core/engine/mechanics/CascadeSpinMechanic.js';
import { resolveWinEvaluator } from '../core/mechanicRegistry.js';
import {
  REELS_COUNT, ROWS_COUNT, PAYTABLE, PAYLINES, REEL_STRIPS, REEL_LENGTH, BET_AMOUNT, SCATTER_TRIGGER_COUNT, FREE_SPINS_AWARD, checkLineCascadeWins,
} from '../games/mayantumble/game.js';

test('mayan tumble paylines and reel strips have consistent shapes', () => {
  assert.equal(PAYLINES.length, 10);
  PAYLINES.forEach(path => {
    assert.equal(path.length, REELS_COUNT);
    path.forEach(row => assert.ok(row >= 0 && row < ROWS_COUNT));
  });
  assert.equal(REEL_STRIPS.length, REELS_COUNT);
  REEL_STRIPS.forEach(strip => {
    assert.ok(strip.length >= REEL_LENGTH && strip.length <= REEL_LENGTH + 5, `Expected strip length near ${REEL_LENGTH}, got ${strip.length}`);
  });
});

test('mayan tumble reels space the gold scatter at least ROWS_COUNT apart (minGap)', () => {
  REEL_STRIPS.forEach(strip => {
    const positions = [];
    strip.forEach((sym, i) => { if (sym === 'gold') positions.push(i); });
    assert.ok(positions.length > 0, 'expected gold to actually appear on this reel');

    const n = strip.length;
    const circularDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n - d); };
    for (let a = 0; a < positions.length; a++) {
      for (let b = a + 1; b < positions.length; b++) {
        assert.ok(circularDist(positions[a], positions[b]) >= ROWS_COUNT);
      }
    }
  });
});

// ---- The worker-side rebuild of this game's evaluator -------------------------------------
// Tuning runs its trials in Worker threads, and a closure cannot cross postMessage. The worker
// gets `winEvaluatorName` plus loose primitives and rebuilds an equivalent evaluator from them
// (core/mechanicRegistry.js). That makes a game's tuneConfig responsible for carrying everything
// its evaluator closes over - and nothing checked that it did.

test('rebuilding this game\'s evaluator without paylines fails by name, not as a TypeError', () => {
  // What shipped: tuneConfig omitted `paylines`, so the first trial threw "Cannot read properties
  // of undefined (reading 'length')" from inside a Worker, with a stack pointing at the pool's
  // settle function - naming neither the game, the evaluator, nor the missing field. START TUNING
  // simply stopped, which is all the panel could say.
  assert.throws(
    () => resolveWinEvaluator('checkLineCascadeWins', PAYTABLE, 'gold', 3, SCATTER_TRIGGER_COUNT, undefined, null),
    (err) => /checkLineCascadeWins/.test(err.message) && /paylines/.test(err.message),
    'the error must name both the evaluator and the field that is missing');
});

test('a line win carries which payline paid it, and a scatter carries none', () => {
  // A cascade engine treats a win as a set of cells, which is the whole story for a cluster game.
  // It is not the whole story here: three matching symbols on a 5x3 grid sit on several paylines
  // at once, and the cells alone cannot tell a player which line they were paid for. Without
  // lineIndex the engine has nothing to draw.
  const gridAt = (offset) => REEL_STRIPS.map(strip =>
    Array.from({ length: ROWS_COUNT }, (_, row) => strip[(offset + row) % strip.length]));
  const evaluate = (grid) => checkLineCascadeWins(grid, PAYTABLE, 'gold', SCATTER_TRIGGER_COUNT, PAYLINES, null);

  let lineWin = null;
  for (let offset = 0; offset < REEL_LENGTH && !lineWin; offset++) {
    const wins = evaluate(gridAt(offset)).clusterWins;
    lineWin = wins.find(w => w.symbol !== 'gold') ?? null;
  }
  assert.ok(lineWin, 'expected at least one line win somewhere on these strips');
  assert.equal(typeof lineWin.lineIndex, 'number');
  assert.ok(lineWin.lineIndex >= 0 && lineWin.lineIndex < PAYLINES.length);

  // Every cell it was paid for must sit on the line it claims - otherwise the drawn path and the
  // highlighted symbols disagree, which is worse than drawing nothing.
  const path = PAYLINES[lineWin.lineIndex];
  lineWin.winningPositions.forEach(([col, row]) => assert.equal(row, path[col]));

  // A scatter pays anywhere, so there is no line to draw and it must not claim one - a lineIndex
  // of 0 here would draw payline 1 across a win that has nothing to do with it.
  const scattered = gridAt(0).map(col => col.slice());
  for (let col = 0; col < SCATTER_TRIGGER_COUNT; col++) scattered[col][0] = 'gold';
  const scatterWin = evaluate(scattered).clusterWins.find(w => w.symbol === 'gold');
  assert.ok(scatterWin, 'expected the forced gold symbols to pay as a scatter');
  assert.equal(scatterWin.lineIndex, undefined);
});

test('the rebuilt evaluator measures identically to the in-process closure', () => {
  // Equivalence is the whole contract. A rebuild that merely runs, but scores differently from
  // the evaluator the game plays with, produces a tuned result for a game nobody ships.
  const base = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paytable: PAYTABLE, reelStrips: REEL_STRIPS,
    paylines: PAYLINES, scatterSymbol: 'gold', mechanic: CascadeSpinMechanic,
  };
  const inProcess = simulateSpins(
    { ...base, winEvaluator: (grid) => checkLineCascadeWins(grid, PAYTABLE, 'gold', SCATTER_TRIGGER_COUNT, PAYLINES, null) },
    2000, BET_AMOUNT / PAYLINES.length, PAYLINES.length, createSeededRng(4242));
  const rebuilt = simulateSpins(
    { ...base, winEvaluator: resolveWinEvaluator('checkLineCascadeWins', PAYTABLE, 'gold', 3, SCATTER_TRIGGER_COUNT, PAYLINES, null) },
    2000, BET_AMOUNT / PAYLINES.length, PAYLINES.length, createSeededRng(4242));

  assert.equal(rebuilt.rtpRaw, inProcess.rtpRaw);
  assert.equal(rebuilt.freeSpinsTriggered, inProcess.freeSpinsTriggered);

  // Field-for-field, not merely payout-equivalent - the rebuild is meant to BE this game's
  // evaluator, so anything the game reads off a win (lineIndex, say) has to survive it.
  const grid = REEL_STRIPS.map(strip => Array.from({ length: ROWS_COUNT }, (_, row) => strip[row]));
  assert.deepEqual(
    resolveWinEvaluator('checkLineCascadeWins', PAYTABLE, 'gold', 3, SCATTER_TRIGGER_COUNT, PAYLINES, null)(grid),
    checkLineCascadeWins(grid, PAYTABLE, 'gold', SCATTER_TRIGGER_COUNT, PAYLINES, null));
});

test('mayan tumble simulated RTP is a finite, sane number', () => {
  const config = {
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    paylines: PAYLINES,
    scatterSymbol: 'gold',
    mechanic: CascadeSpinMechanic,
    winEvaluator: (grid) => checkLineCascadeWins(grid, PAYTABLE, 'gold', SCATTER_TRIGGER_COUNT, PAYLINES, null),
  };
  const results = simulateSpins(config, 1000, BET_AMOUNT / PAYLINES.length, PAYLINES.length);

  assert.ok(
    Number.isFinite(results.rtpRaw) && results.rtpRaw > 0 && results.rtpRaw < 10,
    `RTP ${results.rtp} is not a sane value`
  );
});
