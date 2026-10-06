import assert from "node:assert/strict";
import test from "node:test";

import { countChoiceLines } from "../src/core/preview-text.ts";

test("countChoiceLines counts numbered and bulleted choice lines", () => {
  const message = ["Pick one:", "1. apple", "2. pear", "- cherry", "* plum", "not a choice"].join(
    "\n",
  );

  assert.equal(countChoiceLines(message), 4);
});

test("countChoiceLines ignores prose and blank lines", () => {
  assert.equal(countChoiceLines("just some words\n\nmore words"), 0);
});

test("countChoiceLines accepts an optional selection-arrow prefix", () => {
  // The shared (prefixed) form widens Codex's former unprefixed matcher: a
  // highlighted option rendered with a leading ›/> still counts.
  const message = ["› 1. highlighted", "> 2. other", "  3. plain"].join("\n");

  assert.equal(countChoiceLines(message), 3);
});
