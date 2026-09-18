// TUI entrypoint for the OpenCode V2 plugin package.
//
// This runs in the per-pane TUI process, the only place with a stable
// `TMUX_PANE`, so it owns writing the `pane-<hex>.json` state the tmux reader
// consumes. It subscribes to server events, derives pane status via the shared
// state machine (src/core/opencode-plugin-state.ts), and uses the TUI session
// API for root/child scoping instead of a hand-rolled tracker.
//
// Dependency-free: `Plugin.define` is identity and the loader predicate only
// checks `{ id, setup }`, so a plain object literal loads the same as a defined
// plugin, and we avoid adding `@opencode/plugin` to a repo with no OpenCode deps.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  type PluginEvent,
  PromptLatch,
  applyDerivedStatus,
  createInitialState,
  getEventSessionId,
  getPluginStateDir,
  normalizeEnvValue,
  toStateFileName,
} from "../../src/core/opencode-plugin-state.ts";

// Minimal shape of the V2 TUI plugin context we consume. Kept local so the file
// carries no OpenCode dependency; widen only as needed.
interface TuiLocationRef {
  directory?: string;
}

interface TuiEvent {
  type: string;
  location?: TuiLocationRef | undefined;
  data?: unknown;
  [key: string]: unknown;
}

interface TuiContext {
  location?: TuiLocationRef | undefined;
  ui?: {
    router?: {
      current(): { type: string; sessionID?: string } | undefined;
    };
  };
  data: {
    listen(handler: (event: { details: TuiEvent }) => void): () => void;
    location: {
      default(): TuiLocationRef | undefined;
    };
    session: {
      root(sessionID: string): string;
      get?(sessionID: string): { title?: string } | undefined;
      status?(sessionID: string): "idle" | "running";
    };
  };
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

export default {
  id: "coding-agents-tmux.tui",
  setup(context: TuiContext) {
    const paneId = normalizeEnvValue(process.env.TMUX_PANE);
    // The pane's own location. `context.location` is the TUI's bound location;
    // fall back to the server's default location, NOT process.cwd() (the TUI
    // process cwd is unrelated to the project and previously leaked as "~").
    const paneDirectory =
      context.location?.directory ?? context.data.location.default()?.directory ?? null;
    const directory = paneDirectory ?? process.cwd();

    function rootOf(sessionId: string): string {
      try {
        return context.data.session.root(sessionId) || sessionId;
      } catch {
        return sessionId;
      }
    }

    function sessionStatusOf(sessionId: string | null): "idle" | "running" | null {
      if (!sessionId || !context.data.session.status) {
        return null;
      }
      try {
        return context.data.session.status(sessionId);
      } catch {
        return null;
      }
    }

    // The session this pane's TUI is currently displaying. A resumed session
    // (opencode --continue, or any already-open session) lands here; a fresh
    // start lands on `home`. This is the primary identity + seed source.
    function currentRouteSessionId(): string | null {
      try {
        const route = context.ui?.router?.current?.();
        return route && route.type === "session" && route.sessionID ? route.sessionID : null;
      } catch {
        return null;
      }
    }

    // Tracks the session family this pane owns. Seeded from the current route;
    // updated as the route changes (session switch) or the session is deleted.
    let currentSessionId: string | null = currentRouteSessionId();

    // Seed a resumed session so it shows idle/running immediately instead of the
    // "new" plus-glyph. Only a `home` route (no current session) stays "new".
    const seededStatus = sessionStatusOf(currentSessionId);
    let seededTitle: string | undefined;
    if (currentSessionId && context.data.session.get) {
      try {
        seededTitle = context.data.session.get(currentSessionId)?.title;
      } catch {
        seededTitle = undefined;
      }
    }

    const state = createInitialState({
      paneId,
      target: resolveTmuxPaneTarget(paneId),
      directory,
      title: seededTitle ?? directory.split("/").filter(Boolean).pop() ?? "OpenCode session",
      sessionId: currentSessionId,
      ...(seededStatus ? { status: seededStatus } : {}),
    });

    const latch = new PromptLatch();

    // `context.data.listen` is a firehose of EVERY session across EVERY location.
    // Filter to this pane's work by the current route's session family (primary)
    // plus a location guard (secondary). Following the route means a session
    // switch or resume is tracked automatically without fragile pin/re-election.
    function refreshCurrentSession(): void {
      const routeSession = currentRouteSessionId();
      if (routeSession) {
        currentSessionId = routeSession;
      }
    }

    function eventBelongsToPane(event: PluginEvent, sessionId: string | null): boolean {
      const eventDir = (event.location as TuiLocationRef | undefined)?.directory;

      // Location guard: an event that declares a *different* directory is never
      // ours. Events without a location field pass and are disambiguated below.
      if (paneDirectory && eventDir && eventDir !== paneDirectory) {
        return false;
      }

      if (!sessionId) {
        // No session identity to leak; accept (already location-filtered).
        return true;
      }

      // Follow the current route: adopt it if we have one and none tracked yet.
      if (!currentSessionId) {
        refreshCurrentSession();
      }

      if (currentSessionId) {
        return rootOf(sessionId) === rootOf(currentSessionId);
      }

      // No route session (home) and a location match (or unknown pane dir):
      // accept and adopt, so a brand-new session started in this pane is tracked.
      if (!paneDirectory || eventDir === paneDirectory) {
        currentSessionId = rootOf(sessionId);
        return true;
      }

      return false;
    }

    // Root/child scoping relative to the pane's current session family. The
    // family root is "root"; any other session (a subagent/child) is "child".
    function classifyScope(sessionId: string | null): "root" | "child" | "unknown" {
      if (!sessionId) {
        return "unknown";
      }
      const familyRoot = currentSessionId ? rootOf(currentSessionId) : rootOf(sessionId);
      return sessionId === familyRoot ? "root" : "child";
    }

    function persist(): void {
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

    const unsubscribe = context.data.listen(({ details }) => {
      const event = details as PluginEvent;

      // Keep the tracked session in step with the TUI route (session switches).
      refreshCurrentSession();

      const sessionId = getEventSessionId(event);

      if (!eventBelongsToPane(event, sessionId)) {
        return;
      }

      applyDerivedStatus({
        state,
        event,
        latch,
        classifyScope,
        authoritativeStatus: sessionStatusOf,
      });

      // Re-elect on deletion of the tracked session so the pane can adopt the
      // next session (via the route) instead of going deaf.
      if (
        event.type === "session.deleted" &&
        sessionId &&
        currentSessionId &&
        rootOf(sessionId) === rootOf(currentSessionId)
      ) {
        currentSessionId = null;
      }

      persist();
      scheduleTmuxStatusRefresh();
    });

    persist();
    scheduleTmuxStatusRefresh();

    return () => {
      unsubscribe();
      if (tmuxRefreshTimer) {
        clearTimeout(tmuxRefreshTimer);
        tmuxRefreshTimer = null;
      }
    };
  },
};
