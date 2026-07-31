// Geometry only: turns a connected set of grid cells into one or more ordered perimeter loops.
// Keeping this independent of Canvas makes unusual cluster shapes straightforward to validate.

const keyOf = (x, y) => `${x},${y}`;

function directionIndex(edge) {
  if (edge.x2 > edge.x1) return 1; // right
  if (edge.y2 > edge.y1) return 2; // down
  if (edge.x2 < edge.x1) return 3; // left
  return 0; // up
}

export function buildClusterOutlinePaths(winningPositions, layout) {
  const cells = new Set(winningPositions.map(([col, row]) => keyOf(col, row)));
  const hasCell = (col, row) => cells.has(keyOf(col, row));
  const edges = [];
  const addEdge = (x1, y1, x2, y2) => edges.push({ x1, y1, x2, y2, used: false });

  // Every edge is clockwise around its owning cell, so occupied space stays on the edge's right.
  winningPositions.forEach(([col, row]) => {
    // Keep these coordinates as exact integer grid vertices while routing. Grid layout widths
    // are often fractional CSS pixels; using those floats as Map keys split one contour into
    // broken fragments when `col * width + width !== (col + 1) * width` by a few ulps.
    if (!hasCell(col, row - 1)) addEdge(col, row, col + 1, row);
    if (!hasCell(col + 1, row)) addEdge(col + 1, row, col + 1, row + 1);
    if (!hasCell(col, row + 1)) addEdge(col + 1, row + 1, col, row + 1);
    if (!hasCell(col - 1, row)) addEdge(col, row + 1, col, row);
  });

  const edgesByStart = new Map();
  edges.forEach(edge => {
    const bucket = edgesByStart.get(keyOf(edge.x1, edge.y1)) || [];
    bucket.push(edge);
    edgesByStart.set(keyOf(edge.x1, edge.y1), bucket);
  });

  // At a vertex where two otherwise-independent boundary loops touch diagonally, selecting the
  // first edge merges them into a self-touching figure eight. Prefer the rightmost continuation
  // instead: it keeps the occupied cell on the right and cleanly separates the loops.
  const nextEdge = (edge) => {
    const candidates = (edgesByStart.get(keyOf(edge.x2, edge.y2)) || []).filter(candidate => !candidate.used);
    const direction = directionIndex(edge);
    const preference = [1, 0, 3, 2]; // right turn, straight, left turn, reverse
    return candidates.sort((a, b) => preference.indexOf((directionIndex(a) - direction + 4) % 4) - preference.indexOf((directionIndex(b) - direction + 4) % 4))[0];
  };

  const paths = [];
  edges.forEach(edge => {
    if (edge.used) return;
    const pathEdges = [];
    let current = edge;
    while (current && !current.used) {
      current.used = true;
      pathEdges.push(current);
      current = nextEdge(current);
    }

    const { reelsX, reelsY, symbolWidth, symbolHeight } = layout;
    paths.push({
      edges: pathEdges.map(({ x1, y1, x2, y2 }) => ({
        x1: reelsX + x1 * symbolWidth,
        y1: reelsY + y1 * symbolHeight,
        x2: reelsX + x2 * symbolWidth,
        y2: reelsY + y2 * symbolHeight,
      })),
    });
  });

  return paths;
}

// Generates Canvas path commands for a rounded version of each perimeter. The cubic controls
// use the standard quarter-circle kappa constant, so a 10px cornerRadius is a real 10px-radius
// turn rather than a thick line join. Concave grid steps remain square by default: rounding them
// changes which cells the outline appears to contain.
export function buildRoundedClusterOutlineCommands(paths, {
  cornerRadius = 0,
  roundConcaveCorners = false,
} = {}) {
  const kappa = 0.5522847498;
  return paths.map(({ edges }) => {
    const corners = edges.map((edge, index) => {
      const previous = edges[(index - 1 + edges.length) % edges.length];
      const vertex = { x: edge.x1, y: edge.y1 };
      const incoming = { x: vertex.x - previous.x1, y: vertex.y - previous.y1 };
      const outgoing = { x: edge.x2 - vertex.x, y: edge.y2 - vertex.y };
      const incomingLength = Math.hypot(incoming.x, incoming.y);
      const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
      const isStraight = incoming.x === outgoing.x && incoming.y === outgoing.y;
      const isOutsideTurn = incoming.x * outgoing.y - incoming.y * outgoing.x > 0;
      const radius = isStraight || (!isOutsideTurn && !roundConcaveCorners)
        ? 0
        : Math.min(cornerRadius, incomingLength / 2, outgoingLength / 2);
      const inUnit = { x: incoming.x / incomingLength, y: incoming.y / incomingLength };
      const outUnit = { x: outgoing.x / outgoingLength, y: outgoing.y / outgoingLength };
      const from = { x: vertex.x - inUnit.x * radius, y: vertex.y - inUnit.y * radius };
      const to = { x: vertex.x + outUnit.x * radius, y: vertex.y + outUnit.y * radius };
      return { vertex, radius, inUnit, outUnit, from, to };
    });
    if (!corners.length) return [];

    const commands = [{ type: 'move', ...corners[0].to }];
    for (let index = 1; index <= corners.length; index++) {
      const corner = corners[index % corners.length];
      commands.push({ type: 'line', ...corner.from });
      if (corner.radius) {
        commands.push({
          type: 'curve',
          cp1x: corner.from.x + corner.inUnit.x * corner.radius * kappa,
          cp1y: corner.from.y + corner.inUnit.y * corner.radius * kappa,
          cp2x: corner.to.x - corner.outUnit.x * corner.radius * kappa,
          cp2y: corner.to.y - corner.outUnit.y * corner.radius * kappa,
          x: corner.to.x,
          y: corner.to.y,
        });
      }
    }
    return commands;
  });
}
