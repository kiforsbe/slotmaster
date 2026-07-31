// Presentation for straight horizontal/vertical cascade wins.  Kept separate from the
// connected-cluster outline renderer so a game can use either vocabulary without the
// renderer turning one into a special case of the other.
export class StraightLineWinRenderer {
  render(ctx, { currentClusterWins, currentClusterIndex, layout, visualizer = {} } = {}) {
    if (!currentClusterWins?.length || currentClusterIndex == null || currentClusterIndex < 0) return;
    const win = currentClusterWins[currentClusterIndex];
    if (win?.kind !== 'straight-line' || !win.winningPositions?.length) return;

    const { reelsX, reelsY, symbolWidth, symbolHeight } = layout;
    const ordered = [...win.winningPositions].sort((a, b) => win.orientation === 'horizontal'
      ? a[0] - b[0]
      : a[1] - b[1]);
    const pointOf = ([col, row]) => [
      reelsX + (col + 0.5) * symbolWidth,
      reelsY + (row + 0.5) * symbolHeight,
    ];
    const [startX, startY] = pointOf(ordered[0]);
    const [endX, endY] = pointOf(ordered.at(-1));
    const color = win.orientation === 'horizontal'
      ? (visualizer.horizontalColor || '#fff15a')
      : (visualizer.verticalColor || '#79f7ff');

    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = visualizer.glow ?? 18;
    ctx.lineWidth = visualizer.width ?? Math.max(5, Math.min(symbolWidth, symbolHeight) * 0.1);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(2, ctx.lineWidth * 0.28);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    if (win.wildSpawnPosition) {
      const [x, y] = pointOf(win.wildSpawnPosition);
      const radius = Math.min(symbolWidth, symbolHeight) * 0.18;
      ctx.fillStyle = '#dfff35';
      ctx.strokeStyle = '#16320c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#16320c';
      ctx.font = `bold ${Math.max(11, radius * 1.35)}px Outfit, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', x, y + 1);
    }
    ctx.restore();
  }
}
