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
    book:     { frequency: 0.051 },
    explorer: { frequency: 0.079 },
    tut:      { frequency: 0.157 },
  };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /book:\s*\{ frequency: 0\.051 \}/);
  assert.match(output, /explorer:\s*\{ frequency: 0\.079 \}/);
  assert.match(output, /tut:\s*\{ frequency: 0\.157 \}/);
});

test('formatReelFrequencyTablesForCopy still reads cleanly for larger fruitmachine-scale frequencies', () => {
  const table = { bar: { frequency: 25.3 }, clover: { frequency: 8 } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /bar:\s*\{ frequency: 25\.3 \}/);
  assert.match(output, /clover:\s*\{ frequency: 8 \}/);
});

test('formatReelFrequencyTablesForCopy still includes fixed/min/max fields', () => {
  const table = { star: { frequency: 24, fixed: true }, bar: { frequency: 10, min: 2, max: 20 } };
  const output = formatReelFrequencyTablesForCopy([table]);
  assert.match(output, /star:\s*\{ frequency: 24, fixed: true \}/);
  assert.match(output, /bar:\s*\{ frequency: 10, min: 2, max: 20 \}/);
});
