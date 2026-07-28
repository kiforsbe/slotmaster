// Cluster-pays win evaluation: orthogonal flood-fill clustering plus a cluster-size payout
// tier lookup. Sits alongside core/math/SlotMath.js's checkWins/checkWildLineWins as a sibling
// win-evaluation strategy, not a replacement - CoreSlotEngine (core/engine/CoreSlotEngine.js)
// never imports this directly, a game's own winEvaluator closure does (see
// games/candyfrenzy/game.js).
import { checkScatterCount } from './CascadeMath.js';

/**
 * Orthogonal (4-directional, no diagonals) flood-fill over the grid, grouping
 * same-symbol connected components. Skips any cell whose symbol has no `clusterPayout`
 * entry in the paytable (the scatter symbol, or anything else not meant to cluster) -
 * every such cell is its own dead end, never merged into a neighboring cluster.
 * @param {string[][]} grid - grid[col][row], row 0 = top.
 * @param {Object} paytable - reads `paytable[symbol].clusterPayout` only to decide whether
 *   a symbol participates in clustering at all; the actual tier lookup is checkClusterWins's job.
 * @param {number} minClusterSize - NOT applied here; findClusters returns every connected
 *   component regardless of size, filtering is checkClusterWins's job (kept separate so a
 *   caller can inspect sub-minimum clusters too, e.g. for a future "near miss" UI highlight).
 * @returns {Array<{symbol: string, positions: [number, number][], size: number}>}
 */
export function findClusters(grid, paytable, minClusterSize) {
  const reelsCount = grid.length;
  const rowsCount = grid[0].length;
  const visited = Array.from({ length: reelsCount }, () => new Array(rowsCount).fill(false));
  const clusters = [];

  for (let col = 0; col < reelsCount; col++) {
    for (let row = 0; row < rowsCount; row++) {
      if (visited[col][row]) continue;
      const symbol = grid[col][row];
      const meta = paytable[symbol];
      if (!meta || !meta.clusterPayout) {
        visited[col][row] = true;
        continue;
      }

      const stack = [[col, row]];
      visited[col][row] = true;
      const positions = [];
      while (stack.length > 0) {
        const [c, r] = stack.pop();
        positions.push([c, r]);
        const neighbors = [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]];
        for (const [nc, nr] of neighbors) {
          if (nc < 0 || nc >= reelsCount || nr < 0 || nr >= rowsCount) continue;
          if (visited[nc][nr]) continue;
          if (grid[nc][nr] !== symbol) continue;
          visited[nc][nr] = true;
          stack.push([nc, nr]);
        }
      }
      clusters.push({ symbol, positions, size: positions.length });
    }
  }

  return clusters;
}

// Finds the highest tier whose min <= size (tiers must be ascending by min - see the
// PAYTABLE.clusterPayout shape documented in games/candyfrenzy/game.js).
function payoutForClusterSize(symbol, size, paytable) {
  const tiers = paytable[symbol] && paytable[symbol].clusterPayout;
  if (!tiers) return 0;
  let multiplier = 0;
  for (const tier of tiers) {
    if (size >= tier.min) multiplier = tier.multiplier;
  }
  return multiplier;
}

/**
 * The cluster-pays winEvaluator: qualifying clusters (>= minClusterSize) plus a bundled
 * scatter-anywhere check, combined into one result shape mirroring SlotMath.js's checkWins
 * convention. Meant to be wrapped in a single-argument closure for CascadeEngine/
 * resolveCascadeSequence's `winEvaluator` config, e.g.
 * `(grid) => checkClusterWins(grid, PAYTABLE, 5, 'bonus', 3)`.
 * @returns {{ clusterWins: Array<{symbol,count,payout,winningPositions}>, totalPayoutMultiplier: number, scatterWin: object|null }}
 */
export function checkClusterWins(grid, paytable, minClusterSize, scatterSymbol, scatterTriggerCount) {
  const clusters = findClusters(grid, paytable, minClusterSize);
  const clusterWins = [];
  let totalPayoutMultiplier = 0;

  clusters.forEach(cluster => {
    if (cluster.size < minClusterSize) return;
    const payout = payoutForClusterSize(cluster.symbol, cluster.size, paytable);
    if (payout > 0) {
      clusterWins.push({ symbol: cluster.symbol, count: cluster.size, payout, winningPositions: cluster.positions });
      totalPayoutMultiplier += payout;
    }
  });

  const scatter = checkScatterCount(grid, scatterSymbol, scatterTriggerCount);
  const scatterWin = scatter.count > 0
    ? { symbol: scatterSymbol, count: scatter.count, positions: scatter.positions, triggerFreeSpins: scatter.triggerFreeSpins, payout: 0 }
    : null;

  return { clusterWins, totalPayoutMultiplier, scatterWin };
}
