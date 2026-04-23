// Tests for GeminiAdapter. Run with:
//   node --test lib/host/gemini.test.mjs
// No external test framework — uses Node's built-in `node:test`.
//
// Tests bypass `_locate()` (the disk-walking session-finder) by monkey-
// patching it to return the fixture path. scanActivity() always re-calls
// _locate at the top, so setting _chatFilePath directly does not work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GeminiAdapter } from "./gemini.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = (n) => join(__dirname, "__fixtures__", n);

test("test runner sanity", () => {
  assert.equal(1 + 1, 2);
});

test("legacy .json: parses atomic ConversationRecord and derives snapshot", async () => {
  const a = new GeminiAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-22T04:13:55.394Z",
    pid: 1,
  });
  a._locate = async () => FIX("gemini-legacy.json");
  const snap = await a.scanActivity();
  assert.equal(snap.count, 1, "one tool call counted across the conversation");
  assert.equal(snap.activityState, "idle", "no recent calls within RECENT_CALL_MS → idle");
  assert.equal(snap.toolName, null);
});
