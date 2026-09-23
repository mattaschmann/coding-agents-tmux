import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TabListEntry } from "../src/core/opencode-plugin-state.ts";

// Drives the V2 TUI entrypoint (plugin/coding-agents-tmux/tui.ts) with a fake
// TUI context, exercising the `data.listen` subscription, `.data`-shaped event
// payloads, `data.session.root()` scoping, `TMUX_PANE` keying, and cleanup.

function setEnv(updates: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function loadTuiPlugin() {
  return import(`../plugin/coding-agents-tmux/tui.ts?test=${Math.random()}`);
}

interface FakeEvent {
  type: string;
  location?: { directory?: string };
  data?: Record<string, unknown>;
}

// Minimal fake of the V2 TUI context. `roots` maps a session id to its root id
// (absent = its own root), backing `data.session.root()`. `directory` is the
// pane's bound location; `defaultDirectory` backs `data.location.default()`.
// `routeSession` seeds `ui.router.current()` (a resumed/open session).
// `statuses`/`titles` back `data.session.status()`/`get()`; both are mutable via
// the returned `setStatus`/`setRoute` so tests can model turn transitions.
function makeContext(input: {
  directory?: string;
  defaultDirectory?: string;
  roots?: Record<string, string>;
  routeSession?: string;
  statuses?: Record<string, "idle" | "running">;
  titles?: Record<string, string>;
  // When provided, the fake exposes `ui.tabs` and reports enabled. Mutable via
  // the returned `setTabs` so tests can model a tab opening/closing.
  tabs?: TabListEntry[];
  // Session-family map (id → member ids) backing `data.session.family()`.
  families?: Record<string, string[]>;
  // Per-session pending prompts backing `permission.list()`/`form.list()`.
  permissions?: Record<string, unknown[]>;
  forms?: Record<string, unknown[]>;
}) {
  let handler: ((event: { details: FakeEvent }) => void) | null = null;
  let unsubscribed = false;
  const roots = input.roots ?? {};
  const statuses: Record<string, "idle" | "running"> = { ...input.statuses };
  const titles = input.titles ?? {};
  let routeSession: string | undefined = input.routeSession;
  let tabs: TabListEntry[] | undefined = input.tabs ? [...input.tabs] : undefined;
  const families = input.families ?? {};
  const permissions = input.permissions ?? {};
  const forms = input.forms ?? {};

  const sessionApi: Record<string, unknown> = {
    root(sessionID: string): string {
      return roots[sessionID] ?? sessionID;
    },
    get(sessionID: string): { title?: string } | undefined {
      return titles[sessionID] ? { title: titles[sessionID] } : undefined;
    },
    status(sessionID: string): "idle" | "running" {
      // Default to running when unknown, matching V2 (an active session the
      // TUI is displaying); tests set idle explicitly to model turn end.
      return statuses[sessionID] ?? "running";
    },
    family(sessionID: string): string[] {
      return families[sessionID] ?? [];
    },
    permission: {
      list(sessionID: string): unknown[] | undefined {
        return permissions[sessionID];
      },
    },
    form: {
      list(sessionID: string): unknown[] | undefined {
        return forms[sessionID];
      },
    },
  };

  const context = {
    location: input.directory ? { directory: input.directory } : undefined,
    ui: {
      router: {
        current(): { type: string; sessionID?: string } {
          return routeSession ? { type: "session", sessionID: routeSession } : { type: "home" };
        },
      },
      ...(tabs !== undefined
        ? {
            tabs: {
              enabled(): boolean {
                return true;
              },
              list(): TabListEntry[] {
                return tabs ?? [];
              },
            },
          }
        : {}),
    },
    data: {
      listen(fn: (event: { details: FakeEvent }) => void): () => void {
        handler = fn;
        return () => {
          unsubscribed = true;
          handler = null;
        };
      },
      location: {
        default(): { directory: string } | undefined {
          return input.defaultDirectory ? { directory: input.defaultDirectory } : undefined;
        },
      },
      session: sessionApi,
    },
  };

  return {
    context,
    // Emit stamps the pane's own directory as the event location by default, so
    // single-pane tests exercise the in-location path; pass an explicit
    // `location` to simulate a foreign pane's event.
    emit(event: FakeEvent) {
      const stamped: FakeEvent =
        event.location || !input.directory
          ? event
          : { ...event, location: { directory: input.directory } };
      handler?.({ details: stamped });
    },
    setStatus(sessionID: string, status: "idle" | "running") {
      statuses[sessionID] = status;
    },
    setRoute(sessionID: string | undefined) {
      routeSession = sessionID;
    },
    setTabs(next: TabListEntry[]) {
      tabs = [...next];
    },
    setPermissions(sessionID: string, list: unknown[] | undefined) {
      if (list === undefined) {
        delete permissions[sessionID];
      } else {
        permissions[sessionID] = list;
      }
    },
    setForms(sessionID: string, list: unknown[] | undefined) {
      if (list === undefined) {
        delete forms[sessionID];
      } else {
        forms[sessionID] = list;
      }
    },
    isUnsubscribed: () => unsubscribed,
  };
}

function readOnlyStateFile(stateDir: string): Record<string, unknown> {
  const entries = readdirSync(stateDir);
  assert.equal(entries.length, 1, "expected exactly one plugin state file");
  return JSON.parse(readFileSync(join(stateDir, entries[0] ?? ""), "utf8")) as Record<
    string,
    unknown
  >;
}

function isolatedStateDir(extraEnv: Record<string, string | undefined> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-tui-test-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: stateDir,
    TMUX: undefined,
    TMUX_PANE: undefined,
    ...extraEnv,
  });
  return { stateDir, restoreEnv };
}

test("tui plugin writes an initial state file on setup", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "new");
    assert.equal(state.title, "project");
    assert.equal(state.directory, "/tmp/project");

    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin derives running from a V2 session.status busy event", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "running");
    assert.equal(state.activity, "busy");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin latches waiting on permission.asked through a busy heartbeat", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({ type: "permission.asked", data: { id: "req-1", sessionID: "ses_a" } });
    emit({ type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "waiting-input");
    assert.equal(state.activity, "busy");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin maps form.created to waiting-question", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({
      type: "form.created",
      data: { form: { id: "frm_1", sessionID: "ses_a", fields: [{ options: ["a", "b"] }] } },
    });

    assert.equal(readOnlyStateFile(stateDir).status, "waiting-question");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin releases the latch on form.replied", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({
      type: "form.created",
      data: { form: { id: "frm_1", sessionID: "ses_a", fields: [{ options: ["a"] }] } },
    });
    assert.equal(readOnlyStateFile(stateDir).status, "waiting-question");

    emit({ type: "form.replied", data: { id: "frm_1", sessionID: "ses_a", answer: {} } });
    assert.equal(readOnlyStateFile(stateDir).status, "running");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin treats session.execution.failed as unknown", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.execution.failed", data: { sessionID: "ses_a", error: {} } });

    assert.equal(readOnlyStateFile(stateDir).status, "unknown");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin keeps root busy when a child session goes idle", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    // ses_child's root is ses_root; ses_root is its own root.
    const { context, emit } = makeContext({
      directory: "/tmp/project",
      roots: { ses_child: "ses_root" },
    });
    const cleanup = mod.default.setup(context);

    emit({ type: "permission.asked", data: { id: "req-1", sessionID: "ses_root" } });
    assert.equal(readOnlyStateFile(stateDir).status, "waiting-input");

    emit({ type: "session.idle", data: { sessionID: "ses_child" } });

    assert.equal(
      readOnlyStateFile(stateDir).status,
      "waiting-input",
      "child idle must not clear the root latch",
    );
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin idles the pane when authoritative status is idle", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit, setStatus } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } });
    assert.equal(readOnlyStateFile(stateDir).status, "running");

    // Turn ends: authoritative status flips to idle, then any boundary event
    // reconciles the pane to idle.
    setStatus("ses_a", "idle");
    emit({ type: "session.idle", data: { sessionID: "ses_a" } });

    assert.equal(readOnlyStateFile(stateDir).status, "idle");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin leaves 'new' when a V2 streaming event drives it running", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    assert.equal(readOnlyStateFile(stateDir).status, "new");

    // V2 emits streaming events, not a session.status per token. These must
    // move the pane off "new" to running.
    emit({ type: "session.text.delta", data: { sessionID: "ses_a", part: {} } });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "running", "streaming event must leave 'new'");
    assert.equal(state.activity, "busy");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin idles on execution boundary when authoritative status is idle", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit, setStatus } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    // Mid-turn: authoritative running, boundary events must NOT idle.
    emit({ type: "session.step.streamed", data: { sessionID: "ses_a", part: {} } });
    assert.equal(readOnlyStateFile(stateDir).status, "running");
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
    assert.equal(
      readOnlyStateFile(stateDir).status,
      "running",
      "boundary event while authoritative running must stay running",
    );

    // Turn actually ends: authoritative idle → the next boundary event idles it.
    setStatus("ses_a", "idle");
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
    assert.equal(
      readOnlyStateFile(stateDir).status,
      "idle",
      "boundary event with authoritative idle idles the pane",
    );
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin keeps a pending prompt latched across execution.succeeded", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({ type: "permission.asked", data: { id: "req-1", sessionID: "ses_a" } });
    assert.equal(readOnlyStateFile(stateDir).status, "waiting-input");

    // A segment-complete event mid-prompt must NOT clear the latch.
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
    assert.equal(
      readOnlyStateFile(stateDir).status,
      "waiting-input",
      "execution.succeeded must not discharge a pending prompt",
    );

    // Streaming after the segment also stays latched.
    emit({ type: "session.step.ended", data: { sessionID: "ses_a", part: {} } });
    assert.equal(readOnlyStateFile(stateDir).status, "waiting-input");

    // Only replying discharges it.
    emit({ type: "permission.replied", data: { sessionID: "ses_a", requestID: "req-1" } });
    assert.equal(readOnlyStateFile(stateDir).status, "running");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin ignores non-status events entirely (no file churn)", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
    const before = readOnlyStateFile(stateDir);

    // Background noise must not touch the state file.
    emit({ type: "model.updated", location: { directory: "/tmp/project" } });
    emit({ type: "catalog.updated" });
    emit({ type: "session.viewed", data: { sessionID: "ses_a" } });

    assert.deepEqual(readOnlyStateFile(stateDir), before, "non-status events must not churn state");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin keys the state file by TMUX_PANE", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir({ TMUX_PANE: "%77" });
  try {
    const mod = await loadTuiPlugin();
    const { context } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    const entries = readdirSync(stateDir);
    assert.equal(entries.length, 1);
    const expected = `pane-${Buffer.from("%77").toString("hex")}.json`;
    assert.equal(entries[0], expected, "state file keyed by TMUX_PANE, not cwd");

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.paneId, "%77");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin cleanup unsubscribes from the event stream", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const fake = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(fake.context);

    assert.equal(fake.isUnsubscribed(), false);
    if (typeof cleanup === "function") await cleanup();
    assert.equal(fake.isUnsubscribed(), true, "cleanup must unsubscribe");

    // A stale event after cleanup must not touch the state file.
    const before = readOnlyStateFile(stateDir);
    fake.emit({ type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } });
    assert.deepEqual(readOnlyStateFile(stateDir), before);
  } finally {
    restoreEnv();
  }
});

test("tui plugin ignores events from another pane's location", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    // A busy event for a DIFFERENT directory must not touch this pane.
    emit({
      type: "session.status",
      location: { directory: "/tmp/other-project" },
      data: { sessionID: "ses_foreign", status: { type: "busy" } },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "new", "foreign-location event must not change status");
    assert.equal(state.sessionId, null, "foreign session must not take identity");
    assert.equal(state.directory, "/tmp/project", "directory must stay the pane's own");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin ignores a second session in the same location once pinned", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    // ses_a and ses_b are both roots in the same directory (two panes, one dir).
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    // First session pins the pane.
    emit({ type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } });
    assert.equal(readOnlyStateFile(stateDir).sessionId, "ses_a");

    // A different root session in the same directory must not hijack the pane.
    emit({ type: "session.idle", data: { sessionID: "ses_b" } });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.sessionId, "ses_a", "pinned session must not change");
    assert.notEqual(state.status, "idle", "foreign session's idle must not idle this pane");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin re-elects a new root after the pinned root is deleted", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } });
    assert.equal(readOnlyStateFile(stateDir).sessionId, "ses_a");

    // Pinned root ends; pane must free up to adopt the next session.
    emit({ type: "session.deleted", data: { sessionID: "ses_a" } });
    emit({ type: "session.status", data: { sessionID: "ses_b", status: { type: "busy" } } });

    assert.equal(readOnlyStateFile(stateDir).sessionId, "ses_b", "must adopt replacement root");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin uses data.location.default() when context.location is unset", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    // No bound location; server default provides the pane directory.
    const { context, emit } = makeContext({ defaultDirectory: "/tmp/fallback-dir" });
    const cleanup = mod.default.setup(context);

    assert.equal(readOnlyStateFile(stateDir).directory, "/tmp/fallback-dir");

    // In-location event (matching the fallback dir) is accepted.
    emit({
      type: "session.status",
      location: { directory: "/tmp/fallback-dir" },
      data: { sessionID: "ses_a", status: { type: "busy" } },
    });
    assert.equal(readOnlyStateFile(stateDir).status, "running");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin seeds a resumed idle session as idle, not new", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context } = makeContext({
      directory: "/tmp/project",
      routeSession: "ses_resumed",
      statuses: { ses_resumed: "idle" },
      titles: { ses_resumed: "Resumed work" },
    });
    const cleanup = mod.default.setup(context);

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "idle", "resumed idle session must not be 'new'");
    assert.equal(state.sessionId, "ses_resumed");
    assert.equal(state.title, "Resumed work", "title seeded from session");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin seeds a resumed running session as running", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context } = makeContext({
      directory: "/tmp/project",
      routeSession: "ses_busy",
      statuses: { ses_busy: "running" },
    });
    const cleanup = mod.default.setup(context);

    assert.equal(readOnlyStateFile(stateDir).status, "running");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin stays 'new' when the route is home (fresh start)", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    assert.equal(readOnlyStateFile(stateDir).status, "new", "home route is a fresh 'new' pane");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin keeps waiting even when authoritative status is idle", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({
      directory: "/tmp/project",
      statuses: { ses_a: "idle" },
    });
    const cleanup = mod.default.setup(context);

    emit({ type: "permission.asked", data: { id: "req-1", sessionID: "ses_a" } });
    assert.equal(readOnlyStateFile(stateDir).status, "waiting-input");

    emit({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
    assert.equal(
      readOnlyStateFile(stateDir).status,
      "waiting-input",
      "pending prompt dominates authoritative idle",
    );

    emit({ type: "permission.replied", data: { sessionID: "ses_a", requestID: "req-1" } });
    assert.notEqual(readOnlyStateFile(stateDir).status, "waiting-input", "reply discharges latch");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin follows a session switch in the same pane", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit, setRoute } = makeContext({
      directory: "/tmp/project",
      routeSession: "ses_first",
      statuses: { ses_first: "running", ses_second: "running" },
    });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.step.streamed", data: { sessionID: "ses_first", part: {} } });
    assert.equal(readOnlyStateFile(stateDir).sessionId, "ses_first");

    setRoute("ses_second");
    emit({ type: "session.step.streamed", data: { sessionID: "ses_second", part: {} } });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.sessionId, "ses_second", "pane must follow the route to the new session");
    assert.equal(state.status, "running");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

// --- Session tabs (V2 tabs.enabled) ---------------------------------------

test("tui plugin rolls up a background-tab permission prompt", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    // Focused tab ses_a (route). Background tab ses_b has a pending permission.
    const { context, emit } = makeContext({
      directory: "/tmp/project",
      routeSession: "ses_a",
      statuses: { ses_a: "running", ses_b: "running" },
      tabs: [
        { sessionID: "ses_a", active: true, busy: true, attention: false },
        { sessionID: "ses_b", active: false, busy: false, attention: true },
      ],
      families: { ses_b: ["ses_b"] },
      permissions: { ses_b: [{ id: "req-b" }] },
    });
    const cleanup = mod.default.setup(context);

    // A focused-tab event triggers persist and refreshes the tab snapshot.
    emit({ type: "session.step.streamed", data: { sessionID: "ses_a", part: {} } });

    const state = readOnlyStateFile(stateDir) as Record<string, unknown>;
    const tabs = state.tabs as Array<Record<string, unknown>>;
    assert.equal(tabs.length, 2);
    const bTab = tabs.find((t) => t.sessionId === "ses_b");
    assert.equal(bTab?.status, "waiting-input", "background permission must derive waiting-input");
    // Top-level identity stays the focused tab.
    assert.equal(state.sessionId, "ses_a");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin persists on a background-tab event it does not own", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit, setPermissions, setTabs } = makeContext({
      directory: "/tmp/project",
      routeSession: "ses_a",
      statuses: { ses_a: "running", ses_b: "running" },
      tabs: [
        { sessionID: "ses_a", active: true, busy: true, attention: false },
        { sessionID: "ses_b", active: false, busy: true, attention: false },
      ],
      families: { ses_b: ["ses_b"] },
    });
    const cleanup = mod.default.setup(context);

    // ses_b asks for permission: mark its store + tab, then emit ses_b's event.
    setPermissions("ses_b", [{ id: "req-b" }]);
    setTabs([
      { sessionID: "ses_a", active: true, busy: true, attention: false },
      { sessionID: "ses_b", active: false, busy: false, attention: true },
    ]);
    emit({ type: "permission.asked", data: { id: "req-b", sessionID: "ses_b" } });

    const state = readOnlyStateFile(stateDir) as Record<string, unknown>;
    const tabs = state.tabs as Array<Record<string, unknown>>;
    const bTab = tabs.find((t) => t.sessionId === "ses_b");
    assert.equal(bTab?.status, "waiting-input", "background event must refresh the roll-up");
    // The background event must not steal the top-level identity.
    assert.equal(state.sessionId, "ses_a");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin derives waiting-question from a background-tab form", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({
      directory: "/tmp/project",
      routeSession: "ses_a",
      tabs: [
        { sessionID: "ses_a", active: true, busy: true, attention: false },
        { sessionID: "ses_b", active: false, busy: false, attention: true },
      ],
      families: { ses_b: ["ses_b"] },
      forms: { ses_b: [{ id: "frm-b" }] },
    });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.step.streamed", data: { sessionID: "ses_a", part: {} } });

    const tabs = (readOnlyStateFile(stateDir) as Record<string, unknown>).tabs as Array<
      Record<string, unknown>
    >;
    const bTab = tabs.find((t) => t.sessionId === "ses_b");
    assert.equal(bTab?.status, "waiting-question", "a pending form must derive waiting-question");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin resolves attention via family when the tab has no direct prompt", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    // The tab session ses_b has a subagent ses_b_child holding the permission.
    const { context, emit } = makeContext({
      directory: "/tmp/project",
      routeSession: "ses_a",
      tabs: [
        { sessionID: "ses_a", active: true, busy: true, attention: false },
        { sessionID: "ses_b", active: false, busy: false, attention: true },
      ],
      families: { ses_b: ["ses_b", "ses_b_child"] },
      permissions: { ses_b_child: [{ id: "req-child" }] },
    });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.step.streamed", data: { sessionID: "ses_a", part: {} } });

    const tabs = (readOnlyStateFile(stateDir) as Record<string, unknown>).tabs as Array<
      Record<string, unknown>
    >;
    const bTab = tabs.find((t) => t.sessionId === "ses_b");
    assert.equal(bTab?.status, "waiting-input", "family member's prompt must surface on the tab");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin does not filter a cross-directory (scope global) tab", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit } = makeContext({
      directory: "/tmp/project",
      routeSession: "ses_a",
      tabs: [
        { sessionID: "ses_a", active: true, busy: true, attention: false },
        { sessionID: "ses_b", active: false, busy: false, attention: true },
      ],
      families: { ses_b: ["ses_b"] },
      permissions: { ses_b: [{ id: "req-b" }] },
    });
    const cleanup = mod.default.setup(context);

    // ses_b's event declares a *different* directory (scope: global tab). With
    // tabs enabled the location guard must not drop it.
    emit({
      type: "permission.asked",
      data: { id: "req-b", sessionID: "ses_b" },
      location: { directory: "/tmp/other" },
    });

    const tabs = (readOnlyStateFile(stateDir) as Record<string, unknown>).tabs as Array<
      Record<string, unknown>
    >;
    const bTab = tabs.find((t) => t.sessionId === "ses_b");
    assert.equal(bTab?.status, "waiting-input", "a global-scope tab must not be location-filtered");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin drops a closed tab from the roll-up on the next event", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    const { context, emit, setTabs } = makeContext({
      directory: "/tmp/project",
      routeSession: "ses_a",
      tabs: [
        { sessionID: "ses_a", active: true, busy: true, attention: false },
        { sessionID: "ses_b", active: false, busy: false, attention: true },
      ],
      families: { ses_b: ["ses_b"] },
      permissions: { ses_b: [{ id: "req-b" }] },
    });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.step.streamed", data: { sessionID: "ses_a", part: {} } });
    let tabs = (readOnlyStateFile(stateDir) as Record<string, unknown>).tabs as Array<
      Record<string, unknown>
    >;
    assert.equal(tabs.length, 2);

    // ses_b tab closes; the next event must rebuild the snapshot without it.
    setTabs([{ sessionID: "ses_a", active: true, busy: true, attention: false }]);
    emit({ type: "session.step.streamed", data: { sessionID: "ses_a", part: {} } });

    tabs = (readOnlyStateFile(stateDir) as Record<string, unknown>).tabs as Array<
      Record<string, unknown>
    >;
    assert.equal(tabs.length, 1, "a closed tab must drop on the next event");
    assert.equal(tabs[0]?.sessionId, "ses_a");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});

test("tui plugin writes no tabs field when session tabs are disabled", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();
  try {
    const mod = await loadTuiPlugin();
    // No `tabs` input → the fake omits `ui.tabs` entirely (disabled path).
    const { context, emit } = makeContext({ directory: "/tmp/project" });
    const cleanup = mod.default.setup(context);

    emit({ type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } });

    const state = readOnlyStateFile(stateDir) as Record<string, unknown>;
    assert.equal(state.tabs, undefined, "disabled tabs must not add a tabs field");
    assert.equal(state.status, "running");
    if (typeof cleanup === "function") await cleanup();
  } finally {
    restoreEnv();
  }
});
