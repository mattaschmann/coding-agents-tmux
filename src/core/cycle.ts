// Priority ranking for the `cycle` command. Pure (no tmux/fs) so it is unit
// testable in isolation.
//
// Ordering is seen-major: unseen panes come first, then already-seen panes, so
// repeated presses reach every agent pane and wrap rather than stopping once the
// unacknowledged ones are visited. Within each of those two groups, panes are
// ordered by attention tier (highest first), then oldest `statusSince` first
// (true FIFO — a long-waiting pane is never starved by newer arrivals):
//   0 waiting-question / waiting-input · 1 idle · 2 new · 3 running · 4 unknown
//
// "seen" means the pane was the active pane at some point since it entered its
// current status; it resets when the status changes (see cycle-ledger).

import type { CycleLedger } from "./cycle-ledger.ts";
import type { PaneRuntimeSummary, PaneTarget, RuntimeStatus } from "../types.ts";

function getCycleTier(status: RuntimeStatus): number {
  switch (status) {
    case "waiting-question":
    case "waiting-input":
      return 0;
    case "idle":
      return 1;
    case "new":
      return 2;
    case "running":
      return 3;
    default:
      return 4;
  }
}

/**
 * Rank panes into the cycle queue. Unseen panes first, then seen panes; within
 * each group, highest-attention tier first, then oldest `statusSince` first.
 */
export function rankPanesForCycle(
  summaries: PaneRuntimeSummary[],
  ledger: CycleLedger,
): PaneRuntimeSummary[] {
  return [...summaries].sort((left, right) => {
    const leftSeen = ledger.get(left.pane.paneId)?.seen ? 1 : 0;
    const rightSeen = ledger.get(right.pane.paneId)?.seen ? 1 : 0;
    if (leftSeen !== rightSeen) {
      return leftSeen - rightSeen;
    }

    const leftTier = getCycleTier(left.runtime.status);
    const rightTier = getCycleTier(right.runtime.status);
    if (leftTier !== rightTier) {
      return leftTier - rightTier;
    }

    const leftSince = ledger.get(left.pane.paneId)?.statusSince ?? 0;
    const rightSince = ledger.get(right.pane.paneId)?.statusSince ?? 0;
    if (leftSince !== rightSince) {
      return leftSince - rightSince;
    }

    return left.pane.target.localeCompare(right.pane.target);
  });
}

/**
 * Pick the next pane to jump to from a ranked queue, given the current pane.
 * Skips the current pane so a press always moves; returns the first ranked pane
 * when the current pane is not in the queue (e.g. focus is on a non-agent pane).
 */
export function pickNextCyclePane(
  ranked: PaneRuntimeSummary[],
  currentTarget: PaneTarget | null,
): PaneRuntimeSummary | null {
  if (ranked.length === 0) {
    return null;
  }

  if (currentTarget === null) {
    return ranked[0] ?? null;
  }

  const currentIndex = ranked.findIndex((entry) => entry.pane.target === currentTarget);
  if (currentIndex === -1) {
    return ranked[0] ?? null;
  }

  if (ranked.length === 1) {
    return null;
  }

  return ranked[(currentIndex + 1) % ranked.length] ?? null;
}
