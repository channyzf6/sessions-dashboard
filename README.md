# web-view

A shared browser window for Claude Code. One long-lived daemon owns a single Chromium instance; every Claude Code session connects to it via an MCP proxy, so **multiple sessions interact with the same window**.

Built on Playwright. No extra runtime deps beyond Node 18+.

## Architecture

```
session A ──┐
            ├── MCP stdio ──► index.mjs (proxy) ──► HTTP 127.0.0.1:8787 ──┐
session B ──┘                                                             │
                                                                          ▼
                                                             daemon.mjs ──► Chromium
```

- `index.mjs` — MCP server (one per session). Pings the daemon; spawns it detached if not running.
- `daemon.mjs` — HTTP server on `127.0.0.1:8787`. Owns the browser. Survives Claude Code restarts.
- Concurrent daemon spawns are safe: the loser hits `EADDRINUSE` and exits cleanly.

## Tools

| Tool | Purpose |
|---|---|
| `open_webview` | Open the shared window with a `url` or `html`. Replaces any existing page. |
| `update_webview` | Navigate the open window to a `url` or replace its `html`. |
| `eval_js` | Run a JS expression (async OK) in the page; returns JSON-serialized value. |
| `screenshot` | PNG of the page. `fullPage: true` for full scroll height. |
| `close_webview` | Close the page and browser (daemon stays up for next open). |
| `list_webviews` | Enumerate open named windows — `{ name, url, title, startedAt }`. |
| `open_dashboard` | Open a registered dashboard from `data/dashboards.json` in its own named window. |
| `list_dashboards` | List dashboards registered in `data/dashboards.json`. |
| `set_session_name` | Set or clear a human-readable name for this session. |
| `daemon_info` | `{ pid, port, startedAt, browserConnected, webviews[], sessions[] }` — useful for debugging. |

## Install

```bash
cd ~/.claude/extensions/web-view
npm install
```

`postinstall` pulls Playwright's Chromium build.

## Register with Claude Code

`~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "web-view": {
      "command": "node",
      "args": ["<path to web-view>/index.mjs"]
    }
  }
}
```

On Windows, replace `<path to web-view>` with something like `C:\\Users\\<username>\\.claude\\extensions\\web-view` (note the escaped backslashes). On macOS / Linux, `~/.claude/extensions/web-view` works directly.

Or use the CLI:

```bash
claude mcp add web-view --scope user -- node "~/.claude/extensions/web-view/index.mjs"
```

Restart Claude Code. Tools appear as `mcp__web-view__*`.

## Multi-session usage

- Session A: `open_webview({ url: "..." })` → daemon starts, Chromium opens.
- Session B: `eval_js({ expression: "document.title" })` → same page, same daemon.
- Either session: `screenshot({})`, `update_webview({ ... })`.
- Close Claude Code in session A → daemon keeps running → reopen or spawn session B later → browser still live.

## Configuration

- `WEB_VIEW_PORT` env var overrides the port (default `8787`). All sessions must agree on the port; set it in the MCP server `env` block if you change it.
- `WEB_VIEW_AUTOSTART` — by default the daemon is **dormant** until a webview tool is invoked. Set to `1` in the MCP server `env` block to spawn the daemon + register the session at Claude Code startup (makes the session show up in the sessions dashboard before any tool is called).
- Only one daemon is expected per port. The first to bind wins.

## Troubleshooting

- `daemon_info` returns the PID — use `taskkill /F /PID <pid>` (Windows) to force-kill a wedged daemon.
- If the Chromium window is gone but the daemon is alive, next `open_webview` relaunches Chromium.
- If `ping` / `/call` fails repeatedly, the daemon may be wedged; kill it and let the next tool call respawn it.
