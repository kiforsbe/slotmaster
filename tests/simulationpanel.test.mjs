import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReelFrequencyTablesForCopy } from '../core/SimulationPanel.js';

test('formatReelFrequencyTablesForCopy preserves distinct small frequencies instead of collapsing them', () => {
  // Reproduces the bookbookbook bug: several genuinely distinct tuned frequencies under 1
  // all rounded to the same fixed-1-decimal-place value ("0.1" or "0.2"), silently
  // corrupting the tuned result once pasted back into game.js - book (0.051) and explorer
  // (0.079) both became "0.1", a symbol nearly 2x rarer than another reading back as
  // identical. That collapse of book's frequency alone was enough to blow RTP up to ~390%.
  const table = {
    defaults: {},
    symbols: {
      book:     { frequency: 0.051 },
      explorer: { frequency: 0.079 },
      tut:      { frequency: 0.157 },
    },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /book:\s*\{ frequency: 0\.051 \}/);
  assert.match(output, /explorer:\s*\{ frequency: 0\.079 \}/);
  assert.match(output, /tut:\s*\{ frequency: 0\.157 \}/);
});

test('formatReelFrequencyTablesForCopy still reads cleanly for larger fruitmachine-scale frequencies', () => {
  const table = { defaults: {}, symbols: { bar: { frequency: 25.3 }, clover: { frequency: 8 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /bar:\s*\{ frequency: 25\.3 \}/);
  assert.match(output, /clover:\s*\{ frequency: 8 \}/);
});

test('formatReelFrequencyTablesForCopy still includes fixed/minFrequency/maxFrequency fields', () => {
  const table = {
    defaults: {},
    symbols: { star: { frequency: 24, fixed: true }, bar: { frequency: 10, minFrequency: 2, maxFrequency: 20 } },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /star:\s*\{ frequency: 24, fixed: true \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, minFrequency: 2, maxFrequency: 20 \}/);
});

test('formatReelFrequencyTablesForCopy includes minStack on a symbol that sets it', () => {
  const table = { defaults: {}, symbols: { stacked: { frequency: 10, minStack: 3 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /stacked:\s*\{ frequency: 10, minStack: 3 \}/);
});

test('formatReelFrequencyTablesForCopy emits minStack/minFrequency/maxFrequency in a non-empty defaults block', () => {
  const table = { defaults: { minStack: 2, minFrequency: 1, maxFrequency: 50 }, symbols: { bar: { frequency: 10 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /defaults:\s*\{ minStack: 2, minFrequency: 1, maxFrequency: 50 \}/);
});

test('formatReelFrequencyTablesForCopy emits a non-empty defaults block', () => {
  const table = { defaults: { minGap: 4, maxStack: 2 }, symbols: { bar: { frequency: 10 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /defaults:\s*\{ minGap: 4, maxStack: 2 \}/);
});

test('formatReelFrequencyTablesForCopy includes minGap/maxStack on a symbol that overrides them', () => {
  const table = { defaults: {}, symbols: { book: { frequency: 0.051, minGap: 5 }, bar: { frequency: 10, maxStack: 1 } } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /book:\s*\{ frequency: 0\.051, minGap: 5 \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, maxStack: 1 \}/);
});
