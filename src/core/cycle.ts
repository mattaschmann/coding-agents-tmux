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
//
// Waiting panes are exempt from the seen demotion: they always sort as unseen.
// Glancing at an idle/new/running pane acknowledges it (review done), but
// glancing at a pane blocked on a prompt discharges nothing — only replying
// does — so a still-waiting pane must never sink below an unseen lower tier.

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

// Effective "seen" rank for ordering: 0 sorts ahead of 1. A waiting pane is
// never demoted for having been looked at, since a glance does not discharge a
// pending prompt.
function getSeenRank(summary: PaneRuntimeSummary, ledger: CycleLedger): number {
  if (getCycleTier(summary.runtime.status) === 0) {
    return 0;
  }
  return ledger.get(summary.pane.paneId)?.seen ? 1 : 0;
}

/**
 * Rank panes into the cycle queue. Unseen panes first, then seen panes; within
 * each group, highest-attention tier first, then oldest `statusSince` first.
 * Waiting panes always sort as unseen (a glance does not acknowledge a prompt).
 */
export function rankPanesForCycle(
  summaries: PaneRuntimeSummary[],
  ledger: CycleLedger,
): PaneRuntimeSummary[] {
  return [...summaries].sort((left, right) => {
    const leftSeen = getSeenRank(left, ledger);
    const rightSeen = getSeenRank(right, ledger);
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
