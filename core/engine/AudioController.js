// Wraps the SlotAudio singleton behind the hook interface CoreSlotEngine calls generically, so
// the skeleton never imports or calls SlotAudio by name itself (today SlotEngine.js/
// CascadeEngine.js each do, at ad hoc points inside their own methods).
import { audio } from '../audio/SlotAudio.js';

export class AudioController {
  onSpinStart() { audio.playSpin(); }
  onReelStop(reelIndex) { audio.playReelStop(reelIndex); }
  onWin(amount) { audio.playWin(amount); }
  onScatterTrigger() { audio.playScatterTrigger(); }
  onExpand() { audio.playExpand(); }
  onClusterWin(payoutMultiplier) { audio.playClusterWin(payoutMultiplier); }
}
