import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getPreferredStateDir, getStateDirCandidates } from "../naming.ts";
import {
  buildManagedHookCommand,
  mergeManagedHooks,
  type ManagedHooksDocument,
} from "./hook-install.ts";
import {
  persistHookState,
  readHookStateFile,
  type HookClassification,
  type HookStateFile,
  type StateDirConfig,
} from "./hook-state.ts";
import { countChoiceLines } from "./preview-text.ts";
import type { RuntimeStatus } from "../types.ts";

export type CodexStateFile = HookStateFile;

interface CodexHookPayload {
  cwd?: string;
  hook_event_name?: string;
  last_assistant_message?: string | null;
  session_id?: string;
  tool_name?: string;
}

type CodexHooksDocument = ManagedHooksDocument;

export interface CodexInstallResult {
  configPath: string;
  hooksPath: string;
}

export interface CodexStateEntry {
  filePath: string;
  state: CodexStateFile;
}

const CODEX_STATUS_MESSAGE = "Updating Codex tmux state";
const CODEX_SESSION_TITLE_FALLBACK = "Codex session";
const CODEX_STATE_DIR: StateDirConfig = {
  env: "CODING_AGENTS_TMUX_CODEX_STATE_DIR",
  subdirectory: "codex-state",
};

export function getCodexStateDir(): string {
  return getPreferredStateDir(CODEX_STATE_DIR);
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), "config.toml");
}

export function getCodexHooksPath(): string {
  return join(getCodexHome(), "hooks.json");
}

function classifyWaitingMessage(message: string | null | undefined): RuntimeStatus | null {
  if (!message) {
    return null;
  }

  const trimmed = message.trim();

  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  const choiceLineCount = countChoiceLines(trimmed);

  if (
    choiceLineCount >= 2 &&
    ["would you like", "do you want", "should i", "choose", "select", "option"].some((fragment) =>
      lower.includes(fragment),
    )
  ) {
    return "waiting-question";
  }

  if (/\?\s*$/.test(trimmed)) {
    return "waiting-input";
  }

  if (
    [
      "would you like",
      "do you want",
      "should i",
      "can you",
      "could you",
      "please provide",
      "please confirm",
      "choose",
      "select",
      "confirm",
    ].some((fragment) => lower.includes(fragment))
  ) {
    return "waiting-input";
  }

  return null;
}

function classifyHookPayload(payload: CodexHookPayload): HookClassification {
  const eventName = payload.hook_event_name ?? "unknown";

  switch (eventName) {
    case "SessionStart":
      return {
        activity: "idle",
        detail: "Codex session started",
        sourceEventType: eventName,
        status: "new",
      };
    case "UserPromptSubmit":
      return {
        activity: "busy",
        detail: "Codex is handling a user prompt",
        sourceEventType: eventName,
        status: "running",
      };
    case "PreToolUse":
      return {
        activity: "busy",
        detail: `Codex is running ${payload.tool_name ?? "a tool"}`,
        sourceEventType: eventName,
        status: "running",
      };
    case "PermissionRequest":
      return {
        activity: "busy",
        detail: `Codex is waiting for permission to run ${payload.tool_name ?? "a tool"}`,
        sourceEventType: eventName,
        status: "waiting-input",
      };
    case "PostToolUse":
      return {
        activity: "busy",
        detail: `Codex is processing ${payload.tool_name ?? "tool"} output`,
        sourceEventType: eventName,
        status: "running",
      };
    case "Stop":
      return classifyWaitingMessage(payload.last_assistant_message)
        ? {
            activity: "busy",
            detail:
              classifyWaitingMessage(payload.last_assistant_message) === "waiting-question"
                ? "Codex is waiting for a multiple-choice response"
                : "Codex is waiting for user input",
            sourceEventType: eventName,
            status: classifyWaitingMessage(payload.last_assistant_message) ?? "waiting-input",
          }
        : {
            activity: "idle",
            detail: "Codex is idle between turns",
            sourceEventType: eventName,
            status: "idle",
          };
    default:
      return {
        activity: "unknown",
        detail: `Unhandled Codex hook event: ${eventName}`,
        sourceEventType: eventName,
        status: "unknown",
      };
  }
}

export function persistCodexHookState(rawInput: string): Promise<void> {
  return persistHookState<CodexHookPayload>({
    rawInput,
    stateDir: CODEX_STATE_DIR,
    classify: classifyHookPayload,
    titleFallback: CODEX_SESSION_TITLE_FALLBACK,
  });
}

export function readCodexStateEntries(): CodexStateEntry[] {
  return getStateDirCandidates(CODEX_STATE_DIR)
    .filter((stateDir) => existsSync(stateDir))
    .flatMap((stateDir) =>
      readdirSync(stateDir)
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => join(stateDir, entry))
        .map((filePath) => ({ filePath, state: readHookStateFile(filePath) }))
        .filter((entry): entry is CodexStateEntry => Boolean(entry.state?.directory)),
    );
}

export function readCodexStates(): CodexStateFile[] {
  return readCodexStateEntries().map((entry) => entry.state);
}

function buildManagedCodexHooks(command: string): CodexHooksDocument {
  const hook = buildManagedHookCommand(command, CODEX_STATUS_MESSAGE);

  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      PreToolUse: [{ matcher: "Bash", hooks: [hook] }],
      PermissionRequest: [{ hooks: [hook] }],
      PostToolUse: [{ matcher: "Bash", hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
    },
  };
}

export function updateCodexConfig(existing: string): string {
  const lines = existing.split(/\r?\n/);
  const dottedHooksIndices = lines
    .map((line, index) => (/^\s*features\.hooks\s*=/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const deprecatedDottedHooksIndices = lines
    .map((line, index) => (/^\s*features\.codex_hooks\s*=/.test(line) ? index : -1))
    .filter((index) => index >= 0);

  let featuresIndex = -1;
  let nextSectionIndex = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[features\]\s*$/.test(lines[index] ?? "")) {
      featuresIndex = index;
      continue;
    }

    if (
      featuresIndex >= 0 &&
      index > featuresIndex &&
      /^\s*\[[^\]]+\]\s*$/.test(lines[index] ?? "")
    ) {
      nextSectionIndex = index;
      break;
    }
  }

  const featureHooksIndices: number[] = [];
  const deprecatedFeatureHooksIndices: number[] = [];

  if (featuresIndex >= 0) {
    for (let index = featuresIndex + 1; index < nextSectionIndex; index += 1) {
      if (/^\s*hooks\s*=/.test(lines[index] ?? "")) {
        featureHooksIndices.push(index);
      } else if (/^\s*codex_hooks\s*=/.test(lines[index] ?? "")) {
        deprecatedFeatureHooksIndices.push(index);
      }
    }
  }

  const targetIndex =
    dottedHooksIndices[0] ??
    featureHooksIndices[0] ??
    deprecatedDottedHooksIndices[0] ??
    deprecatedFeatureHooksIndices[0];

  if (targetIndex !== undefined) {
    const targetLine =
      deprecatedFeatureHooksIndices.includes(targetIndex) ||
      featureHooksIndices.includes(targetIndex)
        ? "hooks = true"
        : "features.hooks = true";
    lines[targetIndex] = targetLine;

    const duplicateIndices = new Set([
      ...dottedHooksIndices,
      ...featureHooksIndices,
      ...deprecatedDottedHooksIndices,
      ...deprecatedFeatureHooksIndices,
    ]);
    duplicateIndices.delete(targetIndex);

    return `${lines
      .filter((_, index) => !duplicateIndices.has(index))
      .join("\n")
      .trimEnd()}\n`;
  }

  if (featuresIndex >= 0) {
    lines.splice(nextSectionIndex, 0, "hooks = true");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\n[features]\nhooks = true\n` : "[features]\nhooks = true\n";
}

export function updateCodexHooks(existing: string, command: string): string {
  return mergeManagedHooks(existing, buildManagedCodexHooks(command), CODEX_STATUS_MESSAGE);
}

export function installCodexIntegration(command: string): CodexInstallResult {
  const configPath = getCodexConfigPath();
  const hooksPath = getCodexHooksPath();
  const codexHome = getCodexHome();
  const existingConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const existingHooks = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "";

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(configPath, updateCodexConfig(existingConfig), "utf8");
  writeFileSync(hooksPath, updateCodexHooks(existingHooks, command), "utf8");

  return { configPath, hooksPath };
}

export function buildCodexHooksTemplate(command: string): string {
  return `${JSON.stringify(buildManagedCodexHooks(command), null, 2)}\n`;
}
