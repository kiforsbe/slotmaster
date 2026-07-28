import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSpins } from '../core/SpinSimulator.js';
import { generateReel } from '../core/math/SlotMath.js';

// Mirrors games/bookbookbook/game.js's real PAYTABLE/PAYLINES/reel config. A moderate spin
// count keeps this fast to run on every commit; it's a regression guard against breaking the
// payline-agnostic core refactor, not a precise RTP-tuning tool (see docs/superpowers/plans -
// bookbookbook's own baseline, captured before the refactor, was RTP ~=97.05% at 1M+ spins).
const REELS_COUNT = 5;
const ROWS_COUNT = 3;
const REEL_LENGTH = 500;
const REEL_SEEDS = [1234, 567, 89, 765, 3321];
const BET_PER_LINE = 1;
const LINES_COUNT = 10;
const PAYLINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 2, 2, 2, 1], [1, 0, 0, 0, 1], [0, 1, 0, 1, 0]
];

const PAYTABLE = {
  book:     { payout: [0,  0,   2,   20,  200], frequency: 0.051, type: 'scatter', paymode: 'any',  wild: false, triggerFreeSpins: true,  friendlyName: 'Book of Books' },
  explorer: { payout: [0, 10, 100, 1000, 5000], frequency: 0.079, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'The Explorer' },
  tut:      { payout: [0,  5,  40,  400, 2000], frequency: 0.157, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Tutankhamun' },
  anubis:   { payout: [0,  5,  30,  100,  750], frequency: 0.234, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Anubis Guard' },
  scarab:   { payout: [0,  5,  30,  100,  750], frequency: 0.234, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Scarab Beetle' },
  ace:      { payout: [0,  0,   5,   40,  150], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Golden Ace' },
  king:     { payout: [0,  0,   5,   40,  150], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Pharaoh King' },
  queen:    { payout: [0,  0,   5,   30,  100], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Royal Queen' },
  jack:     { payout: [0,  0,   5,   30,  100], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Desert Jack' },
  ten:      { payout: [0,  0,   5,   30,  100], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Lucky Ten' },
};

test('bookbookbook RTP stays in expected band after payline-agnostic core refactor', () => {
  const reelStrips = REEL_SEEDS.map(seed => generateReel(PAYTABLE, REEL_LENGTH, seed));
  const config = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paytable: PAYTABLE, reelStrips,
    paylines: PAYLINES, wildSymbol: null, scatterSymbol: 'book',
    // This game's free spins really do include an expanding wild - simulateSpins no longer
    // assumes that by default (see its own hasExpandingWild doc), so it must be requested
    // explicitly to mirror bookbookbook/game.js's real engine config.
    hasExpandingWild: true,
  };
  const results = simulateSpins(config, 300000, BET_PER_LINE, LINES_COUNT);

  // Non-seeded Math.random() drives the simulation, so allow a wide band around the
  // ~97% baseline captured before this refactor - this only needs to catch a broken
  // win evaluator, not verify precise RTP tuning.
  assert.ok(
    results.rtpRaw > 0.93 && results.rtpRaw < 1.01,
    `RTP ${results.rtp} is outside the expected band - core refactor may have broken win math`
  );
});
