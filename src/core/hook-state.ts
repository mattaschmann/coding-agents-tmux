// Shared hook-backed runtime-state plumbing for agents whose CLIs emit
// lifecycle hooks (Claude, Codex, Kiro). Owns the per-pane state file format,
// the persist path (stdin payload → classified state file), the newest-wins
// state index + pane/target/directory lookup, and the generic hook-vs-preview
// merge (`mergeHookAndPreview`). Claude and Kiro drive their
// `attachRuntimeWith*` through that merge; Codex uses the persist/index helpers
// here but keeps its own reader in `opencode.ts`.
//
// Agent-specific logic stays in the agent module and is injected here:
// payload → status classification, the live pane-preview classifier, the
// session-title fallback, freshness windows, and the RuntimeSource labels.
//
// Over the ~350-line module guideline by design: this is one cohesive concern
// (the hook-state lifecycle) shared across three agents, and splitting persist
// from the reader/merge would scatter a single contract across files.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { notifyIntegration } from "./notifications.ts";
import { getPreferredStateDir, getStateDirCandidates } from "../naming.ts";
import { runCommand } from "../runtime.ts";
import type {
  DiscoveredPane,
  PaneRuntimeSummary,
  RuntimeInfo,
  RuntimeStatus,
  SessionMatch,
  TmuxPane,
} from "../types.ts";

// Per-pane state written by a hook invocation. `transcriptPath` is only set by
// agents that report one (Claude); others leave it undefined.
export interface HookStateFile {
  activity?: RuntimeInfo["activity"];
  detail?: string;
  directory?: string;
  paneId?: string | null;
  sessionId?: string;
  sourceEventType?: string;
  status?: RuntimeStatus;
  target?: string | null;
  title?: string;
  transcriptPath?: string | null;
  updatedAt?: number;
  version?: number;
}

// A classifier's verdict for a single hook payload.
export interface HookClassification {
  activity: RuntimeInfo["activity"];
  detail: string;
  sourceEventType: string;
  status: RuntimeStatus;
}

export interface HookStateIndex {
  exactPaneIdMatches: Map<string, HookStateFile>;
  exactTargetMatches: Map<string, HookStateFile>;
  statesByDirectory: Map<string, HookStateFile[]>;
}

// Identifies an agent's state directory. `env` overrides the default location;
// `subdirectory` is the folder name under the product state root.
export interface StateDirConfig {
  env: string;
  subdirectory: string;
}

// Default hook-vs-preview freshness windows, shared by agents that follow the
// Claude merge policy. A fresh "waiting" hook is trusted over an idle preview
// for the wait window; a fresh transition hook is trusted over the preview for
// the (shorter) transition window right after the pane event, before redraw.
export const DEFAULT_HOOK_WAIT_FRESHNESS_MS = 60_000;
export const DEFAULT_HOOK_TRANSITION_FRESHNESS_MS = 3_000;
// Hook events that fire just before the pane redraws, so a fresh one briefly
// out-ranks the stale preview.
export const DEFAULT_TRANSITION_EVENTS: ReadonlySet<string> = new Set(["UserPromptSubmit", "Stop"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeEnvValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// Pane-id-keyed file when the hook ran inside tmux; directory-keyed otherwise.
export function toHookStateFileName(input: { directory: string; paneId: string | null }): string {
  if (input.paneId) {
    return `pane-${Buffer.from(input.paneId).toString("hex")}.json`;
  }

  return `cwd-${Buffer.from(input.directory).toString("hex")}.json`;
}

export async function resolveTmuxPaneTarget(paneId: string | null): Promise<string | null> {
  if (!paneId) {
    return null;
  }

  try {
    const { exitCode, stdoutText } = await runCommand([
      "tmux",
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{session_name}:#{window_index}.#{pane_index}",
    ]);

    if (exitCode !== 0) {
      return null;
    }

    const target = stdoutText.trim();
    return target ? target : null;
  } catch {
    return null;
  }
}

export function readHookStateFile(filePath: string): HookStateFile | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as HookStateFile;
  } catch {
    return null;
  }
}

export function sessionTitleFromDirectory(
  directory: string,
  existing: HookStateFile | null,
  fallback: string,
): string {
  if (existing?.title) {
    return existing.title;
  }

  const name = basename(directory);
  return name ? name : fallback;
}

// Minimal hook payload shape shared by persist. Agents cast their richer
// payload to this for the fields persist itself needs.
interface BaseHookPayload {
  cwd?: string;
  hook_event_name?: string;
  session_id?: string;
}

export interface PersistHookStateOptions<Payload extends BaseHookPayload> {
  rawInput: string;
  stateDir: StateDirConfig;
  // Classify a parsed payload into a status verdict.
  classify: (payload: Payload) => HookClassification;
  // Fallback session title when none exists and the directory basename is empty.
  titleFallback: string;
  // Hook events that delete the state file instead of updating it (e.g. SessionEnd).
  deleteOnEvents?: readonly string[];
  // Extra fields merged into the persisted state (payload value preferred, else existing).
  extraFields?: (payload: Payload, existing: HookStateFile | null) => Record<string, unknown>;
}

function resolveStateDir(config: StateDirConfig): string {
  return getPreferredStateDir(config);
}

// Parse one hook payload from stdin and write (or delete) the pane's state file.
export async function persistHookState<Payload extends BaseHookPayload>(
  options: PersistHookStateOptions<Payload>,
): Promise<void> {
  const payload = JSON.parse(options.rawInput) as Payload;
  const directory = payload.cwd?.trim() || process.cwd();
  const paneId = normalizeEnvValue(process.env.TMUX_PANE);
  const stateDir = resolveStateDir(options.stateDir);
  const filePath = join(stateDir, toHookStateFileName({ directory, paneId }));

  if (options.deleteOnEvents?.includes(payload.hook_event_name ?? "")) {
    if (!existsSync(filePath)) {
      return;
    }

    unlinkSync(filePath);
    await notifyIntegration();
    return;
  }

  const existing = readHookStateFile(filePath);
  const classified = options.classify(payload);
  const sessionId = payload.session_id?.trim() || existing?.sessionId;
  const extra = options.extraFields?.(payload, existing) ?? {};

  const nextState: HookStateFile = {
    version: 1,
    paneId,
    target: (await resolveTmuxPaneTarget(paneId)) ?? existing?.target ?? null,
    directory,
    title: sessionTitleFromDirectory(directory, existing, options.titleFallback),
    activity: classified.activity,
    status: classified.status,
    detail: classified.detail,
    updatedAt: Date.now(),
    sourceEventType: classified.sourceEventType,
    ...(sessionId ? { sessionId } : {}),
    ...extra,
  };

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(nextState, null, 2), "utf8");
  await notifyIntegration();
}

export function readHookStates(stateDir: StateDirConfig): HookStateFile[] {
  return getStateDirCandidates(stateDir)
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => join(dir, entry))
        .map((filePath) => readHookStateFile(filePath))
        .filter((state): state is HookStateFile => Boolean(state?.directory)),
    );
}

function stateUpdatedAt(state: HookStateFile): number {
  return state.updatedAt ?? 0;
}

function pickNewerState(
  current: HookStateFile | undefined,
  candidate: HookStateFile,
): HookStateFile {
  if (!current || stateUpdatedAt(candidate) > stateUpdatedAt(current)) {
    return candidate;
  }

  return current;
}

export function buildHookStateIndex(states: HookStateFile[]): HookStateIndex {
  const exactPaneIdMatches = new Map<string, HookStateFile>();
  const exactTargetMatches = new Map<string, HookStateFile>();
  const statesByDirectory = new Map<string, HookStateFile[]>();

  for (const state of states) {
    const directory = state.directory;

    if (!directory) {
      continue;
    }

    const directoryStates = statesByDirectory.get(directory) ?? [];
    directoryStates.push(state);
    statesByDirectory.set(directory, directoryStates);

    if (state.paneId) {
      exactPaneIdMatches.set(
        state.paneId,
        pickNewerState(exactPaneIdMatches.get(state.paneId), state),
      );
    }

    if (state.target) {
      exactTargetMatches.set(
        state.target,
        pickNewerState(exactTargetMatches.get(state.target), state),
      );
    }
  }

  return { exactPaneIdMatches, exactTargetMatches, statesByDirectory };
}

function matchesStateDirectory(
  state: HookStateFile | undefined,
  pane: TmuxPane,
): state is HookStateFile {
  return Boolean(state?.directory && state.directory === pane.currentPath);
}

export function getExactHookState(index: HookStateIndex, pane: TmuxPane): HookStateFile | null {
  const targetState = index.exactTargetMatches.get(pane.target);

  if (matchesStateDirectory(targetState, pane)) {
    return targetState;
  }

  const paneIdState = index.exactPaneIdMatches.get(pane.paneId);

  if (matchesStateDirectory(paneIdState, pane)) {
    return paneIdState;
  }

  return null;
}

export function getDirectoryFallbackHookState(
  index: HookStateIndex,
  pane: TmuxPane,
): HookStateFile | null {
  const states = index.statesByDirectory.get(pane.currentPath) ?? [];

  if (states.length !== 1) {
    return null;
  }

  return states[0] ?? null;
}

export function getHookState(index: HookStateIndex, pane: TmuxPane): HookStateFile | null {
  return getExactHookState(index, pane) ?? getDirectoryFallbackHookState(index, pane);
}

export function toHookSessionMatch(state: HookStateFile, idPrefix: string): SessionMatch | null {
  if (!state.directory || !state.title) {
    return null;
  }

  return {
    id: state.sessionId ?? `${idPrefix}:${state.directory}`,
    directory: state.directory,
    title: state.title,
    timeUpdated: state.updatedAt ?? Date.now(),
  };
}

// A preview classifier's verdict. `null` means the pane could not be read.
export type PreviewClassification = Pick<RuntimeInfo, "activity" | "detail" | "status">;

export interface HookMergeConfig {
  provider: RuntimeInfo["match"]["provider"];
  idPrefix: string;
  // RuntimeSource used when the hook state is authoritative.
  hookSource: RuntimeInfo["source"];
  // RuntimeSource used when the live preview is authoritative.
  previewSource: RuntimeInfo["source"];
  // RuntimeSource + verdict used when the preview is unreadable and no hook state exists.
  commandSource: RuntimeInfo["source"];
  commandActivity: RuntimeInfo["activity"];
  commandStatus: RuntimeStatus;
  commandDetail: (pane: TmuxPane) => string;
  // Optional session used when no hook-state session is available (e.g. a
  // pane-derived pseudo-session). Lets agents keep a session on the preview and
  // command paths even without a hook state file.
  fallbackSession?: (pane: TmuxPane) => SessionMatch | null;
  // Trust a fresh "waiting" hook state over an idle preview for this long.
  waitFreshnessMs: number;
  // Trust a fresh transition hook state over the preview for this long.
  transitionFreshnessMs: number;
  // Hook events whose fresh state should override a non-waiting preview.
  transitionEvents: ReadonlySet<string>;
}

function buildRuntimeInfo(input: {
  activity: RuntimeInfo["activity"];
  status: RuntimeStatus;
  source: RuntimeInfo["source"];
  strategy: RuntimeInfo["match"]["strategy"];
  provider: RuntimeInfo["match"]["provider"];
  heuristic: boolean;
  session: SessionMatch | null;
  detail: string;
}): RuntimeInfo {
  return {
    activity: input.activity,
    status: input.status,
    source: input.source,
    match: {
      strategy: input.strategy,
      provider: input.provider,
      heuristic: input.heuristic,
    },
    session: input.session,
    detail: input.detail,
  };
}

function classifyFromHookState(
  state: HookStateFile | null,
  config: HookMergeConfig,
  input: { detail: string; heuristic: boolean; strategy: RuntimeInfo["match"]["strategy"] },
): RuntimeInfo {
  if (!state?.directory) {
    return buildRuntimeInfo({
      activity: "unknown",
      status: "unknown",
      source: "unmapped",
      strategy: "unmapped",
      provider: "none",
      heuristic: false,
      session: null,
      detail: input.detail,
    });
  }

  const status = state.status ?? "unknown";
  const activity =
    state.activity ??
    (status === "idle" || status === "new" ? "idle" : status === "unknown" ? "unknown" : "busy");

  return buildRuntimeInfo({
    activity,
    status,
    source: config.hookSource,
    strategy: input.strategy,
    provider: config.provider,
    heuristic: input.heuristic,
    session: toHookSessionMatch(state, config.idPrefix),
    detail: state.detail ?? input.detail,
  });
}

function isFreshWait(state: HookStateFile | null, config: HookMergeConfig): state is HookStateFile {
  if (!state?.status?.startsWith("waiting")) {
    return false;
  }

  return Date.now() - (state.updatedAt ?? 0) < config.waitFreshnessMs;
}

function isFreshTransition(
  state: HookStateFile | null,
  config: HookMergeConfig,
): state is HookStateFile {
  if (!state?.sourceEventType || !config.transitionEvents.has(state.sourceEventType)) {
    return false;
  }

  return Date.now() - (state.updatedAt ?? 0) < config.transitionFreshnessMs;
}

// Merge one pane's hook state with its live preview classification. The preview
// is the real-time source of truth; a fresh hook state wins only when it can
// assert a blocking wait or a just-happened transition the preview can't yet
// show. When the preview is unreadable, fall back to the hook state, then to a
// coarse command-detected verdict.
export function mergeHookAndPreview(
  entry: DiscoveredPane,
  hookState: HookStateFile | null,
  preview: PreviewClassification | null,
  config: HookMergeConfig,
): PaneRuntimeSummary {
  const session =
    (hookState ? toHookSessionMatch(hookState, config.idPrefix) : null) ??
    config.fallbackSession?.(entry.pane) ??
    null;

  if (preview) {
    if (preview.status === "idle" && isFreshWait(hookState, config)) {
      return {
        ...entry,
        runtime: classifyFromHookState(hookState, config, {
          detail: "matched fresh hook wait state",
          heuristic: false,
          strategy: "exact",
        }),
      };
    }

    if (preview.status !== "waiting-question" && isFreshTransition(hookState, config)) {
      return {
        ...entry,
        runtime: classifyFromHookState(hookState, config, {
          detail: "matched fresh hook transition",
          heuristic: false,
          strategy: "exact",
        }),
      };
    }

    const detail =
      preview.status === "waiting-question" && hookState?.detail?.includes("waiting")
        ? hookState.detail
        : preview.detail;

    return {
      ...entry,
      runtime: buildRuntimeInfo({
        activity: preview.activity,
        status: preview.status,
        source: config.previewSource,
        strategy: hookState ? "exact" : "unmapped",
        provider: config.provider,
        heuristic: true,
        session,
        detail,
      }),
    };
  }

  if (hookState) {
    return {
      ...entry,
      runtime: classifyFromHookState(hookState, config, {
        detail: "matched hook state (preview unavailable)",
        heuristic: true,
        strategy: "exact",
      }),
    };
  }

  return {
    ...entry,
    runtime: buildRuntimeInfo({
      activity: config.commandActivity,
      status: config.commandStatus,
      source: config.commandSource,
      strategy: "exact",
      provider: config.provider,
      heuristic: false,
      session,
      detail: config.commandDetail(entry.pane),
    }),
  };
}
