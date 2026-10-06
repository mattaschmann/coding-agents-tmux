import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildKiroHooksTemplate,
  installKiroIntegration,
  persistKiroHookState,
} from "../src/core/kiro.ts";
import { attachRuntimeToPanes } from "../src/core/runtime.ts";
import type { DiscoveredPane, TmuxPane } from "../src/types.ts";

function createPane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  const sessionName = overrides.sessionName ?? "work";
  const windowIndex = overrides.windowIndex ?? 1;
  const paneIndex = overrides.paneIndex ?? 0;

  return {
    sessionName,
    windowIndex,
    paneIndex,
    paneId: overrides.paneId ?? `%${paneIndex + 1}`,
    paneTitle: overrides.paneTitle ?? "Kiro CLI",
    currentCommand: overrides.currentCommand ?? "kiro-cli",
    currentPath: overrides.currentPath ?? "/tmp/kiro-project",
    isActive: overrides.isActive ?? false,
    tty: overrides.tty ?? "/dev/ttys001",
    target: overrides.target ?? `${sessionName}:${windowIndex}.${paneIndex}`,
  };
}

function createDiscoveredKiroPane(overrides: Partial<TmuxPane> = {}): DiscoveredPane {
  const pane = createPane(overrides);

  return {
    pane,
    detection: {
      agent: "kiro",
      confidence: "medium",
      reasons: ["command:kiro"],
    },
  };
}

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

function installFakeTmux(script: string): { pathEntry: string } {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-kiro-fake-tmux-"));
  const tmuxPath = join(dir, "tmux");

  writeFileSync(
    tmuxPath,
    `#!/usr/bin/env bash
set -euo pipefail
${script}
`,
    "utf8",
  );
  chmodSync(tmuxPath, 0o755);

  return { pathEntry: dir };
}

test("Kiro preview fallback detects waiting state", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf 'Kiro wants to run a shell command.\n'
  printf 'Allow this command?\n'
  printf '1. Yes\n'
  printf '2. No\n'
  exit 0
fi
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredKiroPane({ target: "work:1.0", currentPath: "/tmp/kiro-project" }),
    ]);

    assert.equal(summaries[0]?.runtime.source, "kiro-preview");
    assert.equal(summaries[0]?.runtime.status, "waiting-question");
    assert.equal(summaries[0]?.runtime.session?.title, "kiro-project");
    assert.equal(summaries[0]?.runtime.session?.directory, "/tmp/kiro-project");
  } finally {
    restoreEnv();
  }
});

test("Kiro command fallback marks unmatched panes as idle", async () => {
  const summaries = await attachRuntimeToPanes([
    createDiscoveredKiroPane({ currentCommand: "kiro-cli-chat", currentPath: "/tmp/kiro-project" }),
  ]);

  assert.equal(summaries[0]?.runtime.source, "kiro-command");
  assert.equal(summaries[0]?.runtime.status, "idle");
  assert.equal(summaries[0]?.runtime.activity, "idle");
  assert.equal(summaries[0]?.runtime.match.provider, "kiro");
  assert.equal(summaries[0]?.runtime.session?.id, "kiro:work:1.0");
  assert.equal(summaries[0]?.runtime.session?.title, "kiro-project");
  assert.equal(summaries[0]?.runtime.session?.directory, "/tmp/kiro-project");
  assert.match(summaries[0]?.runtime.detail ?? "", /assuming idle/);
});

// Build a fake tmux whose `capture-pane` prints the given pane lines verbatim,
// so the Kiro classifier runs against a realistic V3 screen capture.
function installFakeTmuxWithCapture(previewLines: string[]): { pathEntry: string } {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-kiro-fixture-"));
  const fixturePath = join(dir, "preview.txt");
  writeFileSync(fixturePath, `${previewLines.join("\n")}\n`, "utf8");

  return installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  cat ${JSON.stringify(fixturePath)}
  exit 0
fi
exit 0
`);
}

async function classifyKiroFixture(previewLines: string[]) {
  const fakeTmux = installFakeTmuxWithCapture(previewLines);
  const restoreEnv = setEnv({ PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredKiroPane({ target: "work:1.0", currentPath: "/tmp/kiro-project" }),
    ]);
    return summaries[0]?.runtime;
  } finally {
    restoreEnv();
  }
}

// Captured 2026-10-06 from a live `kiro-cli --v3` pane (see task Investigation).
const V3_STATUS_BAR = "Default · auto · ◔ 3%                              /private/tmp/kiro-probe";
const V3_INPUT_IDLE = "›  ask a question or describe a task ↵";
const V3_RULE = "─".repeat(80);

test("Kiro V3 idle screen with a list+question in the reply classifies idle", async () => {
  const runtime = await classifyKiroFixture([
    "• - apple",
    "  - pear",
    "  1. one",
    "  2. two Which do you want?",
    V3_RULE,
    V3_STATUS_BAR,
    V3_INPUT_IDLE,
    "                                   /sessions to resume · /copy to clipboard",
  ]);

  assert.equal(runtime?.source, "kiro-preview");
  assert.equal(runtime?.status, "idle");
  assert.equal(runtime?.activity, "idle");
});

test("Kiro V3 draft input (not sent) classifies idle", async () => {
  const runtime = await classifyKiroFixture([V3_STATUS_BAR, "› draft text not sent"]);

  assert.equal(runtime?.source, "kiro-preview");
  assert.equal(runtime?.status, "idle");
});

test("Kiro V3 working screen classifies running", async () => {
  const runtime = await classifyKiroFixture([
    "ᗦ Thinking... (esc to cancel)",
    V3_RULE,
    V3_STATUS_BAR,
    "›  Kiro is working · 1s · Type to steer · Ctrl+S to queue",
  ]);

  assert.equal(runtime?.source, "kiro-preview");
  assert.equal(runtime?.status, "running");
  assert.equal(runtime?.activity, "busy");
});

test("Kiro V3 tool-approval overlay classifies waiting-question", async () => {
  const runtime = await classifyKiroFixture([
    V3_RULE,
    " Create an empty file requires approval",
    " shell → touch /tmp/kiro-probe/x.txt",
    " ❯ Allow",
    "   Always allow",
    "   Deny",
    "   Always deny",
    V3_RULE,
    " esc to close · ↑↓ to navigate · ↵ to select · Tab to edit",
  ]);

  assert.equal(runtime?.source, "kiro-preview");
  assert.equal(runtime?.status, "waiting-question");
  assert.match(runtime?.detail ?? "", /approval/);
});

test("Kiro V3 user-opened /model overlay still classifies waiting-question", async () => {
  const runtime = await classifyKiroFixture([
    " Settings for selected model: auto                     tab to switch panels",
    V3_RULE,
    " esc to close · ↑↓ to navigate · ↵ to select · tab to switch panels",
  ]);

  assert.equal(runtime?.source, "kiro-preview");
  assert.equal(runtime?.status, "waiting-question");
});

test("Kiro V2-style prompt (no V3 chrome) still uses legacy heuristics", async () => {
  const runtime = await classifyKiroFixture([
    "Kiro wants to run a shell command.",
    "Allow this command?",
    "1. Yes",
    "2. No",
  ]);

  assert.equal(runtime?.source, "kiro-preview");
  assert.equal(runtime?.status, "waiting-question");
});

test("Kiro readable screen with no chrome and no prompt falls back to idle command", async () => {
  const runtime = await classifyKiroFixture([
    "Here is some ordinary assistant output.",
    "Nothing actionable on screen.",
  ]);

  assert.equal(runtime?.source, "kiro-command");
  assert.equal(runtime?.status, "idle");
});

// --- Kiro V3 hook-backed state -----------------------------------------------

function readOnlyStateFile(dir: string): Record<string, unknown> | null {
  if (!existsSync(dir)) {
    return null;
  }
  const file = readdirSync(dir).find((entry) => entry.endsWith(".json"));
  return file
    ? (JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>)
    : null;
}

test("Kiro install writes an owned hooks file under KIRO_HOME", () => {
  const kiroHome = mkdtempSync(join(tmpdir(), "coding-agents-tmux-kiro-home-"));
  const restoreEnv = setEnv({ KIRO_HOME: kiroHome });

  try {
    const result = installKiroIntegration("/bin/cat kiro-hook-state");
    const hooks = readFileSync(result.hooksPath, "utf8");

    assert.equal(result.hooksPath, join(kiroHome, "hooks", "coding-agents-tmux.json"));
    assert.match(hooks, /kiro-hook-state/);
    assert.match(hooks, /"trigger": "SessionStart"/);
    assert.match(hooks, /"trigger": "SessionEnd"/);
    assert.equal(buildKiroHooksTemplate("x").includes('"version": "v1"'), true);
  } finally {
    restoreEnv();
  }
});

test("Kiro hook persist writes a pane-keyed state file and SessionEnd deletes it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-kiro-state-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_KIRO_STATE_DIR: stateDir,
    TMUX_PANE: "%7",
  });

  try {
    await persistKiroHookState(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: "/tmp/kiro-project",
        session_id: "sess_abc",
        tool_name: "execute_bash",
      }),
    );

    const state = readOnlyStateFile(stateDir);
    assert.equal(state?.status, "running");
    assert.equal(state?.activity, "busy");
    assert.equal(state?.paneId, "%7");
    assert.equal(state?.sessionId, "sess_abc");
    assert.equal(state?.title, "kiro-project");

    await persistKiroHookState(
      JSON.stringify({ hook_event_name: "SessionEnd", cwd: "/tmp/kiro-project" }),
    );
    assert.equal(readOnlyStateFile(stateDir), null);
  } finally {
    restoreEnv();
  }
});

test("Kiro Stop hook records idle, never waiting", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-kiro-state-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_KIRO_STATE_DIR: stateDir,
    TMUX_PANE: "%8",
  });

  try {
    await persistKiroHookState(
      JSON.stringify({ hook_event_name: "Stop", cwd: "/tmp/kiro-project" }),
    );
    const state = readOnlyStateFile(stateDir);
    assert.equal(state?.status, "idle");
    assert.equal(state?.activity, "idle");
  } finally {
    restoreEnv();
  }
});

test("Kiro approval preview wins over a fresh PreToolUse running hook", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-kiro-state-"));
  // Hook state recorded running (PreToolUse) just before the approval prompt.
  writeFileSync(
    join(stateDir, "pane-7.json"),
    JSON.stringify({
      version: 1,
      paneId: "%1",
      target: "work:1.0",
      directory: "/tmp/kiro-project",
      title: "kiro-project",
      activity: "busy",
      status: "running",
      sourceEventType: "PreToolUse",
      updatedAt: Date.now(),
    }),
    "utf8",
  );

  const fakeTmux = installFakeTmuxWithCapture([
    "─".repeat(80),
    " Create an empty file requires approval",
    " ❯ Allow",
    "   Deny",
    "─".repeat(80),
    " esc to close · ↑↓ to navigate · ↵ to select · Tab to edit",
  ]);
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_KIRO_STATE_DIR: stateDir,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredKiroPane({ target: "work:1.0", currentPath: "/tmp/kiro-project" }),
    ]);

    assert.equal(summaries[0]?.runtime.source, "kiro-preview");
    assert.equal(summaries[0]?.runtime.status, "waiting-question");
  } finally {
    restoreEnv();
  }
});

test("Kiro fresh UserPromptSubmit hook wins over an idle-looking preview", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-kiro-state-"));
  writeFileSync(
    join(stateDir, "pane-up.json"),
    JSON.stringify({
      version: 1,
      target: "work:1.0",
      directory: "/tmp/kiro-project",
      title: "kiro-project",
      activity: "busy",
      status: "running",
      sourceEventType: "UserPromptSubmit",
      updatedAt: Date.now(),
    }),
    "utf8",
  );

  const fakeTmux = installFakeTmuxWithCapture([
    "Default · auto · ◔ 3%                              /private/tmp/kiro-project",
    "›  ask a question or describe a task ↵",
  ]);
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_KIRO_STATE_DIR: stateDir,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredKiroPane({ target: "work:1.0", currentPath: "/tmp/kiro-project" }),
    ]);

    assert.equal(summaries[0]?.runtime.source, "kiro-hook");
    assert.equal(summaries[0]?.runtime.status, "running");
  } finally {
    restoreEnv();
  }
});
