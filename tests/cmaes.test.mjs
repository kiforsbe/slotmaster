import test from 'node:test';
import assert from 'node:assert/strict';
import { eigenSymmetric, cmaes } from '../core/CMAES.js';

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

test('cmaes stops cooperatively once signal.aborted is set, returning a usable best-so-far', async () => {
  const controller = new AbortController();
  let generationsSeen = 0;
  const { iterations, point } = await cmaes({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 100,
    seed: 1,
    signal: controller.signal,
    onProgress: () => { generationsSeen++; if (generationsSeen === 3) controller.abort(); },
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.ok(iterations < 100, `expected far fewer than 100 generations to have run, got ${iterations}`);
  assert.equal(iterations, generationsSeen, 'expected to stop right after the generation that requested the abort, not later');
  assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]), 'expected a real, usable point even though the search was cut short');
});

test('cmaes never checks signal before generation 0 has a usable best', async () => {
  // Aborting before the very first onProgress call fires must still return a real result (from
  // generation 0's own evaluation) rather than crashing on a null `best`.
  const controller = new AbortController();
  controller.abort();
  const { iterations, loss } = await cmaes({
    initialPoint: [0, 0],
    initialStepSize: 1,
    evaluate: ([x, y]) => ({ loss: (x - 3) ** 2 + (y + 2) ** 2 }),
    maxIterations: 100,
    seed: 1,
    signal: controller.signal,
    yieldToEventLoop: () => Promise.resolve(),
  });
  assert.equal(iterations, 1, 'expected exactly one generation to have run before the already-set signal was noticed');
  assert.ok(Number.isFinite(loss));
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
