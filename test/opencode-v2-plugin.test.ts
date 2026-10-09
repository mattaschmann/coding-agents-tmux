import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  derivePaneState,
  setupPanePlugin,
  writeStateAtomically,
  type PanePluginContext,
  type PaneState,
} from "../plugin/opencode/state.ts";

type Event = { type: string; data: Record<string, unknown> };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const sessions = new Map([
    [
      "ses_root_a",
      {
        id: "ses_root_a",
        title: "Root A",
        location: { directory: "/work/a" },
        time: { updated: 10 },
      },
    ],
    [
      "ses_child_a",
      {
        id: "ses_child_a",
        parentID: "ses_root_a",
        title: "Child A",
        location: { directory: "/work/a" },
        time: { updated: 20 },
      },
    ],
    [
      "ses_root_b",
      {
        id: "ses_root_b",
        title: "Root B",
        location: { directory: "/work/b" },
        time: { updated: 30 },
      },
    ],
  ]);
  const status = new Map<string, "idle" | "running" | "retry">([
    ["ses_root_a", "idle"],
    ["ses_child_a", "running"],
    ["ses_root_b", "idle"],
  ]);
  const permissions = new Map<string, unknown[]>([
    ["ses_root_a", []],
    ["ses_child_a", []],
    ["ses_root_b", []],
  ]);
  const forms = new Map<string, Array<Record<string, unknown>>>([
    ["ses_root_a", []],
    ["ses_child_a", []],
    ["ses_root_b", []],
  ]);
  const handlers = new Map<string, Set<(event: Event) => void>>();
  const unsubscribed: string[] = [];
  let route: { type: "home" } | { type: "session"; sessionID: string } = {
    type: "session",
    sessionID: "ses_child_a",
  };
  const syncCalls: string[] = [];
  const invalidations: string[] = [];

  const collection = <T>(kind: "permission" | "form", values: Map<string, T[]>) => ({
    list(sessionID: string) {
      return values.get(sessionID);
    },
    async sync(sessionID: string) {
      syncCalls.push(`${kind}:${sessionID}`);
    },
    invalidate(sessionID: string) {
      invalidations.push(`${kind}:${sessionID}`);
    },
  });

  const context = {
    ui: {
      router: {
        current: () => route,
      },
    },
    data: {
      on(type: string, handler: (event: Event) => void) {
        const callbacks = handlers.get(type) ?? new Set();
        callbacks.add(handler);
        handlers.set(type, callbacks);
        return () => {
          callbacks.delete(handler);
          unsubscribed.push(type);
        };
      },
      session: {
        get: (id: string) => sessions.get(id),
        root: (id: string) => (id === "ses_child_a" ? "ses_root_a" : id),
        family: (id: string) =>
          id === "ses_root_a" || id === "ses_child_a" ? ["ses_root_a", "ses_child_a"] : [id],
        status: (id: string) => status.get(id) ?? "idle",
        async sync(id: string) {
          syncCalls.push(`session:${id}`);
        },
        invalidate(id: string) {
          invalidations.push(`session:${id}`);
        },
        pending: {
          list: () => [],
          async sync(id: string) {
            syncCalls.push(`pending:${id}`);
          },
          invalidate(id: string) {
            invalidations.push(`pending:${id}`);
          },
        },
        permission: collection("permission", permissions),
        form: collection("form", forms),
      },
    },
  } satisfies PanePluginContext;

  return {
    context,
    forms,
    handlers,
    invalidations,
    permissions,
    sessions,
    setRoute(next: typeof route) {
      route = next;
    },
    status,
    syncCalls,
    unsubscribed,
  };
}

function emit(handlers: Map<string, Set<(event: Event) => void>>, event: Event): void {
  for (const handler of handlers.get(event.type) ?? []) handler(event);
}

test("derivePaneState keeps root identity while aggregating child activity", () => {
  const fx = fixture();

  const state = derivePaneState(fx.context, "ses_child_a", {
    paneId: "%7",
    target: "dev:1.2",
    sourceEventType: "plugin.init",
    now: 100,
  });

  assert.equal(state.sessionId, "ses_root_a");
  assert.equal(state.selectedSessionId, "ses_child_a");
  assert.deepEqual(state.familySessionIds, ["ses_root_a", "ses_child_a"]);
  assert.equal(state.title, "Root A");
  assert.equal(state.directory, "/work/a");
  assert.equal(state.status, "running");
  assert.equal(state.activity, "busy");
  assert.equal(state.opencodeGeneration, "v2");
});

test("selectable forms anywhere in the selected root family are questions", () => {
  const fx = fixture();
  fx.forms.set("ses_child_a", [
    { id: "frm_child", fields: [{ key: "choice", type: "string", options: [{ value: "a" }] }] },
  ]);

  const childFormState = derivePaneState(fx.context, "ses_root_a", {
    paneId: null,
    target: null,
    sourceEventType: "form.created",
    now: 100,
  });
  assert.equal(childFormState.status, "waiting-question");
  assert.equal(childFormState.sessionId, "ses_root_a");
  assert.equal(childFormState.selectedSessionId, "ses_root_a");

  fx.forms.set("ses_child_a", []);
  fx.forms.set("ses_root_a", [
    {
      id: "frm_root",
      fields: [{ key: "choice", type: "multiselect", options: [{ value: "a" }] }],
    },
  ]);
  assert.equal(
    derivePaneState(fx.context, "ses_child_a", {
      paneId: null,
      target: null,
      sourceEventType: "form.created",
      now: 100,
    }).status,
    "waiting-question",
  );

  fx.forms.set("ses_root_a", []);
  fx.permissions.set("ses_child_a", [{ id: "per_1" }]);
  assert.equal(
    derivePaneState(fx.context, "ses_child_a", {
      paneId: null,
      target: null,
      sourceEventType: "permission.asked",
      now: 100,
    }).status,
    "waiting-input",
  );
});

test("setup initializes cached family state and recalculates after blocker replies", async () => {
  const fx = fixture();
  fx.permissions.set("ses_child_a", [{ id: "per_1" }]);
  const writes: PaneState[] = [];
  const refreshes: string[] = [];

  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 5,
    paneId: "%7",
    resolveTarget: () => "dev:1.2",
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => {
      refreshes.push("refresh");
    },
  });

  assert.equal(writes.at(-1)?.status, "waiting-input");
  assert.ok(fx.syncCalls.includes("permission:ses_child_a"));
  assert.ok(fx.syncCalls.includes("form:ses_root_a"));

  fx.permissions.set("ses_child_a", []);
  fx.status.set("ses_child_a", "idle");
  emit(fx.handlers, {
    type: "permission.replied",
    data: { sessionID: "ses_child_a", requestID: "per_1", reply: "once" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(writes.at(-1)?.status, "idle");
  assert.equal(writes.at(-1)?.sourceEventType, "permission.replied");
  assert.ok(fx.invalidations.includes("permission:ses_child_a"));
  assert.ok(refreshes.length >= 2);
  cleanup();
});

test("form.created invalidates the owning session from the V2 event envelope", async () => {
  const fx = fixture();
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: () => undefined,
    scheduleTmuxRefresh: () => undefined,
  });

  emit(fx.handlers, {
    type: "form.created",
    data: { form: { id: "frm_1", sessionID: "ses_child_a", fields: [] } },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.ok(fx.invalidations.includes("form:ses_child_a"));
  cleanup();
});

test("setup notices navigation, changes roots, and cleans every resource", async () => {
  const fx = fixture();
  const writes: PaneState[] = [];
  let effectsCleaned = 0;
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 5,
    paneId: "%7",
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => () => {
      effectsCleaned += 1;
    },
  });

  fx.setRoute({ type: "session", sessionID: "ses_root_b" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(writes.at(-1)?.sessionId, "ses_root_b");
  assert.equal(writes.at(-1)?.directory, "/work/b");

  const count = writes.length;
  cleanup();
  assert.equal(fx.unsubscribed.length, 10);
  assert.ok(effectsCleaned >= 1);
  fx.setRoute({ type: "session", sessionID: "ses_root_a" });
  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "ses_root_a", status: { type: "busy" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(writes.length, count);
});

test("navigation polling coalesces refreshes while the selected session is syncing", async (t) => {
  const fx = fixture();
  const slowRootB = deferred();
  const rootBSyncStarted = deferred();
  let rootBSyncCalls = 0;
  fx.context.data.session.sync = async (id: string) => {
    if (id === "ses_root_b") {
      rootBSyncCalls += 1;
      rootBSyncStarted.resolve();
      await slowRootB.promise;
    }
  };
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 5,
    reconcileMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });
  t.after(() => {
    slowRootB.resolve();
    cleanup();
  });

  fx.setRoute({ type: "session", sessionID: "ses_root_b" });
  await rootBSyncStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(rootBSyncCalls, 1);
  slowRootB.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(writes.at(-1)?.sessionId, "ses_root_b");
});

test("newer refresh generations discard stale async results", async () => {
  const fx = fixture();
  const slow = deferred();
  let delayRootA = false;
  fx.context.data.session.sync = async (id: string) => {
    if (delayRootA && id === "ses_root_a") await slow.promise;
  };
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  delayRootA = true;
  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "ses_root_a", status: { type: "busy" } },
  });
  fx.setRoute({ type: "session", sessionID: "ses_root_b" });
  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "ses_root_b", status: { type: "idle" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  slow.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(writes.at(-1)?.sessionId, "ses_root_b");
  cleanup();
});

test("event status overrides expire after publication so cache recovery can win", async () => {
  const fx = fixture();
  fx.status.set("ses_child_a", "idle");
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "ses_child_a", status: { type: "busy" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes.at(-1)?.status, "running");

  emit(fx.handlers, {
    type: "form.replied",
    data: { id: "frm_1", sessionID: "ses_child_a", answer: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes.at(-1)?.status, "idle");
  cleanup();
});

test("initial sync follows a cold ancestor chain before deriving the root", async () => {
  const fx = fixture();
  const loaded = new Set(["ses_child_a"]);
  fx.context.data.session.root = (id: string) => {
    if (id === "ses_child_a") return loaded.has("ses_parent_a") ? "ses_root_a" : "ses_parent_a";
    if (id === "ses_parent_a") return loaded.has("ses_parent_a") ? "ses_root_a" : "ses_parent_a";
    return id;
  };
  fx.context.data.session.family = (id: string) => {
    if (id === "ses_parent_a") return ["ses_parent_a", "ses_child_a"];
    return id === "ses_root_a" ? ["ses_root_a", "ses_parent_a", "ses_child_a"] : [id];
  };
  const getSession = fx.context.data.session.get;
  fx.context.data.session.get = (id: string) => (loaded.has(id) ? getSession(id) : undefined);
  fx.context.data.session.sync = async (id: string) => {
    loaded.add(id);
  };
  fx.sessions.set("ses_parent_a", {
    id: "ses_parent_a",
    parentID: "ses_root_a",
    title: "Parent A",
    location: { directory: "/work/a" },
    time: { updated: 15 },
  });
  fx.status.set("ses_parent_a", "idle");
  fx.permissions.set("ses_parent_a", []);
  fx.forms.set("ses_parent_a", []);
  const writes: PaneState[] = [];

  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  assert.equal(writes.at(-1)?.sessionId, "ses_root_a");
  assert.equal(writes.at(-1)?.title, "Root A");
  assert.ok(loaded.has("ses_root_a"));
  cleanup();
});

test("a dummy continue-route placeholder is ignored until the real session arrives", async () => {
  const fx = fixture();
  fx.setRoute({ type: "session", sessionID: "dummy" });
  const writes: PaneState[] = [];

  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 5,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  // Placeholder route must never be synced (that throws server-side).
  assert.ok(!fx.syncCalls.includes("session:dummy"));
  assert.equal(writes.at(-1)?.status, "new");
  assert.equal(writes.at(-1)?.sessionId, null);

  fx.setRoute({ type: "session", sessionID: "ses_child_a" });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(writes.at(-1)?.sessionId, "ses_root_a");
  cleanup();
});

test("a failed initial refresh keeps the plugin alive and retries", async () => {
  const fx = fixture();
  const writes: PaneState[] = [];
  let failNext = true;
  const sync = fx.context.data.session.sync;
  fx.context.data.session.sync = async (id: string) => {
    if (failNext) {
      failNext = false;
      throw new Error("transient startup failure");
    }
    await sync(id);
  };

  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    reconcileMs: 1_000,
    refreshRetryMs: 5,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  // Setup resolved despite the first refresh throwing; event subscriptions survive.
  assert.equal(fx.unsubscribed.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.ok(writes.length >= 1);
  assert.equal(writes.at(-1)?.sessionId, "ses_root_a");
  cleanup();
  assert.equal(fx.unsubscribed.length, 10);
});

test("a transient event refresh failure retries the selected session", async () => {
  const fx = fixture();
  const writes: PaneState[] = [];
  let failNext = false;
  const sync = fx.context.data.session.sync;
  fx.context.data.session.sync = async (id: string) => {
    if (failNext) {
      failNext = false;
      throw new Error("transient sync failure");
    }
    await sync(id);
  };
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    refreshRetryMs: 5,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  failNext = true;
  fx.status.set("ses_child_a", "idle");
  emit(fx.handlers, {
    type: "session.execution.succeeded",
    data: { sessionID: "ses_child_a" },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(writes.at(-1)?.status, "idle");
  assert.equal(writes.at(-1)?.sourceEventType, "cache.reconcile");
  cleanup();
});

test("events outside the selected family do not poison later navigation", async () => {
  const fx = fixture();
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 5,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "ses_root_b", status: { type: "busy" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  fx.status.set("ses_root_b", "idle");
  fx.setRoute({ type: "session", sessionID: "ses_root_b" });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(writes.at(-1)?.sessionId, "ses_root_b");
  assert.equal(writes.at(-1)?.status, "idle");
  cleanup();
});

test("periodic reconciliation republishes silently hydrated cache state", async () => {
  const fx = fixture();
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    reconcileMs: 5,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  fx.status.set("ses_child_a", "idle");
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(writes.at(-1)?.status, "idle");
  assert.equal(writes.at(-1)?.sourceEventType, "cache.reconcile");
  cleanup();
});

test("atomic writer leaves only the pane-specific state file", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-v2-state-"));
  const state = {
    version: 2,
    paneId: "%7",
    target: "dev:1.2",
    sessionId: "ses_root_a",
    selectedSessionId: "ses_child_a",
    familySessionIds: ["ses_root_a", "ses_child_a"],
    directory: "/work/a",
    title: "Root A",
    activity: "idle",
    status: "idle",
    detail: "family is idle",
    updatedAt: 100,
    sourceEventType: "plugin.init",
    opencodeGeneration: "v2",
  } satisfies PaneState;

  writeStateAtomically(stateDir, state);

  const entries = readdirSync(stateDir);
  assert.deepEqual(entries, [`pane-${Buffer.from("%7").toString("hex")}.json`]);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, entries[0]!), "utf8")), state);
});

test("default state directory treats empty environment overrides as unset", async () => {
  const fx = fixture();
  const stateHome = mkdtempSync(join(tmpdir(), "coding-agents-tmux-empty-state-env-"));
  const previousStateDir = process.env.CODING_AGENTS_TMUX_STATE_DIR;
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.CODING_AGENTS_TMUX_STATE_DIR = "";
  process.env.XDG_STATE_HOME = `  ${stateHome}  `;

  try {
    const cleanup = await setupPanePlugin(fx.context, {
      navigationPollMs: 1_000,
      reconcileMs: 1_000,
      paneId: "%7",
      resolveTarget: () => "dev:1.2",
      scheduleTmuxRefresh: () => undefined,
    });
    cleanup();

    const stateDir = join(stateHome, "coding-agents-tmux", "plugin-state");
    assert.deepEqual(readdirSync(stateDir), [`pane-${Buffer.from("%7").toString("hex")}.json`]);
  } finally {
    if (previousStateDir === undefined) delete process.env.CODING_AGENTS_TMUX_STATE_DIR;
    else process.env.CODING_AGENTS_TMUX_STATE_DIR = previousStateDir;
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }
});
