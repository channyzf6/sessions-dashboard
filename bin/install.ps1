# One-shot installer for the sessions-dashboard MCP extension (Windows / PowerShell).
# Detects which supported CLIs are on PATH (Claude Code, Gemini CLI, Codex CLI)
# and registers sessions-dashboard with each one found. Errors only if zero
# supported CLIs are present.
$ErrorActionPreference = "Stop"

$here  = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$index = Join-Path $here "index.mjs"

Write-Host "[1/3] npm install"
Write-Host "      First run downloads Chromium via Playwright (~150 MB) - this can take 30-60s."
Push-Location $here
try { npm install } finally { Pop-Location }

Write-Host ""
Write-Host "[2/3] registering sessions-dashboard with detected CLIs"
$registered = 0
foreach ($cli in @('claude', 'gemini', 'codex')) {
    $found = Get-Command $cli -ErrorAction SilentlyContinue
    if (-not $found) { continue }
    Write-Host "  - $cli detected"
    # CLI-specific flag handling. Claude and Gemini accept `--scope user`
    # to mean "register globally for this user, not per-project." Codex
    # doesn't accept that flag -- its mcp add is global by default. Passing
    # --scope to Codex errors out with "unexpected argument '--scope'."
    #
    # envArgs: pin the host explicitly for every CLI. Without this, the
    # proxy's cold-start dir-probe in registry.mjs picks "the host with
    # the most-recent transcript mtime in this cwd" -- which gets the
    # wrong answer in any mixed-host scenario:
    #   - Codex hasn't flushed session_meta when detection runs.
    #   - Gemini's chat file isn't created until the first user message.
    #   - Claude is the default fallback, but only wins when NO other
    #     host has any transcript in the cwd; once Gemini/Codex have
    #     ever been used here, Claude's fresh sessions can be mis-routed
    #     to whichever of them was touched most recently.
    # Pinning each CLI's registration to its own SESSIONS_DASHBOARD_HOST
    # skips the probe entirely and makes detection deterministic. The
    # dir-probe remains as the fallback for manual-install users who
    # edit settings.json directly without running this script.
    switch ($cli) {
        'claude' { $scopeArgs = @('--scope', 'user'); $envArgs = @('--env', 'SESSIONS_DASHBOARD_HOST=claude') }
        'gemini' { $scopeArgs = @('--scope', 'user'); $envArgs = @('--env', 'SESSIONS_DASHBOARD_HOST=gemini') }
        'codex'  { $scopeArgs = @();                    $envArgs = @('--env', 'SESSIONS_DASHBOARD_HOST=codex') }
    }
    # Idempotent: remove any prior registration so re-running the installer
    # is a no-op update. On PowerShell 7.4+ with $ErrorActionPreference='Stop'
    # and the default $PSNativeCommandUseErrorActionPreference=$true, a
    # non-zero exit from `mcp remove` (which happens on first install
    # when there's nothing to remove) throws a terminating
    # NativeCommandExitException -- catch and discard.
    try {
        & $cli mcp remove sessions-dashboard @scopeArgs 2>$null | Out-Null
    } catch {}
    # Register. Tolerate failure on a single CLI -- keep going so a broken
    # Codex install on Windows doesn't block Claude/Gemini for the same user.
    try {
        & $cli mcp add sessions-dashboard @scopeArgs @envArgs -- node "$index"
        $registered++
    } catch {
        Write-Host "    (registration with $cli failed; continuing)"
    }
}

if ($registered -eq 0) {
    Write-Host ""
    Write-Host "ERROR: no supported CLI found on PATH."
    Write-Host "Install one of: claude, gemini, codex -- then re-run this installer."
    Write-Host "Or register manually:"
    Write-Host ""
    # Single-quoted literal + -f interpolation: PowerShell's parser
    # treats `<` as a reserved redirection operator inside double-quoted
    # strings (errors with "The '<' operator is reserved for future use"
    # at parse time, before the string is even evaluated). Single quotes
    # bypass the redirection lexer entirely.
    Write-Host ('  <cli> mcp add sessions-dashboard --scope user -- node "{0}"' -f $index)
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "[3/3] done -- registered with $registered CLI(s)."
Write-Host "Restart your CLI(s), then ask one of them:"
Write-Host ""
Write-Host '    "Open the sessions dashboard"'
Write-Host ""
Write-Host "  The CLI invokes mcp__sessions-dashboard__open_dashboard and a live"
Write-Host "  browser window appears showing every connected session across all"
Write-Host "  registered CLIs."
