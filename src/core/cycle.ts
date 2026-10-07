// Priority grouping for the `cycle` command. Pure (no tmux/fs) so it is unit
// testable in isolation.
//
// Every pane falls into one of three groups. `cycle` jumps to the first group
// that holds a pane other than the current one, then to that group's head:
//
//   1. Waiting   — every waiting pane (seen or not). A glance never clears it;
//                  only answering the prompt (a status change) removes it from
//                  the group. So with several waiting panes, cycling stays among
//                  them until each is resolved. Ordered least-recently-looked-at
//                  first (never-seen = 0, so they lead).
//   2. Unseen    — unseen idle, then unseen new. Panes needing a first look,
//      attention   highest-attention status first, then oldest `statusSince`
//                  (FIFO — a long-idle pane is not starved by newer arrivals).
//   3. Rotation  — everything else: seen idle/new, running, unknown, all mixed.
//                  A fair least-recently-looked-at round-robin so busy panes stay
//                  reachable once the idle ones have been acknowledged.
//
// Because the group dominates, a running pane (group 3) is only reached once no
// waiting (group 1) or unseen idle/new (group 2) pane remains — matching the
// "next pane needing attention" intent. The full menu still reaches every pane.
//
// "seen" means the pane was the active pane at some point since it entered its
// current status; it resets when the status changes (see cycle-ledger). The
// current pane is stamped most-recently-seen on departure and arrival (see
// runCycleCommand), so within its group it sinks to the LRU tail and repeated
// presses advance to siblings instead of snapping back.

import { type CycleLedger } from "./cycle-ledger.ts";
import { isWaitingStatus } from "./status.ts";
import type { PaneRuntimeSummary, PaneTarget, RuntimeStatus } from "../types.ts";

const GROUP_WAITING = 0;
const GROUP_UNSEEN_ATTENTION = 1;
const GROUP_ROTATION = 2;

// Attention rank within the unseen-attention group: idle (0) before new (1).
function unseenAttentionRank(status: RuntimeStatus): number {
  return status === "idle" ? 0 : 1;
}

function isUnseenAttentionStatus(status: RuntimeStatus): boolean {
  return status === "idle" || status === "new";
}

function getCycleGroup(summary: PaneRuntimeSummary, ledger: CycleLedger): number {
  const status = summary.runtime.status;
  if (isWaitingStatus(status)) {
    return GROUP_WAITING;
  }

  const seen = Boolean(ledger.get(summary.pane.paneId)?.seen);
  if (!seen && isUnseenAttentionStatus(status)) {
    return GROUP_UNSEEN_ATTENTION;
  }

  return GROUP_ROTATION;
}

/**
 * Rank panes into the cycle queue. Group first (waiting, then unseen idle/new,
 * then the rotation of everything else); within a group, ordered so the group
 * head is the next pane to visit:
 *   - waiting: least-recently-looked-at first (`lastSeenAt`; never-seen = 0
 *     leads), then oldest `statusSince` (FIFO) so same-age unseen prompts go
 *     oldest-waiting first instead of by pane name
 *   - unseen attention: idle before new, then oldest `statusSince` (FIFO)
 *   - rotation: least-recently-looked-at first (`lastSeenAt`, LRU)
 */
export function rankPanesForCycle(
  summaries: PaneRuntimeSummary[],
  ledger: CycleLedger,
): PaneRuntimeSummary[] {
  return [...summaries].sort((left, right) => {
    const leftGroup = getCycleGroup(left, ledger);
    const rightGroup = getCycleGroup(right, ledger);
    if (leftGroup !== rightGroup) {
      return leftGroup - rightGroup;
    }

    if (leftGroup === GROUP_UNSEEN_ATTENTION) {
      const leftRank = unseenAttentionRank(left.runtime.status);
      const rightRank = unseenAttentionRank(right.runtime.status);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
    } else {
      // Waiting and rotation groups both order least-recently-looked-at first,
      // so repeated presses rotate fairly through the group's members.
      const leftSeenAt = ledger.get(left.pane.paneId)?.lastSeenAt ?? 0;
      const rightSeenAt = ledger.get(right.pane.paneId)?.lastSeenAt ?? 0;
      if (leftSeenAt !== rightSeenAt) {
        return leftSeenAt - rightSeenAt;
      }
    }

    // FIFO fallback shared by all groups: within a tie, the pane that has held
    // its status longest comes first (never-seen waiting prompts share
    // `lastSeenAt` 0, so this orders them oldest-waiting first, not by name).
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
 * The ranked list already encodes full priority (group-major, then intra-group
 * order), so cycling is just "first ranked pane that is not the current one".
 * Skipping the current pane guarantees a press always moves; returning the
 * ranked head when the current pane is absent handles focus on a non-agent pane.
 */
export function pickNextCyclePane(
  ranked: PaneRuntimeSummary[],
  currentTarget: PaneTarget | null,
): PaneRuntimeSummary | null {
  if (ranked.length === 0) {
    return null;
  }

  return ranked.find((entry) => entry.pane.target !== currentTarget) ?? null;
}
