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
  type TabListEntry,
  type WaitingStatus,
  applyDerivedStatus,
  createInitialState,
  getEventSessionId,
  getPluginStateDir,
  normalizeEnvValue,
  snapshotTabs,
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
    tabs?: {
      enabled(): boolean;
      list(): TabListEntry[];
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
      family?(sessionID: string): string[];
      permission?: { list(sessionID: string): unknown[] | undefined };
      form?: { list(sessionID: string): unknown[] | undefined };
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

    // Session tabs are on when the TUI exposes `ui.tabs` and reports enabled.
    // When off (or on V1), every tab-aware branch below is skipped and the file
    // takes the exact pre-tabs code path.
    function tabsEnabled(): boolean {
      try {
        return Boolean(context.ui?.tabs?.enabled?.());
      } catch {
        return false;
      }
    }

    // Latest `ui.tabs.list()` snapshot, re-read per event. Empty when tabs are
    // disabled so callers can treat "no tabs" uniformly.
    function readTabList(): TabListEntry[] {
      if (!tabsEnabled()) {
        return [];
      }
      try {
        return context.ui?.tabs?.list?.() ?? [];
      } catch {
        return [];
      }
    }

    // Every session id in a tab's family, so an event for a subagent of any tab
    // is still recognized as belonging to this pane. Mirrors the TUI's own
    // `family(id) || [id]` fallback: `session.family()` returns [] for a session
    // with no recorded children, which must still resolve to itself.
    function familyOf(sessionId: string): string[] {
      const family = context.data.session.family;
      if (!family) {
        return [sessionId];
      }
      try {
        const members = family(sessionId);
        return members && members.length > 0 ? members : [sessionId];
      } catch {
        return [sessionId];
      }
    }

    function listHasPending(
      probe: { list(sessionID: string): unknown[] | undefined } | undefined,
      sessionId: string,
    ): boolean {
      if (!probe) {
        return false;
      }
      try {
        return (probe.list(sessionId)?.length ?? 0) > 0;
      } catch {
        return false;
      }
    }

    // Re-derive the attention *kind* for a tab flagged `attention`. The plugin
    // boundary flattens it to a boolean, so walk the tab's family and check the
    // (global, event-fed) permission/form stores: a pending permission ⇒
    // waiting-input, else a pending form ⇒ waiting-question. Matches the TUI's
    // own internal derivation order.
    function resolveTabAttention(sessionId: string): WaitingStatus | null {
      for (const member of familyOf(sessionId)) {
        if (listHasPending(context.data.session.permission, member)) {
          return "waiting-input";
        }
      }
      for (const member of familyOf(sessionId)) {
        if (listHasPending(context.data.session.form, member)) {
          return "waiting-question";
        }
      }
      return null;
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

    // Membership of the pane's own (focused) session family, following the
    // route. This governs the top-level identity/status fields.
    function eventBelongsToPane(event: PluginEvent, sessionId: string | null): boolean {
      const eventDir = (event.location as TuiLocationRef | undefined)?.directory;

      // Location guard: an event that declares a *different* directory is never
      // ours. Events without a location field pass and are disambiguated below.
      // Skipped when tabs are enabled: tabs can span directories (`scope:
      // "global"`), so a foreign-directory tab is still ours — membership is
      // then decided by the tab list (see eventBelongsToAnyTab).
      if (!tabsEnabled() && paneDirectory && eventDir && eventDir !== paneDirectory) {
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

    // Whether an event belongs to *any* listed tab's family. Used only when
    // tabs are enabled: a background-tab event must trigger a persist so the
    // roll-up refreshes, even though it does not own the top-level identity.
    function eventBelongsToAnyTab(sessionId: string | null): boolean {
      if (!sessionId) {
        return false;
      }
      const eventRoot = rootOf(sessionId);
      return readTabList().some((tab) => rootOf(tab.sessionID) === eventRoot);
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

    // Refresh `state.tabs` from the latest tab list, or clear it when tabs are
    // disabled. A pure projection — never accumulated — so a closed tab drops on
    // the next event.
    function refreshTabSnapshot(): void {
      const list = readTabList();
      if (list.length === 0) {
        delete state.tabs;
        return;
      }
      state.tabs = snapshotTabs(list, resolveTabAttention);
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

      const ownsIdentity = eventBelongsToPane(event, sessionId);
      // A background-tab event does not own the identity but must still refresh
      // the roll-up. Only relevant when tabs are enabled.
      const belongsToTab = !ownsIdentity && tabsEnabled() && eventBelongsToAnyTab(sessionId);

      if (!ownsIdentity && !belongsToTab) {
        return;
      }

      // Only the focused session's events write the top-level identity/status.
      if (ownsIdentity) {
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
      }

      refreshTabSnapshot();
      persist();
      scheduleTmuxStatusRefresh();
    });

    refreshTabSnapshot();
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
