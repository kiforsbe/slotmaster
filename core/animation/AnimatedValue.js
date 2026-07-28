// A crude CSS-animation equivalent for plain JS values: a property is either a static value, or
// a { default, animation: { to, duration, easing } } descriptor - "transition from `default` to
// `animation.to` over `animation.duration`ms using `animation.easing`", the same mental model as
// CSS's `transition: property duration easing`. One resolver works for any numeric property
// (font size, scale multiplier, rise distance, ...) - a config author picks the easing/duration
// per property without every call site inventing its own tween math.

// Standard cubic easings, t/return both 0-1. Same shapes as CSS's ease-in/ease-out/ease-in-out.
export const EASINGS = {
  linear: t => t,
  easeIn: t => t * t * t,
  easeOut: t => 1 - Math.pow(1 - t, 3),
  easeInOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

/**
 * Resolves an animatable property spec to its concrete value at `elapsedMs` since the
 * animation's start.
 *
 * @param {number|{default: number, animation?: {to: number, duration?: number, easing?: string}}} spec -
 *   a plain number (static, never animates), or a descriptor: `default` is the starting value,
 *   `animation` (if present) describes the transition to `animation.to`. Omitting `animation`
 *   (or passing a plain number) makes the property static at its default value.
 * @param {number} elapsedMs - ms since the animation should have started (e.g. `now - spawnTime`).
 * @param {number} [fallbackDurationMs] - used when `animation.duration` itself is omitted - lets
 *   a property default to "animate across this popup's whole lifetime" without hardcoding that
 *   lifetime into every spec (see CascadeDropAnimator's `position`, whose default duration is
 *   the popup's own on-screen duration, turbo-dependent).
 * @returns {number} the current value - `spec.default` before the animation starts conceptually
 *   has no meaning (elapsedMs is assumed >= 0), held at `animation.to` once elapsedMs exceeds
 *   the resolved duration.
 */
export function resolveAnimatedValue(spec, elapsedMs, fallbackDurationMs) {
  if (typeof spec !== 'object' || spec === null) return spec;
  const from = spec.default;
  if (!spec.animation) return from;

  const { to, duration = fallbackDurationMs ?? 300, easing = 'easeOut' } = spec.animation;
  const t = duration > 0 ? Math.min(elapsedMs / duration, 1) : 1;
  const easingFn = EASINGS[easing] || EASINGS.easeOut;
  return from + (to - from) * easingFn(t);
}
