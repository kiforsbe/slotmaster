// Straight-line cascade win evaluation. Unlike payline games these runs can begin anywhere on
// the grid, and unlike cluster games they only connect horizontally or vertically.

const keyOf = (col, row) => `${col},${row}`;

function payoutAt(meta, count) {
  const ladder = meta?.linePayout;
  if (!Array.isArray(ladder) || count < 3) return 0;
  return Number(ladder[count - 3] ?? 0);
}

function multiplierAt(wildMultipliers, col, row) {
  return Number(wildMultipliers?.[col]?.[row] ?? 1);
}

function lineCells(grid, orientation, fixedIndex) {
  const length = orientation === 'horizontal' ? grid.length : grid[0].length;
  return Array.from({ length }, (_, index) => orientation === 'horizontal'
    ? [index, fixedIndex]
    : [fixedIndex, index]);
}

function maximalSegments(cells, canInclude) {
  const segments = [];
  let start = null;
  cells.forEach((position, index) => {
    if (canInclude(position)) {
      if (start == null) start = index;
      return;
    }
    if (start != null) segments.push(cells.slice(start, index));
    start = null;
  });
  if (start != null) segments.push(cells.slice(start));
  return segments;
}

function centerOf(positions) {
  return positions[Math.floor((positions.length - 1) / 2)];
}

function makeWin({ positions, orientation, symbol, payout, mixed, wildSymbol, grid, wildMultipliers }) {
  const usedWildPositions = positions.filter(([col, row]) => grid[col][row] === wildSymbol);
  const hasDoubleWild = usedWildPositions.some(([col, row]) => multiplierAt(wildMultipliers, col, row) >= 2);
  const multiplier = hasDoubleWild ? 2 : 1;
  return {
    kind: 'straight-line',
    orientation,
    symbol,
    count: positions.length,
    payout: payout * (mixed ? 0.5 : 1) * multiplier,
    basePayout: payout,
    mixed,
    multiplier,
    winningPositions: positions,
    usedWildPositions,
    wildSpawnPosition: centerOf(positions),
  };
}

/**
 * Finds 3–5 symbol horizontal and vertical runs. Regular symbols only connect to themselves
 * (plus wilds). Premiums form a shared family: one natural premium pays full, while a mixed
 * premium family run pays half the highest premium present. Pure wild runs pay the wild ladder.
 */
export function checkStraightLineWins(grid, paytable, {
  wildSymbol = 'lemonpop',
  wildMultipliers = null,
  maxLineLength = 5,
} = {}) {
  const rowsCount = grid[0]?.length ?? 0;
  const reelsCount = grid.length;
  const wins = [];
  const seen = new Set();

  const register = (positions, orientation, family) => {
    if (positions.length < 3 || positions.length > maxLineLength) return;
    const naturals = positions
      .map(([col, row]) => grid[col][row])
      .filter(symbol => symbol && symbol !== wildSymbol);
    const uniqueNaturals = [...new Set(naturals)];
    const signature = `${orientation}:${positions.map(([c, r]) => keyOf(c, r)).join('|')}:${family}`;
    if (seen.has(signature)) return;
    seen.add(signature);

    if (family === 'premium') {
      if (!uniqueNaturals.length) return;
      const premiums = uniqueNaturals.filter(symbol => paytable[symbol]?.type === 'premium');
      if (!premiums.length) return;
      const symbol = premiums.reduce((best, candidate) => (
        payoutAt(paytable[candidate], positions.length) > payoutAt(paytable[best], positions.length) ? candidate : best
      ));
      const mixed = uniqueNaturals.length > 1;
      wins.push(makeWin({
        positions, orientation, symbol,
        payout: payoutAt(paytable[symbol], positions.length), mixed, wildSymbol, grid, wildMultipliers,
      }));
      return;
    }

    if (family === 'wild') {
      if (uniqueNaturals.length) return;
      wins.push(makeWin({
        positions, orientation, symbol: wildSymbol,
        payout: payoutAt(paytable[wildSymbol], positions.length), mixed: false, wildSymbol, grid, wildMultipliers,
      }));
      return;
    }

    const [symbol] = uniqueNaturals;
    if (!symbol || uniqueNaturals.length !== 1) return;
    wins.push(makeWin({
      positions, orientation, symbol,
      payout: payoutAt(paytable[symbol], positions.length), mixed: false, wildSymbol, grid, wildMultipliers,
    }));
  };

  const scan = (orientation, fixedCount) => {
    for (let fixedIndex = 0; fixedIndex < fixedCount; fixedIndex++) {
      const cells = lineCells(grid, orientation, fixedIndex);
      // Premiums can mix with other premiums and wilds. A regular cell breaks that family.
      maximalSegments(cells, ([col, row]) => {
        const symbol = grid[col][row];
        return symbol === wildSymbol || paytable[symbol]?.type === 'premium';
      }).forEach(segment => register(segment, orientation, 'premium'));

      // Every regular symbol has its own compatible run. This avoids regular-only mixed wins.
      Object.entries(paytable)
        .filter(([, meta]) => meta.type === 'regular')
        .forEach(([regular]) => {
          maximalSegments(cells, ([col, row]) => {
            const symbol = grid[col][row];
            return symbol === regular || symbol === wildSymbol;
          }).forEach(segment => register(segment, orientation, `regular:${regular}`));
        });

      maximalSegments(cells, ([col, row]) => grid[col][row] === wildSymbol)
        .forEach(segment => register(segment, orientation, 'wild'));
    }
  };

  scan('horizontal', rowsCount);
  scan('vertical', reelsCount);

  const totalPayoutMultiplier = wins.reduce((sum, win) => sum + win.payout, 0);
  return { clusterWins: wins, totalPayoutMultiplier, scatterWin: null, wildSymbol };
}

export function createWildMultiplierGrid(reelsCount, rowsCount, value = 1) {
  return Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(value));
}
