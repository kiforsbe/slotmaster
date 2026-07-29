import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreSlotEngine } from '../core/engine/CoreSlotEngine.js';
import { audio } from '../core/audio/SlotAudio.js';

function stubCanvas() {
  return { width: 800, height: 600, getContext: () => ({}) };
}

function noAnimation() {
  return {
    playEntrance: (engine, step, onDone) => onDone(),
    playTransition: (engine, prevStep, nextStep, onDone) => onDone(),
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

test('spin() plays only the first step\'s entrance, then transitions through every later cascade step', async () => {
  const entranceGrids = [];
  const transitionPairs = [];
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: {
      resolveLiveSpin: () => ({
        steps: [
          { grid: [['a']], payout: 2 },
          { grid: [['b']], payout: 3 },
          { grid: [['c']], payout: 0 },
        ],
        scatterWin: null,
      }),
    },
    animator: {
      playEntrance: (engine, step, onDone) => { entranceGrids.push(step.grid); onDone(); },
      playTransition: (engine, prevStep, nextStep, onDone) => { transitionPairs.push([prevStep.grid, nextStep.grid]); onDone(); },
    },
    renderer: { draw: () => {} },
  });

  await engine.spin(1);

  // playEntrance must run exactly once, for the very first grid - every later step is reached
  // only through playTransition (see CoreSlotEngine._advanceCascadeSteps). Calling playEntrance
  // again for an already-landed step was a real bug: CascadeDropAnimator would treat that
  // correct, already-displayed grid as a stale "outgoing" board to fall away, while an identical
  // copy re-entered from above - a visible double-drop on every cascade step past the first.
  assert.deepEqual(entranceGrids, [[['a']]]);
  assert.deepEqual(transitionPairs, [
    [[['a']], [['b']]],
    [[['b']], [['c']]],
  ]);
  assert.deepEqual(engine.grid, [['c']]);
  // step.payout is already money (see LineMechanic/CascadeSpinMechanic.resolveLiveSpin's own
  // docs) - CoreSlotEngine sums it as-is, no further bet scaling.
  assert.equal(engine.lastWin, 2 + 3 + 0);
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
  // enterFreeSpins immediately chains into spinFreeSpins(), which decrements freeSpinsRemaining
  // before spin() even starts (matching SlotEngine.js's own enterFreeSpins) - so one spin is
  // already "in flight" by the time this synchronous assertion runs.
  assert.equal(engine.freeSpinsRemaining, 9);
  assert.equal(engine.freeSpinsTotal, 10);

  engine.retriggerFreeSpins(5);
  assert.equal(engine.freeSpinsRemaining, 14);
  assert.equal(engine.freeSpinsTotal, 15);

  engine.exitFreeSpins();
  assert.equal(engine.inFreeSpins, false);
  // exitFreeSpins deliberately does NOT reset freeSpinsRemaining/freeSpinsTotal/
  // freeSpinsAccumulatedWin (matches SlotEngine.js) - a game's game_over handler reads
  // freeSpinsAccumulatedWin for its summary modal immediately after this call, so resetting it
  // here would always show $0. enterFreeSpins() resets these fields at the start of the next
  // round instead.
  assert.equal(engine.freeSpinsRemaining, 14);
});

test('free-spins intro pauses autoplay and ignores spin requests until entry', () => {
  const engine = new CoreSlotEngine(stubCanvas(), {
    mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
    animator: noAnimation(),
    renderer: { draw: () => {} },
  });

  engine.autoPlay = true;
  engine.pendingSpinRequest = true;
  engine.autoPlayTimer = setTimeout(() => {}, 60_000);

  engine.enterFreeSpinsIntro();

  assert.equal(engine.state, 'free_spins_intro');
  assert.equal(engine.pendingSpinRequest, false);
  assert.equal(engine.autoPlayTimer, null);

  // The triggering spin may finish its own bookkeeping and move the visible state back to
  // idle/showing_wins while the intro modal is still open. The persistent lock must survive that.
  engine._setState('idle');
  engine.handleAutoPlay();
  assert.equal(engine.autoPlayTimer, null);

  engine.requestSpin();
  assert.equal(engine.pendingSpinRequest, false);
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

test('a configured `music` map is wired into the audio engine at construction, and swapped on entering/exiting free spins', () => {
  const calls = [];
  const originalSetMusicTracks = audio.setMusicTracks;
  const originalSetMusicState = audio.setMusicState;
  audio.setMusicTracks = (tracks) => calls.push(['setMusicTracks', tracks]);
  audio.setMusicState = (state) => calls.push(['setMusicState', state]);

  try {
    const engine = new CoreSlotEngine(stubCanvas(), {
      mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
      animator: noAnimation(),
      renderer: { draw: () => {} },
      music: { main: 'theme.mp3', freespins: 'freespins.mp3' },
    });

    assert.deepEqual(calls, [
      ['setMusicTracks', { main: 'theme.mp3', freespins: 'freespins.mp3' }],
      ['setMusicState', 'main'],
    ]);

    engine.enterFreeSpins(3);
    assert.deepEqual(calls.at(-1), ['setMusicState', 'freespins']);

    engine.exitFreeSpins();
    assert.deepEqual(calls.at(-1), ['setMusicState', 'main']);
  } finally {
    audio.setMusicTracks = originalSetMusicTracks;
    audio.setMusicState = originalSetMusicState;
  }
});

test('with no `music` config, CoreSlotEngine never calls into the audio engine\'s music subsystem', () => {
  const calls = [];
  const originalSetMusicTracks = audio.setMusicTracks;
  const originalSetMusicState = audio.setMusicState;
  audio.setMusicTracks = (tracks) => calls.push(['setMusicTracks', tracks]);
  audio.setMusicState = (state) => calls.push(['setMusicState', state]);

  try {
    const engine = new CoreSlotEngine(stubCanvas(), {
      mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
      animator: noAnimation(),
      renderer: { draw: () => {} },
    });

    engine.enterFreeSpins(3);
    engine.exitFreeSpins();

    assert.deepEqual(calls, []);
  } finally {
    audio.setMusicTracks = originalSetMusicTracks;
    audio.setMusicState = originalSetMusicState;
  }
});

test('config.ducking and config.compression are always forwarded to the audio engine at construction, defaults included', () => {
  const calls = [];
  const originalSetDucking = audio.setDuckingConfig;
  const originalSetCompression = audio.setCompressionConfig;
  audio.setDuckingConfig = (v) => calls.push(['setDuckingConfig', v]);
  audio.setCompressionConfig = (v) => calls.push(['setCompressionConfig', v]);

  try {
    new CoreSlotEngine(stubCanvas(), {
      mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
      animator: noAnimation(),
      renderer: { draw: () => {} },
      ducking: { amount: 0.5 },
      compression: false,
    });
    assert.deepEqual(calls, [
      ['setDuckingConfig', { amount: 0.5 }],
      ['setCompressionConfig', false],
    ]);

    calls.length = 0;
    new CoreSlotEngine(stubCanvas(), {
      mechanic: { resolveLiveSpin: () => ({ steps: [{ grid: [['a']], payout: 0 }], scatterWin: null }) },
      animator: noAnimation(),
      renderer: { draw: () => {} },
    });
    assert.deepEqual(calls, [
      ['setDuckingConfig', undefined],
      ['setCompressionConfig', undefined],
    ]);
  } finally {
    audio.setDuckingConfig = originalSetDucking;
    audio.setCompressionConfig = originalSetCompression;
  }
});
