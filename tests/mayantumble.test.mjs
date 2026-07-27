import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins } from '../core/SpinSimulator.js';
import { CascadeSpinMechanic } from '../core/CascadeSpinMechanic.js';
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
