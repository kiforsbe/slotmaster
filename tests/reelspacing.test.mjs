import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReel } from '../core/SlotMath.js';

// Properties of generateReel's symbol placement, asserted as BEHAVIOUR rather than as exact
// output. An earlier version of this file hashed generated strips and compared against goldens;
// that was dropped deliberately. Its only real job was proving the _enforceMinGap candidate-scan
// optimization changed nothing, which was verified directly against the pre-optimization
// implementation at the time. Beyond that one-off it was pure cost: reel frequencies, minGap and
// stacking settings are all things a developer changes constantly while tuning a game, and a
// test that has to be re-blessed on every such change stops being read.
//
// What is asserted here instead holds regardless of how those parameters are set.

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

test('the minGap repair does not dominate generateReel\'s cost on a long strip', () => {
  // generateReel runs on the main thread (every game builds REEL_STRIPS at import, and the tuning
  // panel regenerates them per candidate), so its cost is felt directly as UI lag. Before the
  // candidate-scan fix, 7 reels at length 3000 took ~520ms - a visible freeze - against ~11ms for
  // the identical build with spacing off, i.e. the repair was ~48x the entire rest of the work.
  // After, the same comparison is ~7x.
  //
  // Asserted as that RATIO rather than as wall-clock milliseconds on purpose. An absolute
  // threshold is load-dependent: this suite runs its files in parallel, and the same build that
  // takes 168ms alone took 466ms under full-suite CPU contention, which made a millisecond
  // assertion flaky rather than meaningful. Both halves of a ratio absorb that contention equally.
  const symbols = Object.fromEntries('abcdefghijkl'.split('').map(s => [s, { frequency: 1 }]));
  const withGap = { defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.1 }, symbols };
  const withoutGap = { defaults: { minGap: 1, maxStack: 4, minStack: 2, stackChance: 0.1 }, symbols };

  const timeOf = (table) => {
    const started = performance.now();
    for (let i = 0; i < 7; i++) generateReel(table, 3000, 100 + i, [], 3, {});
    return performance.now() - started;
  };
  timeOf(withoutGap); // warm up, so JIT compilation doesn't land entirely on the first measurement
  const baseline = Math.max(timeOf(withoutGap), 1);
  const spaced = timeOf(withGap);

  assert.ok(spaced / baseline < 20,
    `minGap enforcement cost ${(spaced / baseline).toFixed(1)}x the un-spaced build (${spaced.toFixed(0)}ms vs ${baseline.toFixed(0)}ms). It was ~48x before the candidate-scan fix and ~7x after, so this suggests a regression back toward the old O(n * occurrences) scan.`);
});
