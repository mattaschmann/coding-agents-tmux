import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  buildManagedHookCommand,
  mergeManagedHooks,
  type ManagedHooksDocument,
} from "./hook-install.ts";
import {
  buildHookStateIndex,
  getHookState,
  isRecord,
  mergeHookAndPreview,
  persistHookState,
  readHookStates,
  DEFAULT_HOOK_TRANSITION_FRESHNESS_MS,
  DEFAULT_HOOK_WAIT_FRESHNESS_MS,
  DEFAULT_TRANSITION_EVENTS,
  type HookClassification,
  type HookMergeConfig,
  type HookStateFile,
  type HookStateIndex,
  type PreviewClassification,
  type StateDirConfig,
} from "./hook-state.ts";
import { countChoiceLines } from "./preview-text.ts";
import { capturePanePreview } from "./tmux.ts";
import { getPreferredStateDir } from "../naming.ts";
import type { DiscoveredPane, PaneRuntimeSummary, RuntimeStatus, TmuxPane } from "../types.ts";

export type ClaudeStateFile = HookStateFile;

interface ClaudeHookPayload {
  action?: string;
  content?: unknown;
  cwd?: string;
  hook_event_name?: string;
  last_assistant_message?: string | null;
  message?: string;
  mode?: string;
  requested_schema?: unknown;
  session_id?: string;
  tool_input?: unknown;
  tool_name?: string;
  transcript_path?: string;
}

type ClaudeHooksDocument = ManagedHooksDocument;
type ClaudeStateIndex = HookStateIndex;

export interface ClaudeInstallResult {
  settingsPath: string;
}

const CLAUDE_STATUS_MESSAGE = "Updating Claude tmux state";
const CLAUDE_SESSION_TITLE_FALLBACK = "Claude Code session";
const CLAUDE_STATE_DIR: StateDirConfig = {
  env: "CODING_AGENTS_TMUX_CLAUDE_STATE_DIR",
  subdirectory: "claude-state",
};

function getClaudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}

export function getClaudeSettingsPath(): string {
  return join(getClaudeHome(), "settings.json");
}

export function getClaudeStateDir(): string {
  return getPreferredStateDir(CLAUDE_STATE_DIR);
}

function schemaContainsChoiceOptions(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => schemaContainsChoiceOptions(entry));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (Array.isArray(value.enum) && value.enum.length > 0) {
    return true;
  }

  if (Array.isArray(value.oneOf) && value.oneOf.length > 0) {
    return true;
  }

  if (Array.isArray(value.anyOf) && value.anyOf.length > 0) {
    return true;
  }

  return Object.values(value).some((entry) => schemaContainsChoiceOptions(entry));
}

function classifyAskUserQuestion(toolInput: unknown): {
  detail: string;
  status: RuntimeStatus;
} {
  const questions =
    isRecord(toolInput) && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const hasOptions = questions.some(
    (question) =>
      isRecord(question) && Array.isArray(question.options) && question.options.length > 0,
  );

  if (hasOptions) {
    return {
      detail: "Claude Code is waiting for a multiple-choice response",
      status: "waiting-question",
    };
  }

  return {
    detail: "Claude Code is waiting for user input",
    status: "waiting-input",
  };
}

function classifyElicitation(payload: ClaudeHookPayload): {
  detail: string;
  status: RuntimeStatus;
} {
  const message = payload.message?.trim();
  const mode = payload.mode?.trim().toLowerCase();
  const status =
    mode === "form" && !schemaContainsChoiceOptions(payload.requested_schema)
      ? ("waiting-input" as const)
      : ("waiting-question" as const);

  return {
    detail:
      status === "waiting-question"
        ? `Claude Code is waiting for an MCP response${message ? `: ${message}` : ""}`
        : `Claude Code is waiting for MCP input${message ? `: ${message}` : ""}`,
    status,
  };
}

function classifyHookPayload(payload: ClaudeHookPayload): HookClassification {
  const eventName = payload.hook_event_name ?? "unknown";

  switch (eventName) {
    case "SessionStart":
      return {
        activity: "idle",
        detail: "Claude Code session started",
        sourceEventType: eventName,
        status: "new",
      };
    case "UserPromptSubmit":
      return {
        activity: "busy",
        detail: "Claude Code is handling a user prompt",
        sourceEventType: eventName,
        status: "running",
      };
    case "PreToolUse":
      if (payload.tool_name === "AskUserQuestion") {
        const questionState = classifyAskUserQuestion(payload.tool_input);

        return {
          activity: "busy",
          detail: questionState.detail,
          sourceEventType: eventName,
          status: questionState.status,
        };
      }

      return {
        activity: "busy",
        detail: `Claude Code is running ${payload.tool_name ?? "a tool"}`,
        sourceEventType: eventName,
        status: "running",
      };
    case "PermissionRequest":
      return {
        activity: "busy",
        detail: "Claude Code is waiting for permission approval",
        sourceEventType: eventName,
        status: "waiting-question",
      };
    case "PermissionDenied":
      return {
        activity: "busy",
        detail: "Claude Code is handling a denied permission request",
        sourceEventType: eventName,
        status: "running",
      };
    case "Elicitation": {
      const elicitation = classifyElicitation(payload);

      return {
        activity: "busy",
        detail: elicitation.detail,
        sourceEventType: eventName,
        status: elicitation.status,
      };
    }
    case "ElicitationResult":
      return {
        activity: "busy",
        detail: "Claude Code is processing an MCP elicitation response",
        sourceEventType: eventName,
        status: "running",
      };
    case "PostToolUse":
      return {
        activity: "busy",
        detail: `Claude Code is processing ${payload.tool_name ?? "tool"} output`,
        sourceEventType: eventName,
        status: "running",
      };
    case "PostToolUseFailure":
      return {
        activity: "busy",
        detail: `Claude Code is recovering from a ${payload.tool_name ?? "tool"} failure`,
        sourceEventType: eventName,
        status: "running",
      };
    case "PostToolBatch":
      return {
        activity: "busy",
        detail: "Claude Code is processing tool results",
        sourceEventType: eventName,
        status: "running",
      };
    case "Stop":
      // A Stop event means Claude finished its turn and handed control back to
      // the user. That is an idle state. Genuine blocking prompts arrive via
      // dedicated hooks (PreToolUse+AskUserQuestion, PermissionRequest,
      // Elicitation); a prose question at the end of a turn is not a blocking
      // wait, so we must not classify it as "waiting" here.
      return {
        activity: "idle",
        detail: "Claude Code is idle between turns",
        sourceEventType: eventName,
        status: "idle",
      };
    default:
      return {
        activity: "unknown",
        detail: `Unhandled Claude Code hook event: ${eventName}`,
        sourceEventType: eventName,
        status: "unknown",
      };
  }
}

export function persistClaudeHookState(rawInput: string): Promise<void> {
  return persistHookState<ClaudeHookPayload>({
    rawInput,
    stateDir: CLAUDE_STATE_DIR,
    classify: classifyHookPayload,
    titleFallback: CLAUDE_SESSION_TITLE_FALLBACK,
    deleteOnEvents: ["SessionEnd"],
    extraFields: (payload, existing) => {
      const transcriptPath = payload.transcript_path?.trim() || existing?.transcriptPath;
      return transcriptPath ? { transcriptPath } : {};
    },
  });
}

export function readClaudeStates(): ClaudeStateFile[] {
  return readHookStates(CLAUDE_STATE_DIR);
}

function buildClaudeStateIndex(states = readClaudeStates()): ClaudeStateIndex {
  return buildHookStateIndex(states);
}

// Claude's interactive prompts (permission requests, AskUserQuestion) render a
// selectable list where the highlighted option is marked with an arrow glyph.
// Requiring the arrow avoids misreading ordinary numbered prose in an assistant
// message as a live prompt. The arrow must sit on a numbered option: echoed
// prompts and the input line also start with "❯", so a bare arrow would flag
// every idle screen that has a bulleted answer above it.
function hasInteractiveChoicePrompt(lines: string[]): boolean {
  const trimmed = lines.map((line) => line.trim());
  const hasSelectionArrow = trimmed.some((line) => /^[❯›>]\s*\d+\.\s+\S/.test(line));

  return hasSelectionArrow && countChoiceLines(lines.join("\n")) >= 2;
}

// The tmux pane is the authoritative real-time signal for whether Claude is
// actively working. While Claude is processing it renders "esc to interrupt" in
// the footer and a spinner status line (e.g. "✳ Forming… (1m 2s · ↓ 4.2k
// tokens)"); once the turn ends both disappear. Hook state, by contrast, can go
// stale because Claude does not always emit a Stop event after a tool batch.
function detectClaudeBusy(text: string, lower: string): boolean {
  return lower.includes("esc to interrupt") || /…\s*\(\s*\d+\s*[hms]/.test(text);
}

// When Claude delegates to background subagents (the Task tool) it can sit on a
// "Waiting for N background agents to finish" spinner. In that state the footer
// drops "esc to interrupt" and each agent row reports its own elapsed time
// instead of the main spinner's "… (1m 2s)" format, so detectClaudeBusy misses
// it and the pane would otherwise fall through to the idle default. The parent
// session is still actively blocked on that work, so treat it as busy.
//
// Claude animates its "thinking" status with a rotating sparkle/asterisk glyph
// (✳ ✶ ✷ ✻ ✽ · …). The live background-agents status row is exactly that
// glyph followed by "Waiting for N background agents to finish".
const CLAUDE_SPINNER_GLYPH = /^[\u00b7\u2217\u2722-\u273f]\s+/u;

// Claude draws its input as a box: an optional live status line, a horizontal
// rule, the ❯ prompt, another rule, then the footer (and any background-agent
// rows). The rules are runs of the ─ box-drawing char.
const CLAUDE_INPUT_PROMPT = /^\u276f(?:\s|$)/;
const CLAUDE_BORDER_RULE = /\u2500{3,}/;

// Extract the single "live status" line that Claude renders directly above the
// input box's top rule. That slot is authoritative for the current turn: idle
// panes show e.g. "✻ Churned for 1m", a working pane shows "✻ Waiting for N
// background agents to finish". Copied/quoted status rows elsewhere in the
// scrollback sit above this slot and are deliberately ignored.
function getClaudeLiveStatusLine(lines: string[]): string | null {
  let promptIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (CLAUDE_INPUT_PROMPT.test(lines[i]?.trim() ?? "")) {
      promptIndex = i;
      break;
    }
  }

  if (promptIndex <= 0) {
    return null;
  }

  // The top rule sits just above the prompt (allow a couple of lines of slack
  // for wrapped input).
  let borderIndex = -1;
  for (let i = promptIndex - 1; i >= 0 && i >= promptIndex - 3; i -= 1) {
    if (CLAUDE_BORDER_RULE.test(lines[i] ?? "")) {
      borderIndex = i;
      break;
    }
  }

  if (borderIndex <= 0) {
    return null;
  }

  const status = lines[borderIndex - 1]?.trim() ?? "";
  return status || null;
}

// A background-agent wait is reported only when the live status slot itself
// reads "<spinner glyph> Waiting for N background agents". Anchoring to that one
// line (rather than scanning the whole buffer) keeps large agent lists working
// — the status line stays above the prompt no matter how many rows stack below
// the footer — while ignoring quoted, bulleted, or copied mentions in prose.
function detectClaudeBackgroundAgents(lines: string[]): boolean {
  const status = getClaudeLiveStatusLine(lines);

  if (!status || !CLAUDE_SPINNER_GLYPH.test(status)) {
    return false;
  }

  return /^waiting for \d+ background agents?\b/i.test(status.replace(CLAUDE_SPINNER_GLYPH, ""));
}

// Claude's slash-command menus (/effort, /model, /config, …) open an
// interactive overlay whose footer offers confirm/cancel and navigation hints.
// These block on user interaction, so they count as "waiting" rather than idle.
function isInteractiveDialog(lower: string): boolean {
  return (
    lower.includes("enter to confirm") ||
    lower.includes("esc to cancel") ||
    (lower.includes("to select") && lower.includes("enter")) ||
    (lower.includes("to adjust") && lower.includes("confirm"))
  );
}

function classifyClaudePreview(lines: string[]): PreviewClassification | null {
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);

  if (nonEmptyLines.length === 0) {
    return null;
  }

  const text = nonEmptyLines.join("\n");
  const lower = text.toLowerCase();
  const recentLines = nonEmptyLines.slice(-12);
  const recentText = recentLines.join("\n");
  const recentLower = recentText.toLowerCase();

  // Waiting is checked first: a blocking prompt or interactive dialog can also
  // keep "esc to interrupt" on screen, but it is a genuine wait for user input.
  if (
    hasInteractiveChoicePrompt(recentLines) ||
    ["permission", "allow", "deny"].every((fragment) => recentLower.includes(fragment)) ||
    isInteractiveDialog(recentLower)
  ) {
    return {
      activity: "busy",
      detail: "Claude Code appears to be waiting for a response",
      status: "waiting-question",
    };
  }

  if (detectClaudeBackgroundAgents(nonEmptyLines)) {
    return {
      activity: "busy",
      detail: "Claude Code is waiting on background agents",
      status: "running",
    };
  }

  if (detectClaudeBusy(text, lower)) {
    return {
      activity: "busy",
      detail: "Claude Code is working",
      status: "running",
    };
  }

  // A live Claude session with no active spinner and no blocking prompt is idle
  // between turns, regardless of what a possibly-stale hook event recorded. The
  // absence of "esc to interrupt" is strong evidence Claude is not working, so a
  // readable-but-otherwise-unrecognized Claude screen is treated as idle rather
  // than defaulting to "running".
  return {
    activity: "idle",
    detail: "Claude Code is idle between turns",
    status: "idle",
  };
}

async function loadClaudePreviewClassification(
  target: TmuxPane["target"],
): Promise<PreviewClassification | null> {
  try {
    const lines = await capturePanePreview(target, 24);
    return classifyClaudePreview(lines);
  } catch {
    return null;
  }
}

function buildManagedClaudeHooks(command: string): ClaudeHooksDocument {
  const hook = buildManagedHookCommand(command, CLAUDE_STATUS_MESSAGE);

  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook] }],
      PermissionRequest: [{ hooks: [hook] }],
      Elicitation: [{ hooks: [hook] }],
      ElicitationResult: [{ hooks: [hook] }],
      PostToolUse: [{ hooks: [hook] }],
      PostToolUseFailure: [{ hooks: [hook] }],
      PostToolBatch: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }],
    },
  };
}

export function updateClaudeSettings(existing: string, command: string): string {
  return mergeManagedHooks(existing, buildManagedClaudeHooks(command), CLAUDE_STATUS_MESSAGE);
}

export function installClaudeIntegration(command: string): ClaudeInstallResult {
  const settingsPath = getClaudeSettingsPath();
  const claudeHome = getClaudeHome();
  const existingSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";

  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(settingsPath, updateClaudeSettings(existingSettings, command), "utf8");

  return { settingsPath };
}

export function buildClaudeHooksTemplate(command: string): string {
  return `${JSON.stringify(buildManagedClaudeHooks(command), null, 2)}\n`;
}

// The merge trusts a fresh hook state over the live preview only briefly: a
// blocking wait the preview cannot see (e.g. an MCP elicitation form) for the
// wait window, and a just-happened transition for the shorter transition window
// before Claude redraws (e.g. "esc to interrupt" lingering at Stop). Beyond
// that the pane preview is the sole source of truth, so stale "waiting"/
// "running" events do not linger after Claude goes idle.
const CLAUDE_MERGE_CONFIG: HookMergeConfig = {
  provider: "claude",
  idPrefix: "claude",
  hookSource: "claude-hook",
  previewSource: "claude-preview",
  commandSource: "claude-command",
  commandActivity: "busy",
  commandStatus: "running",
  commandDetail: (pane) => `detected ${pane.currentCommand} process in tmux pane`,
  waitFreshnessMs: DEFAULT_HOOK_WAIT_FRESHNESS_MS,
  transitionFreshnessMs: DEFAULT_HOOK_TRANSITION_FRESHNESS_MS,
  transitionEvents: DEFAULT_TRANSITION_EVENTS,
};

export async function attachRuntimeWithClaude(
  panes: DiscoveredPane[],
  index = buildClaudeStateIndex(),
): Promise<PaneRuntimeSummary[]> {
  return Promise.all(
    panes.map(async (entry) => {
      const hookState = getHookState(index, entry.pane);
      const preview = await loadClaudePreviewClassification(entry.pane.target);
      return mergeHookAndPreview(entry, hookState, preview, CLAUDE_MERGE_CONFIG);
    }),
  );
}
