// Win-celebration particle burst, extracted from SlotEngine's inline particle code so
// CascadeEngine can reuse the same effect for its own cluster-clear celebrations.

// Caps how many particles exist at once - spawn() clears any previous burst first, and each
// spot only gets particles up to this overall budget (matches SlotEngine's prior behavior).
const MAX_PARTICLES = 200;
const PARTICLES_PER_SPOT = 20;

export class ParticleSystem {
  constructor() {
    this.particles = [];
  }

  /** Advances every particle one frame and drops any that have fully faded. */
  update() {
    this.particles = this.particles.filter(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= p.decay;
      p.rotation += p.vRotation;
      return p.alpha > 0;
    });
  }

  /**
   * Replaces any current burst with a fresh one centered on each given world-space point.
   * @param {{x: number, y: number}[]} points
   */
  spawn(points) {
    this.particles = [];
    const maxSpots = Math.min(points.length, Math.floor(MAX_PARTICLES / PARTICLES_PER_SPOT));
    points.slice(0, maxSpots).forEach(({ x: cx, y: cy }) => {
      for (let i = 0; i < PARTICLES_PER_SPOT; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1 + Math.random() * 5;
        this.particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1.5,
          size: 2 + Math.random() * 6,
          alpha: 1.0,
          decay: 0.015 + Math.random() * 0.02,
          color: `hsl(${45 + Math.random() * 15}, 100%, ${50 + Math.random() * 30}%)`,
          rotation: Math.random() * Math.PI * 2,
          vRotation: -0.1 + Math.random() * 0.2,
        });
      }
    });
  }

  render(ctx) {
    this.particles.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  clear() {
    this.particles = [];
  }
}
