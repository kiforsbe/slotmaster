import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFrequencyComparisonTables } from '../core/ui/dev/tuning/TuningResultView.js';

test('completed tuning results render type-aware symbol labels and frequency deltas', () => {
  const html = renderFrequencyComparisonTables({
    paytable: { ruby: { type: 'premium', friendlyName: 'Ruby' } },
    reelFrequencyTables: [{ symbols: { ruby: { frequency: 1.25 } } }],
    tunedReelTables: [{ symbols: { ruby: { frequency: 0.75 } } }],
  });

  assert.match(html, /title="Ruby \(premium\)"/);
  assert.match(html, /1\.2500/);
  assert.match(html, /0\.7500/);
  assert.match(html, /-0\.5000/);
});
