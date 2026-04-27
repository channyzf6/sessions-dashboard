// Tests for ClaudeAdapter._resolvePath. Run with:
//   node --test lib/host/claude.test.mjs
//
// Specifically covers the sticky-binding + last-line-timestamp resolver
// (added in v0.4.6 to fix cross-session contamination between resumed
// sibling sessions in the same cwd).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "./claude.mjs";

// Build a project dir under a fake $HOME / $USERPROFILE that mirrors the
// real layout (~/.claude/projects/<encoded-cwd>/). Returns { home, cwd }
// where cwd is what to pass to the adapter ctx.
function makeProjectDir({ cwd }) {
  const home = mkdtempSync(path.join(tmpdir(), "ghs-claude-"));
  const encoded = String(cwd).replace(/[:\\/_]/g, "-");
  const dir = path.join(home, ".claude", "projects", encoded);
  mkdirSync(dir, { recursive: true });
  return { home, dir };
}

function writeJsonl(fp, lines, mtimeMs) {
  writeFileSync(fp, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  if (mtimeMs) {
    const sec = mtimeMs / 1000;
    utimesSync(fp, sec, sec);
  }
}

function withHome(home, fn) {
  const prevH = process.env.HOME;
  const prevU = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return Promise.resolve(fn()).finally(() => {
    if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH;
    if (prevU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevU;
  });
}

test("resolver picks the JSONL whose last-line ts is closest to sessionStart", async () => {
  const cwd = "C:\\fake\\proj";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    // Both files: first-entry timestamps 15+ min before sessionStart
    // (resumed-session shape). Last-entry timestamps differ — only A's
    // tail is near our sessionStart; B's tail is 4 minutes earlier.
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "aaaa.jsonl");
    const b = path.join(dir, "bbbb.jsonl");
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T15:08:00.000Z", content: "old" },
      { type: "assistant", timestamp: "2026-04-27T15:23:38.500Z", message: { content: [] } },
    ], Date.parse("2026-04-27T15:23:38.500Z"));
    writeJsonl(b, [
      { type: "user", timestamp: "2026-04-27T15:11:00.000Z", content: "old" },
      { type: "assistant", timestamp: "2026-04-27T15:20:00.000Z", message: { content: [] } },
    ], Date.parse("2026-04-27T15:23:39.000Z")); // freshest mtime — would have won under old fallback

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const pick = await ad._resolvePath();
      assert.equal(pick, a, "last-line ts on A is 0.5s from sessionStart; B's is 3:39 — A must win");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolver returns null (no fallback) when no JSONL's last-line ts is within 30s", async () => {
  const cwd = "C:\\fake\\proj2";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    // Two stale sibling JSONLs whose last lines predate sessionStart by
    // many minutes. Pre-fix this would have returned the most-recent-mtime
    // one (cross-contamination). Post-fix returns null — the watcher
    // re-tries next tick.
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "aaaa.jsonl");
    const b = path.join(dir, "bbbb.jsonl");
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T15:09:00.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:23:40.000Z"));
    writeJsonl(b, [
      { type: "user", timestamp: "2026-04-27T15:11:00.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:23:39.500Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const pick = await ad._resolvePath();
      assert.equal(pick, null, "no candidate within 30s window — must not fall back to most-recent mtime");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolver is sticky: subsequent calls return the cached path even if a sibling becomes more recent", async () => {
  const cwd = "C:\\fake\\proj3";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "aaaa.jsonl");
    const b = path.join(dir, "bbbb.jsonl");
    // Initial: only A has a recent last-line ts. B is stale.
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T15:23:38.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:23:38.000Z"));
    writeJsonl(b, [
      { type: "user", timestamp: "2026-04-27T15:20:00.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:20:00.000Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const first = await ad._resolvePath();
      assert.equal(first, a, "first call binds to A");

      // Now B becomes the more recent file (sibling activity). Pre-fix
      // the resolver would re-evaluate and flip to B's most-recent-mtime.
      writeJsonl(b, [
        { type: "user", timestamp: "2026-04-27T15:23:38.000Z", content: "x" },
        { type: "assistant", timestamp: "2026-04-27T15:30:00.000Z", message: { content: [] } },
      ], Date.parse("2026-04-27T15:30:00.000Z"));

      const second = await ad._resolvePath();
      assert.equal(second, a, "sticky binding: subsequent call still returns A despite B now being most-recent");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolver re-binds if the cached file disappears", async () => {
  const cwd = "C:\\fake\\proj4";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "aaaa.jsonl");
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T15:23:39.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:23:39.000Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      assert.equal(await ad._resolvePath(), a);
      rmSync(a);
      const after = await ad._resolvePath();
      assert.equal(after, null, "cached path stat fails — re-resolve runs and finds nothing");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ignores a JSONL whose mtime is older than sessionStart-2s", async () => {
  // Confirms the existing mtime hard-filter still applies — stale
  // transcripts from old sessions can't be picked up via this code path
  // (unless they're being actively written, in which case mtime catches up).
  const cwd = "C:\\fake\\proj5";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const stale = path.join(dir, "stale.jsonl");
    writeJsonl(stale, [
      { type: "user", timestamp: "2026-04-27T15:23:39.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:00:00.000Z")); // mtime way before sessionStart

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      assert.equal(await ad._resolvePath(), null, "stale-mtime file filtered out before tail-read");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
