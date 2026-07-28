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
import { createSeededRng } from './math/SlotMath.js';

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

function sampleGaussian(rng) {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * @param {number[]} initialPoint
 * @param {number} initialStepSize - initial global step size (sigma)
 * @param {(point: number[]) => (Object|Promise<Object>)} evaluate - must resolve to an object
 *   with a numeric `.loss` (lower is better); any extra fields are carried through onto the
 *   returned `result`, same contract as nelderMead's `evaluate`.
 * @param {number} maxIterations - generation budget
 * @param {number} seed - seeds this function's own candidate sampling (distinct from whatever
 *   randomness `evaluate` itself uses for Monte Carlo measurement noise)
 * @param {number} [convergenceTolerance=1e-4] - stops once `sigma * max(D)` (the search
 *   distribution's largest standard deviation) drops below this - analogous to nelderMead's
 *   simplex-collapse check, adapted to CMA-ES's own notion of "spread".
 * @param {Function} [onProgress] - `(iteration, point, result, best, attempted) =>
 *   (void|Promise<void>)`, called once per generation - same positional shape as nelderMead's.
 * @param {Function} [onBusy] - `(info: { iteration, operation: 'generation',
 *   verticesToEvaluate, verticesEvaluated? }) => (void|Promise<void>)`, called while a
 *   generation's population is still resolving - same shape/cadence as nelderMead's shrink
 *   reporting.
 * @param {number} [busyReportIntervalMs=300]
 * @param {() => Promise<void>} yieldToEventLoop
 * @param {AbortSignal} [signal] - Checked once per generation, after that generation's
 *   population has fully evaluated and been incorporated into `best`/the search distribution -
 *   cooperative cancellation stops at the next generation boundary (never mid-generation,
 *   never discarding already-completed work) rather than throwing, returning whatever `best`
 *   has been found so far with `iterations` less than `maxIterations`.
 * @returns {Promise<{ point: number[], loss: number, result: Object, iterations: number, converged: boolean }>}
 */
export async function cmaes({
  initialPoint, initialStepSize, evaluate, maxIterations, seed,
  convergenceTolerance = 1e-4,
  onProgress = null, onBusy = null, busyReportIntervalMs = 300,
  yieldToEventLoop,
  signal = null,
}) {
  const n = initialPoint.length;
  const lambda = 4 + Math.floor(3 * Math.log(n));
  const mu = Math.floor(lambda / 2);

  const rawWeights = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
  const weightSum = rawWeights.reduce((a, b) => a + b, 0);
  const weights = rawWeights.map(w => w / weightSum);
  const mueff = 1 / weights.reduce((sum, w) => sum + w * w, 0);

  const cc = (4 + mueff / n) / (n + 4 + 2 * mueff / n);
  const cs = (mueff + 2) / (n + mueff + 5);
  const c1 = 2 / ((n + 1.3) ** 2 + mueff);
  const cmu = Math.min(1 - c1, 2 * (mueff - 2 + 1 / mueff) / ((n + 2) ** 2 + mueff));
  const damps = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs;
  const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
  const eigenEveryGens = Math.max(1, Math.floor(lambda / ((c1 + cmu) * n * 10)));

  const rng = createSeededRng(seed ?? 1);

  let mean = initialPoint.slice();
  let sigma = initialStepSize;
  let C = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  let pc = new Array(n).fill(0);
  let ps = new Array(n).fill(0);
  let B = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  let D = new Array(n).fill(1);
  let lastEigenGen = 0;

  // `generation` is passed through to `evaluate` so a caller wrapping a stochastic measurement
  // can rotate its RNG seed per generation while keeping common random numbers WITHIN a
  // generation. That combination is what CMA-ES actually needs: it is rank-based, so it only
  // requires that one generation's candidates be compared fairly against each other - it does
  // not require the objective to be identical across generations. Holding one seed for a whole
  // run instead makes the search optimize that single noise realization, and the covariance
  // adaptation will steer into directions where that particular draw happens to be favorable.
  // Ignored by any evaluate that doesn't declare the parameter, so this is backward compatible.
  const evalPoint = async (point, generation) => ({ point, ...(await evaluate(point, generation)) });

  let best = null;
  let iterations = 0;
  let converged = false;

  for (let gen = 0; gen < maxIterations; gen++) {
    iterations = gen + 1;

    const zs = Array.from({ length: lambda }, () => Array.from({ length: n }, () => sampleGaussian(rng)));
    const ys = zs.map(z => B.map(row => row.reduce((sum, Bij, j) => sum + Bij * (D[j] * z[j]), 0)));
    const points = ys.map(y => mean.map((m, d) => m + sigma * y[d]));

    let completed = 0;
    let lastBusyReportTime = Date.now();
    if (onBusy) await onBusy({ iteration: gen, operation: 'generation', verticesToEvaluate: lambda });
    const candidates = await Promise.all(points.map((point) => evalPoint(point, gen).then(async (result) => {
      completed++;
      const isLast = completed === points.length;
      const now = Date.now();
      if (onBusy && !isLast && now - lastBusyReportTime >= busyReportIntervalMs) {
        lastBusyReportTime = now;
        await onBusy({ iteration: gen, operation: 'generation', verticesToEvaluate: lambda, verticesEvaluated: completed });
      }
      return result;
    })));

    const ranked = candidates.map((candidate, i) => ({ candidate, y: ys[i] })).sort((a, b) => a.candidate.loss - b.candidate.loss);
    const bestOfGen = ranked[0].candidate;
    if (!best || bestOfGen.loss < best.loss) best = bestOfGen;

    const yw = new Array(n).fill(0);
    for (let i = 0; i < mu; i++) {
      ranked[i].y.forEach((yi, d) => { yw[d] += weights[i] * yi; });
    }
    const newMean = mean.map((m, d) => m + sigma * yw[d]);

    const Btyw = B[0].map((_, j) => B.reduce((sum, row, i) => sum + row[j] * yw[i], 0));
    const invDBtyw = Btyw.map((v, i) => v / D[i]);
    const cInvHalfYw = B.map((row) => row.reduce((sum, Bij, j) => sum + Bij * invDBtyw[j], 0));
    const psNew = ps.map((psi, d) => (1 - cs) * psi + Math.sqrt(cs * (2 - cs) * mueff) * cInvHalfYw[d]);

    const psNorm = Math.sqrt(psNew.reduce((sum, v) => sum + v * v, 0));
    const newSigma = sigma * Math.exp((cs / damps) * (psNorm / chiN - 1));

    const hsig = (psNorm / Math.sqrt(1 - (1 - cs) ** (2 * (gen + 1)))) / chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    const pcNew = pc.map((pci, d) => (1 - cc) * pci + hsig * Math.sqrt(cc * (2 - cc) * mueff) * yw[d]);

    const newC = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let rankMu = 0;
        for (let k = 0; k < mu; k++) rankMu += weights[k] * ranked[k].y[i] * ranked[k].y[j];
        const rankOne = pcNew[i] * pcNew[j];
        newC[i][j] = (1 - c1 - cmu) * C[i][j] + c1 * (rankOne + (1 - hsig) * cc * (2 - cc) * C[i][j]) + cmu * rankMu;
      }
    }

    mean = newMean;
    sigma = newSigma;
    pc = pcNew;
    ps = psNew;
    C = newC;

    if (gen - lastEigenGen >= eigenEveryGens || gen === maxIterations - 1) {
      lastEigenGen = gen;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) C[j][i] = C[i][j]; // enforce symmetry against float drift
      }
      const decomposed = eigenSymmetric(C);
      D = decomposed.eigenvalues.map(v => Math.sqrt(Math.max(v, 1e-300)));
      B = decomposed.eigenvectors;
    }

    if (onProgress) await onProgress(gen, bestOfGen.point, bestOfGen, best, bestOfGen);
    await yieldToEventLoop();

    if (sigma * Math.max(...D) < convergenceTolerance) { converged = true; break; }
    // Checked last, after this generation's population has fully evaluated and `best`/mean/
    // sigma/covariance have all already incorporated it - a user-requested stop takes effect at
    // the next generation boundary rather than discarding a generation's already-completed work,
    // and `best` is guaranteed non-null by this point regardless of how early gen 0 stops here.
    if (signal?.aborted) break;
  }

  return { point: best.point, loss: best.loss, result: best, iterations, converged };
}
