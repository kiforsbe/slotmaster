import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreSlotEngine } from '../core/engine/CoreSlotEngine.js';

function stubCanvas() {
  return { width: 800, height: 600, getContext: () => ({}) };
}

function noAnimation() {
  return {
    playEntrance: (step, ctx, onDone) => onDone(),
    playTransition: (prev, next, ctx, onDone) => onDone(),
  };
}

test('CoreSlotEngine starts idle with the given balance and no active spin', () => {
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
    animator: noAnimation(),
    renderer: { draw: () => {} },
  });
  assert.equal(engine.state, 'idle');
  assert.equal(engine.balance, 1000);
  assert.equal(engine.inFreeSpins, false);
  assert.equal(engine.spinSequence, null);
});

test('spin() moves idle -> spinning -> showing_wins when the mechanic reports a payout', async () => {
  const states = [];
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: {
      resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 5 }], scatterWin: null }),
    },
    animator: noAnimation(),
    renderer: { draw: () => {} },
    onStateChange: (s) => states.push(s),
  });

  await engine.spin(42);

  assert.equal(engine.state, 'showing_wins');
  assert.deepEqual(states, ['spinning', 'evaluating', 'showing_wins']);
  assert.equal(engine.lastSpinSeed, 42);
  assert.deepEqual(engine.grid, [['a']]);
});

test('spin() moves idle -> spinning -> idle when the mechanic reports no payout', async () => {
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
    animator: noAnimation(),
    renderer: { draw: () => {} },
  });

  await engine.spin(1);

  assert.equal(engine.state, 'idle');
});

test('spin() plays every step of a multi-step (cascade) sequence in order', async () => {
  const playedGrids = [];
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: {
      resolveLiveSpin: () => ({
        steps: [
          { grid: [['a']], payout: 2 },
          { grid: [['b']], payout: 3 },
        ],
        scatterWin: null,
      }),
    },
    animator: {
      playEntrance: (step, ctx, onDone) => { playedGrids.push(step.grid); onDone(); },
      playTransition: (prev, next, ctx, onDone) => onDone(),
    },
    renderer: { draw: () => {} },
  });

  await engine.spin(1);

  assert.deepEqual(playedGrids, [[['a']], [['b']]]);
  assert.equal(engine.lastWin, (2 + 3) * (engine.betPerLine * engine.linesCount));
});

test('enterFreeSpins sets inFreeSpins and the spins counters; exitFreeSpins clears them', () => {
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
    animator: noAnimation(),
    renderer: { draw: () => {} },
  });

  engine.enterFreeSpinsIntro();
  assert.equal(engine.state, 'free_spins_intro');

  engine.enterFreeSpins(10);
  assert.equal(engine.inFreeSpins, true);
  assert.equal(engine.freeSpinsRemaining, 10);
  assert.equal(engine.freeSpinsTotal, 10);

  engine.retriggerFreeSpins(5);
  assert.equal(engine.freeSpinsRemaining, 15);
  assert.equal(engine.freeSpinsTotal, 15);

  engine.exitFreeSpins();
  assert.equal(engine.inFreeSpins, false);
  assert.equal(engine.freeSpinsRemaining, 0);
});

test('spin() calls audioController.onSpinStart and onWin when configured', async () => {
  const calls = [];
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 5 }], scatterWin: null }) },
    animator: noAnimation(),
    renderer: { draw: () => {} },
    audioController: {
      onSpinStart: () => calls.push('spinStart'),
      onWin: (amt) => calls.push(`win:${amt}`),
      onScatterTrigger: () => calls.push('scatter'),
    },
  });

  await engine.spin(1);

  assert.deepEqual(calls, ['spinStart', `win:${engine.lastWin}`]);
});

test('spin() calls onScatterTrigger and audioController.onScatterTrigger when the mechanic reports a trigger', async () => {
  const scatterCalls = [];
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: {
      resolveLiveSpin: () => ({
        steps: [{ grid: [['a']], payout: 0 }],
        scatterWin: { triggerFreeSpins: true, count: 3 },
      }),
    },
    animator: noAnimation(),
    renderer: { draw: () => {} },
    onScatterTrigger: (count) => scatterCalls.push(count),
    audioController: { onSpinStart: () => {}, onScatterTrigger: () => scatterCalls.push('audio') },
  });

  await engine.spin(1);

  assert.deepEqual(scatterCalls, [3, 'audio']);
});

test('a spin queued via requestSpin while busy runs once the current spin settles', async () => {
  let spinCount = 0;
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => { spinCount += 1; return { steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }; } },
    animator: noAnimation(),
    renderer: { draw: () => {} },
  });

  engine.state = 'spinning';
  engine.requestSpin();
  assert.equal(engine.pendingSpinRequest, true);
  assert.equal(spinCount, 0);
});
