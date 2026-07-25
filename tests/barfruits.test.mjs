import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins } from '../core/SpinSimulator.js';
import {
  REELS_COUNT, ROWS_COUNT, PAYTABLE, PAYLINES, REEL_STRIPS, REEL_LENGTH, BET_PER_LINE, LINES_COUNT,
} from '../games/barfruits/game.js';

test('bar fruits paylines and reel strips have consistent shapes', () => {
  assert.equal(PAYLINES.length, 10);
  PAYLINES.forEach(path => {
    assert.equal(path.length, REELS_COUNT);
    path.forEach(row => assert.ok(row >= 0 && row < ROWS_COUNT));
  });
  assert.equal(REEL_STRIPS.length, REELS_COUNT);
  REEL_STRIPS.forEach(strip => assert.equal(strip.length, REEL_LENGTH));
});

test('bar fruits reels space the star scatter at least ROWS_COUNT apart (minGap)', () => {
  // With 3 visible rows, two stars closer than that on the same reel strip could land in
  // the same visible window at once - FREQUENCY_REELn sets an explicit minGap: 3 on star
  // specifically to prevent that (see the comment above FREQUENCY_REEL1 in game.js).
  REEL_STRIPS.forEach(strip => {
    const positions = [];
    strip.forEach((sym, i) => { if (sym === 'star') positions.push(i); });
    assert.ok(positions.length > 0, 'expected star to actually appear on this reel');

    const n = strip.length;
    const circularDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n - d); };
    for (let a = 0; a < positions.length; a++) {
      for (let b = a + 1; b < positions.length; b++) {
        assert.ok(circularDist(positions[a], positions[b]) >= ROWS_COUNT);
      }
    }
  });
});

test('bar fruits simulated RTP is a finite, sane number (baseline is untuned - see README)', () => {
  const config = {
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    paylines: PAYLINES,
    scatterSymbol: 'star',
  };
  const results = simulateSpins(config, 150000, BET_PER_LINE, LINES_COUNT);

  // This game hasn't been through a TUNE FREQUENCIES pass yet (that requires the in-browser
  // panel) - unlike fruitmachine/bookbookbook's tight regression bands, this only guards
  // against a gross break (e.g. checkWins/generateReel/paytable wiring silently broken),
  // not a specific target RTP.
  assert.ok(
    Number.isFinite(results.rtpRaw) && results.rtpRaw > 0 && results.rtpRaw < 5,
    `RTP ${results.rtp} is not a sane value - PAYTABLE/FREQUENCY_REELn wiring may be broken`
  );
});
