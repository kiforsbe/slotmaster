import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateReel } from '../core/SlotMath.js';

// Reel strips ARE shipped game data: every game builds its REEL_STRIPS by calling generateReel
// with fixed seeds at module load, so any change to how it places or spaces symbols silently
// changes that game's live reels and its RTP. These goldens exist so such a change has to be
// deliberate - if one fails, the question is not "update the hash" but "did I mean to alter
// every existing game's reels?". They were captured while optimizing _enforceMinGap's candidate
// scan, specifically to prove that optimization changed nothing.
const GOLDEN = {
  barfruits: '55f2988adc4dae19',
  bookbookbook: '9b319a4be9d7b732',
  candyfrenzy: '94506b5230d65386',
  fruitmachine: '7c6edd571e317932',
};

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// game.js modules register a window load handler at import time.
globalThis.window ??= { addEventListener() {} };

for (const game of Object.keys(GOLDEN)) {
  test(`generateReel output for ${game} is unchanged (shipped reel strips)`, async () => {
    const m = await import(`../games/${game}/game.js`);
    const tables = [m.FREQUENCY_REEL1, m.FREQUENCY_REEL2, m.FREQUENCY_REEL3,
      m.FREQUENCY_REEL4, m.FREQUENCY_REEL5, m.FREQUENCY_REEL6, m.FREQUENCY_REEL7].filter(Boolean);
    // bookbookbook doesn't export its seeds/paytable; the fallbacks only need to be STABLE for
    // this golden to be meaningful, not to match that game's own internal values.
    const seeds = m.REEL_SEEDS ?? [1234, 567, 89, 765, 3321, 111, 222];
    const len = m.REEL_LENGTH ?? 500;
    const paytable = m.PAYTABLE ?? {};
    const all = tables.map((rt, i) => generateReel(rt, len, seeds[i % seeds.length], [], 3, paytable).join('|')).join('#');
    assert.equal(hash(all), GOLDEN[game],
      `${game}'s generated reel strips changed. This alters the live game's reels and RTP - only update this golden if that was intended.`);
  });
}

test('generateReel output is unchanged for a dense, tightly-spaced, long strip', () => {
  // The case that actually exercises _enforceMinGap's repair loop hard: one symbol taking most of
  // the strip, a wide gap requirement it cannot fully satisfy, and lengths where the old
  // O(n * occurrences) candidate scan dominated the runtime.
  const stress = {
    defaults: { minGap: 9, maxStack: 3, minStack: 1 },
    symbols: { a: { frequency: 5 }, b: { frequency: 1 }, c: { frequency: 1 }, d: { frequency: 1 } },
  };
  const combined = [500, 1500, 3000]
    .map(len => [1, 42].map(seed => generateReel(stress, len, seed, [], 3, {}).join('|')).join('#'))
    .join('##');
  assert.equal(hash(combined), '62871b1dc1d467b4',
    'generateReel changed on a dense/long strip - the minGap repair path is not producing identical output');
});

test('generateReel honors minGap whenever the strip has room for it', () => {
  // 300 positions, minGap 5, `rare` occurring ~10 times: 10 * 5 = 50 << 300, so there is ample
  // room and the spacing must actually hold. (It is only best-effort when the strip is too dense
  // - a symbol needing N runs requires reelLength >= N * minGap.)
  //
  // Constraints are set on `rare` ALONE, with `defaults` left empty. generateReel runs its
  // minGap and maxStack repair passes per symbol, sequentially, over one shared array, and every
  // pass swaps positions freely - so a later symbol's repair can undo an earlier symbol's
  // spacing. Any constraint `filler` cannot satisfy makes it thrash and re-break `rare`: at 290
  // occurrences on a 300-length strip, `filler` can meet neither minGap 5 (it would need 1450
  // positions) nor maxStack 1 (it cannot be isolated at that density). Both were verified to
  // break this test when placed in `defaults`. That interaction is real and worth knowing about -
  // it is a large part of why Candy Frenzy, which puts minGap on all 12 candies at once, ends up
  // with so many violations - but it is not what this test is asserting.
  const table = {
    defaults: {},
    symbols: { rare: { frequency: 1, minGap: 5 }, filler: { frequency: 29 } },
  };
  const strip = generateReel(table, 300, 7, [], 3, {});
  const positions = [];
  for (let i = 0; i < strip.length; i++) if (strip[i] === 'rare') positions.push(i);
  assert.ok(positions.length > 1, `expected several occurrences to space out, got ${positions.length}`);
  assert.ok(positions.length * 5 <= 300, 'fixture must leave room for the gap, otherwise this asserts the impossible');

  const n = strip.length;
  const circularDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n - d); };
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      assert.ok(circularDist(positions[a], positions[b]) >= 5,
        `positions ${positions[a]} and ${positions[b]} are closer than minGap 5`);
    }
  }
});

test('generateReel stays responsive on a long strip - the minGap repair is not superlinear enough to stall a UI', () => {
  // generateReel runs on the main thread (every game builds REEL_STRIPS at import, and the tuning
  // panel regenerates them per candidate), so its cost is felt directly as UI lag. Before the
  // candidate-scan fix, 7 reels at length 3000 took ~520ms - a visible freeze. This is a generous
  // ceiling meant to catch a return to the old near-cubic behavior, not to pin an exact number.
  const table = {
    defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.1 },
    symbols: Object.fromEntries('abcdefghijkl'.split('').map(s => [s, { frequency: 1 }])),
  };
  const started = Date.now();
  for (let i = 0; i < 7; i++) generateReel(table, 3000, 100 + i, [], 3, {});
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400,
    `expected 7 reels at length 3000 to build well under 400ms, took ${elapsed}ms - the minGap repair has regressed toward its old cost`);
});
