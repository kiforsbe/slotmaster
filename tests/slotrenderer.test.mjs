import assert from 'node:assert/strict';
import test from 'node:test';
import { SlotRenderer } from '../core/rendering/SlotRenderer.js';
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

test('cluster outline ignores payline cascade wins', () => {
  const ctx = outlineContext();
  new ClusterOutlineRenderer().render(ctx, {
    currentClusterWins: [{ lineIndex: 0, winningPositions: [[0, 0], [1, 0]] }],
    currentClusterIndex: 0,
    layout,
    drawClusterOutline: true,
  });

  assert.deepEqual(ctx.calls, []);
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
