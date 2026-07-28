// Cascade drop-in/clear/fall entrance and transition (CascadeEngine.js's default today): the
// initial grid drops in column by column (playEntrance); between cascade steps, a winning
// cluster's cells clear one cluster at a time, then the vacated cells' replacements fall in
// (playTransition).
//
// Both method bodies below are intentionally stubs, not finished extractions: CascadeEngine.js's
// animate()/update()/_rampSpeed()/_columnStartDelay()/_onStepLanded()/_beginClusterClear()/
// _spawnClusterWinPopups()/_advanceToNextStep()/_spawnClearParticles() (lines ~241-437) are the
// largest, most stateful piece of either engine class - genuinely risky to rewrite blind against
// a canvas that isn't running (no automated test harness covers canvas animation; it's verified
// by hand). Finishing this extraction is folded into Task 17 (Candy Frenzy migration,
// docs/superpowers/plans/2026-07-28-core-modularization.md) - the first point this animator has
// a running game to verify against.
export class CascadeDropAnimator {
  constructor(renderer, particleSystem, { normalClearDurationMs = 760, turboClearDurationMs = 300 } = {}) {
    this.renderer = renderer;
    this.particleSystem = particleSystem;
    this.normalClearDurationMs = normalClearDurationMs;
    this.turboClearDurationMs = turboClearDurationMs;
  }

  playEntrance(step, ctx, onDone) {
    // TODO(Task 17): extract CascadeEngine.js's animate()/update()/_rampSpeed()/
    // _columnStartDelay() here for the "cells fall in" half. Call onDone() once every column has
    // landed on step.grid.
    onDone();
  }

  playTransition(prevStep, nextStep, ctx, onDone) {
    // TODO(Task 17): extract _onStepLanded()/_beginClusterClear()/_spawnClusterWinPopups()/
    // _advanceToNextStep()/_spawnClearParticles() here: clear prevStep's winning cells (one
    // cluster at a time, via this.particleSystem for the clear-burst effect), then fall
    // nextStep's grid in using the same per-column logic as playEntrance. Call onDone() once
    // nextStep.grid is fully landed.
    onDone();
  }
}
