import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { simulateSpins } from '../core/simulation/SpinSimulator.js';
import {
  REELS_COUNT, ROWS_COUNT, PAYTABLE, PAYLINES, REEL_STRIPS, REEL_LENGTH, BET_PER_LINE, LINES_COUNT,
  STACKED_SYMBOLS, SURFER_COLORS, BONUS_REEL_INDEXES, BONUS_SYMBOL,
} from '../games/beachparty/game.js';

test('beachparty grid shape: 5 reels, 5 rows', () => {
  assert.equal(REELS_COUNT, 5);
  assert.equal(ROWS_COUNT, 5);
});

test('beachparty paylines and reel strips have consistent shapes', () => {
  assert.equal(PAYLINES.length, 30);
  PAYLINES.forEach(path => {
    assert.equal(path.length, REELS_COUNT);
    path.forEach(row => assert.ok(row >= 0 && row < ROWS_COUNT));
  });
  assert.equal(REEL_STRIPS.length, REELS_COUNT);
  REEL_STRIPS.forEach(strip => assert.equal(strip.length, REEL_LENGTH));
});

test('every stacked-symbol variant list has exactly ROWS_COUNT entries, one per surfer color', () => {
  assert.deepEqual(Object.keys(STACKED_SYMBOLS).sort(), [...SURFER_COLORS].sort());
  Object.values(STACKED_SYMBOLS).forEach(variants => assert.equal(variants.length, ROWS_COUNT));
});

test('the bonus symbol only appears on reels 1, 3, 5 (indexes 0, 2, 4)', () => {
  assert.deepEqual(BONUS_REEL_INDEXES, [0, 2, 4]);
  REEL_STRIPS.forEach((strip, reelIndex) => {
    const appears = strip.includes(BONUS_SYMBOL);
    if (BONUS_REEL_INDEXES.includes(reelIndex)) {
      assert.ok(appears, `expected ${BONUS_SYMBOL} on reel ${reelIndex}`);
    } else {
      assert.ok(!appears, `did not expect ${BONUS_SYMBOL} on reel ${reelIndex}`);
    }
  });
});

test('every paytable symbol referenced by STACKED_SYMBOLS or as a plain symbol exists as a real tile name', () => {
  // Sanity check against the actual sheet, so a typo'd symbol name fails loudly here instead of
  // silently drawing nothing in the browser.
  const tilesJson = JSON.parse(
    fs.readFileSync(new URL('../games/beachparty/assets/symbols/symbols.tiles.json', import.meta.url), 'utf8')
  );
  const tileNames = new Set(tilesJson.tiles.map(t => t.name));
  Object.keys(PAYTABLE).forEach(symbol => assert.ok(tileNames.has(symbol), `${symbol} missing from symbols.tiles.json`));
  Object.values(STACKED_SYMBOLS).flat().forEach(name => assert.ok(tileNames.has(name), `${name} missing from symbols.tiles.json`));
});

test('beachparty simulated RTP is a finite, sane number (baseline is untuned - see README)', () => {
  const config = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paytable: PAYTABLE,
    reelStrips: REEL_STRIPS, paylines: PAYLINES,
  };
  const results = simulateSpins(config, 150000, BET_PER_LINE, LINES_COUNT);
  assert.ok(
    Number.isFinite(results.rtpRaw) && results.rtpRaw > 0 && results.rtpRaw < 5,
    `RTP ${results.rtp} is not a sane value - PAYTABLE/FREQUENCY_REELn wiring may be broken`
  );
});
