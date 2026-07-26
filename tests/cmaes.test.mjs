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
