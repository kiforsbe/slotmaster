// Physical reel-scroll entrance (SlotEngine.js's default today): reels spin up, then land in a
// staggered stop, one after another. A line-pay spin's step sequence is always length 1, so
// playTransition is never actually invoked by CoreSlotEngine - it exists only to satisfy the
// SpinAnimator interface every animator implements.
//
// playEntrance's body below is intentionally a stub, not a finished extraction: SlotEngine.js's
// animate()/update()/easeOutCubic() (lines ~230-480) and the symbol-placement half of
// renderReelsSymbols (~928-949) implement a real-time requestAnimationFrame loop with
// precomputed landing timestamps, per-reel bounce physics, and turbo-speed handling - genuinely
// risky to rewrite blind against a canvas that isn't running (this file has no automated test
// harness; canvas animation is verified by hand). Finishing this extraction is folded into
// Task 14 (Lucky Fruits migration, docs/superpowers/plans/2026-07-28-core-modularization.md) -
// the first point this animator has a running game to verify against.
export class ReelScrollAnimator {
  constructor(renderer, { spinDuration = 2000, reelDelay = 150 } = {}) {
    this.renderer = renderer;
    this.spinDuration = spinDuration;
    this.reelDelay = reelDelay;
  }

  playEntrance(step, ctx, onDone) {
    // TODO(Task 14): extract SlotEngine.js's animate()/update()/easeOutCubic() and the
    // symbol-placement half of renderReelsSymbols here, replacing `this.state`-driven control
    // flow with a local tween loop scoped to this one call. Call onDone() once every reel's
    // landing tween has completed against step.grid.
    onDone();
  }

  playTransition(prevStep, nextStep, ctx, onDone) {
    onDone();
  }
}
