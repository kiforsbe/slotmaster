/**
 * CMA-ES (Covariance Matrix Adaptation Evolution Strategy) - a population-based, derivative-free
 * search for continuous, noisy, non-convex objectives, following Hansen's reference "purecmaes"
 * algorithm. Used as a drop-in alternative to nelderMead() (SpinSimulator.js) for
 * tuneFrequencies' Phase 2 joint per-symbol frequency search - see
 * docs/superpowers/specs/2026-07-26-cmaes-frequency-search-design.md for why: that search is
 * high-dimensional (Candy Frenzy: ~84 dims) and its measurements are noisy (Monte Carlo RTP
 * simulation), both of which Nelder-Mead's pairwise-comparison, n+1-vertex-simplex approach
 * handles poorly.
 */
import { createSeededRng } from './SlotMath.js';

/**
 * Eigendecomposition of a symmetric matrix via the classical (cyclic Jacobi) eigenvalue
 * algorithm: repeatedly zeroes the largest off-diagonal pair via a Givens rotation until the
 * matrix is diagonal to within `tolerance`. Only works on symmetric matrices (CMA-ES's
 * covariance matrix always is, by construction) - chosen over more general methods specifically
 * because it's simple to implement correctly and always converges for this case.
 * @param {number[][]} matrix - symmetric n x n matrix
 * @param {number} [maxSweeps=100] - safety cap on the number of full sweeps over all pairs
 * @param {number} [tolerance=1e-10] - stop once the off-diagonal Frobenius norm drops below this
 * @returns {{ eigenvalues: number[], eigenvectors: number[][] }} - `eigenvectors[i][k]` is the
 *   i-th component of the k-th eigenvector (i.e. `eigenvectors` is the orthogonal matrix whose
 *   *columns* are the eigenvectors), so `matrix ~= eigenvectors * diag(eigenvalues) * eigenvectors^T`.
 */
export function eigenSymmetric(matrix, maxSweeps = 100, tolerance = 1e-10) {
  const n = matrix.length;
  const A = matrix.map(row => row.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  function offDiagonalNorm() {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) sum += A[i][j] * A[i][j];
    }
    return Math.sqrt(2 * sum);
  }

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    if (offDiagonalNorm() < tolerance) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const app = A[p][p], aqq = A[q][q], apq = A[p][q];
        A[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
        A[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
        A[p][q] = 0;
        A[q][p] = 0;
        for (let i = 0; i < n; i++) {
          if (i !== p && i !== q) {
            const aip = A[i][p], aiq = A[i][q];
            A[i][p] = c * aip - s * aiq;
            A[p][i] = A[i][p];
            A[i][q] = s * aip + c * aiq;
            A[q][i] = A[i][q];
          }
        }
        for (let i = 0; i < n; i++) {
          const vip = V[i][p], viq = V[i][q];
          V[i][p] = c * vip - s * viq;
          V[i][q] = s * vip + c * viq;
        }
      }
    }
  }

  const eigenvalues = Array.from({ length: n }, (_, i) => A[i][i]);
  const eigenvectors = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => V[i][j]));
  return { eigenvalues, eigenvectors };
}
