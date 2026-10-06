import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bumpLastSeen,
  computeObservation,
  observePane,
  readCycleLedger,
} from "../src/core/cycle-ledger.ts";
function withCycleStateDir<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-cycle-ledger-"));
  const previous = process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR;
  process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR = dir;

  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR;
    } else {
      process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR = previous;
    }
  }
}

test("computeObservation resets statusSince and seen on a status change", () => {
  const next = computeObservation(
    { observedStatus: "running", statusSince: 100, seen: true, lastSeenAt: 50 },
    "idle",
    false,
    500,
  );

  assert.deepEqual(next, {
    observedStatus: "idle",
    statusSince: 500,
    seen: false,
    lastSeenAt: 0,
    version: 1,
  });
});

test("computeObservation stamps lastSeenAt when the current pane first sees a status", () => {
  assert.equal(
    computeObservation(
      { observedStatus: "idle", statusSince: 100, seen: false, lastSeenAt: 0 },
      "idle",
      true,
      500,
    )?.lastSeenAt,
    500,
  );
  // Status-change observed as the current pane also stamps it.
  assert.equal(
    computeObservation(
      { observedStatus: "running", statusSince: 1, seen: true, lastSeenAt: 9 },
      "idle",
      true,
      700,
    )?.lastSeenAt,
    700,
  );
});

test("computeObservation marks seen when the current pane matches an unchanged status", () => {
  const next = computeObservation(
    { observedStatus: "idle", statusSince: 100, seen: false, lastSeenAt: 0 },
    "idle",
    true,
    500,
  );

  assert.equal(next?.seen, true);
  assert.equal(next?.statusSince, 100);
});

test("computeObservation returns null when nothing needs to change", () => {
  assert.equal(
    computeObservation(
      { observedStatus: "idle", statusSince: 100, seen: true, lastSeenAt: 100 },
      "idle",
      true,
      500,
    ),
    null,
  );
  assert.equal(
    computeObservation(
      { observedStatus: "idle", statusSince: 100, seen: false, lastSeenAt: 0 },
      "idle",
      false,
      500,
    ),
    null,
  );
});

test("observePane persists and readCycleLedger reads back by pane id", () => {
  withCycleStateDir(() => {
    observePane("%42", "waiting-question", false, 1000, "server-a");
    const ledger = readCycleLedger("server-a");
    const entry = ledger.get("%42");

    assert.equal(entry?.observedStatus, "waiting-question");
    assert.equal(entry?.statusSince, 1000);
    assert.equal(entry?.seen, false);
  });
});

test("observePane no-ops leave the prior record intact", () => {
  withCycleStateDir(() => {
    observePane("%7", "idle", false, 1000, "server-a");
    observePane("%7", "idle", false, 2000, "server-a");
    const entry = readCycleLedger("server-a").get("%7");

    assert.equal(entry?.statusSince, 1000);
  });
});

test("independent servers and restarted lifetimes never inherit pane acknowledgement or age", () => {
  withCycleStateDir(() => {
    const a = "123:100:/socket-a";
    const b = "456:100:/socket-b";
    const restarted = "789:101:/socket-a";
    observePane("%0", "idle", true, 1000, a);
    for (const identity of [b, restarted]) {
      assert.equal(readCycleLedger(identity).size, 0);
      observePane("%0", "idle", false, 2000, identity);
      assert.deepEqual(readCycleLedger(identity).get("%0"), {
        observedStatus: "idle",
        statusSince: 2000,
        seen: false,
        lastSeenAt: 0,
        version: 1,
      });
    }
    assert.equal(readCycleLedger(a).get("%0")?.seen, true);
    assert.equal(readCycleLedger(a).get("%0")?.statusSince, 1000);
  });
});

test("surviving panes preserve acknowledgement while new panes and changed statuses are unseen", () => {
  withCycleStateDir(() => {
    observePane("%0", "idle", true, 1000, "server-a");
    observePane("%0", "idle", false, 2000, "server-a");
    observePane("%1", "idle", false, 2000, "server-a");
    assert.equal(readCycleLedger("server-a").get("%0")?.seen, true);
    assert.equal(readCycleLedger("server-a").get("%0")?.statusSince, 1000);
    assert.equal(readCycleLedger("server-a").get("%1")?.seen, false);
    observePane("%0", "running", false, 3000, "server-a");
    assert.equal(readCycleLedger("server-a").get("%0")?.seen, false);
    assert.equal(readCycleLedger("server-a").get("%0")?.statusSince, 3000);
  });
});

test("legacy unscoped records and missing server identities are never trusted", () => {
  withCycleStateDir(() => {
    writeFileSync(
      join(process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR!, "pane-2530.json"),
      JSON.stringify({ observedStatus: "idle", statusSince: 1, seen: true }),
    );
    assert.equal(readCycleLedger("server-a").size, 0);
    assert.equal(readCycleLedger(null).size, 0);
    observePane("%0", "idle", true, 2000, null);
    assert.equal(readCycleLedger("server-a").size, 0);
    observePane("%0", "idle", false, 3000, "server-a");
    assert.equal(readCycleLedger("server-a").get("%0")?.seen, false);
    assert.equal(readCycleLedger("server-a").get("%0")?.statusSince, 3000);
  });
});

test("observePane stamps lastSeenAt on first sight; a later re-sight no-ops the ledger", () => {
  withCycleStateDir(() => {
    observePane("%0", "idle", true, 1000, "server-a");
    assert.equal(readCycleLedger("server-a").get("%0")?.lastSeenAt, 1000);
    // Already-seen current pane: no further write, lastSeenAt frozen (bump is explicit).
    observePane("%0", "idle", true, 2000, "server-a");
    assert.equal(readCycleLedger("server-a").get("%0")?.lastSeenAt, 1000);
  });
});

test("bumpLastSeen moves an already-seen pane to the back without touching status fields", () => {
  withCycleStateDir(() => {
    observePane("%0", "idle", true, 1000, "server-a");
    bumpLastSeen("%0", 5000, "server-a");
    const entry = readCycleLedger("server-a").get("%0");
    assert.equal(entry?.lastSeenAt, 5000);
    assert.equal(entry?.statusSince, 1000);
    assert.equal(entry?.observedStatus, "idle");
    assert.equal(entry?.seen, true);
  });
});

test("bumpLastSeen is a no-op for an untracked pane or a missing server identity", () => {
  withCycleStateDir(() => {
    bumpLastSeen("%missing", 5000, "server-a");
    assert.equal(readCycleLedger("server-a").size, 0);
    bumpLastSeen("%0", 5000, null);
    assert.equal(readCycleLedger("server-a").size, 0);
  });
});
