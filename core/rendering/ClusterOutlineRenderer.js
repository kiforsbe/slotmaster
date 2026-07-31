// Canvas presentation for active cascade wins.
//
// ClusterOutline.js owns only the geometry of a connected cluster. This class owns the
// presentation of that geometry and of cascade payline wins, so SlotRenderer can orchestrate
// the frame without knowing how either visual is painted.
import { buildClusterOutlinePaths, buildRoundedClusterOutlineCommands } from '../math/ClusterOutline.js';

const LINE_TAG_OFFSET = 15;
const CASCADE_LINE_COLORS = [
  '#ff003c', '#00ff66', '#00d2ff', '#ffcc00', '#ff00ff',
  '#ff6600', '#00ffff', '#9933ff', '#d4af37', '#33ff33',
];

export class ClusterOutlineRenderer {
  /**
   * Paint the active cascade win using the same per-game visualizer configuration for either
   * representation: a connected-cluster perimeter or a payline path.
   *
   * The animator owns which win is active; this renderer owns how that win is represented.
   * Payline wins carry `lineIndex`, while connected-cluster wins carry only `winningPositions`.
   */
  render(ctx, {
    currentClusterWins,
    currentClusterIndex,
    layout,
    paylines,
    reelsCount,
    visualizer = {},
    drawClusterOutline = false,
  } = {}) {
    const win = currentClusterWins?.[currentClusterIndex];
    if (!win) return;

    if (win.lineIndex != null) {
      this.drawPaylinePath(ctx, win, layout, paylines, reelsCount, visualizer);
      // A cascade payline win still has a concrete set of winning cells. Keep the active
      // payline as the game's primary explanation, but let clusterVisualizer add its configured
      // perimeter around those cells too. This is what makes the same visualizer useful for
      // Mayan Tumble-style line wins as well as Candy Frenzy-style connected clusters.
      if (drawClusterOutline) this.drawClusterOutline(ctx, win, layout, visualizer);
    } else if (drawClusterOutline) {
      this.drawClusterOutline(ctx, win, layout, visualizer);
    }
  }

  drawPaylinePath(ctx, win, layout, paylines, reelsCount, visualizer = {}) {
    const path = paylines?.[win.lineIndex];
    const count = reelsCount ?? path?.length;
    if (!path || !count || path.length < count || !layout) return;

    const { reelsX, reelsY, reelsWidth, symbolWidth, symbolHeight } = layout;
    const color = visualizer.color ?? CASCADE_LINE_COLORS[win.lineIndex % CASCADE_LINE_COLORS.length];
    const lastReel = count - 1;
    const centerOf = (col) => ({
      x: reelsX + (col + 0.5) * symbolWidth,
      y: reelsY + (path[col] + 0.5) * symbolHeight,
    });
    const leftTagX = reelsX - LINE_TAG_OFFSET;
    const rightTagX = reelsX + reelsWidth + LINE_TAG_OFFSET;

    ctx.save();
    this._applyStrokeStyle(ctx, visualizer, {
      color,
      lineWidth: 4,
      glow: 12,
    });
    ctx.beginPath();
    ctx.moveTo(leftTagX, centerOf(0).y);
    for (let col = 0; col < count; col++) {
      const { x, y } = centerOf(col);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(rightTagX, centerOf(lastReel).y);
    ctx.stroke();
    ctx.restore();

    const label = win.lineIndex + 1;
    this.drawLineTag(ctx, label, leftTagX, centerOf(0).y, color);
    this.drawLineTag(ctx, label, rightTagX, centerOf(lastReel).y, color);
  }

  drawClusterOutline(ctx, cluster, layout, visualizer = {}) {
    if (!cluster?.winningPositions?.length || !layout) return;

    const { symbolWidth, symbolHeight } = layout;
    ctx.save();
    this._applyStrokeStyle(ctx, visualizer, {
      color: '#fff4a8',
      lineWidth: Math.max(3, Math.min(symbolWidth, symbolHeight) * 0.075),
      glow: 14,
    });
    ctx.beginPath();

    const paths = buildClusterOutlinePaths(cluster.winningPositions, layout);
    buildRoundedClusterOutlineCommands(paths, visualizer).forEach(commands => {
      commands.forEach(command => {
        if (command.type === 'move') ctx.moveTo(command.x, command.y);
        else if (command.type === 'line') ctx.lineTo(command.x, command.y);
        else ctx.bezierCurveTo(command.cp1x, command.cp1y, command.cp2x, command.cp2y, command.x, command.y);
      });
    });
    ctx.stroke();
    ctx.restore();
  }

  drawLineTag(ctx, num, x, y, color) {
    this.drawTag(ctx, num, x, y, color);
  }

  drawTag(ctx, num, x, y, color) {
    ctx.save();
    ctx.fillStyle = '#0f0f13';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Outfit, Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(num, x, y);
    ctx.restore();
  }

  _applyStrokeStyle(ctx, visualizer, defaults) {
    const pulse = this._pulseAlpha(visualizer.pulse);
    const glow = visualizer.glow === false ? 0 : (visualizer.glow ?? defaults.glow);

    ctx.strokeStyle = visualizer.color ?? defaults.color;
    ctx.lineWidth = visualizer.lineWidth ?? defaults.lineWidth;
    ctx.lineCap = visualizer.lineCap ?? 'round';
    ctx.lineJoin = visualizer.lineJoin ?? 'round';
    if (visualizer.miterLimit != null) ctx.miterLimit = visualizer.miterLimit;
    ctx.setLineDash?.(visualizer.lineDash ?? []);
    ctx.lineDashOffset = visualizer.lineDashOffset ?? 0;
    ctx.globalAlpha = (visualizer.alpha ?? 1) * pulse;
    ctx.shadowColor = visualizer.glowColor ?? ctx.strokeStyle;
    ctx.shadowBlur = glow;
  }

  _pulseAlpha(pulseConfig) {
    if (pulseConfig === false) return 1;
    const pulse = pulseConfig || {};
    const minAlpha = pulse.minAlpha ?? 0.82;
    const maxAlpha = pulse.maxAlpha ?? 1;
    const periodMs = pulse.periodMs ?? 690;
    const phase = (Math.sin((Date.now() / periodMs) * Math.PI * 2) + 1) / 2;
    return minAlpha + (maxAlpha - minAlpha) * phase;
  }
}
