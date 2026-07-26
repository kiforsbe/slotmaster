# CMA-ES Frequency Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CMA-ES as a second, selectable Phase 2 search algorithm for `tuneFrequencies`
(`core/SpinSimulator.js`), alongside the existing Nelder-Mead, and make the cross-round "is
this candidate actually better?" decision noise-aware regardless of which algorithm produced
it.

**Architecture:** A new standalone module, `core/CMAES.js`, implements a faithful CMA-ES
(Hansen's reference algorithm - standard population size/recombination/learning-rate formulas,
its own Jacobi eigendecomposition for the covariance matrix) behind the exact same
`{point, loss, result, iterations, converged}` return contract `nelderMead()` already returns.
`tuneFrequencies` gets a new `searchAlgorithm: 'nelderMead' | 'cmaes'` option (default
`'nelderMead'`, byte-identical to today) that picks which function its existing Phase 2 round
loop calls - the round loop itself (restarts, stall detection, seed-shifting, `reason`
classification) is untouched, since it already only depends on that shared return shape. A
separate, narrower change upgrades the round loop's own cross-round `best`-tracking to require
a statistically meaningful improvement (using the already-existing `trialRtpStdError`), so a
noisy "better" result can't silently replace a genuinely better one - regardless of algorithm.

**Tech Stack:** Plain ES modules, `node --test` for the test suite (`node --test tests/*.mjs`).
No new dependencies - CMA-ES's linear algebra (matrix-vector products, symmetric
eigendecomposition via the Jacobi method) is implemented from scratch in `core/CMAES.js`.

## Global Constraints

- `npm test` (`node --test tests/*.mjs`) must stay green after every task, with the same 4
  pre-existing/known-flaky failures as before this work (`barfruits.test.mjs`'s
  `501 !== 500`, and 3 `tunefrequencies.test.mjs` tests: `limitPenaltyWeight` soft cap,
  reel-default `maxFrequency`, `converged-with-violations` reason) - these fail identically on
  unmodified code and are not this plan's concern.
- `nelderMead()` is not modified at all (per the design's non-goals).
- `tuneFrequencies`'s default behavior (`searchAlgorithm` omitted) must stay byte-identical to
  before this work, on every existing test/fixture - the new option must be fully additive.
- `tuneFrequencies` must remain fully deterministic: identical options (including a fixed
  `searchSeed`) must always produce byte-identical `reelFrequencyTables`, for either algorithm.
- No new npm dependencies.
- Windows/PowerShell environment. Run tests via `node --test tests/*.mjs` (Bash tool - Git
  Bash - or PowerShell both work).

---

## File Structure

- Create: `core/CMAES.js` - `eigenSymmetric(matrix)` (standalone Jacobi eigendecomposition) and
  `cmaes({...})` (the search algorithm itself), self-contained, no dependency on
  `SpinSimulator.js`.
- Create: `tests/cmaes.test.mjs` - unit tests for both exports of `core/CMAES.js`, mirroring
  the existing `nelderMead` tests in `tests/tunefrequencies.test.mjs` (same quadratic-bowl,
  determinism, concurrency, and progress-reporting test patterns).
- Modify: `core/SpinSimulator.js` - import `cmaes` from `./CMAES.js`; add `searchAlgorithm` and
  `bestAcceptanceZ` to `tuneFrequencies`'s options destructure (~line 811-851); add a
  module-level `beatsIncumbent(candidate, incumbent, z)` helper near `nelderMead`; dispatch on
  `searchAlgorithm` inside the Phase 2 round loop (~line 1343-1364) instead of calling
  `nelderMead` directly; replace the round loop's raw `best` comparison (~line 1372) with
  `beatsIncumbent`; update the function's JSDoc.
- Modify: `tests/tunefrequencies.test.mjs` - new tests for `searchAlgorithm: 'cmaes'`
  integration and `beatsIncumbent`.
- Modify: `core/SimulationPanel.js` - add a "Search Algorithm" `<select>` next to the existing
  "Initial Frequency Strategy" one (~line 438-444), wire it into `startTuning`'s `inputs`
  (~line 620) and `options` (~line 675) objects.
- Modify: `docs/ARCHITECTURE.md` - document `searchAlgorithm`/CMA-ES near the existing
  Nelder-Mead description (~line 448) and "Parallel tuning" section (~line 467), fix a now-stale
  sentence about the variance-warning threshold (~line 459, already superseded by
  `maxRtpStdError` gating earlier this session but never corrected in the docs), bump the
  "Docs last synced" footer.

---

## Task 1: Jacobi eigendecomposition (`eigenSymmetric`)

The foundational piece CMA-ES needs every few generations: decompose its symmetric covariance
matrix `C` into `eigenvalues` and `eigenvectors` such that `C ≈ V · diag(eigenvalues) · Vᵀ`.
Implemented and tested completely on its own before anything in `cmaes()` depends on it.

**Files:**
- Create: `core/CMAES.js`
- Test: `tests/cmaes.test.mjs`

**Interfaces:**
- Produces: `eigenSymmetric(matrix: number[][], maxSweeps = 100, tolerance = 1e-10) ->
  { eigenvalues: number[], eigenvectors: number[][] }`, where `eigenvectors[i][k]` is the
  `i`-th component of the `k`-th eigenvector (so `eigenvectors` is the orthogonal matrix `V`
  with eigenvectors as its *columns*). Consumed by Task 2's `cmaes()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/cmaes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { eigenSymmetric } from '../core/CMAES.js';

test('eigenSymmetric decomposes a symmetric matrix such that V * diag(eigenvalues) * V^T reconstructs it', () => {
  const matrix = [[4, 1, 0], [1, 3, 1], [0, 1, 2]];
  const { eigenvalues, eigenvectors } = eigenSymmetric(matrix);
  const n = matrix.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += eigenvectors[i][k] * eigenvalues[k] * eigenvectors[j][k];
      assert.ok(Math.abs(sum - matrix[i][j]) < 1e-6,
        `expected reconstructed[${i}][${j}] ~= ${matrix[i][j]}, got ${sum}`);
    }
  }
});

test('eigenSymmetric on a diagonal matrix returns the diagonal entries as eigenvalues', () => {
  const { eigenvalues } = eigenSymmetric([[5, 0], [0, 9]]);
  const sorted = [...eigenvalues].sort((a, b) => a - b);
  assert.ok(Math.abs(sorted[0] - 5) < 1e-9, `expected 5, got ${sorted[0]}`);
  assert.ok(Math.abs(sorted[1] - 9) < 1e-9, `expected 9, got ${sorted[1]}`);
});

test('eigenSymmetric returns orthonormal eigenvectors', () => {
  const { eigenvectors } = eigenSymmetric([[2, 1], [1, 2]]);
  const n = eigenvectors.length;
  // Each column (fixed k, varying i) should have unit length.
  for (let k = 0; k < n; k++) {
    let normSq = 0;
    for (let i = 0; i < n; i++) normSq += eigenvectors[i][k] ** 2;
    assert.ok(Math.abs(normSq - 1) < 1e-9, `expected eigenvector ${k} to be unit length, got norm^2=${normSq}`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/cmaes.test.mjs`
Expected: FAIL - `core/CMAES.js` does not exist yet (`Cannot find module`).

- [ ] **Step 3: Implement `eigenSymmetric`**

Create `core/CMAES.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/cmaes.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/CMAES.js tests/cmaes.test.mjs
git commit -m "feat: add Jacobi eigendecomposition as the basis for a CMA-ES search"
```

---

## Task 2: Core `cmaes()` algorithm

The actual optimizer: samples a population each generation from a covariance-shaped Gaussian
around the current mean, evaluates it (concurrently - population evaluation is trivially
parallel, so writing it any other way would be extra code for no reason), and adapts its mean/
step-size/covariance from the ranked results. Correctness is verified on deterministic and
noisy synthetic objectives before it ever touches real frequency tuning.

**Files:**
- Modify: `core/CMAES.js`
- Test: `tests/cmaes.test.mjs`

**Interfaces:**
- Consumes: `eigenSymmetric` (Task 1).
- Produces: `cmaes({ initialPoint: number[], initialStepSize: number, evaluate: (point:
  number[]) => (Object|Promise<Object>) /* must include .loss */, maxIterations: number, seed:
  number, convergenceTolerance?: number, onProgress?: Function, onBusy?: Function,
  busyReportIntervalMs?: number, yieldToEventLoop: () => Promise<void> }) -> Promise<{ point:
  number[], loss: number, result: Object, iterations: number, converged: boolean }>` - the same
  shape `nelderMead()` returns. Consumed by Task 3 (progress reporting) and Task 4
  (`tuneFrequencies` wiring).

- [ ] **Step 1: Write the failing tests**

Add to `tests/cmaes.test.mjs`:

```js
import { cmaes } from '../core/CMAES.js';

test('cmaes minimizes a simple 2D quadratic bowl', async () => {
  const { point, loss, converged } = await cmaes({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 200,
    seed: 1,
    convergenceTolerance: 1e-8,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(converged, `expected convergence, got loss=${loss}`);
  assert.ok(Math.abs(point[0] - 3) < 0.05, `expected x near 3, got ${point[0]}`);
  assert.ok(Math.abs(point[1] - (-2)) < 0.05, `expected y near -2, got ${point[1]}`);
});

test('cmaes minimizes a higher-dimensional (10D) quadratic bowl', async () => {
  const target = Array.from({ length: 10 }, (_, i) => i - 5); // [-5, -4, ..., 4]
  const { loss } = await cmaes({
    initialPoint: new Array(10).fill(0),
    initialStepSize: 2,
    evaluate: (x) => ({ loss: x.reduce((sum, xi, i) => sum + (xi - target[i]) ** 2, 0) }),
    maxIterations: 400,
    seed: 1,
    convergenceTolerance: 1e-6,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(loss < 0.1, `expected near-zero loss on a 10D quadratic bowl, got ${loss}`);
});

test('cmaes tolerates a noisy evaluate and still lands close to the true minimum', async () => {
  const noiseRng = (() => {
    let seed = 42;
    return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 2; };
  })();
  const { point } = await cmaes({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 + noiseRng() }),
    maxIterations: 300,
    seed: 7,
    convergenceTolerance: 1e-8,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(Math.abs(point[0] - 3) < 0.5, `expected x within 0.5 of 3 despite noise, got ${point[0]}`);
  assert.ok(Math.abs(point[1] - (-2)) < 0.5, `expected y within 0.5 of -2 despite noise, got ${point[1]}`);
});

test('cmaes is deterministic given the same seed', async () => {
  const args = {
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 50,
    seed: 99,
    yieldToEventLoop: () => Promise.resolve(),
  };
  const a = await cmaes(args);
  const b = await cmaes(args);
  assert.deepEqual(a.point, b.point);
  assert.equal(a.loss, b.loss);
  assert.equal(a.iterations, b.iterations);
});

test('cmaes respects maxIterations and still returns the best point found', async () => {
  const { iterations } = await cmaes({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 3,
    seed: 1,
    convergenceTolerance: 1e-12, // unreachable in 3 generations, forces the cap
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(iterations <= 3, `expected iterations capped at 3, got ${iterations}`);
});

test('cmaes carries extra evaluate() fields through onto the returned result', async () => {
  const { result } = await cmaes({
    initialPoint: [0],
    initialStepSize: 1,
    evaluate: ([x]) => ({ loss: (x - 5) ** 2, tag: 'custom-field' }),
    maxIterations: 50,
    seed: 1,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(result.tag, 'custom-field');
});

test('cmaes evaluates a generation\'s population concurrently when evaluate is async', async () => {
  const delayMs = 40;
  const delayedEvaluate = (point) => new Promise(resolve => {
    setTimeout(() => resolve({ loss: (point[0] - 3) ** 2 + (point[1] + 2) ** 2 }), delayMs);
  });
  const startedAt = Date.now();
  await cmaes({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: delayedEvaluate,
    maxIterations: 1,
    seed: 1,
    yieldToEventLoop: () => Promise.resolve(),
  });
  const elapsed = Date.now() - startedAt;
  // n=2 gives lambda = 4 + floor(3*ln(2)) = 6. Sequential would take ~6*delayMs (240ms);
  // concurrent should land close to 1*delayMs. Generous bound to absorb scheduler jitter.
  assert.ok(elapsed < delayMs * 3, `expected the population to evaluate concurrently (~${delayMs}ms), took ${elapsed}ms`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/cmaes.test.mjs`
Expected: FAIL - `cmaes` is not exported yet.

- [ ] **Step 3: Implement `cmaes()`**

Add to `core/CMAES.js` (below `eigenSymmetric`):

```js
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
 * @returns {Promise<{ point: number[], loss: number, result: Object, iterations: number, converged: boolean }>}
 */
export async function cmaes({
  initialPoint, initialStepSize, evaluate, maxIterations, seed,
  convergenceTolerance = 1e-4,
  onProgress = null, onBusy = null, busyReportIntervalMs = 300,
  yieldToEventLoop,
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

  const evalPoint = async (point) => ({ point, ...(await evaluate(point)) });

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
    const candidates = await Promise.all(points.map((point) => evalPoint(point).then(async (result) => {
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
  }

  return { point: best.point, loss: best.loss, result: best, iterations, converged };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/cmaes.test.mjs`
Expected: PASS (10 tests total: 3 from Task 1 + 7 new)

- [ ] **Step 5: Commit**

```bash
git add core/CMAES.js tests/cmaes.test.mjs
git commit -m "feat: implement the core CMA-ES search algorithm"
```

---

## Task 3: `tuneFrequencies` becomes search-algorithm-agnostic

Wire `cmaes()` into the existing Phase 2 round loop as a selectable alternative to
`nelderMead()`, and add the statistically-gated `best`-tracking that applies regardless of
which algorithm is chosen.

**Files:**
- Modify: `core/SpinSimulator.js`
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: `cmaes` (Task 2).
- Produces: `tuneFrequencies(paytable, reelFrequencyTables, { ..., searchAlgorithm?:
  'nelderMead'|'cmaes', bestAcceptanceZ?: number })`; module-level `beatsIncumbent(candidate:
  {loss: number, trialRtpStdError？: number}, incumbent: {loss: number, trialRtpStdError?:
  number}|null, z: number) -> boolean`.

- [ ] **Step 1: Write the failing tests**

First, update the existing top-of-file import line (currently `import { gradientDescent1D,
nelderMead, tuneFrequencies, simulateSpins } from '../core/SpinSimulator.js';`) to also import
`beatsIncumbent`:

```js
import { gradientDescent1D, nelderMead, tuneFrequencies, simulateSpins, beatsIncumbent } from '../core/SpinSimulator.js';
```

Then add the new tests to `tests/tunefrequencies.test.mjs` (after the existing
parallel-dispatch tests, i.e. after line 901):

```js
test('beatsIncumbent always accepts when there is no incumbent yet', () => {
  assert.equal(beatsIncumbent({ loss: 5, trialRtpStdError: 0 }, null, 1), true);
});

test('beatsIncumbent rejects a "better" candidate whose margin is within combined measurement noise', () => {
  // Candidate's loss is only slightly lower than incumbent's, but both carry std error large
  // enough that the difference isn't statistically meaningful.
  const incumbent = { loss: 10, trialRtpStdError: 3 };
  const candidate = { loss: 9, trialRtpStdError: 3 };
  assert.equal(beatsIncumbent(candidate, incumbent, 1), false);
});

test('beatsIncumbent accepts a candidate that beats the incumbent by more than the combined noise margin', () => {
  const incumbent = { loss: 10, trialRtpStdError: 0.1 };
  const candidate = { loss: 2, trialRtpStdError: 0.1 };
  assert.equal(beatsIncumbent(candidate, incumbent, 1), true);
});

test('beatsIncumbent treats missing trialRtpStdError as zero, matching a raw comparison when noise-free', () => {
  // Both sides omit trialRtpStdError entirely -> margin collapses to z*sqrt(0+0) = 0, so any
  // strictly-lower loss is accepted, same as today's raw `<` comparison for deterministic
  // candidates (trialsPerPoint: 1, or a synthetic non-noisy evaluate like this one).
  const incumbent = { loss: 10 };
  const candidate = { loss: 9.999 };
  assert.equal(beatsIncumbent(candidate, incumbent, 1), true);
});

test('tuneFrequencies with searchAlgorithm: "nelderMead" (explicit) matches the default (omitted) exactly', async () => {
  const opts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 10, searchSeed: 42,
  };
  const withDefault = await tuneFrequencies(PAYTABLE, [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3], opts);
  const withExplicit = await tuneFrequencies(PAYTABLE, [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3], { ...opts, searchAlgorithm: 'nelderMead' });
  assert.deepEqual(withDefault.reelFrequencyTables, withExplicit.reelFrequencyTables);
  assert.equal(withDefault.rtp, withExplicit.rtp);
});

test('tuneFrequencies with searchAlgorithm: "cmaes" converges to a sane RTP on a real fixture', async () => {
  const { rtp, diagnostics } = await tuneFrequencies(PAYTABLE, [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3], {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 20000, trialsPerPoint: 1, maxIterations: 80,
    searchAlgorithm: 'cmaes', searchSeed: 42,
  });
  assert.ok(Math.abs(rtp - 96) < 10, `expected cmaes to get reasonably close to target RTP 96, got ${rtp}`);
  assert.ok(diagnostics.rtpPhase.iterationsRun > 0, 'expected the cmaes path to actually run iterations');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: FAIL - `beatsIncumbent` is not exported, `searchAlgorithm`/`bestAcceptanceZ` options
are silently ignored (the "cmaes" test will actually just run nelderMead today and may or may
not pass by coincidence - the `beatsIncumbent` import failure is the reliable signal here).

- [ ] **Step 3: Wire `cmaes` and `beatsIncumbent` into `core/SpinSimulator.js`**

Add the import near the top of the file (after the existing imports, ~line 6):

```js
import { cmaes } from './CMAES.js';
```

In the `tuneFrequencies` options destructure (~line 811-851), add two new options (anywhere in
the list - alongside `initialStepSize`/`searchSeed` reads naturally):

```js
    searchAlgorithm = 'nelderMead',
    bestAcceptanceZ = 1.0,
```

Add this module-level function near `nelderMead`/`gradientDescent1D` (top-level export, not
inside `tuneFrequencies` - it doesn't need any of that closure's state):

```js
/**
 * Whether `candidate` counts as a genuine improvement over `incumbent`, accounting for each
 * side's own measurement uncertainty (`trialRtpStdError` - see `measure()`'s own doc in
 * `tuneFrequencies`) rather than a raw `loss` comparison. A `candidate` only replaces a real
 * `incumbent` once it beats it by more than their combined standard error, scaled by `z` - so a
 * "better" result that's really just a luckier Monte Carlo sample can't silently become the new
 * best. Collapses to today's raw `<` comparison whenever both sides have zero (or missing)
 * `trialRtpStdError` - i.e. a deterministic evaluate, or `trialsPerPoint: 1`, is unaffected.
 * @param {{loss: number, trialRtpStdError?: number}} candidate
 * @param {{loss: number, trialRtpStdError?: number}|null} incumbent - `null` means "no incumbent
 *   yet", always accepted
 * @param {number} z - margin multiplier (tuneFrequencies' `bestAcceptanceZ` option)
 * @returns {boolean}
 */
export function beatsIncumbent(candidate, incumbent, z) {
  if (!incumbent) return true;
  const margin = z * Math.sqrt((candidate.trialRtpStdError ?? 0) ** 2 + (incumbent.trialRtpStdError ?? 0) ** 2);
  return (incumbent.loss - candidate.loss) > margin;
}
```

In the Phase 2 round loop, replace the `nelderMead` call (~line 1347-1364):

```js
      const nm = await nelderMead({
        initialPoint: point,
        initialStepSize: stepSize,
        evaluate: makeEvaluate(nmSeed),
        maxIterations: roundIterations,
        onProgress: onProgress
          ? (i, pt, result, roundBest, attempted) => onProgress('shape', roundStartIterations + i, null, { ...result, attempted }, roundBest)
          : null,
        onBusy: onProgress
          ? (info) => onProgress('busy', roundStartIterations + info.iteration, null, { ...info, sourcePhase: 'shape' }, null)
          : null,
        busyReportIntervalMs,
        yieldToEventLoop,
      });
```

with:

```js
      const runSearch = searchAlgorithm === 'cmaes' ? cmaes : nelderMead;
      const nm = await runSearch({
        initialPoint: point,
        initialStepSize: stepSize,
        evaluate: makeEvaluate(nmSeed),
        maxIterations: roundIterations,
        seed: nmSeed, // ignored by nelderMead (no such param); seeds cmaes's own sampling
        onProgress: onProgress
          ? (i, pt, result, roundBest, attempted) => onProgress('shape', roundStartIterations + i, null, { ...result, attempted }, roundBest)
          : null,
        onBusy: onProgress
          ? (info) => onProgress('busy', roundStartIterations + info.iteration, null, { ...info, sourcePhase: 'shape' }, null)
          : null,
        busyReportIntervalMs,
        yieldToEventLoop,
      });
```

Replace the raw best comparison (~line 1372):

```js
      if (!best || nm.result.loss < best.loss) best = nm.result;
```

with:

```js
      if (beatsIncumbent(nm.result, best, bestAcceptanceZ)) best = nm.result;
```

Add two new `@param` entries to `tuneFrequencies`' JSDoc, right after the
`options.initialWeightStrategy` block ends (~line 740, immediately before the `@param
{(phase: 'initial'|...` line for `onProgress`):

```
 * @param {'nelderMead'|'cmaes'} [options.searchAlgorithm='nelderMead'] - Which algorithm Phase
 *   2 uses to search the joint per-symbol weight space. `'nelderMead'` (default, unchanged) is
 *   a simplex search - cheap and effective for a small number of tunable symbols. `'cmaes'`
 *   (`core/CMAES.js`) is a population-based search that scales better to many tunable symbols
 *   at once (e.g. Candy Frenzy's ~84) and is more tolerant of noisy per-candidate RTP
 *   measurements, at the cost of evaluating a whole population every generation instead of one
 *   or two points. Both return the same shape, so switching this option doesn't change anything
 *   else about how Phase 2's round loop (restarts, stall detection, `reason` classification)
 *   behaves.
 * @param {number} [options.bestAcceptanceZ=1.0] - Margin (in combined standard errors) a new
 *   candidate must beat the current cross-round incumbent by, via `trialRtpStdError`, before it
 *   replaces it as `best` (see `beatsIncumbent`) - independent of `searchAlgorithm`. Collapses
 *   to a raw loss comparison whenever both candidates have zero/missing `trialRtpStdError`
 *   (e.g. `trialsPerPoint: 1`), so this only changes behavior on a game whose RTP measurement is
 *   actually noisy.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS, including all pre-existing tests in this file (same 3 pre-existing failures as
noted in Global Constraints, none newly broken).

Then run the full suite: `npm test`
Expected: 125 tests total (121 passing + the same 4 pre-existing failures), now plus this
task's and Task 1/2's new tests - confirm the pass/fail count only grew by new-test passes, no
regressions.

- [ ] **Step 5: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "feat: make tuneFrequencies' Phase 2 search pluggable (cmaes option) with noise-aware best tracking"
```

---

## Task 4: UI wiring (`core/SimulationPanel.js`)

Expose `searchAlgorithm` as a dropdown in the TUNE FREQUENCIES panel, next to "Initial Frequency
Strategy". This file has no automated test harness today (only `formatReelFrequencyTablesForCopy`
is unit-tested in `tests/simulationpanel.test.mjs` - the DOM-heavy panel functions are verified
manually via Playwright against the running dev server, consistent with how every other change
to this file was verified this session) - this task's verification step is a Playwright check,
not a new automated test.

**Files:**
- Modify: `core/SimulationPanel.js`

**Interfaces:**
- Consumes: `tuneFrequencies`' new `searchAlgorithm` option (Task 3) - the UI only needs to read
  a `<select>`'s `.value` and pass it through, exactly like `initialWeightStrategy` already does.

- [ ] **Step 1: Add the dropdown to the options grid**

In `openTuneFrequenciesPanel`'s template literal, right after the closing `</label>` of
"Initial Frequency Strategy" (~line 444) and before the grid's closing `</div>` (~line 445):

```html
        <label title="Which algorithm searches the per-symbol reel weights (Phase 2). Nelder-Mead (default) is a simplex search - simple and fast for a small number of tunable symbols. CMA-ES is a population-based search that scales better to many tunable symbols at once and is more tolerant of noisy RTP measurements (e.g. Candy Frenzy's cascade multiplier bonus) - at the cost of evaluating a whole population of candidates every generation instead of one or two." style="font-size: 0.8em; color: #ccc;">Search Algorithm<br>
          <select id="tune-search-algorithm" style="width: 100%; margin-top: 4px;">
            <option value="nelderMead" selected>Nelder-Mead (default)</option>
            <option value="cmaes">CMA-ES</option>
          </select>
        </label>
```

- [ ] **Step 2: Wire it into `startTuning`'s `inputs` and `options`**

In the `inputs` object (~line 620), add a line after `initialWeightStrategy`:

```js
    searchAlgorithm: tuneContainer.querySelector('#tune-search-algorithm'),
```

In the `options` object (~line 675), add a line after `initialWeightStrategy`:

```js
    searchAlgorithm: inputs.searchAlgorithm.value,
```

(No changes needed to the disable/enable-on-run logic - both loops already iterate
`Object.values(inputs)` generically, so the new entry is covered automatically.)

- [ ] **Step 3: Verify manually via Playwright against the running dev server**

With the dev server already running at `http://localhost:5757` (start it if not:
`npm run dev` or equivalent), navigate to a game's TUNE FREQUENCIES panel (e.g.
`http://localhost:5757/games/candyfrenzy/`), open the panel, confirm:

- The new "Search Algorithm" dropdown appears next to "Initial Frequency Strategy" with
  "Nelder-Mead (default)" pre-selected.
- Selecting "CMA-ES", setting a small `tune-max-iterations` (e.g. 10) and modest
  `tune-trial-spins` (e.g. 3000) for a fast run, then clicking START TUNING completes without
  errors and produces a results panel (RTP/log/live table all render, same as the Nelder-Mead
  path).
- The browser console shows no new errors during a CMA-ES run.

- [ ] **Step 4: Commit**

```bash
git add core/SimulationPanel.js
git commit -m "feat: expose CMA-ES as a selectable search algorithm in the TUNE FREQUENCIES panel"
```

---

## Task 5: Documentation

Bring `docs/ARCHITECTURE.md` in line with the new pluggable search algorithm, and fix an
already-stale sentence in the same section while it's open (the variance-warning description
still describes the old "twice `rtpTolerancePct`" heuristic, superseded earlier this session by
`maxRtpStdError` gating but never corrected here).

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Update the `tuneFrequencies` description (~line 448)**

Change:

```markdown
frequencies that hit a target RTP and free-spins trigger rate, returning a tuned clone (never
mutates its input). See its own extensive JSDoc in the file for the full two-phase strategy
(trigger-rate scaling, then a joint Nelder-Mead search over per-symbol weights) and every
```

to:

```markdown
frequencies that hit a target RTP and free-spins trigger rate, returning a tuned clone (never
mutates its input). See its own extensive JSDoc in the file for the full two-phase strategy
(trigger-rate scaling, then a joint per-symbol weight search - Nelder-Mead by default, or
CMA-ES via `options.searchAlgorithm: 'cmaes'`, see "Pluggable search algorithm" below) and every
```

- [ ] **Step 2: Fix the stale variance-warning sentence (~line 459)**

Change:

```markdown
`core/SimulationPanel.js`'s tuning panel surfaces this as a warning banner when the
spread exceeds twice `rtpTolerancePct`.
```

to:

```markdown
`core/SimulationPanel.js`'s tuning panel always surfaces this spread alongside the RTP figure,
and shows a dedicated warning banner whenever the candidate's standard error exceeds
`options.maxRtpStdError` (which also gates whether `tuneFrequencies` itself considers that
result `'converged'` at all - see `maxRtpStdError`'s own doc).
```

- [ ] **Step 3: Add a "Pluggable search algorithm" subsection**

Add after the existing "### Parallel tuning (`options.runTrial`)" section (~after line 492, before
the `## core/SimulationPanel.js` heading):

```markdown
### Pluggable search algorithm (`options.searchAlgorithm`)

Phase 2's joint per-symbol weight search can run on either of two interchangeable algorithms,
selected via `options.searchAlgorithm` (`'nelderMead'` - the default, unchanged - or `'cmaes'`):
both `nelderMead()` (this file) and `cmaes()` (`core/CMAES.js`) return the exact same
`{ point, loss, result, iterations, converged }` shape, so `tuneFrequencies`' round loop
(restarts, stall detection, seed-shifting, `reason` classification) calls either one without
knowing which it got.

CMA-ES (Covariance Matrix Adaptation Evolution Strategy) samples a whole population of
candidates each generation from a covariance-shaped Gaussian distribution around its current
best guess, ranks them, and adapts its mean/step-size/covariance from that ranking - see
`core/CMAES.js`'s own doc for the full algorithm. Two properties make it a better fit than
Nelder-Mead for a search like Candy Frenzy's (~84 tunable dimensions, ~70% measured RTP standard
error at default trial settings): every generation's population evaluates concurrently across
the Worker pool (a bigger, more consistent win than Nelder-Mead's occasional shrink-step
parallelism), and its rank-based, population-wide comparisons are inherently more tolerant of
noisy per-candidate measurements than Nelder-Mead's pairwise `<` comparisons.

Independent of which algorithm is chosen, `tuneFrequencies`' own cross-round `best`-tracking
(`beatsIncumbent`, this file) only replaces the incumbent once a new candidate beats it by more
than their combined `trialRtpStdError`-based margin (scaled by `options.bestAcceptanceZ`,
default `1.0`) - so a "better" result that's really just a luckier Monte Carlo sample can't
silently become the new best, regardless of which algorithm produced it.
```

- [ ] **Step 4: Bump the "Docs last synced" footer**

Run `git rev-parse --short HEAD` to get the current commit hash, then update the footer line at
the end of the file to `_Docs last synced with the codebase: <today's date>, commit
`<that hash>`._` (matching the existing footer's format).

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: document the pluggable CMA-ES search algorithm and fix a stale variance-warning description"
```

---

## Self-Review Notes

- **Spec coverage**: every design-doc section has a task - `core/CMAES.js`
  (Tasks 1-2), pluggable dispatch + statistically-gated best tracking (Task 3), UI (Task 4),
  docs (Task 5). The design's non-goals (no `nelderMead()` changes, no Phase 1/2 merge, no SPSA)
  are respected throughout - no task touches any of them.
- **Determinism**: Task 2's dedicated determinism test plus Task 3's byte-identical
  default-vs-explicit-`'nelderMead'` test together cover the project's hard invariant from both
  the new algorithm's own side and the integration side.
- **No placeholders**: every step above shows complete, real code - no "add appropriate
  handling" or "similar to Task N" shortcuts.
