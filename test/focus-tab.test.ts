import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { focusWaitingTab, hasWaitingBackgroundTab, selectTab } from "../src/core/focus-tab.ts";
import type {
  AgentKind,
  PaneRuntimeSummary,
  PaneTabInfo,
  RuntimeInfo,
  RuntimeStatus,
  TmuxPane,
} from "../src/types.ts";

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

// Fake tmux that logs each invocation's argv (tab-joined, one line each) and
// answers `show-option -gqv <opt>` from the provided option map.
function installFakeTmux(options: Record<string, string> = {}): {
  pathEntry: string;
  logPath: string;
  reads(): string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-focus-"));
  const tmuxPath = join(dir, "tmux");
  const logPath = join(dir, "tmux.log");

  const cases = Object.entries(options)
    .map(([opt, value]) => `  "${opt}") printf '%s' ${JSON.stringify(value)} ;;`)
    .join("\n");

  writeFileSync(
    tmuxPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ "\${1:-}" = "show-option" ]; then
  case "\${3:-}" in
${cases}
  *) : ;;
  esac
fi
exit 0
`,
    "utf8",
  );
  chmodSync(tmuxPath, 0o755);

  return {
    pathEntry: dir,
    logPath,
    reads() {
      if (!existsSync(logPath)) {
        return [];
      }
      return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    },
  };
}

function createTab(overrides: Partial<PaneTabInfo> = {}): PaneTabInfo {
  return {
    sessionId: overrides.sessionId ?? "ses_x",
    title: overrides.title ?? "Tab",
    status: overrides.status ?? "idle",
    activity: overrides.activity ?? "idle",
    active: overrides.active ?? false,
    updatedAt: overrides.updatedAt ?? 0,
  };
}

function createRuntime(overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
  const runtime: RuntimeInfo = {
    activity: overrides.activity ?? "busy",
    status: overrides.status ?? "running",
    source: overrides.source ?? "plugin-exact",
    match: overrides.match ?? { strategy: "exact", provider: "plugin", heuristic: false },
    session: overrides.session ?? null,
    detail: overrides.detail ?? "",
  };

  if (overrides.tabs !== undefined) {
    runtime.tabs = overrides.tabs;
  }

  return runtime;
}

function createPane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    sessionName: overrides.sessionName ?? "work",
    windowIndex: overrides.windowIndex ?? 1,
    paneIndex: overrides.paneIndex ?? 1,
    paneId: overrides.paneId ?? "%13",
    paneTitle: overrides.paneTitle ?? "OpenCode",
    currentCommand: overrides.currentCommand ?? "zsh",
    currentPath: overrides.currentPath ?? "/tmp/project",
    isActive: overrides.isActive ?? true,
    tty: overrides.tty ?? "/dev/ttys002",
    target: overrides.target ?? "work:1.1",
  };
}

function createSummary(input: {
  agent?: AgentKind | null;
  tabs?: PaneTabInfo[];
  status?: RuntimeStatus;
}): PaneRuntimeSummary {
  const runtimeOverrides: Partial<RuntimeInfo> = { status: input.status ?? "waiting-input" };

  if (input.tabs !== undefined) {
    runtimeOverrides.tabs = input.tabs;
  }

  return {
    pane: createPane(),
    detection: { agent: input.agent ?? "opencode", confidence: "high", reasons: ["title:OC"] },
    runtime: createRuntime(runtimeOverrides),
  };
}

test("hasWaitingBackgroundTab: a waiting non-active tab is a candidate", () => {
  const runtime = createRuntime({
    tabs: [
      createTab({ active: true, status: "running" }),
      createTab({ active: false, status: "waiting-input" }),
    ],
  });
  assert.equal(hasWaitingBackgroundTab(runtime), true);
});

test("hasWaitingBackgroundTab: a waiting focused tab is not a candidate", () => {
  const runtime = createRuntime({
    tabs: [
      createTab({ active: true, status: "waiting-input" }),
      createTab({ active: false, status: "idle" }),
    ],
  });
  assert.equal(hasWaitingBackgroundTab(runtime), false);
});

test("hasWaitingBackgroundTab: no tabs is not a candidate", () => {
  assert.equal(hasWaitingBackgroundTab(createRuntime({})), false);
  assert.equal(hasWaitingBackgroundTab(createRuntime({ tabs: [] })), false);
});

test("focusWaitingTab: sends exactly one send-keys with the default key when eligible", async () => {
  const fake = installFakeTmux();
  const restore = setEnv({ PATH: `${fake.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await focusWaitingTab(
      createSummary({
        tabs: [
          createTab({ active: true, status: "running" }),
          createTab({ active: false, status: "waiting-input" }),
        ],
      }),
    );

    const sends = fake.reads().filter((line) => line.startsWith("send-keys"));
    assert.equal(sends.length, 1);
    assert.equal(sends[0], "send-keys -t work:1.1 M-S-Down");
  } finally {
    restore();
  }
});

test("focusWaitingTab: honors a client and an overridden key", async () => {
  const fake = installFakeTmux({ "@coding-agents-tmux-focus-waiting-tab-key": "C-a" });
  const restore = setEnv({ PATH: `${fake.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await focusWaitingTab(
      createSummary({
        tabs: [
          createTab({ active: true, status: "running" }),
          createTab({ active: false, status: "waiting-question" }),
        ],
      }),
      "/dev/ttys009",
    );

    const sends = fake.reads().filter((line) => line.startsWith("send-keys"));
    assert.equal(sends.length, 1);
    assert.equal(sends[0], "send-keys -c /dev/ttys009 -t work:1.1 C-a");
  } finally {
    restore();
  }
});

test("focusWaitingTab: no send for a non-OpenCode pane", async () => {
  const fake = installFakeTmux();
  const restore = setEnv({ PATH: `${fake.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await focusWaitingTab(
      createSummary({
        agent: "claude",
        tabs: [createTab({ active: false, status: "waiting-input" })],
      }),
    );

    assert.equal(fake.reads().filter((line) => line.startsWith("send-keys")).length, 0);
  } finally {
    restore();
  }
});

test("focusWaitingTab: no send when the option is off", async () => {
  const fake = installFakeTmux({ "@coding-agents-tmux-focus-waiting-tab": "off" });
  const restore = setEnv({ PATH: `${fake.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await focusWaitingTab(
      createSummary({
        tabs: [createTab({ active: false, status: "waiting-input" })],
      }),
    );

    assert.equal(fake.reads().filter((line) => line.startsWith("send-keys")).length, 0);
  } finally {
    restore();
  }
});

test("focusWaitingTab: no send when only the focused tab is waiting", async () => {
  const fake = installFakeTmux();
  const restore = setEnv({ PATH: `${fake.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await focusWaitingTab(
      createSummary({
        tabs: [
          createTab({ active: true, status: "waiting-input" }),
          createTab({ active: false, status: "idle" }),
        ],
      }),
    );

    assert.equal(fake.reads().filter((line) => line.startsWith("send-keys")).length, 0);
  } finally {
    restore();
  }
});

test("focusWaitingTab: no send when the pane has no tabs", async () => {
  const fake = installFakeTmux();
  const restore = setEnv({ PATH: `${fake.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await focusWaitingTab(createSummary({}));
    assert.equal(fake.reads().filter((line) => line.startsWith("send-keys")).length, 0);
  } finally {
    restore();
  }
});

test("selectTab: sends the default leader sequence with the index substituted", async () => {
  const fake = installFakeTmux();
  const restore = setEnv({ PATH: `${fake.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await selectTab(createSummary({ tabs: [createTab({})] }), 3);

    const sends = fake.reads().filter((line) => line.startsWith("send-keys"));
    assert.equal(sends.length, 1);
    assert.equal(sends[0], "send-keys -t work:1.1 C-x 3");
  } finally {
    restore();
  }
});

test("selectTab: honors a client and a custom single-token select pattern", async () => {
  const fake = installFakeTmux({ "@coding-agents-tmux-focus-waiting-tab-select-key": "C-{n}" });
  const restore = setEnv({ PATH: `${fake.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await selectTab(createSummary({ tabs: [createTab({})] }), 2, "/dev/ttys009");

    const sends = fake.reads().filter((line) => line.startsWith("send-keys"));
    assert.equal(sends.length, 1);
    assert.equal(sends[0], "send-keys -c /dev/ttys009 -t work:1.1 C-2");
  } finally {
    restore();
  }
});

test("selectTab: no send when the feature is off", async () => {
  const fake = installFakeTmux({ "@coding-agents-tmux-focus-waiting-tab": "off" });
  const restore = setEnv({ PATH: `${fake.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await selectTab(createSummary({ tabs: [createTab({})] }), 1);
    assert.equal(fake.reads().filter((line) => line.startsWith("send-keys")).length, 0);
  } finally {
    restore();
  }
});
