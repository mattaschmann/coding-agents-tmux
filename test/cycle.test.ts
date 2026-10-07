import assert from "node:assert/strict";
import test from "node:test";

import type { CycleLedger, CycleLedgerEntry } from "../src/core/cycle-ledger.ts";
import { pickNextCyclePane, rankPanesForCycle } from "../src/core/cycle.ts";
import type { PaneRuntimeSummary, PaneTarget, RuntimeStatus, TmuxPane } from "../src/types.ts";

function createPane(target: PaneTarget, paneId: string): TmuxPane {
  const [sessionWindow, paneIndexRaw] = target.split(".");
  const [sessionName, windowIndexRaw] = (sessionWindow ?? "").split(":");

  return {
    sessionName: sessionName ?? "",
    windowIndex: Number(windowIndexRaw),
    paneIndex: Number(paneIndexRaw),
    paneId,
    paneTitle: "OpenCode",
    currentCommand: "opencode",
    currentPath: "/tmp/project",
    isActive: false,
    tty: "/dev/ttys001",
    target,
  };
}

function createSummary(
  target: PaneTarget,
  paneId: string,
  status: RuntimeStatus,
): PaneRuntimeSummary {
  return {
    pane: createPane(target, paneId),
    detection: { agent: "opencode", confidence: "high", reasons: [] },
    runtime: {
      activity: status === "idle" || status === "new" ? "idle" : "busy",
      status,
      source: "plugin-exact",
      match: { strategy: "exact", provider: "plugin", heuristic: false },
      session: null,
      detail: `runtime:${status}`,
    },
  };
}

function ledgerOf(entries: Record<string, Partial<CycleLedgerEntry>>): CycleLedger {
  const ledger: CycleLedger = new Map();
  for (const [paneId, entry] of Object.entries(entries)) {
    ledger.set(paneId, {
      observedStatus: entry.observedStatus ?? "idle",
      statusSince: entry.statusSince ?? 0,
      seen: entry.seen ?? false,
      lastSeenAt: entry.lastSeenAt ?? 0,
    });
  }
  return ledger;
}

// Drive repeated cycle presses the way runCycleCommand does: before each press
// the leaving pane is re-stamped most-recently-seen (and marked seen), then the
// next pane is picked. Returns the sequence of visited pane ids.
function cyclePresses(
  panes: PaneRuntimeSummary[],
  ledger: CycleLedger,
  start: PaneTarget | null,
  presses: number,
): string[] {
  const visited: string[] = [];
  let current = start;
  let clock = 1000;
  for (let step = 0; step < presses; step += 1) {
    if (current !== null) {
      const leaving = panes.find((p) => p.pane.target === current);
      if (leaving) {
        const prev = ledger.get(leaving.pane.paneId);
        ledger.set(leaving.pane.paneId, {
          observedStatus: prev?.observedStatus ?? leaving.runtime.status,
          statusSince: prev?.statusSince ?? 0,
          seen: true,
          lastSeenAt: (clock += 1),
        });
      }
    }
    const ranked = rankPanesForCycle(panes, ledger);
    const next = pickNextCyclePane(ranked, current);
    assert.ok(next);
    visited.push(next.pane.paneId);
    const prev = ledger.get(next.pane.paneId);
    ledger.set(next.pane.paneId, {
      observedStatus: prev?.observedStatus ?? next.runtime.status,
      statusSince: prev?.statusSince ?? 0,
      seen: true,
      lastSeenAt: (clock += 1),
    });
    current = next.pane.target as PaneTarget;
  }
  return visited;
}

test("rankPanesForCycle orders by group: waiting > unseen idle/new > rotation", () => {
  const panes = [
    createSummary("work:1.0", "%running", "running"),
    createSummary("work:1.1", "%idle", "idle"),
    createSummary("work:1.2", "%waiting", "waiting-input"),
    createSummary("work:1.3", "%unknown", "unknown"),
    createSummary("work:1.4", "%new", "new"),
  ];

  const ranked = rankPanesForCycle(panes, ledgerOf({}));

  // waiting, then unseen idle, then unseen new, then rotation (running/unknown).
  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%waiting", "%idle", "%new", "%running", "%unknown"],
  );
});

test("rankPanesForCycle orders waiting panes least-recently-looked-at first", () => {
  const panes = [
    createSummary("work:1.0", "%seenRecently", "waiting-question"),
    createSummary("work:1.1", "%seenAgo", "waiting-question"),
    createSummary("work:1.2", "%unseen", "waiting-question"),
  ];
  const ledger = ledgerOf({
    "%seenRecently": { observedStatus: "waiting-question", seen: true, lastSeenAt: 500 },
    "%seenAgo": { observedStatus: "waiting-question", seen: true, lastSeenAt: 100 },
    "%unseen": { observedStatus: "waiting-question", seen: false, lastSeenAt: 0 },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  // never-seen (lastSeenAt 0) leads, then oldest look.
  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%unseen", "%seenAgo", "%seenRecently"],
  );
});

test("rankPanesForCycle breaks waiting ties by oldest statusSince (FIFO), not pane name", () => {
  // All three are never-seen (lastSeenAt 0), so the LRU key ties; order must
  // fall to statusSince (oldest-waiting first), not alphabetical pane target.
  const panes = [
    createSummary("work:1.0", "%newest", "waiting-question"),
    createSummary("work:1.1", "%oldest", "waiting-input"),
    createSummary("work:1.2", "%middle", "waiting-question"),
  ];
  const ledger = ledgerOf({
    "%newest": { observedStatus: "waiting-question", statusSince: 900, seen: false },
    "%oldest": { observedStatus: "waiting-input", statusSince: 100, seen: false },
    "%middle": { observedStatus: "waiting-question", statusSince: 500, seen: false },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%oldest", "%middle", "%newest"],
  );
});

test("rankPanesForCycle orders unseen attention idle before new, then FIFO", () => {
  const panes = [
    createSummary("work:1.0", "%newOld", "new"),
    createSummary("work:1.1", "%idleNew", "idle"),
    createSummary("work:1.2", "%idleOld", "idle"),
  ];
  const ledger = ledgerOf({
    "%newOld": { observedStatus: "new", statusSince: 1, seen: false },
    "%idleNew": { observedStatus: "idle", statusSince: 500, seen: false },
    "%idleOld": { observedStatus: "idle", statusSince: 100, seen: false },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%idleOld", "%idleNew", "%newOld"],
  );
});

test("rankPanesForCycle keeps a seen waiting pane ahead of an unseen idle pane", () => {
  const panes = [
    createSummary("work:1.0", "%unseenIdle", "idle"),
    createSummary("work:1.1", "%seenWaiting", "waiting-question"),
  ];
  const ledger = ledgerOf({
    "%unseenIdle": { observedStatus: "idle", seen: false },
    "%seenWaiting": { observedStatus: "waiting-question", seen: true },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%seenWaiting", "%unseenIdle"],
  );
});

test("rankPanesForCycle demotes a seen idle pane into the rotation", () => {
  const panes = [
    createSummary("work:1.0", "%seenIdle", "idle"),
    createSummary("work:1.1", "%unseenRunning", "running"),
    createSummary("work:1.2", "%unseenIdle", "idle"),
  ];
  const ledger = ledgerOf({
    "%seenIdle": { observedStatus: "idle", seen: true, lastSeenAt: 50 },
    "%unseenRunning": { observedStatus: "running", seen: false, lastSeenAt: 0 },
    "%unseenIdle": { observedStatus: "idle", seen: false, statusSince: 10 },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  // Unseen idle leads (group 2). Then the rotation group ordered by lastSeenAt:
  // the unseen running pane (0) before the seen idle pane (50).
  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%unseenIdle", "%unseenRunning", "%seenIdle"],
  );
});

test("pickNextCyclePane advances past the current pane to the ranked head", () => {
  const panes = [
    createSummary("work:1.0", "%waiting", "waiting-input"),
    createSummary("work:1.1", "%idle", "idle"),
    createSummary("work:1.2", "%new", "new"),
  ];
  const ledger = ledgerOf({});
  const ranked = rankPanesForCycle(panes, ledger);

  // From the ranked head, skip it and take the next.
  assert.equal(pickNextCyclePane(ranked, "work:1.0")?.pane.paneId, "%idle");
  // From a non-head pane, take the ranked head.
  assert.equal(pickNextCyclePane(ranked, "work:1.1")?.pane.paneId, "%waiting");
});

test("pickNextCyclePane returns the first pane when current is not in the queue", () => {
  const panes = [
    createSummary("work:1.0", "%waiting", "waiting-input"),
    createSummary("work:1.1", "%idle", "idle"),
  ];
  const ledger = ledgerOf({});
  const ranked = rankPanesForCycle(panes, ledger);

  assert.equal(pickNextCyclePane(ranked, "work:9.9")?.pane.paneId, "%waiting");
  assert.equal(pickNextCyclePane(ranked, null)?.pane.paneId, "%waiting");
});

test("pickNextCyclePane returns null for an empty queue or a single current pane", () => {
  assert.equal(pickNextCyclePane([], "work:1.0"), null);

  const single = [createSummary("work:1.0", "%1", "idle")];
  assert.equal(pickNextCyclePane(single, "work:1.0"), null);
});

test("multiple waiting panes cycle only among themselves until resolved", () => {
  const panes = [
    createSummary("work:1.0", "%waitA", "waiting-input"),
    createSummary("work:1.1", "%waitB", "waiting-question"),
    createSummary("work:1.2", "%idle", "idle"),
  ];
  const ledger = ledgerOf({
    "%waitA": { observedStatus: "waiting-input", seen: true, lastSeenAt: 10 },
    "%waitB": { observedStatus: "waiting-question", seen: true, lastSeenAt: 20 },
    "%idle": { observedStatus: "idle", seen: true, lastSeenAt: 30 },
  });

  // From waitA, repeated presses stay among the two waiting panes (never the
  // idle one) until a prompt is answered.
  const visited = cyclePresses(panes, ledger, "work:1.0", 4);
  assert.deepEqual(new Set(visited), new Set(["%waitA", "%waitB"]));
});

test("a single waiting pane bounces but every pane stays reachable", () => {
  const panes = [
    createSummary("work:1.0", "%wait", "waiting-input"),
    createSummary("work:1.1", "%idleA", "idle"),
    createSummary("work:1.2", "%idleB", "idle"),
  ];
  // All seen so idle panes are in the rotation group alongside nothing else.
  const ledger = ledgerOf({
    "%wait": { observedStatus: "waiting-input", seen: true, lastSeenAt: 5 },
    "%idleA": { observedStatus: "idle", seen: true, lastSeenAt: 10 },
    "%idleB": { observedStatus: "idle", seen: true, lastSeenAt: 15 },
  });

  const visited = cyclePresses(panes, ledger, "work:1.0", 6);
  // Every pane is reached, and the waiting pane recurs between the idle ones.
  assert.deepEqual(new Set(visited), new Set(["%wait", "%idleA", "%idleB"]));
  assert.ok(visited.filter((id) => id === "%wait").length >= 2);
});

test("unseen idle panes are visited oldest-first before any running pane", () => {
  const panes = [
    createSummary("work:1.0", "%running", "running"),
    createSummary("work:1.1", "%idleNew", "idle"),
    createSummary("work:1.2", "%idleOld", "idle"),
  ];
  const ledger = ledgerOf({
    "%running": { observedStatus: "running", seen: false, lastSeenAt: 0 },
    "%idleNew": { observedStatus: "idle", statusSince: 500, seen: false },
    "%idleOld": { observedStatus: "idle", statusSince: 100, seen: false },
  });

  const ranked = rankPanesForCycle(panes, ledger);
  // From the running pane, the oldest unseen idle comes first.
  assert.equal(pickNextCyclePane(ranked, "work:1.0")?.pane.paneId, "%idleOld");
});

test("once idle panes are seen they rotate fairly with running panes", () => {
  const panes = [
    createSummary("work:1.0", "%idleA", "idle"),
    createSummary("work:1.1", "%idleB", "idle"),
    createSummary("work:1.2", "%running", "running"),
  ];
  // All seen: everything is in the rotation group, so the running pane is
  // reachable and repeated presses visit every pane before repeating.
  const ledger = ledgerOf({
    "%idleA": { observedStatus: "idle", seen: true, lastSeenAt: 10 },
    "%idleB": { observedStatus: "idle", seen: true, lastSeenAt: 20 },
    "%running": { observedStatus: "running", seen: true, lastSeenAt: 30 },
  });

  const visited = cyclePresses(panes, ledger, "work:1.2", 3);
  assert.deepEqual(new Set(visited).size, panes.length);
});

test("cycle does not snap back to one pane once all are seen (LRU rotation)", () => {
  const panes = [
    createSummary("work:1.0", "%idleA", "idle"),
    createSummary("work:1.1", "%idleC", "idle"),
    createSummary("work:1.2", "%running", "running"),
  ];
  const ledger = ledgerOf({
    "%idleA": { observedStatus: "idle", seen: true, lastSeenAt: 10 },
    "%idleC": { observedStatus: "idle", seen: true, lastSeenAt: 20 },
    "%running": { observedStatus: "running", seen: true, lastSeenAt: 30 },
  });

  // Sitting on the running pane (most-recently-seen). First press reaches the
  // least-recently-seen pane; the second must advance rather than snap back.
  let ranked = rankPanesForCycle(panes, ledger);
  const first = pickNextCyclePane(ranked, "work:1.2");
  assert.equal(first?.pane.paneId, "%idleA");

  ledger.set("%idleA", { observedStatus: "idle", statusSince: 0, seen: true, lastSeenAt: 40 });
  ranked = rankPanesForCycle(panes, ledger);
  const second = pickNextCyclePane(ranked, "work:1.0");
  assert.equal(second?.pane.paneId, "%idleC");
});

test("cycle falls through to the rotation when the only waiting pane is current", () => {
  const panes = [
    createSummary("work:1.0", "%currentWaiting", "waiting-input"),
    createSummary("work:1.1", "%seenIdle", "idle"),
  ];
  const ledger = ledgerOf({
    "%currentWaiting": { observedStatus: "waiting-input", seen: true, lastSeenAt: 50 },
    "%seenIdle": { observedStatus: "idle", seen: true, lastSeenAt: 10 },
  });

  const ranked = rankPanesForCycle(panes, ledger);
  // The waiting pane is the group head but it is current, so cycle advances to
  // the next pane rather than going dead.
  assert.equal(pickNextCyclePane(ranked, "work:1.0")?.pane.paneId, "%seenIdle");
});
