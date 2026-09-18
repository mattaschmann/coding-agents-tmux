// Fast-path status cache reader.
//
// tmux evaluates `#(...)` in status-right on every redraw, caps that expansion
// at ~100ms wall-clock, and will not re-run it more than once per second. The
// full `status` render costs ~130ms (mostly Node startup + TS import of the
// core graph), which blows the budget and shows stale/blank until a later tick.
//
// This entry is intentionally dependency-light — only node built-ins, no
// commander/core imports — so it starts in ~30ms. It prints a cached render
// when the cache is at least as new as the newest plugin-state file; otherwise
// it exits non-zero so the caller can fall back to a full render. The full
// `status` command writes the cache (see writeStatusCache in cli.ts).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function stateHome(): string {
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

function pluginStateDir(): string {
  return (
    process.env.CODING_AGENTS_TMUX_STATE_DIR ??
    join(stateHome(), "coding-agents-tmux", "plugin-state")
  );
}

function cacheDir(): string {
  return (
    process.env.CODING_AGENTS_TMUX_STATUS_CACHE_DIR ??
    join(stateHome(), "coding-agents-tmux", "status-cache")
  );
}

// Newest mtime across plugin-state files: the freshness watermark the cache
// must meet or beat. Also factors in the cycle ledger, since acknowledging a
// pane (seen) changes the render without touching a plugin-state file.
function newestInputMtime(): number {
  let newest = 0;
  for (const dir of [pluginStateDir(), join(stateHome(), "coding-agents-tmux", "cycle-state")]) {
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
// miss/stale/error so the caller falls back to a full render.
export function readFreshCache(input: {
  variant: string | undefined;
  cacheFile: string;
  newestInput: number;
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

  const cached = readFreshCache({
    variant,
    cacheFile: join(cacheDir(), `${variant}.txt`),
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
