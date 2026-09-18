// Shared OpenCode plugin state derivation.
//
// This module owns the logic that turns OpenCode session events into the
// `pane-<hex>.json` state files the tmux reader consumes. It is imported by
// both plugin entrypoints:
//   - plugin/coding-agents-tmux.ts   (V1 loose-file, `.properties` event shape)
//   - plugin/coding-agents-tmux/tui.ts (V2 TUI plugin, `.data` event shape)
// and by src/core/opencode.ts, which reuses the low-level value probes for its
// own server-payload classification. Keeping it here — instead of duplicating
// it in the symlinked plugin file — is only possible under V2's directory
// package layout, which can `import` from src/.
//
// Pure and dependency-light: only node built-ins + src/naming.ts, so importing
// it never pulls the heavy sqlite reader into the plugin process.

import { Buffer } from "node:buffer";
import { join } from "node:path";
import { getPreferredStateDir } from "../naming.ts";

export const PLUGIN_STATE_ENV = "CODING_AGENTS_TMUX_STATE_DIR";
export const PLUGIN_STATE_SUBDIR = "plugin-state";

// Shared low-level probes (also consumed by src/core/opencode.ts).

export function getNestedValue(payload: unknown, path: string[]): unknown {
  let current: unknown = payload;

  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!(key in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

export function getStringCandidate(payload: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

export function getBooleanCandidate(payload: unknown, paths: string[][]): boolean | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === "boolean") {
      return value;
    }
  }

  return null;
}

export function getNumberCandidate(payload: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === "number") {
      return value;
    }
  }

  return null;
}

// Event-shape helpers. Candidate paths probe both the V1 `properties.*` shape
// and the V2 `data.*` shape, plus a few flat fallbacks, so the same derivation
// drives both entrypoints.

export type PluginEvent = { type: string; [key: string]: unknown };

export function getStatusCandidate(payload: unknown): string | null {
  return getStringCandidate(payload, [
    ["status"],
    ["session", "status"],
    ["state", "status"],
    ["properties", "status", "type"],
    ["properties", "part", "state", "status"],
    ["data", "status", "type"],
    ["data", "part", "state", "status"],
  ]);
}

export function getToolCandidate(payload: unknown): string | null {
  return getStringCandidate(payload, [
    ["tool"],
    ["session", "tool"],
    ["state", "tool"],
    ["properties", "part", "tool"],
    ["data", "part", "tool"],
  ]);
}

export function getOptionCount(payload: unknown): number | null {
  const candidates = [
    ["question", "options"],
    ["questions", "0", "options"],
    ["session", "question", "options"],
    ["session", "questions", "0", "options"],
    ["input", "questions", "0", "options"],
    ["state", "input", "questions", "0", "options"],
    ["session", "input", "questions", "0", "options"],
    ["properties", "questions", "0", "options"],
    ["properties", "part", "state", "input", "questions", "0", "options"],
    ["properties", "form", "fields", "0", "options"],
    ["data", "form", "fields", "0", "options"],
    ["data", "questions", "0", "options"],
    ["data", "part", "state", "input", "questions", "0", "options"],
  ];

  for (const path of candidates) {
    const value = getNestedValue(payload, path);
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return null;
}

const MISSING_REQUEST_ID = "__coding-agents-tmux:unknown-request__";
const MISSING_SESSION_ID = "__coding-agents-tmux:unknown-session__";

export function getRequestId(event: PluginEvent): string {
  const id = getStringCandidate(event, [
    ["properties", "id"],
    ["properties", "requestID"],
    ["data", "id"],
    ["data", "requestID"],
    ["data", "form", "id"],
  ]);
  return id ?? MISSING_REQUEST_ID;
}

export function getEventSessionId(event: PluginEvent): string | null {
  return getStringCandidate(event, [
    ["properties", "sessionID"],
    ["properties", "info", "id"],
    ["properties", "part", "sessionID"],
    ["data", "sessionID"],
    ["data", "info", "id"],
    ["data", "part", "sessionID"],
    ["data", "form", "sessionID"],
    ["session", "id"],
    ["sessionID"],
    ["sessionId"],
  ]);
}

export function getEventParentId(event: PluginEvent): string | null {
  return getStringCandidate(event, [
    ["properties", "info", "parentID"],
    ["properties", "parentID"],
    ["data", "parentID"],
    ["data", "info", "parentID"],
  ]);
}

export function getEventTitle(event: PluginEvent): string | null {
  return getStringCandidate(event, [
    ["properties", "info", "title"],
    ["data", "info", "title"],
    ["data", "title"],
    ["session", "title"],
  ]);
}

export function getEventDirectory(event: PluginEvent): string | null {
  return getStringCandidate(event, [
    ["properties", "info", "directory"],
    ["properties", "info", "path", "cwd"],
    ["data", "info", "directory"],
    ["data", "location", "directory"],
    ["session", "directory"],
  ]);
}

export function getEventUpdatedAt(event: PluginEvent): number | null {
  return getNumberCandidate(event, [
    ["timeUpdated"],
    ["session", "timeUpdated"],
    ["timestamp"],
    ["properties", "info", "time", "updated"],
    ["properties", "part", "state", "time", "start"],
    ["properties", "part", "state", "time", "end"],
    ["data", "info", "time", "updated"],
    ["data", "part", "state", "time", "start"],
    ["data", "part", "state", "time", "end"],
  ]);
}

// Waiting-status derivation.

export type WaitingStatus = "waiting-question" | "waiting-input";

function isWaitingStatus(status: string | null): boolean {
  return status === "waiting-question" || status === "waiting-input";
}

export function isQuestionLikeEvent(input: {
  status: string | null;
  tool: string | null;
  optionCount: number | null;
}): boolean {
  if (isWaitingStatus(input.status)) {
    return true;
  }

  if (input.tool === "question") {
    return true;
  }

  return input.optionCount !== null;
}

export function getWaitingStatus(input: {
  status: string | null;
  tool: string | null;
  optionCount: number | null;
}): WaitingStatus | null {
  if (input.status === "waiting-question") {
    return "waiting-question";
  }

  if (input.status === "waiting-input") {
    return "waiting-input";
  }

  if (input.optionCount !== null) {
    return input.optionCount > 0 ? "waiting-question" : "waiting-input";
  }

  if (isQuestionLikeEvent(input)) {
    return "waiting-input";
  }

  return null;
}

// Pending-prompt latch. Sticky record of unreplied permission/question prompts,
// keyed by `${sessionId}:${requestId}`. While non-empty, the pane is forced to
// the recorded waiting status so interleaved busy events cannot clobber it.
export class PromptLatch {
  private readonly pending = new Map<string, WaitingStatus>();

  key(sessionId: string | null, requestId: string): string {
    return `${sessionId ?? MISSING_SESSION_ID}:${requestId}`;
  }

  set(sessionId: string | null, requestId: string, status: WaitingStatus): void {
    this.pending.set(this.key(sessionId, requestId), status);
  }

  delete(sessionId: string | null, requestId: string): void {
    this.pending.delete(this.key(sessionId, requestId));
  }

  clearForSession(sessionId: string | null): void {
    const prefix = `${sessionId ?? MISSING_SESSION_ID}:`;
    for (const existing of this.pending.keys()) {
      if (existing.startsWith(prefix)) {
        this.pending.delete(existing);
      }
    }
  }

  clear(): void {
    this.pending.clear();
  }

  // Most recently latched waiting status, or null when nothing is pending.
  latest(): WaitingStatus | null {
    let latest: WaitingStatus | null = null;
    for (const value of this.pending.values()) {
      latest = value;
    }
    return latest;
  }
}

// Tracks root/child session identity so subagent (child) sessions cannot take
// ownership of the pane's reported identity. Fed only by session.* lifecycle
// events (parentID), since parentID on message info refers to a parent message,
// not a parent session.
//
// The V2 TUI plugin can instead use `context.data.session.root()`/`.family()`;
// this tracker is the fallback for the V1 loose-file entrypoint, which has no
// such API.
export class SessionScopeTracker {
  private parents = new Map<string, string | null>();
  private rootId: string | null = null;

  private static readonly MAX_WALK_DEPTH = 32;

  recordLifecycle(sessionId: string, parentId: string | null, deleted: boolean): void {
    if (deleted) {
      this.parents.delete(sessionId);
      if (this.rootId === sessionId) {
        this.rootId = null;
      }
      return;
    }

    this.parents.set(sessionId, parentId);

    if (parentId === null) {
      const ancestor = this.resolveAncestor(sessionId);
      if (this.rootId === null || this.rootId === sessionId || this.rootId === ancestor) {
        this.rootId = ancestor;
      }
      return;
    }

    if (this.rootId === sessionId) {
      this.rootId = this.resolveAncestor(sessionId);
    }
  }

  observe(sessionId: string): void {
    if (this.rootId === null && this.parents.get(sessionId) == null) {
      this.rootId = sessionId;
    }
  }

  classify(sessionId: string | null): "root" | "child" | "unknown" {
    if (!sessionId) {
      return "unknown";
    }
    if (this.rootId !== null && sessionId === this.rootId) {
      return "root";
    }
    return "child";
  }

  private resolveAncestor(sessionId: string): string {
    let current = sessionId;
    const seen = new Set<string>();
    for (let depth = 0; depth < SessionScopeTracker.MAX_WALK_DEPTH; depth += 1) {
      if (seen.has(current)) {
        return current;
      }
      seen.add(current);
      const parent = this.parents.get(current);
      if (parent === undefined || parent === null) {
        return current;
      }
      current = parent;
    }
    return current;
  }
}

// State shape + file layout (unchanged from the pre-V2 plugin, so the reader
// side needs no changes).

export type PluginActivity = "busy" | "idle" | "unknown";
export type PluginStatus =
  | "running"
  | "waiting-question"
  | "waiting-input"
  | "idle"
  | "new"
  | "unknown";

export interface PluginState {
  version: number;
  paneId: string | null;
  target: string | null;
  sessionId: string | null;
  directory: string;
  title: string;
  activity: PluginActivity;
  status: PluginStatus;
  detail: string;
  updatedAt: number;
  sourceEventType: string;
}

export const SESSION_LIFECYCLE_EVENTS = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.forked",
]);

// V2 streaming/activity events that mean "actively working" → running. V2 emits
// `session.status` only on transitions, so without these a pane that starts,
// streams, and settles would never leave its initial "new" status.
function isBusyActivityEvent(type: string): boolean {
  return (
    type === "session.execution.started" ||
    type.startsWith("session.text.") ||
    type.startsWith("session.step.") ||
    type.startsWith("session.tool.") ||
    type.startsWith("session.reasoning.") ||
    type.startsWith("session.compaction.")
  );
}

// `session.execution.succeeded`/`.interrupted` mark the end of an agent-loop
// execution. They do not themselves define idle — instead they trigger a
// re-read of the authoritative session status (see `authoritativeStatus` in
// applyDerivedStatus). They must never clear a pending prompt latch. Treated as
// status-relevant so the reconciliation runs; the actual idle/running verdict
// comes from the authoritative resolver, not the event name.
function isExecutionBoundaryEvent(type: string): boolean {
  return type === "session.execution.succeeded" || type === "session.execution.interrupted";
}

// Whether an event can affect pane status at all. Events outside this set
// (model.updated, catalog.updated, file.watcher.updated, session.viewed, ...)
// are ignored entirely — they must not bump updatedAt/sourceEventType, or an
// idle pane would look continuously "fresh" to the reader and distort cycle
// ordering.
function isStatusRelevantEvent(event: PluginEvent, derived: { waiting: boolean }): boolean {
  const type = event.type;
  return (
    SESSION_LIFECYCLE_EVENTS.has(type) ||
    type === "session.idle" ||
    type === "session.error" ||
    type === "session.execution.failed" ||
    type === "session.status" ||
    type === "permission.asked" ||
    type === "permission.replied" ||
    type === "question.asked" ||
    type === "question.replied" ||
    type === "question.rejected" ||
    type === "form.created" ||
    type === "form.replied" ||
    type === "form.cancelled" ||
    isBusyActivityEvent(type) ||
    isExecutionBoundaryEvent(type) ||
    derived.waiting
  );
}

export function getPluginStateDir(): string {
  return getPreferredStateDir({ env: PLUGIN_STATE_ENV, subdirectory: PLUGIN_STATE_SUBDIR });
}

export function toStateFileName(input: { directory: string; paneId: string | null }): string {
  if (input.paneId) {
    return `pane-${Buffer.from(input.paneId).toString("hex")}.json`;
  }

  return `cwd-${Buffer.from(input.directory).toString("hex")}.json`;
}

export function stateFilePath(state: Pick<PluginState, "directory" | "paneId">): string {
  return join(getPluginStateDir(), toStateFileName(state));
}

export function normalizeEnvValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// Core state machine. Given the current state, an event, and a way to classify
// a session as root/child, mutate `state` in place. Shared by both entrypoints;
// the per-runtime differences are `classifyScope` (V2: TUI session API, V1:
// SessionScopeTracker) and the optional `authoritativeStatus` resolver (V2 backs
// it with `data.session.status()`; V1 omits it and falls back to event-derived
// idle/running). The prompt latch is authoritative for waiting regardless.
export function applyDerivedStatus(input: {
  state: PluginState;
  event: PluginEvent;
  latch: PromptLatch;
  classifyScope: (sessionId: string | null) => "root" | "child" | "unknown";
  authoritativeStatus?: (sessionId: string | null) => "idle" | "running" | null;
}): void {
  const { state, event, latch, classifyScope, authoritativeStatus } = input;
  const sessionId = getEventSessionId(event);

  const eventScope = classifyScope(sessionId);
  const isChild = eventScope === "child";
  const childSuffix = isChild ? " (child session)" : "";

  const sessionTitle = getEventTitle(event);
  const sessionDirectory = getEventDirectory(event);
  const status = getStatusCandidate(event);
  const tool = getToolCandidate(event);
  const busy = getBooleanCandidate(event, [["busy"], ["session", "busy"], ["state", "busy"]]);
  const optionCount = getOptionCount(event);
  const updatedAt = getEventUpdatedAt(event);
  const waitingStatus = getWaitingStatus({ status, tool, optionCount });

  // Ignore events that cannot affect status — do not even touch the file, so
  // updatedAt/sourceEventType stay meaningful as "last real activity". A latched
  // prompt is the exception: any event must keep the pane pinned to waiting.
  if (
    !isStatusRelevantEvent(event, { waiting: waitingStatus !== null }) &&
    latch.latest() === null
  ) {
    return;
  }

  // Only a root-scoped session may take ownership of the pane's identity.
  if (!isChild) {
    if (sessionId) {
      state.sessionId = sessionId;
    }

    if (sessionTitle) {
      state.title = sessionTitle;
    }

    if (sessionDirectory) {
      state.directory = sessionDirectory;
    }
  }

  state.updatedAt = updatedAt ?? Date.now();
  state.sourceEventType = event.type;

  // `session.idle` for a root session: V1 treats it as authoritative (clear the
  // latch and idle). V2 passes an authoritative resolver — trust it: idle only
  // when the session really settled, and keep a pending prompt latched (a stray
  // idle hint must not discharge an open prompt). A child idle never idles.
  if (event.type === "session.idle") {
    if (isChild) {
      latch.clearForSession(sessionId);
      const remaining = latch.latest();
      if (remaining) {
        state.activity = "busy";
        state.status = remaining;
        state.detail = `${event.type} kept latched waiting state${childSuffix}`;
        return;
      }
      // Fall through to normal derivation without forcing idle.
    } else if (authoritativeStatus) {
      // V2: a pending prompt dominates; otherwise reconcile against real status.
      if (
        latch.latest() === null &&
        authoritativeStatus(state.sessionId ?? sessionId) !== "running"
      ) {
        state.activity = "idle";
        state.status = "idle";
        state.detail = `${event.type} event`;
        return;
      }
      // Prompt pending or still running — fall through.
    } else {
      // V1 fallback: session.idle is authoritative — clear everything and idle.
      latch.clear();
      state.activity = "idle";
      state.status = "idle";
      state.detail = `${event.type} event`;
      return;
    }
  }

  if (event.type === "session.error" || event.type === "session.execution.failed") {
    state.activity = "unknown";
    state.status = "unknown";
    state.detail = `${event.type} event${childSuffix}`;
    return;
  }

  if (
    event.type === "permission.asked" ||
    event.type === "question.asked" ||
    event.type === "form.created"
  ) {
    const forced =
      waitingStatus ?? (event.type === "permission.asked" ? "waiting-input" : "waiting-question");
    latch.set(sessionId, getRequestId(event), forced);
    state.activity = "busy";
    state.status = forced;
    state.detail = `${event.type} event${childSuffix}`;
    return;
  }

  if (
    event.type === "permission.replied" ||
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "form.replied" ||
    event.type === "form.cancelled"
  ) {
    latch.delete(sessionId, getRequestId(event));
    const remaining = latch.latest();

    if (remaining) {
      state.activity = "busy";
      state.status = remaining;
      state.detail = `${event.type} with pending prompt${childSuffix}`;
      return;
    }

    state.activity = "busy";
    state.status = "running";
    state.detail = `${event.type} event${childSuffix}`;
    return;
  }

  // Any other event while a prompt is latched keeps the pane waiting.
  const latched = latch.latest();
  if (latched) {
    state.activity = "busy";
    state.status = latched;
    state.detail = `${event.type} kept latched waiting state${childSuffix}`;
    return;
  }

  if (waitingStatus) {
    state.activity = "busy";
    state.status = waitingStatus;
    state.detail = `${event.type} waiting event${childSuffix}`;
    return;
  }

  // Authoritative reconciliation (V2): with no prompt pending, trust the TUI's
  // session status over event-name inference. This resolves execution-boundary
  // events (succeeded/interrupted) and any streaming event to the real state:
  // idle when the loop has settled, running while it works. Scoped to the pane's
  // own session so a child's boundary event cannot idle the root.
  if (authoritativeStatus) {
    const authoritative = authoritativeStatus(state.sessionId ?? sessionId);
    if (authoritative === "idle") {
      if (!isChild) {
        state.activity = "idle";
        state.status = "idle";
        state.detail = `${event.type} → authoritative idle`;
        return;
      }
      // Child event while root is authoritatively idle: leave as-is.
    } else if (authoritative === "running") {
      state.activity = "busy";
      state.status = "running";
      state.detail = `${event.type} → authoritative running${childSuffix}`;
      return;
    }
    // authoritative === null: fall through to event-derived heuristics.
  }

  // A child going idle must never idle the pane; only a root-scoped idle may.
  if (!isChild && (status === "idle" || busy === false)) {
    state.activity = "idle";
    state.status = "idle";
    state.detail = `${event.type} idle event`;
    return;
  }

  // V2 streaming/activity events and explicit running signals → busy.
  if (
    status === "running" ||
    status === "busy" ||
    busy === true ||
    event.type === "session.status" ||
    isBusyActivityEvent(event.type)
  ) {
    state.activity = "busy";
    state.status = "running";
    state.detail = `${event.type} running event${childSuffix}`;
    return;
  }
}

export function createInitialState(input: {
  paneId: string | null;
  target: string | null;
  directory: string;
  title: string;
  // Optional seed for a resumed session: the TUI already displays an existing
  // session, so the pane is idle/running (not "new"). Only `home` stays "new".
  sessionId?: string | null;
  status?: PluginStatus;
  activity?: PluginActivity;
}): PluginState {
  const status = input.status ?? "new";
  const activity = input.activity ?? (status === "idle" ? "idle" : "busy");
  const seeded = status !== "new";
  return {
    version: 2,
    paneId: input.paneId,
    target: input.target,
    sessionId: input.sessionId ?? null,
    directory: input.directory,
    title: input.title,
    activity: seeded ? activity : "idle",
    status,
    detail: seeded
      ? "plugin initialized; resumed session"
      : "plugin initialized; awaiting first session event",
    updatedAt: Date.now(),
    sourceEventType: "plugin.init",
  };
}
