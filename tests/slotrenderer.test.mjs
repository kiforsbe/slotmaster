import assert from 'node:assert/strict';
import test from 'node:test';
import { SlotRenderer, selectViewportBackground } from '../core/rendering/SlotRenderer.js';
import { ClusterOutlineRenderer } from '../core/rendering/ClusterOutlineRenderer.js';

function outlineContext() {
  const calls = [];
  return {
    calls,
    strokeStyles: [],
    save() {}, restore() {}, beginPath() { calls.push('begin'); }, stroke() {
      calls.push('stroke');
      this.strokeStyles.push({
        strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, lineWidth: this.lineWidth,
        lineCap: this.lineCap, lineJoin: this.lineJoin, miterLimit: this.miterLimit,
        lineDashOffset: this.lineDashOffset, shadowBlur: this.shadowBlur,
      });
    },
    moveTo(x, y) { calls.push(['move', x, y]); }, lineTo(x, y) { calls.push(['line', x, y]); },
    bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) { calls.push(['curve', cp1x, cp1y, cp2x, cp2y, x, y]); },
    setLineDash(dash) { calls.push(['dash', ...dash]); },
    arc() {}, fill() {}, fillText() {},
  };
}

const layout = { reelsX: 10, reelsY: 20, symbolWidth: 30, symbolHeight: 40 };

test('cluster outline traces only the exterior edges of the active cluster', () => {
  const ctx = outlineContext();
  new ClusterOutlineRenderer().render(ctx, {
    currentClusterWins: [{ winningPositions: [[0, 0], [1, 0]] }],
    currentClusterIndex: 0,
    layout,
    drawClusterOutline: true,
    visualizer: { pulse: false },
  });

  const lines = ctx.calls.filter(call => Array.isArray(call) && call[0] === 'line');
  assert.equal(lines.length, 6, 'two adjoining cells share one internal edge, leaving six exterior edges');
  const segments = ctx.calls.reduce((result, call, index) => {
    if (call[0] === 'move' && ctx.calls[index + 1]?.[0] === 'line') result.push([call, ctx.calls[index + 1]]);
    return result;
  }, []);
  assert.ok(!segments.some(([[, x1, y1], [, x2, y2]]) => x1 === 40 && y1 === 20 && x2 === 40 && y2 === 60), 'the shared edge is not drawn');
  assert.equal(ctx.calls.at(-1), 'stroke');
});

test('configured cluster outline also renders for payline cascade wins', () => {
  const ctx = outlineContext();
  new ClusterOutlineRenderer().render(ctx, {
    currentClusterWins: [{ lineIndex: 0, winningPositions: [[0, 0], [1, 0]] }],
    currentClusterIndex: 0,
    layout,
    paylines: [[0, 0]],
    reelsCount: 2,
    drawClusterOutline: true,
    visualizer: { pulse: false },
  });

  assert.ok(ctx.calls.filter(call => call === 'stroke').length >= 2, 'expected both the active payline and cell outline');
  const lines = ctx.calls.filter(call => Array.isArray(call) && call[0] === 'line');
  assert.equal(lines.length, 9, 'the payline adds three segments and the outline still traces six exterior edges');
});

test('payline cascade wins use clusterVisualizer styling for their active path', () => {
  const ctx = outlineContext();
  new ClusterOutlineRenderer().render(ctx, {
    currentClusterWins: [{ lineIndex: 1, winningPositions: [[0, 0], [1, 1], [2, 0]] }],
    currentClusterIndex: 0,
    layout: { reelsX: 10, reelsY: 20, reelsWidth: 90, symbolWidth: 30, symbolHeight: 40 },
    paylines: [[0, 0, 0], [0, 1, 0]],
    reelsCount: 3,
    visualizer: {
      color: '#abcdef', alpha: 0.5, lineWidth: 7, lineCap: 'square', lineJoin: 'bevel',
      miterLimit: 2, lineDash: [6, 3], lineDashOffset: 4, glow: false, pulse: false,
    },
  });

  const pathStyle = ctx.strokeStyles[0];
  assert.equal(pathStyle.strokeStyle, '#abcdef');
  assert.equal(pathStyle.globalAlpha, 0.5);
  assert.equal(pathStyle.lineWidth, 7);
  assert.equal(pathStyle.lineCap, 'square');
  assert.equal(pathStyle.lineJoin, 'bevel');
  assert.equal(pathStyle.miterLimit, 2);
  assert.equal(pathStyle.lineDashOffset, 4);
  assert.equal(pathStyle.shadowBlur, 0);
  assert.deepEqual(ctx.calls.find(call => call[0] === 'dash'), ['dash', 6, 3]);
  assert.ok(ctx.calls.some(call => call[0] === 'line'), 'expected the active payline path to be drawn');
});

test('cluster outline forwards canvas line and glow styling options', () => {
  const ctx = outlineContext();
  new ClusterOutlineRenderer().render(ctx, {
    currentClusterWins: [{ winningPositions: [[0, 0]] }], currentClusterIndex: 0,
    layout,
    drawClusterOutline: true,
    visualizer: {
      color: '#abcdef', alpha: 0.5, lineWidth: 7, lineCap: 'square', lineJoin: 'bevel',
      miterLimit: 2, lineDash: [6, 3], lineDashOffset: 4, glow: false, pulse: false,
    },
  });

  assert.equal(ctx.strokeStyle, '#abcdef');
  assert.equal(ctx.globalAlpha, 0.5);
  assert.equal(ctx.lineWidth, 7);
  assert.equal(ctx.lineCap, 'square');
  assert.equal(ctx.lineJoin, 'bevel');
  assert.equal(ctx.miterLimit, 2);
  assert.equal(ctx.lineDashOffset, 4);
  assert.equal(ctx.shadowBlur, 0);
  assert.deepEqual(ctx.calls.find(call => call[0] === 'dash'), ['dash', 6, 3]);
});

test('cluster outline uses a 10px cubic radius for its outer corners', () => {
  const ctx = outlineContext();
  new ClusterOutlineRenderer().render(ctx, {
    currentClusterWins: [{ winningPositions: [[0, 0]] }], currentClusterIndex: 0,
    layout,
    drawClusterOutline: true,
    visualizer: { cornerRadius: 10, pulse: false },
  });

  assert.equal(ctx.calls.filter(call => call[0] === 'curve').length, 4);
});

test('per-cell clear highlight remains opt-in at the grid renderer', () => {
  const renderer = new SlotRenderer();
  let highlights = 0;
  renderer._drawClearGlow = () => { highlights++; };
  const gridState = {
    grid: [['candy']], cellOffsets: [[0]],
    currentClearVariants: new Map([['0,0', { variant: 'scaleFade' }]]),
    cellBounceStartTime: [[-Infinity]], clearProgress: 0.5, bounceDuration: 200, now: 0,
  };
  const ctx = { save() {}, restore() {}, translate() {}, scale() {} };

  renderer.drawGridSymbols(ctx, null, {}, layout, 1, 1, gridState);
  assert.equal(highlights, 1, 'legacy behavior remains the default for grid games');

  highlights = 0;
  renderer.drawGridSymbols(ctx, null, {}, layout, 1, 1, { ...gridState, clearCellHighlight: false });
  assert.equal(highlights, 0, 'games can replace per-cell boxes with a cluster-level visualizer');
});

function spriteCaptureContext() {
  const draws = [];
  return {
    draws,
    save() {}, restore() {}, translate() {}, scale() {}, drawImage(...args) { draws.push(args); },
  };
}

test('drawReelsSymbols draws a stacked symbol\'s per-row variant tiles when the whole column matches, once the reel is idle', () => {
  const ctx = spriteCaptureContext();
  const asset = { image: {} };
  const symbolsConfig = {
    filler: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow_1: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow_2: { x: 0, y: 128, w: 256, h: 128 },
    surfer_yellow_3: { x: 0, y: 256, w: 256, h: 128 },
  };
  const stackedSymbols = { surfer_yellow: ['surfer_yellow_1', 'surfer_yellow_2', 'surfer_yellow_3'] };
  const gridLayout = { reelsX: 0, reelsY: 0, symbolWidth: 256, symbolHeight: 128 };
  const reels = [{
    state: 'idle', offsetY: 0, speed: 0,
    symbols: ['filler', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'filler', 'filler'],
  }];

  new SlotRenderer().drawReelsSymbols(ctx, asset, symbolsConfig, gridLayout, 1, reels, stackedSymbols);

  const sourceYs = ctx.draws.map(args => args[2]); // drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) -> sy at index 2
  assert.deepEqual(sourceYs, [0, 0, 128, 256, 0, 0], 'the 3 visible rows use variant tiles 1/2/3 (sy 0/128/256); the 2 filler rows stay plain (sy 0)');
});

test('drawReelsSymbols does not stack a symbol while the reel is still spinning', () => {
  const ctx = spriteCaptureContext();
  const asset = { image: {} };
  const symbolsConfig = {
    surfer_yellow: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow_1: { x: 0, y: 0, w: 256, h: 128 },
  };
  const stackedSymbols = { surfer_yellow: ['surfer_yellow_1'] };
  const gridLayout = { reelsX: 0, reelsY: 0, symbolWidth: 256, symbolHeight: 128 };
  const reels = [{
    state: 'spinning', offsetY: 40, speed: 10,
    symbols: ['surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow'],
  }];

  new SlotRenderer().drawReelsSymbols(ctx, asset, symbolsConfig, gridLayout, 1, reels, stackedSymbols);

  const sourceYs = ctx.draws.map(args => args[2]);
  assert.ok(sourceYs.every(sy => sy === 0), 'mid-spin, every draw uses the plain tile (sy 0), never a variant');
});

test('drawReelsSymbols renders a full-height stack cropped to the visible window when part of it stopped off-screen', () => {
  const ctx = spriteCaptureContext();
  const asset = { image: {} };
  const symbolsConfig = {
    filler: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow_3: { x: 0, y: 256, w: 256, h: 128 },
    surfer_yellow_4: { x: 0, y: 384, w: 256, h: 128 },
    surfer_yellow_5: { x: 0, y: 512, w: 256, h: 128 },
  };
  const stackedSymbols = {
    surfer_yellow: ['surfer_yellow_1', 'surfer_yellow_2', 'surfer_yellow_3', 'surfer_yellow_4', 'surfer_yellow_5'],
  };
  const gridLayout = { reelsX: 0, reelsY: 0, symbolWidth: 256, symbolHeight: 128 };
  // True run on the strip is 5 long (positions 2-6), but the reel only stopped with positions
  // 4-6 (the bottom 3 of that run) inside the 3-row visible window - positions 2-3 are two rows
  // above what's on screen.
  const strip = ['filler', 'filler', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'filler'];
  const reels = [{
    state: 'idle', offsetY: 0, speed: 0, strip, stopIndex: 4,
    symbols: ['filler', 'surfer_yellow', 'surfer_yellow', 'surfer_yellow', 'filler', 'filler'],
  }];

  new SlotRenderer().drawReelsSymbols(ctx, asset, symbolsConfig, gridLayout, 1, reels, stackedSymbols);

  const sourceYs = ctx.draws.map(args => args[2]);
  assert.deepEqual(sourceYs, [0, 256, 384, 512, 0, 0], 'the 3 visible rows use the bottom 3 variant tiles (3/4/5) of the 5-tall run, not variants 1/2/3');
});

test('drawReelsSymbols does not crop-stack a run shorter than the full variant count, even with strip context', () => {
  const ctx = spriteCaptureContext();
  const asset = { image: {} };
  const symbolsConfig = {
    filler: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow: { x: 0, y: 0, w: 256, h: 128 },
    surfer_yellow_1: { x: 0, y: 128, w: 256, h: 128 },
  };
  const stackedSymbols = {
    surfer_yellow: ['surfer_yellow_1', 'surfer_yellow_2', 'surfer_yellow_3', 'surfer_yellow_4', 'surfer_yellow_5'],
  };
  const gridLayout = { reelsX: 0, reelsY: 0, symbolWidth: 256, symbolHeight: 128 };
  // Only a 2-long run on the strip (positions 3-4) - shorter than the 5-tile variant set, so it
  // should stay plain even though strip context is available.
  const strip = ['filler', 'filler', 'filler', 'surfer_yellow', 'surfer_yellow', 'filler'];
  const reels = [{
    state: 'idle', offsetY: 0, speed: 0, strip, stopIndex: 3,
    symbols: ['filler', 'surfer_yellow', 'surfer_yellow', 'filler', 'filler'],
  }];

  new SlotRenderer().drawReelsSymbols(ctx, asset, symbolsConfig, gridLayout, 1, reels, stackedSymbols);

  const sourceYs = ctx.draws.map(args => args[2]);
  assert.ok(sourceYs.every(sy => sy === 0), 'a genuinely short run (not a full-height stack) renders plain tiles only');
});

test('selectViewportBackground uses the base background outside free spins', () => {
  const config = { viewportBackground: 'base.png', freeSpinsViewportBackground: 'bonus.png' };
  assert.equal(selectViewportBackground(config, { inFreeSpins: false }), 'base.png');
});

test('selectViewportBackground prefers freeSpinsViewportBackground while inFreeSpins', () => {
  const config = { viewportBackground: 'base.png', freeSpinsViewportBackground: 'bonus.png' };
  assert.equal(selectViewportBackground(config, { inFreeSpins: true }), 'bonus.png');
});

test('selectViewportBackground falls back to the base background if freeSpinsViewportBackground is unset', () => {
  const config = { viewportBackground: 'base.png' };
  assert.equal(selectViewportBackground(config, { inFreeSpins: true }), 'base.png');
});
