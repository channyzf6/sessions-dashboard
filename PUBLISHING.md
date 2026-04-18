# web-view — Publishing & Roadmap

Working doc for taking the `web-view` MCP server from a private hack to a public release on GitHub and the Anthropic plugin marketplace.

---

## 1. What this is (elevator pitch)

A Model Context Protocol server that gives AI agents a **shared, persistent browser window**. One long-lived daemon owns a single Chromium instance; every MCP client (Claude Code session, Claude Desktop, Cursor, custom agent) connects to it and drives the same set of windows.

**The novel primitive**: multi-agent coordination around a shared visual surface. Most web-view MCPs are single-session (playwright-mcp, browser-use). Here, N sessions share state — which means:

- Two Claude Code sessions can watch the same live dashboard update as each posts results.
- A long-running agent can leave a window open; a new session picks up exactly where it left off after restart.
- A "sessions" dashboard shows every connected agent in real time — who's live, who's idle, what cwd they're in, what name they've claimed.

The demo that sells it: a GIF of two CC terminals in split-view, each appending experiments to the same dashboard, cards pulsing as they land.

---

## 2. Technical architecture

```
session A ──┐
            ├── MCP stdio ──► index.mjs (proxy) ──► HTTP 127.0.0.1:8787 ──┐
session B ──┘                                                             │
                                                                          ▼
                                                             daemon.mjs ──► Chromium
                                                                              ├── window "main"
                                                                              ├── window "sessions"
                                                                              └── window "custom-dashboard"
```

### Components

| Component | Role |
|---|---|
| `index.mjs` | MCP server (one per session). Thin stdio → HTTP proxy. Registers this session, heartbeats every 5 s, propagates `/rename` changes. |
| `daemon.mjs` | Long-lived HTTP server on `127.0.0.1:<port>`. Owns Chromium via Playwright. Tracks named windows, connected sessions, serves dashboard config + data. |
| `data/dashboards.json` | Registry of named dashboards (url, size, title, autoOpen). |
| `data/*.html` | Bundled dashboard HTML (`sessions.html` ships by default; add your own to the `data/` directory and register them in `dashboards.json`). |

### Key design choices

- **One BrowserContext per named window** (`daemon.mjs:26`). Each `name` maps to its own OS window (not a tab). `open_webview({ name: "sessions" })` opens a second window next to `open_webview({ name: "main" })`.
- **Lazy daemon startup** (`index.mjs:23`, `WEB_VIEW_AUTOSTART`). Installing the MCP server does **not** spawn a background process. The daemon boots on the first tool call. Set `WEB_VIEW_AUTOSTART=1` in the MCP server env block to opt into eager spawn (makes the session appear in the sessions dashboard before any tool is called).
- **Session presence via heartbeat**. MCP proxies POST to `/session/register` on first activity, heartbeat `/session/heartbeat` every 5 s, and `unregister` best-effort on shutdown. Stale sessions (no heartbeat for 15 s) are expired server-side.
- **Session-name discovery** (`index.mjs:114`). The proxy scans `~/.claude/projects/<encoded-cwd>/*.jsonl` for `/rename` commands and adopts the latest — so a user-chosen name survives CC restarts without config.
- **Concurrent-safe spawn**. If two MCP proxies start simultaneously and both try to spawn the daemon, the loser hits `EADDRINUSE` and exits cleanly (`daemon.mjs`).
- **Dashboard registry**. `dashboards.json` names reusable dashboards; `open_dashboard({ name: "sessions" })` is a one-arg shortcut that pulls URL, size, and title from config.
- **CORS-enabled daemon HTTP** (locked to `file://` / loopback origins only). Dashboards loaded from `file://` can fetch daemon endpoints (`/sessions`, `/session-groups`) directly without needing a separate static-file server.

### Tool surface

| Tool | Purpose |
|---|---|
| `open_webview` | Open a named window with `url` or `html`. Re-navigates if the name already exists. |
| `update_webview` | Navigate or replace HTML of an existing window. |
| `eval_js` | Run async JS in the page; returns JSON-serialized value. |
| `screenshot` | PNG of the page (full-page optional). |
| `close_webview` | Close a named window (daemon stays up). |
| `list_webviews` | Enumerate open windows. |
| `open_dashboard` | Open a named dashboard from `dashboards.json`. |
| `list_dashboards` | List registered dashboards. |
| `set_session_name` | Set or clear the human-readable session name. |
| `daemon_info` | `{pid, port, uptime, browserConnected, webviews[], sessions[]}`. |

### Lifecycle guarantees

- Daemon survives Claude Code restarts (detached process, unref'd).
- Browser window survives MCP proxy restart as long as the daemon is alive.
- If the daemon is manually killed, the next MCP tool call respawns it — but any previously open windows are gone.
- If Chromium is closed manually, the daemon detects `disconnected` and clears state; next `open_webview` relaunches the browser.

---

## 3. Proposed public README

What follows is a drop-in replacement for the repo's root `README.md` when it goes public. Kept skimmable; heavy on copy-pasteable commands.

````markdown
# web-view

> A shared browser window for AI agents. One Chromium instance, many sessions.

[![npm](https://img.shields.io/npm/v/web-view-mcp.svg)](https://www.npmjs.com/package/web-view-mcp)
[![mcp](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

<!-- demo.gif goes here — two CC sessions updating the same dashboard side-by-side -->

Most browser-automation MCPs (playwright-mcp, browser-use) give each session its own headless browser. `web-view` does the opposite: **one long-lived daemon owns a single Chromium instance, and every MCP client connects to the same windows**. Two agents can watch the same dashboard, drive the same app, or coordinate via a shared UI surface.

## Why

- **Multi-agent dashboards.** Point two Claude Code sessions at the same dashboard URL; both push live updates, both see each other's cards pulse in.
- **Persistence across restarts.** Close Claude Code, reopen it — your windows are still there.
- **A coordination primitive.** Session registry + presence heartbeat + named windows = a minimal substrate for agents that need to see each other.

## Install

```bash
npm install -g web-view-mcp
```

Then register it with your MCP client.

**Claude Code:**
```bash
claude mcp add web-view -- npx -y web-view-mcp
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):
```json
{
  "mcpServers": {
    "web-view": { "command": "npx", "args": ["-y", "web-view-mcp"] }
  }
}
```

**Cursor** — add to `~/.cursor/mcp.json` with the same config.

Restart your client. Tools appear as `mcp__web-view__*`.

## Quickstart

```
> open_webview({ url: "https://example.com" })
> eval_js({ expression: "document.title" })
> screenshot({})
```

From a second session, call `eval_js` on the same window — you're looking at the same page.

## Tools

| Tool | Purpose |
|---|---|
| `open_webview` | Open a named window. Each `name` is a separate OS window. |
| `update_webview` | Navigate or replace HTML. |
| `eval_js` | Run async JS; returns JSON. |
| `screenshot` | PNG. `fullPage: true` for full scroll height. |
| `close_webview` | Close the window (daemon stays up). |
| `list_webviews` | Enumerate open windows. |
| `open_dashboard` | Open a pre-registered dashboard by name. |
| `daemon_info` | Status of the daemon + connected sessions. |

## Configuration

Env vars, settable in the MCP server's `env` block:

- `WEB_VIEW_PORT` — port (default `8787`). All sessions must agree on the port.
- `WEB_VIEW_AUTOSTART` — `1` to spawn the daemon at MCP server startup. Default is **lazy**: the daemon is dormant until you invoke a tool. Set `1` if you want this session to appear in the sessions dashboard immediately.

## Shared dashboards

Register reusable dashboards in `data/dashboards.json`:
```json
{
  "dashboards": {
    "sessions": {
      "title": "Connected Sessions",
      "url": "file:///.../data/sessions.html",
      "width": 1100,
      "height": 800
    }
  }
}
```

Then `open_dashboard({ name: "sessions" })` opens it with the right size and title.

## Troubleshooting

- **`daemon_info` says the daemon is elsewhere.** `WEB_VIEW_PORT` mismatch between clients.
- **Windows won't open.** The daemon may be wedged. `taskkill /F /PID <pid>` (Windows) or `kill <pid>` (macOS/Linux). Next tool call respawns.
- **Chromium closed manually, daemon still alive.** Next `open_webview` relaunches the browser.

## License

MIT
````

---

## 4. Installation & distribution guide

### Option A — publish as an npm MCP server (widest reach)

This is the primary distribution path. Works with every MCP client (Claude Code, Claude Desktop, Cursor, custom agents).

**Prep checklist:**

1. Choose a package name — `web-view-mcp`, `mcp-web-view`, or `@<scope>/web-view` if scoped.
2. Verify it's available: `npm view web-view-mcp`.
3. Audit `package.json`:
   - `"bin": { "web-view-mcp": "./index.mjs" }` — makes the package runnable via `npx`.
   - `"main": "./index.mjs"`, `"type": "module"`, `"engines": { "node": ">=18" }`.
   - `"files"`: include `index.mjs`, `daemon.mjs`, `data/`, `README.md`, `LICENSE`. Exclude `node_modules`, `*.rendered.html`, local dashboards you don't want to ship.
   - `"postinstall": "node node_modules/playwright/install.js chromium"` — pulls Chromium on install so users don't hit a first-run delay. (Or use `playwright-core` + make users run `npx playwright install chromium` explicitly; trade-off between install-time footprint and UX.)
4. Add a `LICENSE` file (MIT recommended — max adoption).
5. Smoke-test with `npm pack && npm install -g ./web-view-mcp-0.3.0.tgz` before publishing.
6. `npm publish --access public`.

**Then the install story is one command:**
```bash
claude mcp add web-view -- npx -y web-view-mcp
```

### Option B — ship as a Claude Code plugin (better CC-user onboarding)

Plugins bundle MCP servers, skills, commands, and hooks into a single installable unit. This gets you marketplace visibility inside Claude Code.

**Plugin layout:**
```
web-view-plugin/
├── plugin.json           # plugin manifest
├── mcp/
│   └── web-view/         # bundled MCP server (or depend on npm package)
├── skills/
│   └── open-dashboard/   # trigger skill
│       └── SKILL.md
└── commands/
    └── sessions.md       # slash command that opens the sessions dashboard
```

**`plugin.json` skeleton:**
```json
{
  "name": "web-view",
  "version": "1.0.0",
  "description": "Shared browser window for Claude Code agents",
  "mcpServers": {
    "web-view": { "command": "npx", "args": ["-y", "web-view-mcp"] }
  },
  "skills": ["skills/open-dashboard"],
  "commands": ["commands/sessions.md"]
}
```

Keep the plugin thin: it depends on the npm-published MCP server rather than re-bundling. One source of truth, two surfaces.

**Marketplace submission** (Anthropic plugin marketplace):
1. Publish your plugin repo under an `anthropics/claude-plugins-marketplace`-compatible structure (check current docs for the exact schema at publish time).
2. Open a PR to the marketplace index with a `marketplace.json` entry.
3. Include screenshots, a demo GIF, and a clear README. Anthropic curates — polish matters.

### Option C — Claude Desktop extension (`.dxt` bundle)

Claude Desktop supports one-click installers via the `.dxt` format. This targets the non-developer audience (people who don't want to edit JSON configs). Wrap the npm package in a `.dxt` manifest and publish to the Desktop extension directory. Lower priority than A and B, but a meaningful reach expansion if the tool gains traction.

### Recommended sequence

1. **Ship npm package first** — broadest reach, easiest to iterate.
2. **Then a plugin wrapper** — gets you into the marketplace without duplicating code.
3. **Eventually a `.dxt`** — if adoption justifies the maintenance cost.

---

## 5. Pre-launch checklist

Must-have before going public:

- [ ] **Cross-platform testing** — code currently has Windows-centric bits (`taskkill` in README, `\` path handling in `discoverSessionName`). Verify on macOS and Linux. Normalize path handling.
- [ ] **MIT LICENSE** file.
- [ ] **Public README** with a demo GIF above the fold. GIF matters more than the prose.
- [ ] **Screenshots** of multi-session dashboard updates.
- [ ] **CI** — a single GitHub Actions job that installs, lints, and runs a Playwright smoke test (launch daemon, open a page, eval_js, close). Badge on the README.
- [ ] **Security posture doc** — single paragraph explaining: daemon binds `127.0.0.1` only, no auth by default, localhost-only, don't expose via tunnels, etc. Pre-empts the inevitable issue.
- [ ] **Node version floor** — test on Node 18, 20, 22.
- [x] **Strip user-specific demo data** — done (no private dashboards or data files ship). Consider adding a generic example dashboard (e.g. multi-agent task tracker) to `data/` before release.
- [ ] **CHANGELOG.md**.
- [ ] **Error messages** audited for clarity (e.g. "No webview open with name 'main'. Call open_webview first." — already good).

Nice-to-haves:

- [ ] Prebuilt Chromium skip flag (`WEB_VIEW_SKIP_BROWSER_INSTALL=1`) for users who already have Playwright's browsers.
- [ ] `--version` / `--help` flags on the binary for discoverability.
- [ ] A "hello world" example repo that uses the MCP server from a custom agent.

---

## 6. Roadmap

### v0.4 — polish (private)
- [x] Client-side refresh pattern for file://-loaded dashboards (fetch daemon endpoints via CORS).
- [x] Lazy-by-default daemon startup (`WEB_VIEW_AUTOSTART`).
- [ ] Click-to-focus: click a session in the sessions dashboard to foreground that terminal (HWND registry + `SetForegroundWindow` via a small PowerShell bridge on Windows; `osascript` / `wmctrl` on macOS / Linux).
- [ ] Hot-reload of `dashboards.json` (watch file, push to open windows).
- [ ] Dashboard `autoOpen: true` — auto-open flagged dashboards on daemon boot.

### v1.0 — public release
- [ ] Everything in the pre-launch checklist.
- [ ] Package renamed / scoped for npm publish.
- [ ] First-time-user docs include a 2-minute video.
- [ ] Launch post (see §8).

### v1.1+ — growth
- [ ] **Optional auth token.** Env var `WEB_VIEW_TOKEN`; daemon rejects calls without it. Unblocks non-localhost scenarios.
- [ ] **Remote mode.** Daemon on a different machine. Useful for headless servers + remote dashboards.
- [ ] **Pluggable window backend.** Currently Chromium-only; add Webkit and Firefox via Playwright's other drivers.
- [ ] **Window tiling API.** `arrange_windows({ layout: "grid" })` for demos with many dashboards.
- [ ] **Session chat channel.** Lightweight message-passing between sessions through the daemon — a shared blackboard primitive. Crosses the line from "shared browser" to "coordination hub."
- [ ] **Recording / replay.** `start_recording({ window: "main" })` dumps a Playwright trace; reopenable in the trace viewer. Great for debugging agent behavior.
- [ ] **Dashboard auth via signed URLs.** For dashboards that point at hosted resources.

### Stretch ideas (post-1.x)

- Native app packaging so the daemon runs as a proper macOS/Windows service.
- Browser extension that lets humans participate in the shared window (annotate, take over, hand back control).
- A hosted demo: claim a session ID, watch Anthropic's example agent drive a sandbox dashboard in real time.

---

## 7. What sets this apart (positioning)

When writing copy for the launch, lean on these — don't bury them:

1. **"Multi-agent, one browser."** This is the one-line pitch. Everything else is consequence.
2. **Lazy by default.** Installing costs you nothing until you use it. A small detail that signals care.
3. **Survives restarts.** Close your editor, reopen — your window is still there.
4. **Session presence is built in.** Not just a browser tool — a coordination primitive.
5. **Dashboards-as-code.** `dashboards.json` + any HTML file = a shared live view. No hosting, no infra.

Known limits to be upfront about:
- Single-user / localhost-only by default.
- Chromium-only initially.
- No auth on the local HTTP surface (intentional for v1; adds complexity).
- Windows-tested first; macOS/Linux parity is v1.0 work.

---

## 8. Launch strategy

### Assets to produce
- **Primary demo GIF** (~15 s): two terminal panes, each running a CC session, both updating the same dashboard. The pulse animation on new cards is the visual hook.
- **Secondary demo GIF**: close CC, reopen, window is still there.
- **Architecture diagram** (SVG, not PNG — clean at any zoom).
- **2-minute YouTube demo** linked from the README.

### Channels (in order)
1. **GitHub release** with release notes + GIF.
2. **Twitter / X** — demo GIF + one-paragraph pitch. Tag `@AnthropicAI` and MCP ecosystem folks. The novelty is what gets retweets; don't bury it under API details.
3. **Hacker News** — "Show HN: A shared browser window for AI agents." Post mid-morning US-Eastern on a Tuesday or Wednesday.
4. **Anthropic plugin marketplace** — once the npm package is stable.
5. **MCP community channels** (Discord / GitHub discussions on `modelcontextprotocol/servers`).
6. **Claude Code subreddit / community forums.**
7. **Targeted outreach** to people building multi-agent systems who would immediately get the pitch.

### Anthropic attention
- DevRel tends to amplify tools that push MCP's boundaries. "Multi-agent coordination through a shared MCP server" is a concept they haven't showcased much; that's the angle.
- Get the plugin into the marketplace — Anthropic curates what's featured.
- A good launch post that explicitly frames this as "a pattern others can extend" invites a retweet/quote more than "here's my MCP server."
- Consider submitting to the [Anthropic cookbook](https://github.com/anthropics/anthropic-cookbook) as a reference implementation of "multi-agent coordination."

### Success metrics for v1.0
- 500+ GitHub stars in month 1
- 5+ community-contributed dashboards / plugins built on top
- Mentioned or featured by Anthropic at least once
- At least one "I built X on top of web-view" blog post from someone else

---

## 9. Open questions to resolve before launch

- **Package name.** `web-view-mcp` is descriptive but generic. Alternatives: `mcp-coven` (multi-agent vibe), `shared-view`, `glass`. A memorable name helps — this is worth 30 minutes of thought.
- **Maintainer identity.** Personal repo, an org, or community? Affects issue triage expectations and perceived seriousness.
- **Demo dashboard to ship.** `sessions.html` is solid baseline infrastructure. Add a second, visually appealing example dashboard (multi-agent task tracker, shared experiment log, etc.) so the demo GIF has something to point at.
- **Is the plugin a separate repo?** Mono-repo simpler; split repo makes each pitch cleaner. Default: mono-repo with a `plugin/` subdir.
- **Should the daemon ship prebuilt for Windows/macOS/Linux?** For now: no — it's a pure Node script, `npx` is enough. Revisit if install friction is a reported issue.

---

## 10. References

- MCP spec — https://modelcontextprotocol.io
- Claude Code plugin docs — (latest official docs at publish time)
- Playwright — https://playwright.dev
- Reference implementations of popular MCPs to benchmark against: `@modelcontextprotocol/server-filesystem`, `playwright-mcp`, `browser-use`.
