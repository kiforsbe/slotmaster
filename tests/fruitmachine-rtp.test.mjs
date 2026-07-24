import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins } from '../core/SpinSimulator.js';
import { checkWildLineWins } from '../core/SlotMath.js';
import {
  REELS_COUNT, ROWS_COUNT, PAYTABLE, PAYLINES, REEL_STRIPS, BET_PER_LINE, LINES_COUNT,
} from '../games/fruitmachine/game.js';

test('fruit machine RTP stays near the 96% design target', () => {
  const config = {
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    paylines: PAYLINES,
    winEvaluator: checkWildLineWins,
  };
  const results = simulateSpins(config, 300000, BET_PER_LINE, LINES_COUNT);

  // Wide-ish band: this is a fast regression guard (not a precise tuning check) against the
  // dual-wild win evaluator or reel generation silently breaking - see Task 8 of
  // docs/superpowers/plans/2026-07-24-fruitmachine-game.md for the offline tuning pass that
  // validated ~96.1% RTP at 2,000,000 spins.
  assert.ok(
    results.rtpRaw > 0.90 && results.rtpRaw < 1.02,
    `RTP ${results.rtp} is outside the expected band - checkWildLineWins or PAYTABLE frequencies may be broken`
  );
});

test('fruit machine paylines and reel strips have consistent shapes', () => {
  assert.equal(PAYLINES.length, 5);
  PAYLINES.forEach(path => assert.equal(path.length, REELS_COUNT));
  assert.equal(REEL_STRIPS.length, REELS_COUNT);
  // Star and strawberry (last-reel-only wilds) must never appear on reels 1-2
  for (let col = 0; col < REELS_COUNT - 1; col++) {
    assert.ok(!REEL_STRIPS[col].includes('star'));
    assert.ok(!REEL_STRIPS[col].includes('strawberry'));
  }
});
