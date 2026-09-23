import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { newestInputMtime, readFreshCache } from "../src/status-cache.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "coding-agents-tmux-cache-test-"));
}

test("readFreshCache returns null when the variant is missing", () => {
  assert.equal(
    readFreshCache({ variant: undefined, cacheFile: "/nope.txt", newestInput: 0 }),
    null,
  );
});

test("readFreshCache returns null when the cache file does not exist", () => {
  const dir = tmp();
  assert.equal(
    readFreshCache({ variant: "main", cacheFile: join(dir, "main.txt"), newestInput: 0 }),
    null,
  );
});

test("readFreshCache returns the cached render when it is newer than inputs", () => {
  const dir = tmp();
  const cacheFile = join(dir, "main.txt");
  writeFileSync(cacheFile, "CACHED", "utf8");
  // Cache mtime is "now"; inputs are in the past.
  assert.equal(
    readFreshCache({ variant: "main", cacheFile, newestInput: Date.now() - 60_000 }),
    "CACHED",
  );
});

test("readFreshCache returns null (miss) when an input is newer than the cache", () => {
  const dir = tmp();
  const cacheFile = join(dir, "main.txt");
  writeFileSync(cacheFile, "CACHED", "utf8");
  // Force the cache file's mtime into the past, then treat inputs as "now".
  const past = Date.now() / 1000 - 60;
  utimesSync(cacheFile, past, past);
  assert.equal(
    readFreshCache({ variant: "main", cacheFile, newestInput: Date.now() }),
    null,
    "stale cache must miss so the caller re-renders",
  );
});

test("readFreshCache expires an old cache when maxAgeMs is set", () => {
  const dir = tmp();
  const cacheFile = join(dir, "main.txt");
  writeFileSync(cacheFile, "CACHED", "utf8");
  const past = Date.now() / 1000 - 30;
  utimesSync(cacheFile, past, past);

  assert.equal(
    readFreshCache({ variant: "main", cacheFile, newestInput: 0, maxAgeMs: 5_000 }),
    null,
  );
  assert.equal(
    readFreshCache({ variant: "main", cacheFile, newestInput: 0, maxAgeMs: 60_000 }),
    "CACHED",
  );
  assert.equal(
    readFreshCache({ variant: "main", cacheFile, newestInput: 0, maxAgeMs: 0 }),
    "CACHED",
  );
});

test("newestInputMtime covers root subdirectories and env-relocated state dirs", () => {
  const stateHome = tmp();
  const relocated = tmp();
  const claudeDir = join(stateHome, "coding-agents-tmux", "claude-state");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(stateHome, "coding-agents-tmux", "status-cache"), { recursive: true });
  writeFileSync(join(claudeDir, "a.json"), "{}", "utf8");
  writeFileSync(join(stateHome, "coding-agents-tmux", "status-cache", "main.json"), "{}", "utf8");
  writeFileSync(join(relocated, "b.json"), "{}", "utf8");
  utimesSync(join(claudeDir, "a.json"), 1_000, 1_000);
  utimesSync(join(stateHome, "coding-agents-tmux", "status-cache", "main.json"), 9_000, 9_000);
  utimesSync(join(relocated, "b.json"), 5_000, 5_000);

  const saved = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    CODING_AGENTS_TMUX_CODEX_STATE_DIR: process.env.CODING_AGENTS_TMUX_CODEX_STATE_DIR,
  };
  try {
    process.env.XDG_STATE_HOME = stateHome;
    delete process.env.CODING_AGENTS_TMUX_CODEX_STATE_DIR;
    assert.equal(newestInputMtime(), 1_000_000, "status-cache subdir must be ignored");

    process.env.CODING_AGENTS_TMUX_CODEX_STATE_DIR = relocated;
    assert.equal(newestInputMtime(), 5_000_000);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
