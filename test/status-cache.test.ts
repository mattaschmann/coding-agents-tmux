import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readFreshCache } from "../src/status-cache.ts";

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
