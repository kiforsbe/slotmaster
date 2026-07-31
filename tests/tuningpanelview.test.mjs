import test from 'node:test';
import assert from 'node:assert/strict';
import { openTuningPanel } from '../core/ui/dev/tuning/TuningPanelView.js';

function makeElement({ empty = false } = {}) {
  return {
    style: {},
    dataset: {},
    appendChild(child) { this.child = child; },
    addEventListener() {},
    querySelector() { return empty ? null : makeElement(); },
    querySelectorAll() { return []; },
  };
}

test('openTuningPanel builds its controls without relying on facade globals', () => {
  const originalDocument = globalThis.document;
  const panel = makeElement({ empty: true });
  globalThis.document = {
    createElement: makeElement,
    querySelectorAll: () => [],
  };

  try {
    openTuningPanel({
      paytable: {},
      reelFrequencyTables: [],
      tuneConfig: { reelsCount: 3, targetTriggerRatePct: 0.6 },
      panel,
    });
  } finally {
    globalThis.document = originalDocument;
  }

  assert.match(panel.child.innerHTML, /tune-target-trigger-spins/);
  assert.equal(panel.style.display, 'block');
});
