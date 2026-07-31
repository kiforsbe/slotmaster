// Replaces the duplicated `_pushSpinLogEntry` methods in SlotEngine.js/CascadeEngine.js with one
// component both a line-pay and cascade CoreSlotEngine plug in. Builds entries from
// core/SpinLog.js's existing pure functions - this class only owns the bounded buffer and the
// choice of which SpinLog builder a given sequence shape needs.
import { createSpinLogEntry, createCascadeSpinLogEntry, applyExpandingWinToSpinLogEntry } from '../SpinLog.js';

const DEFAULT_MAX_ENTRIES = 20000;

export class SpinLogRecorder {
  constructor(gameConfig = {}) {
    this.gameConfig = gameConfig;
    this.maxEntries = gameConfig.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.entries = [];
    this.listeners = new Set();
  }

  /**
   * Subscribe to newly recorded live-spin entries. Returns an unsubscribe function so a
   * developer panel can follow the recorder only while it is open.
   */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record({ sequence, scatterWin, seed, timestamp, phase, chargedBet, expandingWinData, expandingSymbol }) {
    const isCascade = sequence.length > 0 && 'clusterWins' in sequence[0];
    const entry = isCascade
      ? this._buildCascadeEntry(sequence, scatterWin, seed, timestamp, phase, chargedBet)
      : this._buildLineEntry(sequence, seed, timestamp, phase, chargedBet);

    // Only known once the expansion animation has actually resolved (see
    // CoreSlotEngine._spin's own 'expanding' state handling), so it can't travel inside `entry`
    // from the start the way lineWins/scatterWin do - applyExpandingWinToSpinLogEntry folds it
    // in after the fact, matching SlotEngine.js's own _pushSpinLogEntry timing.
    if (expandingWinData && expandingWinData.totalPayoutMultiplier > 0) {
      applyExpandingWinToSpinLogEntry(entry, {
        expandingSymbol,
        expandingReels: expandingWinData.expandingReels.length,
        expandingWin: expandingWinData.totalPayoutMultiplier * this.gameConfig.betPerLine,
      });
    }

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.listeners.forEach(listener => {
      try {
        listener(entry);
      } catch (error) {
        // A dev-only observer must never be able to break the live spin lifecycle.
        console.warn('SpinLogRecorder listener failed:', error);
      }
    });
    return entry;
  }

  _buildLineEntry(sequence, seed, timestamp, phase, chargedBet) {
    const step = sequence[0];
    const winData = {
      lineWins: step.lineWins,
      scatterWin: step.scatterWin,
      totalLinePayoutMultiplier: (step.lineWins || []).reduce((sum, lw) => sum + (lw.payout || 0), 0),
    };
    return createSpinLogEntry({
      spinIndex: this.entries.length + 1,
      phase,
      betPerLine: this.gameConfig.betPerLine,
      linesCount: this.gameConfig.linesCount,
      chargedBet,
      scatterBetBase: this.gameConfig.betPerLine * this.gameConfig.linesCount,
      winData,
      scatterSymbol: this.gameConfig.scatterSymbol,
      seed,
      timestamp,
    });
  }

  _buildCascadeEntry(sequence, scatterWin, seed, timestamp, phase, chargedBet) {
    return createCascadeSpinLogEntry({
      spinIndex: this.entries.length + 1,
      phase,
      betAmount: this.gameConfig.betAmount,
      chargedBet,
      cascadeSteps: sequence,
      scatterSymbol: this.gameConfig.scatterSymbol,
      scatterWin,
      seed,
      timestamp,
    });
  }
}
