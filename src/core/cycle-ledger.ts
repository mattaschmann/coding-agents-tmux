// Reader-side cycle ledger: tracks per-pane observed status + acknowledgement so
// the `cycle` command can rank panes by priority (oldest-first within a tier)
// and skip panes the user has already seen. Distinct from the agent state
// writers — this is derived from the *displayed* runtime status at read time and
// covers every agent, including ones with no state file (Kiro).
//
// "seen" means the pane was the active tmux pane at some point since it entered
// its current status. It resets whenever the status changes.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { getPreferredStateDir, getStateDirCandidates } from "../naming.ts";
import type { RuntimeStatus } from "../types.ts";

const STATE_ENV = "CODING_AGENTS_TMUX_CYCLE_STATE_DIR";
const STATE_SUBDIR = "cycle-state";
const LEDGER_VERSION = 1;

export interface CycleLedgerEntry {
  observedStatus: RuntimeStatus;
  statusSince: number;
  seen: boolean;
  // Wall-clock time the pane was last looked at (active pane during an observe).
  // Drives least-recently-seen ordering once every pane is seen. 0 = never.
  lastSeenAt: number;
  version?: number;
}

export type CycleLedger = Map<string, CycleLedgerEntry>;

// Ledger key for a session tab within a pane. The ledger is key-agnostic
// (`toFileName` hex-encodes any string, `computeObservation` is pure), so a tab
// tracks its own seen/statusSince independently of its host pane's pane-id key.
export function tabLedgerKey(paneId: string, sessionId: string): string {
  return `${paneId}:${sessionId}`;
}

function serverDirectory(serverIdentity: string): string {
  return `server-${createHash("sha256").update(serverIdentity).digest("hex")}`;
}

function getCycleStateDir(serverIdentity: string): string {
  return join(
    getPreferredStateDir({ env: STATE_ENV, subdirectory: STATE_SUBDIR }),
    serverDirectory(serverIdentity),
  );
}

function toFileName(paneId: string): string {
  return `pane-${Buffer.from(paneId).toString("hex")}.json`;
}

function readEntry(filePath: string): CycleLedgerEntry | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CycleLedgerEntry>;
    if (!parsed || typeof parsed.observedStatus !== "string") {
      return null;
    }

    return {
      observedStatus: parsed.observedStatus,
      statusSince: typeof parsed.statusSince === "number" ? parsed.statusSince : 0,
      seen: Boolean(parsed.seen),
      lastSeenAt: typeof parsed.lastSeenAt === "number" ? parsed.lastSeenAt : 0,
      ...(typeof parsed.version === "number" ? { version: parsed.version } : {}),
    };
  } catch {
    return null;
  }
}

/** Load only this server lifetime's entries, keyed by pane id. Legacy files are ignored. */
export function readCycleLedger(serverIdentity: string | null | undefined): CycleLedger {
  const ledger: CycleLedger = new Map();
  if (!serverIdentity) return ledger;

  for (const root of getStateDirCandidates({ env: STATE_ENV, subdirectory: STATE_SUBDIR })) {
    const stateDir = join(root, serverDirectory(serverIdentity));
    if (!existsSync(stateDir)) {
      continue;
    }

    for (const name of readdirSync(stateDir)) {
      if (!name.startsWith("pane-") || !name.endsWith(".json")) {
        continue;
      }

      const paneId = decodePaneIdFromFileName(name);
      if (!paneId) {
        continue;
      }

      const entry = readEntry(join(stateDir, name));
      if (entry) {
        ledger.set(paneId, entry);
      }
    }
  }

  return ledger;
}

function decodePaneIdFromFileName(name: string): string | null {
  const hex = name.slice("pane-".length, -".json".length);
  if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    return null;
  }

  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Compute the next ledger entry for a pane given its currently displayed status.
 * Returns null when no write is needed (keeps the frequent status path cheap).
 */
export function computeObservation(
  previous: CycleLedgerEntry | null,
  status: RuntimeStatus,
  isCurrent: boolean,
  now: number,
): CycleLedgerEntry | null {
  if (!previous || previous.observedStatus !== status) {
    return {
      observedStatus: status,
      statusSince: now,
      seen: isCurrent,
      lastSeenAt: isCurrent ? now : 0,
      version: LEDGER_VERSION,
    };
  }

  // Same status, first sight by the active pane: acknowledge + stamp the LRU
  // clock. Re-visits of an already-seen pane are stamped explicitly by the
  // cycle command (see bumpLastSeen), not here, so the frequent status tick
  // stays a no-op once a pane is seen.
  if (isCurrent && !previous.seen) {
    return { ...previous, seen: true, lastSeenAt: now, version: LEDGER_VERSION };
  }

  return null;
}

/** Atomic write-temp-rename of a ledger entry (RMW-safe for overlapping short-lived procs). */
function writeEntry(stateDir: string, filePath: string, entry: CycleLedgerEntry): void {
  mkdirSync(stateDir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(entry, null, 2), "utf8");
  renameSync(tempPath, filePath);
}

/** Record an observation for a pane, writing atomically only when something changed. */
export function observePane(
  paneId: string,
  status: RuntimeStatus,
  isCurrent: boolean,
  now: number,
  serverIdentity: string | null | undefined,
): void {
  if (!serverIdentity) return;
  const stateDir = getCycleStateDir(serverIdentity);
  const filePath = join(stateDir, toFileName(paneId));
  const next = computeObservation(readEntry(filePath), status, isCurrent, now);

  if (!next) {
    return;
  }

  writeEntry(stateDir, filePath, next);
}

/**
 * Re-stamp `lastSeenAt` for an already-tracked pane, moving it to the back of
 * the least-recently-seen queue. Used by the cycle command on the panes it
 * leaves and lands on so repeated presses rotate fairly instead of snapping
 * back to one pane. No-op if the pane has no ledger entry yet (its first
 * observation will stamp it).
 */
export function bumpLastSeen(
  paneId: string,
  now: number,
  serverIdentity: string | null | undefined,
): void {
  if (!serverIdentity) return;
  const stateDir = getCycleStateDir(serverIdentity);
  const filePath = join(stateDir, toFileName(paneId));
  const previous = readEntry(filePath);
  if (!previous || previous.lastSeenAt === now) {
    return;
  }

  writeEntry(stateDir, filePath, { ...previous, lastSeenAt: now, version: LEDGER_VERSION });
}
