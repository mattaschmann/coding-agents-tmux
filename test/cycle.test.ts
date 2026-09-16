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
    });
  }
  return ledger;
}

test("rankPanesForCycle orders by tier: waiting > idle > new > running > unknown", () => {
  const panes = [
    createSummary("work:1.0", "%1", "running"),
    createSummary("work:1.1", "%2", "idle"),
    createSummary("work:1.2", "%3", "waiting-input"),
    createSummary("work:1.3", "%4", "unknown"),
    createSummary("work:1.4", "%5", "new"),
  ];

  const ranked = rankPanesForCycle(panes, ledgerOf({}));

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%3", "%2", "%5", "%1", "%4"],
  );
});

test("rankPanesForCycle sorts oldest statusSince first within a tier (true FIFO)", () => {
  const panes = [
    createSummary("work:1.0", "%new", "waiting-question"),
    createSummary("work:1.1", "%old", "waiting-question"),
  ];
  const ledger = ledgerOf({
    "%new": { observedStatus: "waiting-question", statusSince: 500 },
    "%old": { observedStatus: "waiting-question", statusSince: 100 },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%old", "%new"],
  );
});

test("rankPanesForCycle drops panes marked seen", () => {
  const panes = [
    createSummary("work:1.0", "%seen", "waiting-input"),
    createSummary("work:1.1", "%unseen", "idle"),
  ];
  const ledger = ledgerOf({
    "%seen": { observedStatus: "waiting-input", seen: true },
    "%unseen": { observedStatus: "idle", seen: false },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%unseen"],
  );
});

test("pickNextCyclePane advances past the current pane and wraps around", () => {
  const ranked = [
    createSummary("work:1.0", "%1", "waiting-input"),
    createSummary("work:1.1", "%2", "idle"),
    createSummary("work:1.2", "%3", "new"),
  ];

  assert.equal(pickNextCyclePane(ranked, "work:1.0")?.pane.paneId, "%2");
  assert.equal(pickNextCyclePane(ranked, "work:1.2")?.pane.paneId, "%1");
});

test("pickNextCyclePane returns the first pane when current is not in the queue", () => {
  const ranked = [
    createSummary("work:1.0", "%1", "waiting-input"),
    createSummary("work:1.1", "%2", "idle"),
  ];

  assert.equal(pickNextCyclePane(ranked, "work:9.9")?.pane.paneId, "%1");
  assert.equal(pickNextCyclePane(ranked, null)?.pane.paneId, "%1");
});

test("pickNextCyclePane returns null for an empty queue or a single current pane", () => {
  assert.equal(pickNextCyclePane([], "work:1.0"), null);

  const single = [createSummary("work:1.0", "%1", "idle")];
  assert.equal(pickNextCyclePane(single, "work:1.0"), null);
});
