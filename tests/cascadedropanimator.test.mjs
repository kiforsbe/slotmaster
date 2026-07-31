import test from 'node:test';
import assert from 'node:assert/strict';
import { CascadeDropAnimator } from '../core/engine/animators/CascadeDropAnimator.js';

test('all-at-once cascade clear uses engine turbo state when stopping', () => {
  const callbacks = [];
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousDateNow = Date.now;
  let now = 1000;
  globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
  Date.now = () => now;

  try {
    const animator = new CascadeDropAnimator(null, null, {
      normalClearDurationMs: 0,
      turboClearDurationMs: 0,
    });
    let fallCompleted = false;
    animator._spawnClearParticles = () => {};
    animator._spawnClusterWinPopups = () => {};
    animator._runFallPhase = () => { fallCompleted = true; };

    const engine = {
      config: { reelsCount: 1, rowsCount: 1, cascadeWinPreviewDurationMs: 1 },
      turboMode: false,
      _stopRequested: true,
      inFreeSpins: false,
      freeSpinsMode: null,
      reelsX: 0,
      reelsY: 0,
      symbolWidth: 1,
      symbolHeight: 1,
      betAmount: 1,
      audioController: null,
    };
    const win = { symbol: 'a', count: 3, payout: 1, winningPositions: [[0, 0]], lineIndex: 0 };
    animator._playAllAtOnceWinTransition(
      engine,
      { grid: [['a']], clusterWins: [win] },
      { grid: [['b']], fallOffsets: [[0]] },
      () => {},
    );

    assert.equal(callbacks.length, 1, 'expected the line preview frame to be scheduled');
    now = 1001;
    callbacks.shift()();
    assert.equal(callbacks.length, 1, 'expected the clear wait frame to be scheduled');
    assert.doesNotThrow(() => callbacks.shift()());
    assert.equal(fallCompleted, true);
  } finally {
    if (previousRequestAnimationFrame) globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    else delete globalThis.requestAnimationFrame;
    Date.now = previousDateNow;
  }
});
