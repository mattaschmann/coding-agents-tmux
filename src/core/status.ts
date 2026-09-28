// Shared runtime-status helpers. Single source of truth for the "waiting" set
// (a pane blocked on a permission/question prompt), consumed by cycle ranking,
// status rendering, the CLI list filters, and tab-focus detection. Keeping the
// membership here means the literals are never re-spelled across modules.

import type { RuntimeStatus } from "../types.ts";

export type WaitingStatus = Extract<RuntimeStatus, "waiting-question" | "waiting-input">;

export function isWaitingStatus(status: RuntimeStatus): status is WaitingStatus {
  return status === "waiting-question" || status === "waiting-input";
}
