// Git helpers for session-card branch display.
//
// Two-phase split:
//   - resolveGitDir(cwd): expensive walk up the directory tree, runs once
//     at session register. SESSION_CWD is captured once at proxy startup
//     and never changes, so the resolved git-dir is stable for the
//     session's lifetime.
//   - readHead(gitDir): single-file read, runs on every heartbeat (5s).
//
// We only read `<gitDir>/HEAD` — enough for current-branch / short-sha
// display. `commondir` resolution (needed for packed-refs, config, etc.
// in worktree setups) is deliberately deferred; any future feature that
// needs those will have to extend this module.

import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Walk up from `cwd` looking for a `.git` entry. Returns the absolute path
 * to the git directory, or null if none found (cwd not in a repo).
 *
 * Handles:
 *   - Regular checkout: `.git` is a directory → return it.
 *   - Worktree / submodule: `.git` is a file containing `gitdir: <path>`.
 *     The <path> is interpreted relative to the directory containing the
 *     `.git` file (per git's spec). We follow the redirect once.
 *
 * The 40-iteration cap is a pathological-loop bound; real termination
 * happens via path.dirname() reaching filesystem root (parent === self).
 * It is NOT a symlink-cycle defense — that would require realpath
 * tracking which isn't worth it for a dim UI label.
 */
export async function resolveGitDir(cwd) {
  if (!cwd) return null;
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const gitEntry = path.join(dir, ".git");
    let stat = null;
    try { stat = await fsp.lstat(gitEntry); } catch { /* entry doesn't exist here — walk up */ }
    if (stat?.isDirectory()) return gitEntry;
    if (stat?.isFile()) {
      let content;
      try { content = await fsp.readFile(gitEntry, "utf8"); } catch { return null; }
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      const target = m[1].trim();
      return path.isAbsolute(target) ? target : path.resolve(dir, target);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Read `<gitDir>/HEAD` and parse. Returns one of:
 *   - { branch, sha: null, detached: false }  // branch mode
 *   - { branch: null, sha, detached: true }   // detached HEAD; sha is short (7 chars)
 *   - null                                    // not a git dir, unreadable, or unknown format
 *
 * SHA regex covers both SHA-1 (40) and SHA-256 (up to 64) repos. Harmless
 * for SHA-1 and lets us work unchanged on experimental 2.42+ repos.
 */
export async function readHead(gitDir) {
  if (!gitDir) return null;
  let head;
  try { head = await fsp.readFile(path.join(gitDir, "HEAD"), "utf8"); } catch { return null; }
  head = head.trim();
  const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (refMatch) return { branch: refMatch[1], sha: null, detached: false };
  if (/^[0-9a-f]{40,64}$/.test(head)) return { branch: null, sha: head.slice(0, 7), detached: true };
  return null;
}
