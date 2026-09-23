// Fast-path status cache reader.
//
// tmux evaluates `#(...)` in status-right on every redraw, caps that expansion
// at ~100ms wall-clock, and will not re-run it more than once per second. The
// full `status` render costs ~130ms (mostly Node startup + TS import of the
// core graph), which blows the budget and shows stale/blank until a later tick.
//
// This entry is intentionally dependency-light — only node built-ins, no
// commander/core imports — so it starts in ~30ms. It prints a cached render
// when the cache is at least as new as the newest agent state file (any
// provider) and, if a max age is given, not older than it; otherwise it exits
// non-zero so the caller can fall back to a full render. The full
// `status` command writes the cache (see writeStatusCache in cli.ts).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  getEnvValue,
  getStateRoot,
  getStatusCacheDir,
  STATE_DIR_ENVS,
  STATUS_CACHE_SUBDIR,
} from "./naming.ts";

// Directories whose *.json mtimes gate the cache: every subdirectory of the
// state root (plugin, claude, codex, pi, cycle ledger, ...) so new providers are
// covered without a fixed list, plus any env-relocated state dir. The cycle
// ledger is included because acknowledging a pane (seen) changes the render
// without touching a provider file.
function stateInputDirs(): string[] {
  const root = getStateRoot();
  let rootDirs: string[] = [];
  try {
    rootDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== STATUS_CACHE_SUBDIR)
      .map((entry) => join(root, entry.name));
  } catch {
    // no state root yet; env-relocated dirs may still exist
  }
  const overrides = STATE_DIR_ENVS.flatMap((name) => getEnvValue(name) ?? []);
  return [...new Set([...rootDirs, ...overrides])];
}

// Newest mtime across stateInputDirs(): the freshness watermark the cache must
// meet or beat.
export function newestInputMtime(): number {
  let newest = 0;
  for (const dir of stateInputDirs()) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        const m = statSync(join(dir, name)).mtimeMs;
        if (m > newest) {
          newest = m;
        }
      } catch {
        // ignore files that vanish mid-scan
      }
    }
  }
  return newest;
}

// variant is passed by the caller (status style / tone) so distinct renders do
// not clobber each other. Returns the cached string when fresh, or null on a
// miss/stale/error so the caller falls back to a full render. maxAgeMs (0 or
// omitted = unlimited) bounds staleness for changes no state file records, such
// as a pane going idle after an interrupt.
export function readFreshCache(input: {
  variant: string | undefined;
  cacheFile: string;
  newestInput: number;
  maxAgeMs?: number;
  now?: number;
}): string | null {
  if (!input.variant) {
    return null;
  }

  let cacheStat: ReturnType<typeof statSync>;
  try {
    cacheStat = statSync(input.cacheFile);
  } catch {
    return null; // no cache yet
  }

  if (cacheStat.mtimeMs < input.newestInput) {
    return null; // stale — let the caller do a full render
  }

  if (input.maxAgeMs && (input.now ?? Date.now()) - cacheStat.mtimeMs > input.maxAgeMs) {
    return null; // expired — pane-only changes leave no state file behind
  }

  try {
    return readFileSync(input.cacheFile, "utf8");
  } catch {
    return null;
  }
}

function main(): number {
  const variant = process.argv[2];
  if (!variant) {
    return 1;
  }

  const maxAgeMs = Number(process.argv[3]);
  const cached = readFreshCache({
    variant,
    maxAgeMs: maxAgeMs > 0 ? maxAgeMs : 0,
    cacheFile: join(getStatusCacheDir(), `${variant}.txt`),
    newestInput: newestInputMtime(),
  });

  if (cached === null) {
    return 1;
  }

  process.stdout.write(cached);
  return 0;
}

// Only run as a CLI when invoked directly, so tests can import readFreshCache
// without triggering process.exit.
if (process.argv[1] && process.argv[1].endsWith("status-cache.ts")) {
  process.exit(main());
}
