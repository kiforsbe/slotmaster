import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWins, checkExpandingWins, checkWildLineWins, generateReel, resolveFrequencyBounds } from '../core/math/SlotMath.js';

test('generateReel never places a symbol whose frequency is explicitly 0', () => {
  const paytable = {
    common:  { frequency: 10 },
    rare:    { frequency: 1 },
    never:   { frequency: 0 },
  };
  const reel = generateReel(paytable, 200, 42);
  assert.ok(!reel.includes('never'), 'a symbol with frequency: 0 must never appear on the reel');
  assert.ok(reel.includes('common'));
  assert.ok(reel.includes('rare'));
});

test('generateReel spaces a triggerFreeSpins symbol by its default gap, reading paytable separately', () => {
  // Per-reel frequency tables (games/*/game.js's FREQUENCY_REELn) carry only `.frequency` -
  // spacing for a free-spins-triggering symbol comes from the real paytable's
  // triggerFreeSpins flag, passed as the 6th arg, not from anything on the weights table.
  const reelWeights = {
    scatter: { frequency: 1 },
    filler:  { frequency: 30 },
  };
  const paytable = {
    scatter: { triggerFreeSpins: true },
    filler:  { triggerFreeSpins: false },
  };
  const reel = generateReel(reelWeights, 60, 7, [], 3, paytable);
  const positions = reel.reduce((acc, s, i) => { if (s === 'scatter') acc.push(i); return acc; }, []);
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 3, `expected scatter symbols at least 3 apart, got positions ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel defaults its paytable param to the weights table itself (backward compatible)', () => {
  // A caller passing one combined frequency+triggerFreeSpins table (the old, pre-per-reel
  // model style) must keep working unchanged - paytable defaults to reelWeights when omitted.
  const combined = {
    scatter: { frequency: 1, triggerFreeSpins: true },
    filler:  { frequency: 30, triggerFreeSpins: false },
  };
  const reel = generateReel(combined, 60, 7);
  const positions = reel.reduce((acc, s, i) => { if (s === 'scatter') acc.push(i); return acc; }, []);
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 3, `expected scatter symbols at least 3 apart, got positions ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel applies an explicit per-symbol minGap, structured shape', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      rare:   { frequency: 1, minGap: 6 },
      filler: { frequency: 30 },
    },
  };
  const reel = generateReel(reelWeights, 60, 3);
  const positions = reel.reduce((acc, s, i) => { if (s === 'rare') acc.push(i); return acc; }, []);
  assert.ok(positions.length > 0, 'expected "rare" to actually appear on the built reel');
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 6, `expected rare at least 6 apart, got ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel applies a reel-level default minGap when a symbol does not override it', () => {
  const reelWeights = {
    defaults: { minGap: 5 },
    symbols: {
      rare:   { frequency: 1 },
      filler: { frequency: 30 },
    },
  };
  const reel = generateReel(reelWeights, 60, 3);
  const positions = reel.reduce((acc, s, i) => { if (s === 'rare') acc.push(i); return acc; }, []);
  assert.ok(positions.length > 0, 'expected "rare" to actually appear on the built reel');
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 5, `expected rare at least 5 apart (reel default), got ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel lets a per-symbol minGap override the reel default', () => {
  const reelWeights = {
    defaults: { minGap: 2 },
    symbols: {
      rare:   { frequency: 1, minGap: 6 },
      filler: { frequency: 30 },
    },
  };
  const reel = generateReel(reelWeights, 60, 3);
  const positions = reel.reduce((acc, s, i) => { if (s === 'rare') acc.push(i); return acc; }, []);
  assert.ok(positions.length > 0, 'expected "rare" to actually appear on the built reel');
  for (let a = 0; a < positions.length; a++) {
    for (let b = a + 1; b < positions.length; b++) {
      const d = Math.abs(positions[a] - positions[b]);
      const circularDist = Math.min(d, reel.length - d);
      assert.ok(circularDist >= 6, `expected rare at least 6 apart (symbol override beats reel default of 2), got ${positions[a]} and ${positions[b]}`);
    }
  }
});

test('generateReel caps consecutive runs of a symbol via maxStack', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      common: { frequency: 1, maxStack: 2 },
      filler: { frequency: 1 },
    },
  };
  const reel = generateReel(reelWeights, 60, 11);
  assert.ok(reel.includes('common'), 'expected "common" to actually appear on the built reel');
  let runLen = 0;
  for (let i = 0; i < reel.length; i++) {
    const prevIdx = (i - 1 + reel.length) % reel.length;
    runLen = (reel[i] === 'common' && reel[prevIdx] === 'common') ? runLen + 1 : (reel[i] === 'common' ? 1 : 0);
    assert.ok(runLen <= 2, `expected no run of "common" longer than 2, found a run at position ${i}`);
  }
});

test('generateReel forms runs of at least minStack whenever a clustered symbol appears', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      stacked: { frequency: 1, minStack: 3 },
      filler:  { frequency: 5 },
    },
  };
  const reel = generateReel(reelWeights, 100, 5);
  assert.ok(reel.includes('stacked'), 'expected "stacked" to actually appear on the built reel');
  const n = reel.length;
  let seam = -1;
  for (let i = 0; i < n; i++) { if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; } }
  assert.notEqual(seam, -1, 'reel should not be a single uniform symbol');
  let i = 0;
  while (i < n) {
    const idx = (seam + i) % n;
    if (reel[idx] === 'stacked') {
      let runLen = 1;
      while (runLen < n && reel[(seam + i + runLen) % n] === 'stacked') runLen++;
      assert.ok(runLen >= 3, `expected every "stacked" run to be at least 3 long, found a run of ${runLen} at position ${idx}`);
      i += runLen;
    } else {
      i++;
    }
  }
});

test('generateReel caps a clustered symbol\'s own run size via maxStack, without merging separate clusters over that cap', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      stacked: { frequency: 1, minStack: 2, maxStack: 4 },
      filler:  { frequency: 3 },
    },
  };
  const reel = generateReel(reelWeights, 150, 9);
  assert.ok(reel.includes('stacked'), 'expected "stacked" to actually appear on the built reel');
  const n = reel.length;
  let seam = -1;
  for (let i = 0; i < n; i++) { if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; } }
  let i = 0;
  while (i < n) {
    const idx = (seam + i) % n;
    if (reel[idx] === 'stacked') {
      let runLen = 1;
      while (runLen < n && reel[(seam + i + runLen) % n] === 'stacked') runLen++;
      assert.ok(runLen <= 4, `expected no "stacked" run longer than 4, found a run of ${runLen} at position ${idx}`);
      i += runLen;
    } else {
      i++;
    }
  }
});

test('generateReel spaces clusters apart (not individual stops within a cluster) once minStack > 1 and minGap is set', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      stacked: { frequency: 1, minStack: 2, minGap: 20 },
      filler:  { frequency: 20 },
    },
  };
  const reel = generateReel(reelWeights, 1000, 3);
  const n = reel.length;
  let seam = -1;
  for (let i = 0; i < n; i++) { if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; } }
  const runs = [];
  let i = 0;
  while (i < n) {
    const idx = (seam + i) % n;
    if (reel[idx] === 'stacked') {
      let runLen = 1;
      while (runLen < n && reel[(seam + i + runLen) % n] === 'stacked') runLen++;
      runs.push({ start: idx, length: runLen });
      i += runLen;
    } else {
      i++;
    }
  }
  assert.ok(runs.length >= 2, `expected at least 2 clusters to compare distances between, got ${runs.length}`);
  const circularDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, n - d); };
  for (let a = 0; a < runs.length; a++) {
    for (let b = a + 1; b < runs.length; b++) {
      const dist = circularDist(runs[a].start, runs[b].start);
      assert.ok(dist >= 20, `expected clusters at least 20 apart (by start position), got ${dist} between clusters at ${runs[a].start} and ${runs[b].start}`);
    }
  }
});

test('generateReel with every symbol at minStack: 1 (the default) is byte-identical to before minStack existed', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      common: { frequency: 1, maxStack: 2 },
      filler: { frequency: 1 },
    },
  };
  const withDefaultMinStack = generateReel(reelWeights, 60, 11);
  const explicitlyOne = generateReel(
    { defaults: {}, symbols: { common: { frequency: 1, maxStack: 2, minStack: 1 }, filler: { frequency: 1, minStack: 1 } } },
    60, 11
  );
  assert.deepEqual(withDefaultMinStack, explicitlyOne);
});

test('generateReel with stackChance: 0 never lets a minStack>1 symbol form a run - every occurrence is a lone single', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      stacked: { frequency: 1, minStack: 2, maxStack: 4, stackChance: 0 },
      filler:  { frequency: 3 },
    },
  };
  const reel = generateReel(reelWeights, 200, 7);
  assert.ok(reel.includes('stacked'), 'expected "stacked" to actually appear on the built reel');
  const n = reel.length;
  let seam = -1;
  for (let i = 0; i < n; i++) { if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; } }
  let i = 0;
  while (i < n) {
    const idx = (seam + i) % n;
    if (reel[idx] === 'stacked') {
      let runLen = 1;
      while (runLen < n && reel[(seam + i + runLen) % n] === 'stacked') runLen++;
      assert.equal(runLen, 1, `expected every "stacked" occurrence isolated at stackChance: 0, found a run of ${runLen} at position ${idx}`);
      i += runLen;
    } else {
      i++;
    }
  }
});

test('generateReel with a fractional stackChance mixes lone singles and valid min-max stacks, never anything in between', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      stacked: { frequency: 1, minStack: 2, maxStack: 4, stackChance: 0.5 },
      filler:  { frequency: 3 },
    },
  };
  const reel = generateReel(reelWeights, 300, 42);
  const n = reel.length;
  let seam = -1;
  for (let i = 0; i < n; i++) { if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; } }
  const runs = [];
  let i = 0;
  while (i < n) {
    const idx = (seam + i) % n;
    if (reel[idx] === 'stacked') {
      let runLen = 1;
      while (runLen < n && reel[(seam + i + runLen) % n] === 'stacked') runLen++;
      runs.push(runLen);
      i += runLen;
    } else {
      i++;
    }
  }
  assert.ok(runs.some(r => r === 1), 'expected at least one lone single at stackChance: 0.5');
  assert.ok(runs.some(r => r > 1), 'expected at least one stack at stackChance: 0.5');
  assert.ok(runs.every(r => r === 1 || (r >= 2 && r <= 4)), `expected every run to be a lone single or a 2-4 stack, got runs: ${runs.join(',')}`);
});

test('generateReel resolves stackChance as symbol override -> reel defaults -> built-in default of 1 (always stack)', () => {
  const reelWeights = {
    defaults: { stackChance: 0 },
    symbols: {
      stacked:      { frequency: 1, minStack: 2, maxStack: 3 }, // inherits the reel default of 0
      alwaysStack:  { frequency: 1, minStack: 2, maxStack: 3, stackChance: 1 }, // overrides back to 1
      filler:       { frequency: 3 },
    },
  };
  const reel = generateReel(reelWeights, 300, 3);
  const n = reel.length;

  function maxRunLength(symbol) {
    let seam = -1;
    for (let i = 0; i < n; i++) { if (reel[i] !== reel[(i - 1 + n) % n]) { seam = i; break; } }
    let max = 0;
    let i = 0;
    while (i < n) {
      const idx = (seam + i) % n;
      if (reel[idx] === symbol) {
        let runLen = 1;
        while (runLen < n && reel[(seam + i + runLen) % n] === symbol) runLen++;
        max = Math.max(max, runLen);
        i += runLen;
      } else {
        i++;
      }
    }
    return max;
  }

  assert.equal(maxRunLength('stacked'), 1, 'reel-level stackChance: 0 default should keep "stacked" from ever forming a run');
  assert.ok(maxRunLength('alwaysStack') >= 2, '"alwaysStack"\'s own stackChance: 1 should override the reel default back to always-stack');
});

test('generateReel degrades gracefully (best effort) when a symbol has fewer occurrences than its own minStack', () => {
  const reelWeights = {
    defaults: {},
    symbols: {
      rare:   { frequency: 0.05, minStack: 50 },
      filler: { frequency: 20 },
    },
  };
  const reel = generateReel(reelWeights, 100, 1);
  // Must not throw, hang, or drop the symbol entirely - best effort, same tolerance as
  // minGap/maxStack already have for a reel too dense/sparse to fully satisfy. (Exact length
  // isn't asserted here - the existing Math.max(1, round(...)) floor on tiny weights can push
  // the total slightly past targetLength regardless of minStack, a pre-existing characteristic
  // unrelated to this feature.)
  assert.ok(reel.includes('rare'), 'expected "rare" to still appear at least once, even under-clustered');
  assert.ok(reel.length >= 99 && reel.length <= 102, `expected reel length close to 100, got ${reel.length}`);
});

test('generateReel treats a table with no .symbols key as a flat legacy symbol map', () => {
  const flat = { a: { frequency: 10 }, b: { frequency: 1 } };
  const reel = generateReel(flat, 50, 5);
  assert.ok(reel.includes('a'));
  assert.ok(reel.includes('b'));
});

test('resolveFrequencyBounds returns null for both when neither symbol nor reel defaults set them', () => {
  const reelTable = { defaults: {}, symbols: { bar: { frequency: 10 } } };
  const bounds = resolveFrequencyBounds(reelTable, 'bar');
  assert.deepEqual(bounds, { minFrequency: null, maxFrequency: null });
});

test('resolveFrequencyBounds reads a per-symbol override', () => {
  const reelTable = { defaults: {}, symbols: { bar: { frequency: 10, minFrequency: 2, maxFrequency: 20 } } };
  const bounds = resolveFrequencyBounds(reelTable, 'bar');
  assert.deepEqual(bounds, { minFrequency: 2, maxFrequency: 20 });
});

test('resolveFrequencyBounds falls back to the reel-level default when the symbol has no override', () => {
  const reelTable = { defaults: { minFrequency: 1, maxFrequency: 50 }, symbols: { bar: { frequency: 10 } } };
  const bounds = resolveFrequencyBounds(reelTable, 'bar');
  assert.deepEqual(bounds, { minFrequency: 1, maxFrequency: 50 });
});

test('resolveFrequencyBounds lets a per-symbol override win over the reel default, independently per bound', () => {
  const reelTable = {
    defaults: { minFrequency: 1, maxFrequency: 50 },
    symbols: { bar: { frequency: 10, maxFrequency: 20 } }, // only overrides max, not min
  };
  const bounds = resolveFrequencyBounds(reelTable, 'bar');
  assert.deepEqual(bounds, { minFrequency: 1, maxFrequency: 20 });
});

test('resolveFrequencyBounds treats a table with no .symbols key as a flat legacy symbol map', () => {
  const flat = { bar: { frequency: 10, minFrequency: 3 } };
  const bounds = resolveFrequencyBounds(flat, 'bar');
  assert.deepEqual(bounds, { minFrequency: 3, maxFrequency: null });
});

test('checkWins accepts arbitrary grid shapes (3x3)', () => {
  const grid3x3 = [
    ['a', 'a', 'a'],
    ['a', 'a', 'a'],
    ['a', 'a', 'a'],
  ];
  const paylines3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
  const paytable3 = { a: { payout: [0, 0, 5], paymode: 'line' } };

  const result = checkWins(grid3x3, paytable3, paylines3, 3, null, null);
  assert.equal(result.lineWins.length, 3);
  assert.equal(result.totalLinePayoutMultiplier, 15);
});

test('checkWins pays a line win when paymode is omitted (defaults to line)', () => {
  const grid3x3 = [
    ['a', 'a', 'a'],
    ['a', 'a', 'a'],
    ['a', 'a', 'a'],
  ];
  const paylines3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
  const paytable3 = { a: { payout: [0, 0, 5] } }; // no paymode field at all
  const result = checkWins(grid3x3, paytable3, paylines3, 3, null, null);
  assert.equal(result.lineWins.length, 3);
  assert.equal(result.totalLinePayoutMultiplier, 15);
});

test('checkWins does not pay a scatter-typed symbol as a line win when paymode is omitted (defaults to any)', () => {
  const grid3x3 = [
    ['s', 's', 's'],
    ['s', 's', 's'],
    ['s', 's', 's'],
  ];
  const paylines3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
  const paytable3 = { s: { payout: [0, 0, 10, 0, 0], type: 'scatter' } }; // no paymode field
  const result = checkWins(grid3x3, paytable3, paylines3, 3, null, 's');
  assert.equal(result.lineWins.length, 0, 'a scatter-typed symbol with implicit paymode "any" must not be paid as a line win');
});

test('checkWins preserves original 5-reel behavior', () => {
  const grid5x3 = [
    ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a']
  ];
  const paylines5 = [[1, 1, 1, 1, 1]];
  const paytable5 = { a: { payout: [0, 0, 0, 0, 20], paymode: 'line' } };
  const result = checkWins(grid5x3, paytable5, paylines5, 1, null, null);
  assert.equal(result.totalLinePayoutMultiplier, 20);
});

test('checkExpandingWins accepts non-5-reel, non-3-row grids', () => {
  const expPaytable = { x: { payout: [0, 50, 500] } };
  const paylines3 = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
  const gridExp = [
    ['x', 'b', 'b'], ['x', 'b', 'b'], ['b', 'b', 'b']
  ];
  const expResult = checkExpandingWins(gridExp, 'x', expPaytable, paylines3, 3);
  assert.equal(expResult.expandingReels.length, 2);
  assert.equal(expResult.expandedPositions.length, 6);
});

test('checkWildLineWins - reel-restricted dual-wild rules', () => {
  const PAYTABLE = {
    bar:        { payout: [0, 0, 10] },
    clover:     { payout: [0, 0, 4], wildPenalty: 1 },
    pear:       { payout: [0, 0, 3] },
    grapes:     { payout: [0, 0, 2], wildPenalty: 1 },
    cherries:   { payout: [0.40, 0.80, 1.60] },
    star:       { payout: [0, 0, 0], wild: true, wildExcludes: ['cherries'] },
    strawberry: { payout: [0, 0, 0], wild: true, wildOnly: ['cherries'], aloneBonus: 0.80 },
  };

  function payoutFor(symbols) {
    const grid = [[symbols[0]], [symbols[1]], [symbols[2]]];
    const result = checkWildLineWins(grid, PAYTABLE, [[0, 0, 0]], 1);
    return result.totalLinePayoutMultiplier;
  }

  const cases = [
    [['bar', 'bar', 'bar'], 10],
    [['grapes', 'grapes', 'star'], 1],
    [['pear', 'pear', 'star'], 3],
    [['cherries', 'cherries', 'star'], 0.80],
    [['cherries', 'cherries', 'strawberry'], 1.60],
    [['bar', 'bar', 'strawberry'], 0.80],
    [['cherries', 'bar', 'strawberry'], 1.20],
    [['pear', 'clover', 'strawberry'], 0.80],
    [['bar', 'clover', 'bar'], 0],
  ];

  for (const [symbols, expected] of cases) {
    const actual = payoutFor(symbols);
    assert.ok(Math.abs(actual - expected) < 1e-9, `${symbols.join(',')} -> ${actual} (expected ${expected})`);
  }
});
