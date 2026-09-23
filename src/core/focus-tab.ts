// Auto-focus a waiting background tab after switching to an OpenCode V2 pane.
//
// When `cycle`/`switch`/menu lands on an OpenCode pane whose *background* tab is
// blocked on a permission/question prompt, the focused tab is still the idle one
// the user last left. This drives OpenCode's own `session.tab.next_unread`
// command (default keybind `alt+shift+down`) via `tmux send-keys`, which focuses
// the waiting tab and is a safe no-op when nothing is waiting.
//
// Gated so a keystroke is only ever sent when it is both wanted and meaningful:
// the pane must be OpenCode, the feature enabled, and a *background* tab actually
// waiting (a focused-tab prompt needs no move). Reads its two options at runtime
// via `tmux show-option` — mirroring notifications — so no env plumbing through
// the `.tmux` entry is needed and the options stay live-reloadable.

import { isWaitingStatus } from "./status.ts";
import { runCommand } from "../runtime.ts";
import type { PaneRuntimeSummary, RuntimeInfo } from "../types.ts";

const ENABLED_OPTION = "@coding-agents-tmux-focus-waiting-tab";
const KEY_OPTION = "@coding-agents-tmux-focus-waiting-tab-key";
const SELECT_KEY_OPTION = "@coding-agents-tmux-focus-waiting-tab-select-key";
const DEFAULT_KEY = "M-S-Down";
// `{n}` is replaced by the 1-based tab index. Leader form (`ctrl+x` then N)
// rather than `ctrl+N`, which terminals commonly intercept before OpenCode.
const DEFAULT_SELECT_KEY = "C-x {n}";

// Match the falsy set used elsewhere (e.g. CODING_AGENTS_TMUX_STATUS_SHOW_PREFIX).
const FALSY_VALUES = new Set(["0", "false", "no", "off"]);

// True when a non-active tab is waiting on a prompt. A focused-tab prompt is
// excluded — the user is already there — and a pane with no tab roll-up (only
// the live V2 TUI plugin writes `tabs`) is never a candidate.
export function hasWaitingBackgroundTab(runtime: RuntimeInfo): boolean {
  return (runtime.tabs ?? []).some((tab) => !tab.active && isWaitingStatus(tab.status));
}

async function readTmuxOption(option: string): Promise<string | undefined> {
  try {
    const { exitCode, stdoutText } = await runCommand(["tmux", "show-option", "-gqv", option]);

    if (exitCode !== 0) {
      return undefined;
    }

    const value = stdoutText.trim();
    return value ? value : undefined;
  } catch {
    // A missing/unavailable tmux must not break the switch it follows.
    return undefined;
  }
}

function isEnabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return true;
  }

  return !FALSY_VALUES.has(raw.toLowerCase());
}

// Send the tab-focus keystroke when the pane warrants it. Silently returns
// (sending nothing) for non-OpenCode panes, when disabled, or when no background
// tab is waiting. Best-effort: a failed send-keys never throws into the caller.
export async function focusWaitingTab(summary: PaneRuntimeSummary, client?: string): Promise<void> {
  if (summary.detection.agent !== "opencode") {
    return;
  }

  if (!hasWaitingBackgroundTab(summary.runtime)) {
    return;
  }

  const [enabledRaw, keyRaw] = await Promise.all([
    readTmuxOption(ENABLED_OPTION),
    readTmuxOption(KEY_OPTION),
  ]);

  if (!isEnabled(enabledRaw)) {
    return;
  }

  const key = keyRaw ?? DEFAULT_KEY;
  await sendKeys(summary.pane.target, [key], client);
}

// Build and run a `tmux send-keys` for one or more key tokens (a leader sequence
// like `C-x 3` is two tokens). Best-effort: never throws into the caller.
async function sendKeys(target: string, keys: string[], client?: string): Promise<void> {
  const command = ["tmux", "send-keys"];

  if (client) {
    command.push("-c", client);
  }

  command.push("-t", target, ...keys);

  try {
    await runCommand(command);
  } catch {
    // The keystroke is an ergonomic nicety; never surface its failure.
  }
}

// Focus a specific 1-based tab index by sending the configured select sequence
// (default `C-x {n}`, `{n}` → index). Gated on the same enable toggle; the
// caller has already decided the tab qualifies, so no tab-state check here.
export async function selectTab(
  summary: PaneRuntimeSummary,
  index: number,
  client?: string,
): Promise<void> {
  const [enabledRaw, patternRaw] = await Promise.all([
    readTmuxOption(ENABLED_OPTION),
    readTmuxOption(SELECT_KEY_OPTION),
  ]);

  if (!isEnabled(enabledRaw)) {
    return;
  }

  const pattern = patternRaw ?? DEFAULT_SELECT_KEY;
  const keys = pattern.replaceAll("{n}", String(index)).split(/\s+/).filter(Boolean);

  if (keys.length === 0) {
    return;
  }

  await sendKeys(summary.pane.target, keys, client);
}
