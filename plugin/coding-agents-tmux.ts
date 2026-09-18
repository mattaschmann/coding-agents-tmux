// V1 loose-file entrypoint for the OpenCode plugin.
//
// V1 (OpenCode 1.x) discovers only loose `.ts` files under
// `$CONFIG_DIR/plugins/`, not directory packages — verified empirically against
// 1.18.31. So this file is kept as the V1 entrypoint alongside the V2 directory
// package (plugin/coding-agents-tmux/), both symlinked by the `.tmux` installer.
//
// Under V1 the plugin runs per-CLI-process, so `TMUX_PANE` here is the real
// pane. It reuses the shared state machine (src/core/opencode-plugin-state.ts),
// backing root/child scoping with SessionScopeTracker since V1 has no TUI
// session API. The V2 writer lives in plugin/coding-agents-tmux/tui.ts.
//
// NOTE: under V2 the directory package can import from src/; V1 loose files are
// loaded the same way (bare `.ts`), so this import also resolves for V1.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  type PluginEvent,
  PromptLatch,
  SESSION_LIFECYCLE_EVENTS,
  SessionScopeTracker,
  applyDerivedStatus,
  createInitialState,
  getEventParentId,
  getEventSessionId,
  getPluginStateDir,
  normalizeEnvValue,
  toStateFileName,
} from "../src/core/opencode-plugin-state.ts";

interface PluginLogClient {
  app: {
    log(input: {
      body: {
        service: string;
        level: string;
        message: string;
        extra: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
}

interface PluginProject {
  name?: string;
}

interface PluginInitContext {
  directory: string;
  project?: PluginProject;
  client: PluginLogClient;
}

interface PluginEventContext {
  event: PluginEvent;
}

let tmuxRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function dispatchNotification(command: string): void {
  const child = spawn(process.env.SHELL ?? "/bin/sh", ["-c", command], { stdio: "ignore" });
  const timeout = setTimeout(() => child.kill(), 5_000);
  const clear = () => clearTimeout(timeout);
  timeout.unref();
  child.once("error", clear);
  child.once("exit", clear);
  child.unref();
}

function scheduleTmuxStatusRefresh(): void {
  if (!process.env.TMUX || tmuxRefreshTimer) {
    return;
  }

  tmuxRefreshTimer = setTimeout(() => {
    tmuxRefreshTimer = null;
    spawnSync("tmux", ["refresh-client", "-S"], { stdio: "ignore" });
    const notificationResult = spawnSync(
      "tmux",
      ["show-option", "-gqv", "@coding-agents-tmux-notify-command"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const configured =
      notificationResult.status === 0 && typeof notificationResult.stdout === "string"
        ? notificationResult.stdout.trim()
        : "";

    if (configured) {
      dispatchNotification(configured);
    }
  }, 150);
}

function runTmuxCommand(args: string[]) {
  return spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function resolveTmuxPaneTarget(paneId: string | null): string | null {
  if (!paneId) {
    return null;
  }

  const result = runTmuxCommand([
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{session_name}:#{window_index}.#{pane_index}",
  ]);

  if (result.status !== 0) {
    return null;
  }

  const target = result.stdout.trim();
  return target ? target : null;
}

export const CodingAgentsTmuxPlugin = async ({ directory, project, client }: PluginInitContext) => {
  const paneId = normalizeEnvValue(process.env.TMUX_PANE);
  const state = createInitialState({
    paneId,
    target: resolveTmuxPaneTarget(paneId),
    directory,
    title: project?.name ?? directory.split("/").filter(Boolean).pop() ?? "OpenCode session",
  });

  const latch = new PromptLatch();
  const scope = new SessionScopeTracker();

  function classifyScope(sessionId: string | null): "root" | "child" | "unknown" {
    return scope.classify(sessionId);
  }

  async function persist(): Promise<void> {
    const target = resolveTmuxPaneTarget(state.paneId);
    if (target) {
      state.target = target;
    }

    const stateDir = getPluginStateDir();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      `${stateDir}/${toStateFileName({ directory: state.directory, paneId: state.paneId })}`,
      JSON.stringify(state, null, 2),
    );
  }

  function handleEvent(event: PluginEvent): void {
    // Feed session lifecycle metadata to the scope tracker before deriving, so
    // child sessions cannot take the pane's identity.
    const sessionId = getEventSessionId(event);
    if (SESSION_LIFECYCLE_EVENTS.has(event.type) && sessionId) {
      scope.recordLifecycle(sessionId, getEventParentId(event), event.type === "session.deleted");
    } else if (sessionId) {
      scope.observe(sessionId);
    }

    applyDerivedStatus({ state, event, latch, classifyScope });
  }

  await client.app.log({
    body: {
      service: "coding-agents-tmux-plugin",
      level: "info",
      message: "plugin initialized",
      extra: { directory, paneId: state.paneId, target: state.target },
    },
  });

  await persist();
  scheduleTmuxStatusRefresh();

  return {
    event: async ({ event }: PluginEventContext) => {
      handleEvent(event);
      await persist();
      scheduleTmuxStatusRefresh();
    },
  };
};
