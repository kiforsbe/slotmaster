// Shared UI metadata for the tuning controls. The panel view builds controls
// from it, while reports use the same keys to explain the current loss state.
export const PENALTY_INTENTS = [
  {
    key: 'ordering', lossKey: 'ordering', weightId: 'tune-ordering-weight', label: 'Respect payout ordering',
    title: "How hard the search works to keep each reel's payout-ordering preference (set per reel below) satisfied. A higher-paying symbol should not be more frequent than a lower-paying one - or the reverse, if that reel's preference is 'more frequent'. Always a soft preference: the search will accept a small violation rather than push RTP far off target.",
  },
  {
    key: 'limit', lossKey: 'limits', weightId: 'tune-limit-weight', label: 'Respect per-symbol frequency limits',
    title: "How hard the search works to keep each symbol inside its own minFrequency/maxFrequency, which are set in that symbol's FREQUENCY_REELn entry in game.js rather than here.",
  },
  {
    key: 'uniformity', lossKey: 'uniformity', weightId: 'tune-uniformity-weight', label: 'Keep symbols evenly spread',
    title: "How hard the search works to keep every tunable symbol near a straight-line target across that reel's payout tiers. The line is flat when the reel's ordering preference is 'No preference', and tilts to match that preference otherwise - so this never fights ordering with a competing flat target.",
  },
  {
    key: 'spacing', lossKey: 'spacing', weightId: 'tune-spacing-weight', label: 'Honor reel spacing',
    title: "How hard the search works to keep the generated strip honoring each symbol's minGap and maxStack. generateReel enforces both best-effort - on a strip too dense to space a symbol out it silently gives up - so without this the search sees no cost in pushing a frequency past what the strip can represent. On a cluster-pays game that clumping is exactly what inflates cluster wins and RTP. Note this cannot always reach zero: a game already over the ceiling at baseline starts non-zero, and the point is to stop the search making it much worse.",
  },
  {
    key: 'triggerRate', lossKey: 'triggerRate', weightId: 'tune-trigger-rate-weight', label: 'Hold the free-spin trigger rate',
    title: "How hard the search works to keep the trigger rate inside its target band. Phase 2 never tunes trigger symbols directly, so on a line-pay game this cannot move and can stay Off. On a cascade game it moves a lot: the other symbols' weights control how readily clusters form, which controls cascade depth, and every cascade refills the grid with fresh chances to draw the scatter. Measured on Candy Frenzy, reweighting only the candies swings the trigger rate from 0.75% to 2.04%.",
  },
];
