// Priority ranking for the `cycle` command. Pure (no tmux/fs) so it is unit
// testable in isolation.
//
// Ordering is seen-major: unseen panes come first, then already-seen panes. The
// `cycle` command then rings over the unseen panes first (highest-priority
// first) and, once none remain unacknowledged, falls back to the full ranked
// list so every agent pane is still reachable. Within each group, panes are
// ordered by attention tier (highest first), then within a tier:
//   - unseen: oldest `statusSince` first (true FIFO — a long-waiting pane is
//     never starved by newer arrivals)
//   - seen: oldest `lastSeenAt` first (LRU — the all-seen fallback is a fair
//     round-robin, so cycling never snaps back to one pane and starves siblings)
//   0 waiting-question / waiting-input · 1 idle · 2 new · 3 running · 4 unknown
//
// "seen" means the pane was the active pane at some point since it entered its
// current status; it resets when the status changes (see cycle-ledger).
//
// Waiting panes are exempt from the seen demotion: they always sort as unseen.
// Glancing at an idle/new/running pane acknowledges it (review done), but
// glancing at a pane blocked on a prompt discharges nothing — only replying
// does — so a still-waiting pane must never sink below an unseen lower tier.

import { type CycleLedger } from "./cycle-ledger.ts";
import { isWaitingStatus } from "./status.ts";
import type { PaneRuntimeSummary, PaneTarget, RuntimeStatus } from "../types.ts";

function getCycleTier(status: RuntimeStatus): number {
  if (isWaitingStatus(status)) {
    return 0;
  }

  switch (status) {
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
 * each group, highest-attention tier first. Unseen panes break ties by oldest
 * `statusSince` (FIFO); seen panes break ties by oldest `lastSeenAt` (LRU), so
 * the all-seen fallback rotates fairly. Waiting panes always sort as unseen (a
 * glance does not acknowledge a prompt).
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

    // Within a group+tier, unseen panes order oldest-waiting first (FIFO on
    // `statusSince`); seen panes order least-recently-looked-at first (LRU on
    // `lastSeenAt`) so the all-seen fallback is a fair round-robin.
    if (leftSeen === 0) {
      const leftSince = ledger.get(left.pane.paneId)?.statusSince ?? 0;
      const rightSince = ledger.get(right.pane.paneId)?.statusSince ?? 0;
      if (leftSince !== rightSince) {
        return leftSince - rightSince;
      }
    } else {
      const leftSeenAt = ledger.get(left.pane.paneId)?.lastSeenAt ?? 0;
      const rightSeenAt = ledger.get(right.pane.paneId)?.lastSeenAt ?? 0;
      if (leftSeenAt !== rightSeenAt) {
        return leftSeenAt - rightSeenAt;
      }
    }

    return left.pane.target.localeCompare(right.pane.target);
  });
}

/**
 * Pick the next pane to jump to from a ranked queue, given the current pane.
 * Skips the current pane so a press always moves; returns the first ranked pane
 * when the current pane is not in the queue (e.g. focus is on a non-agent pane).
 *
 * Membership of the "unseen ring" uses the raw `ledger.seen` flag, NOT
 * `getSeenRank`. They are deliberately different: `getSeenRank` exempts tier 0
 * (waiting panes) from the seen demotion so a prompt always *sorts* above an
 * unseen lower tier. Reusing that for ring membership would keep a waiting pane
 * in the ring forever, so with a single pending prompt cycling would oscillate
 * between it and one partner pane and never reach the rest. Using raw `seen`
 * lets the ring drain: unseen panes are visited first (in ranked order), then
 * once none remain the ring falls back to the full list. A waiting pane still
 * gets priority once while unseen, then releases after a glance.
 */
export function pickNextCyclePane(
  ranked: PaneRuntimeSummary[],
  currentTarget: PaneTarget | null,
  ledger: CycleLedger,
): PaneRuntimeSummary | null {
  if (ranked.length === 0) {
    return null;
  }

  // Prefer the unseen ring, but fall through to the full ranked list when it
  // holds no pane other than the current one (otherwise cycle would go dead
  // when you are sitting on the only unacknowledged pane).
  const unseen = ranked.filter((entry) => !ledger.get(entry.pane.paneId)?.seen);
  const hasOtherUnseen = unseen.some((entry) => entry.pane.target !== currentTarget);
  const ring = hasOtherUnseen ? unseen : ranked;

  if (currentTarget === null) {
    return ring[0] ?? null;
  }

  const currentIndex = ring.findIndex((entry) => entry.pane.target === currentTarget);
  if (currentIndex === -1) {
    return ring[0] ?? null;
  }

  if (ring.length === 1) {
    return null;
  }

  // All-seen fallback: pure least-recently-seen rotation across *all* tiers
  // (settled design — once everything is acknowledged, fairness beats priority,
  // so a running pane is not permanently outranked by idle ones). The current
  // pane was just stamped most-recently-seen, so jumping to the global min
  // `lastSeenAt` (ties broken by target) never snaps back to it and visits every
  // pane in turn. The unseen ring keeps its positional FIFO sweep.
  if (!hasOtherUnseen) {
    const candidates = ring.filter((entry) => entry.pane.target !== currentTarget);
    return (
      candidates.reduce<PaneRuntimeSummary | null>((best, entry) => {
        if (!best) return entry;
        const bestAt = ledger.get(best.pane.paneId)?.lastSeenAt ?? 0;
        const entryAt = ledger.get(entry.pane.paneId)?.lastSeenAt ?? 0;
        if (entryAt !== bestAt) {
          return entryAt < bestAt ? entry : best;
        }
        return entry.pane.target.localeCompare(best.pane.target) < 0 ? entry : best;
      }, null) ?? null
    );
  }

  return ring[(currentIndex + 1) % ring.length] ?? null;
}
