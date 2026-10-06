import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  buildHookStateIndex,
  getHookState,
  mergeHookAndPreview,
  persistHookState,
  readHookStates,
  DEFAULT_HOOK_TRANSITION_FRESHNESS_MS,
  DEFAULT_HOOK_WAIT_FRESHNESS_MS,
  DEFAULT_TRANSITION_EVENTS,
  type HookClassification,
  type HookMergeConfig,
  type StateDirConfig,
} from "./hook-state.ts";
import { countChoiceLines } from "./preview-text.ts";
import { capturePanePreview } from "./tmux.ts";
import { getPreferredStateDir } from "../naming.ts";
import type {
  DiscoveredPane,
  PaneRuntimeSummary,
  RuntimeInfo,
  SessionMatch,
  TmuxPane,
} from "../types.ts";

const KIRO_SESSION_TITLE_FALLBACK = "Kiro CLI session";
const KIRO_STATE_DIR: StateDirConfig = {
  env: "CODING_AGENTS_TMUX_KIRO_STATE_DIR",
  subdirectory: "kiro-state",
};

export function getKiroStateDir(): string {
  return getPreferredStateDir(KIRO_STATE_DIR);
}

export interface KiroInstallResult {
  hooksPath: string;
}

interface KiroHookPayload {
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  session_id?: string;
  tool_name?: string;
}

function getKiroHome(): string {
  return process.env.KIRO_HOME ?? join(homedir(), ".kiro");
}

function getKiroHooksPath(): string {
  return join(getKiroHome(), "hooks", "coding-agents-tmux.json");
}

// Pane-derived pseudo-session so a detected Kiro pane with no hook state still
// renders a session (directory + title) instead of "(unmatched)".
function createKiroPaneSession(pane: TmuxPane): SessionMatch {
  const title = basename(pane.currentPath) || pane.paneTitle.trim() || "Kiro CLI";

  return {
    id: `kiro:${pane.target}`,
    directory: pane.currentPath,
    title,
    timeUpdated: Date.now(),
  };
}

// --- Kiro V3 TUI chrome classification ---------------------------------------
//
// Kiro V3 (`kiro-cli --v3`) draws fixed chrome at the bottom of the pane that
// states its own status, so we read that instead of guessing from the
// conversation text above it (which the V2 heuristics below do, and which
// misreads a reply containing a list or a trailing "?"). When no V3 chrome is
// detected we fall through to the V2 heuristics, which were written for V2.
//
// Observed chrome (bottom-anchored; horizontal rules are runs of ─):
//   idle:    "Default · auto · ◔ 3%"  then  "› ask a question…"
//   running: input line "› Kiro is working · 1s · Type to steer …"
//            or "(esc to cancel)" above the final rule
//   overlay: a navigate footer "esc to close · ↑↓ to navigate · ↵ to select …"
//            as the last line (tool approval, or a user-opened menu like /model)

// Status bar Kiro renders directly above the input line, e.g.
// "Default · auto · ◔ 3%". Two "·" separators and a trailing "N%".
const KIRO_V3_STATUS_BAR = /·.*·.*\d+%/;
// The input prompt line starts with the "›" glyph.
const KIRO_V3_INPUT_PROMPT = /^›/;
// Overlay footer shown while a selectable overlay (approval / menu) is open.
const KIRO_V3_OVERLAY_FOOTER = /esc to close\b.*(?:navigate|select)/i;
// Running markers.
const KIRO_V3_WORKING = /kiro is working\s*·/i;
const KIRO_V3_CANCEL = /\(?\besc to cancel\b\)?/i;

function detectKiroV3Chrome(
  lines: string[],
): Pick<RuntimeInfo, "activity" | "detail" | "status"> | null {
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);

  if (nonEmptyLines.length === 0) {
    return null;
  }

  const lastLine = nonEmptyLines.at(-1) ?? "";
  const recentText = nonEmptyLines.slice(-20).join("\n");
  const recentLower = recentText.toLowerCase();
  const hasInputPrompt = nonEmptyLines.some((line) => KIRO_V3_INPUT_PROMPT.test(line));
  const hasStatusBar = nonEmptyLines.some((line) => KIRO_V3_STATUS_BAR.test(line));

  // A selectable overlay (tool approval, or a user-opened menu such as /model)
  // blocks on input. Like Claude's interactive dialogs, these count as waiting.
  if (KIRO_V3_OVERLAY_FOOTER.test(lastLine)) {
    const isApproval = recentLower.includes("requires approval");
    return {
      activity: "busy",
      detail: isApproval
        ? "Kiro is waiting for tool approval"
        : "Kiro is waiting on an interactive overlay",
      status: "waiting-question",
    };
  }

  // Without the V3 status bar and input line this is not a recognizable V3
  // screen — let the V2 heuristics decide.
  if (!hasStatusBar || !hasInputPrompt) {
    return null;
  }

  const inputLine =
    [...nonEmptyLines].reverse().find((line) => KIRO_V3_INPUT_PROMPT.test(line)) ?? "";

  if (KIRO_V3_WORKING.test(inputLine) || KIRO_V3_CANCEL.test(recentText)) {
    return {
      activity: "busy",
      detail: "Kiro is working",
      status: "running",
    };
  }

  return {
    activity: "idle",
    detail: "Kiro is idle between turns",
    status: "idle",
  };
}

function classifyKiroPreview(
  lines: string[],
): Pick<RuntimeInfo, "activity" | "detail" | "status"> | null {
  const v3 = detectKiroV3Chrome(lines);

  if (v3) {
    return v3;
  }

  return classifyKiroV2Preview(lines);
}

// V2 heuristics: Kiro V2 does not render the V3 chrome, so fall back to scanning
// the recent conversation text for an obvious prompt. Only reached when no V3
// chrome is detected.
function classifyKiroV2Preview(
  lines: string[],
): Pick<RuntimeInfo, "activity" | "detail" | "status"> | null {
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);
  const recentLines = nonEmptyLines.slice(-10);
  const recentText = recentLines.join("\n");
  const recentLower = recentText.toLowerCase();
  const lastLine = recentLines.at(-1) ?? "";

  if (
    countChoiceLines(recentText) >= 2 ||
    ["permission", "allow", "deny"].every((fragment) => recentLower.includes(fragment)) ||
    ["approval", "trust this", "yes", "no"].every((fragment) => recentLower.includes(fragment))
  ) {
    return {
      activity: "busy",
      detail: "Kiro appears to be waiting for a multiple-choice response",
      status: "waiting-question",
    };
  }

  if (
    /\?\s*$/.test(lastLine) ||
    ["would you like", "do you want", "should i", "please confirm", "what would you like"].some(
      (fragment) => recentLower.includes(fragment),
    )
  ) {
    return {
      activity: "busy",
      detail: "Kiro appears to be waiting for user input",
      status: "waiting-input",
    };
  }

  return null;
}

async function loadKiroPreview(
  target: TmuxPane["target"],
): Promise<Pick<RuntimeInfo, "activity" | "detail" | "status"> | null> {
  try {
    return classifyKiroPreview(await capturePanePreview(target, 24));
  } catch {
    return null;
  }
}

// Kiro V3 hook events → runtime state. No hook fires while a tool-approval
// prompt is on screen, so "waiting" always comes from the preview; Stop is idle
// (like Claude), never waiting.
function classifyKiroHookPayload(payload: KiroHookPayload): HookClassification {
  const eventName = payload.hook_event_name ?? "unknown";

  switch (eventName) {
    case "SessionStart":
      return {
        activity: "idle",
        detail: "Kiro session started",
        sourceEventType: eventName,
        status: "new",
      };
    case "UserPromptSubmit":
      return {
        activity: "busy",
        detail: "Kiro is handling a user prompt",
        sourceEventType: eventName,
        status: "running",
      };
    case "PreToolUse":
      return {
        activity: "busy",
        detail: `Kiro is running ${payload.tool_name ?? "a tool"}`,
        sourceEventType: eventName,
        status: "running",
      };
    case "PostToolUse":
      return {
        activity: "busy",
        detail: `Kiro is processing ${payload.tool_name ?? "tool"} output`,
        sourceEventType: eventName,
        status: "running",
      };
    case "Stop":
      return {
        activity: "idle",
        detail: "Kiro is idle between turns",
        sourceEventType: eventName,
        status: "idle",
      };
    default:
      return {
        activity: "unknown",
        detail: `Unhandled Kiro hook event: ${eventName}`,
        sourceEventType: eventName,
        status: "unknown",
      };
  }
}

export function persistKiroHookState(rawInput: string): Promise<void> {
  return persistHookState<KiroHookPayload>({
    rawInput,
    stateDir: KIRO_STATE_DIR,
    classify: classifyKiroHookPayload,
    titleFallback: KIRO_SESSION_TITLE_FALLBACK,
    deleteOnEvents: ["SessionEnd"],
  });
}

const KIRO_MERGE_CONFIG: HookMergeConfig = {
  provider: "kiro",
  idPrefix: "kiro",
  hookSource: "kiro-hook",
  previewSource: "kiro-preview",
  // Kiro keeps upstream's conservative default: a live process with no stronger
  // signal is assumed idle, not running.
  commandSource: "kiro-command",
  commandActivity: "idle",
  commandStatus: "idle",
  commandDetail: (pane) =>
    `detected ${pane.currentCommand} process in tmux pane; assuming idle without stronger Kiro state`,
  fallbackSession: createKiroPaneSession,
  waitFreshnessMs: DEFAULT_HOOK_WAIT_FRESHNESS_MS,
  transitionFreshnessMs: DEFAULT_HOOK_TRANSITION_FRESHNESS_MS,
  transitionEvents: DEFAULT_TRANSITION_EVENTS,
};

export async function attachRuntimeWithKiro(
  panes: DiscoveredPane[],
  index = buildHookStateIndex(readHookStates(KIRO_STATE_DIR)),
): Promise<PaneRuntimeSummary[]> {
  return Promise.all(
    panes.map(async (entry) => {
      const hookState = getHookState(index, entry.pane);
      const preview = await loadKiroPreview(entry.pane.target);
      return mergeHookAndPreview(entry, hookState, preview, KIRO_MERGE_CONFIG);
    }),
  );
}

// Kiro V3 reads every file under <KIRO_HOME>/hooks, so we own one file outright
// and overwrite it on install — no settings merge needed.
function buildKiroHooks(command: string) {
  const action = { type: "command" as const, command };
  const hook = (name: string) => ({ name: `coding-agents-tmux-${name}`, trigger: name, action });

  return {
    version: "v1" as const,
    hooks: [
      hook("SessionStart"),
      hook("UserPromptSubmit"),
      hook("PreToolUse"),
      hook("PostToolUse"),
      hook("Stop"),
      hook("SessionEnd"),
    ],
  };
}

export function buildKiroHooksTemplate(command: string): string {
  return `${JSON.stringify(buildKiroHooks(command), null, 2)}\n`;
}

export function installKiroIntegration(command: string): KiroInstallResult {
  const hooksPath = getKiroHooksPath();

  mkdirSync(join(getKiroHome(), "hooks"), { recursive: true });
  writeFileSync(hooksPath, buildKiroHooksTemplate(command), "utf8");

  return { hooksPath };
}
