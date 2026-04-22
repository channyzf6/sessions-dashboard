// Host detection + adapter selection. The proxy calls this once at startup
// to figure out which CLI spawned it (Claude Code, Gemini CLI, ...) and
// gets back a configured HostAdapter it will call for activity + name work.

import fsp from "node:fs/promises";
import path from "node:path";
import { HOST, HostAdapter } from "./base.mjs";
import { ClaudeAdapter } from "./claude.mjs";
import { GeminiAdapter } from "./gemini.mjs";

// Probe Claude's per-cwd transcript dir. Returns {mtime} of the most-recent
// .jsonl in that dir, or null if nothing's there. cwd encoding must match
// what Claude Code uses: replace [:\/_] with "-".
async function probeClaudeDir(cwd) {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;
  const encoded = String(cwd).replace(/[:\\/_]/g, "-");
  const dir = path.join(home, ".claude", "projects", encoded);
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return null; }
  let mostRecent = 0;
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const st = await fsp.stat(path.join(dir, f));
      if (st.mtimeMs > mostRecent) mostRecent = st.mtimeMs;
    } catch { /* skip unreadable */ }
  }
  return mostRecent > 0 ? { mtime: mostRecent } : null;
}

// Probe Gemini's tmp dirs. Iterate each subdir of ~/.gemini/tmp, read
// .project_root, match on cwd. Returns {mtime} of most-recent chat file
// in that tmp dir, or null if no match or no chats.
async function probeGeminiDir(cwd) {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;
  const tmpDir = path.join(home, ".gemini", "tmp");
  let entries;
  try { entries = await fsp.readdir(tmpDir); } catch { return null; }
  const want = String(cwd).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  for (const e of entries) {
    const entryPath = path.join(tmpDir, e);
    let st; try { st = await fsp.stat(entryPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    let pr;
    try { pr = await fsp.readFile(path.join(entryPath, ".project_root"), "utf8"); } catch { continue; }
    const norm = pr.trim().toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm !== want) continue;
    // Match found — get latest chat mtime for tie-breaking against Claude.
    const chatsDir = path.join(entryPath, "chats");
    let chatFiles;
    try { chatFiles = await fsp.readdir(chatsDir); } catch { return { mtime: st.mtimeMs }; }
    let latest = 0;
    for (const f of chatFiles) {
      if (!f.endsWith(".json")) continue;
      try {
        const fst = await fsp.stat(path.join(chatsDir, f));
        if (fst.mtimeMs > latest) latest = fst.mtimeMs;
      } catch { /* skip */ }
    }
    return { mtime: latest > 0 ? latest : st.mtimeMs };
  }
  return null;
}

/**
 * Detect which host CLI launched us.
 *
 * Priority:
 *   1. SESSIONS_DASHBOARD_HOST env var (explicit override — always wins).
 *   2. Dir-probe: check which host has transcripts for this cwd. If only
 *      one has, pick it. If both have, pick the more recently active.
 *   3. CLAUDE fallback (backward-compat for all existing installs).
 *
 * @param {{ cwd: string }} ctx
 * @returns {Promise<string>}  one of HOST.*
 */
export async function detectHost({ cwd } = {}) {
  const declared = (process.env.SESSIONS_DASHBOARD_HOST || "").toLowerCase().trim();
  if (declared === HOST.CLAUDE) return HOST.CLAUDE;
  if (declared === HOST.GEMINI) return HOST.GEMINI;
  if (!cwd) return HOST.CLAUDE;

  const [claudeHit, geminiHit] = await Promise.all([
    probeClaudeDir(cwd),
    probeGeminiDir(cwd),
  ]);
  if (claudeHit && !geminiHit) return HOST.CLAUDE;
  if (geminiHit && !claudeHit) return HOST.GEMINI;
  if (claudeHit && geminiHit) {
    // Ambiguous — both hosts have worked in this cwd. Pick whichever's
    // transcript was written more recently. If mtimes tie, prefer Claude
    // for backwards-compat.
    return claudeHit.mtime >= geminiHit.mtime ? HOST.CLAUDE : HOST.GEMINI;
  }
  return HOST.CLAUDE;
}

/**
 * Construct a HostAdapter for the detected host.
 * @param {{ host: string, cwd: string, sessionStart: string, pid: number }} ctx
 * @returns {HostAdapter}
 */
export function makeAdapter({ host, cwd, sessionStart, pid }) {
  if (host === HOST.GEMINI) return new GeminiAdapter({ cwd, sessionStart, pid });
  // Default: Claude (also the fallback for HOST.UNKNOWN and unset).
  return new ClaudeAdapter({ cwd, sessionStart, pid });
}
