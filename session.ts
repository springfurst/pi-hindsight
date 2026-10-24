/**
 * Per-session mutable state for the extension runtime.
 */

export interface HookRecord {
  firedAt?: string;
  result?: "ok" | "failed" | "skipped" | "none";
  detail?: string;
}

export interface HookStats {
  sessionStart: HookRecord;
  recall: HookRecord;
  retain: HookRecord;
}

export interface SessionState {
  cwd: string;
  turnsSinceRecall: number;
  activeUserTurn: boolean;
  recallCalledThisTurn: boolean;
  sessionHintResolved: boolean;
  sessionHintActive: boolean;
  sessionHintMessage: string;
  retainSuccessCount: number;
  retainEligibleCount: number;
  currentPrompt: string;
  shuttingDown: boolean;
  disabled: boolean;
  hookStats: HookStats;
  pendingRetains: Map<Promise<unknown>, () => void>;
}

function emptyHookStats(): HookStats {
  return { sessionStart: {}, recall: {}, retain: {} };
}

export function createSessionState(cwd: string = process.cwd()): SessionState {
  return {
    cwd,
    turnsSinceRecall: 0,
    activeUserTurn: false,
    recallCalledThisTurn: false,
    sessionHintResolved: false,
    sessionHintActive: false,
    sessionHintMessage: "",
    retainSuccessCount: 0,
    retainEligibleCount: 0,
    currentPrompt: "",
    shuttingDown: false,
    disabled: false,
    hookStats: emptyHookStats(),
    pendingRetains: new Map(),
  };
}

export function resetSessionState(state: SessionState, cwd: string): void {
  state.cwd = cwd;
  state.turnsSinceRecall = 0;
  state.activeUserTurn = false;
  state.recallCalledThisTurn = false;
  state.sessionHintResolved = false;
  state.sessionHintActive = false;
  state.sessionHintMessage = "";
  state.retainSuccessCount = 0;
  state.retainEligibleCount = 0;
  state.currentPrompt = "";
  state.shuttingDown = false;
  state.disabled = false;
  state.hookStats = emptyHookStats();
  state.pendingRetains.clear();
}
