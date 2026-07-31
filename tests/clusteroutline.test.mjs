import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClusterOutlinePaths, buildRoundedClusterOutlineCommands } from '../core/rendering/ClusterOutline.js';

const layout = { reelsX: 0, reelsY: 0, symbolWidth: 10, symbolHeight: 10 };
const k = (x, y) => `${x},${y}`;

// The catalogue deliberately includes convex, concave, holed, narrow, zig-zag, and boundary-
// touching forms. Every entry is one orthogonally connected cluster, exactly as ClusterMath emits.
const SHAPES = {
  single: [[0, 0]],
  horizontalDomino: [[0, 0], [1, 0]],
  verticalDomino: [[0, 0], [0, 1]],
  square2x2: [[0, 0], [1, 0], [0, 1], [1, 1]],
  rectangle3x2: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
  lTriomino: [[0, 0], [1, 0], [0, 1]],
  lPentomino: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]],
  tTetromino: [[0, 0], [1, 0], [2, 0], [1, 1]],
  plusPentomino: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
  uPentomino: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
  cPentomino: [[0, 0], [1, 0], [0, 1], [0, 2], [1, 2]],
  zTetromino: [[0, 0], [1, 0], [1, 1], [2, 1]],
  sTetromino: [[1, 0], [2, 0], [0, 1], [1, 1]],
  staircaseFive: [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]],
  hookSix: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3], [2, 3]],
  ring3x3: [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]],
  ring4x3: [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2]],
  forkSeven: [[1, 0], [1, 1], [0, 2], [1, 2], [2, 2], [1, 3], [1, 4]],
  dumbbellBridge: [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [3, 1], [3, 2], [4, 1], [4, 2]],
  diagonalBoundaryTouch: [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [1, 2], [0, 2]],
  snakeNine: [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1], [0, 2], [1, 2], [2, 2]],
  wideComb: [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2], [3, 2]],
};

function expectedEdges(cells) {
  const occupied = new Set(cells.map(([x, y]) => k(x, y)));
  const edges = new Set();
  const add = (x1, y1, x2, y2) => edges.add(`${x1},${y1}>${x2},${y2}`);
  for (const [x, y] of cells) {
    if (!occupied.has(k(x, y - 1))) add(x * 10, y * 10, (x + 1) * 10, y * 10);
    if (!occupied.has(k(x + 1, y))) add((x + 1) * 10, y * 10, (x + 1) * 10, (y + 1) * 10);
    if (!occupied.has(k(x, y + 1))) add((x + 1) * 10, (y + 1) * 10, x * 10, (y + 1) * 10);
    if (!occupied.has(k(x - 1, y))) add(x * 10, (y + 1) * 10, x * 10, y * 10);
  }
  return edges;
}

for (const [name, cells] of Object.entries(SHAPES)) {
  test(`cluster outline topology: ${name}`, () => {
    const paths = buildClusterOutlinePaths(cells, layout);
    const expected = expectedEdges(cells);
    const actual = new Set(paths.flatMap(path => path.edges.map(edge => `${edge.x1},${edge.y1}>${edge.x2},${edge.y2}`)));

    assert.deepEqual(actual, expected, 'every exposed cell edge appears exactly once in the outline');
    for (const path of paths) {
      assert.ok(path.edges.length > 0);
      path.edges.forEach((edge, index) => {
        const next = path.edges[(index + 1) % path.edges.length];
        assert.deepEqual([edge.x2, edge.y2], [next.x1, next.y1], 'each perimeter loop is continuous and closed');
      });
      assert.equal(new Set(path.edges.map(edge => k(edge.x1, edge.y1))).size, path.edges.length, 'a perimeter loop never self-touches at a vertex');
    }

    const rounded = buildRoundedClusterOutlineCommands(paths, { cornerRadius: 4 });
    for (const commands of rounded) {
      assert.ok(commands.length > 1);
      const start = commands[0];
      const end = commands.at(-1);
      assert.deepEqual([end.x, end.y], [start.x, start.y], 'the rounded contour returns exactly to its start point');
      commands.forEach(command => {
        Object.entries(command).forEach(([key, value]) => {
          if (key !== 'type') assert.ok(Number.isFinite(value), `rounded command ${key} is finite`);
        });
      });
    }
  });
}

function cubicPoint(start, curve, t) {
  const inv = 1 - t;
  return {
    x: inv ** 3 * start.x + 3 * inv ** 2 * t * curve.cp1x + 3 * inv * t ** 2 * curve.cp2x + t ** 3 * curve.x,
    y: inv ** 3 * start.y + 3 * inv ** 2 * t * curve.cp1y + 3 * inv * t ** 2 * curve.cp2y + t ** 3 * curve.y,
  };
}

test('a 10px contour corner is a mathematically accurate quarter-circle approximation', () => {
  const largeCell = { reelsX: 0, reelsY: 0, symbolWidth: 100, symbolHeight: 100 };
  const [commands] = buildRoundedClusterOutlineCommands(
    buildClusterOutlinePaths([[0, 0]], largeCell),
    { cornerRadius: 10 },
  );
  const curveIndex = commands.findIndex(command => command.type === 'curve');
  const curve = commands[curveIndex];
  const start = commands[curveIndex - 1];

  // First corner is top-right: its circle is centred 10px down and left of the grid vertex.
  assert.deepEqual([start.x, start.y], [90, 0]);
  assert.deepEqual([curve.x, curve.y], [100, 10]);
  assert.ok(Math.abs(curve.cp1x - (90 + 10 * 0.5522847498)) < 1e-9);
  assert.ok(Math.abs(curve.cp2y - (10 - 10 * 0.5522847498)) < 1e-9);
  for (const t of [0.125, 0.25, 0.5, 0.75, 0.875]) {
    const point = cubicPoint(start, curve, t);
    const radiusError = Math.abs(Math.hypot(point.x - 90, point.y - 10) - 10);
    assert.ok(radiusError < 0.003, `curve stays within 0.003px of a 10px circle at t=${t}`);
  }
});

test('fractional cell dimensions never split a contour at an adjacent grid corner', () => {
  const fractionalLayout = { reelsX: 17.25, reelsY: 9.5, symbolWidth: 79.57142857142857, symbolHeight: 81.14285714285714 };
  const cells = SHAPES.diagonalBoundaryTouch;
  const paths = buildClusterOutlinePaths(cells, fractionalLayout);

  for (const { edges } of paths) {
    edges.forEach((edge, index) => {
      const next = edges[(index + 1) % edges.length];
      assert.equal(edge.x2, next.x1, 'shared x coordinate is produced from one integer grid vertex');
      assert.equal(edge.y2, next.y1, 'shared y coordinate is produced from one integer grid vertex');
    });
  }
});
