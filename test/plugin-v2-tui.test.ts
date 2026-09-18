import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
}) {
  let handler: ((event: { details: FakeEvent }) => void) | null = null;
  let unsubscribed = false;
  const roots = input.roots ?? {};
  const statuses: Record<string, "idle" | "running"> = { ...input.statuses };
  const titles = input.titles ?? {};
  let routeSession: string | undefined = input.routeSession;

  const context = {
    location: input.directory ? { directory: input.directory } : undefined,
    ui: {
      router: {
        current(): { type: string; sessionID?: string } {
          return routeSession ? { type: "session", sessionID: routeSession } : { type: "home" };
        },
      },
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
      session: {
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
      },
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
