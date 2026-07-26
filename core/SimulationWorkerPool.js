// A small pool of persistent Worker threads, each running core/simulationTrialWorker.js, that
// tuneFrequencies() dispatches individual simulateSpins() trials to via its `options.runTrial`
// hook (see SpinSimulator.js's own doc) - this is what turns "many Monte Carlo measurements,
// one at a time on a single CPU core" into "measured concurrently across every available core",
// without tuneFrequencies() itself needing to know Workers exist at all.
//
// Deliberately a flat task queue over a fixed set of persistent Workers (not one Worker spun up
// per trial) - creating a Worker has real startup cost, and tuneFrequencies can dispatch
// thousands of trials over a single run; reusing the same N Workers for the whole run avoids
// paying that cost per trial.

// Leaves one core free for the tab's own UI thread (rendering the live tuning log/gauges) -
// using every core for trial workers would make the page itself janky exactly while it's
// trying to show progress for a run that's likely to take a while anyway.
function defaultPoolSize() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, cores - 1);
}

/**
 * @param {number} [size] - Number of persistent Worker threads to spawn. Defaults to
 *   `navigator.hardwareConcurrency - 1` (or 4 if unavailable), floored at 1 - a pool of size 1
 *   still moves every trial off the calling thread, same as the old single dedicated worker,
 *   it just never runs more than one trial at a time.
 * @returns {{
 *   runTrial: (config: Object, numSpins: number, betPerLine: number, linesCount: number, rngSeed: number|null) => Promise<{ rtpRaw: number, freeSpinsTriggered: number, baseSpins: number }>,
 *   terminate: () => void,
 *   size: number,
 * }}
 */
export function createSimulationWorkerPool(size = defaultPoolSize()) {
  const pending = new Map(); // taskId -> { resolve, reject }
  const queue = [];
  let nextTaskId = 0;

  function settleTask(taskId, error, result) {
    const entry = pending.get(taskId);
    if (!entry) return; // already settled (or an error for a task this worker wasn't running)
    pending.delete(taskId);
    if (error) entry.reject(error instanceof Error ? error : new Error(error));
    else entry.resolve(result);
  }

  function createWorkerEntry() {
    const worker = new Worker(new URL('./simulationTrialWorker.js', import.meta.url), { type: 'module' });
    const entry = { worker, busy: false, currentTaskId: null };
    worker.onmessage = (event) => {
      const { taskId, result, error } = event.data;
      entry.busy = false;
      entry.currentTaskId = null;
      settleTask(taskId, error, result);
      pump();
    };
    worker.onerror = (event) => {
      entry.busy = false;
      const taskId = entry.currentTaskId;
      entry.currentTaskId = null;
      if (taskId != null) settleTask(taskId, event.message || 'simulation worker failed', null);
      pump();
    };
    return entry;
  }

  const entries = Array.from({ length: Math.max(1, size) }, createWorkerEntry);

  // Hands queued tasks to every currently-idle worker, not just one - called after any worker
  // frees up or any task is enqueued, so the queue drains as fast as the pool can go.
  function pump() {
    if (queue.length === 0) return;
    const idle = entries.find(e => !e.busy);
    if (!idle) return;
    const task = queue.shift();
    idle.busy = true;
    idle.currentTaskId = task.taskId;
    idle.worker.postMessage(task);
    pump();
  }

  function runTrial(config, numSpins, betPerLine, linesCount, rngSeed) {
    return new Promise((resolve, reject) => {
      const taskId = nextTaskId++;
      pending.set(taskId, { resolve, reject });
      queue.push({ taskId, config, numSpins, betPerLine, linesCount, rngSeed });
      pump();
    });
  }

  function terminate() {
    entries.forEach(e => e.worker.terminate());
  }

  return { runTrial, terminate, size: entries.length };
}
