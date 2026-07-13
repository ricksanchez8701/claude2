@echo off
setlocal enabledelayedexpansion

set "CLAUDE2_DIR=%~dp0.."
set "PROXY_SCRIPT=%CLAUDE2_DIR%\server\proxy.mjs"
set "CLAUDE_BIN=C:\Users\D34TH\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"

echo [claude2] Starting opencode bridge proxy...
start "claude2-proxy" /B node "%PROXY_SCRIPT%"

timeout /t 2 /nobreak >nul

echo [claude2] Launching Claude Code CLI with opencode as the AI driver...
echo [claude2] ANTHROPIC_BASE_URL=http://127.0.0.1:3124

set "ANTHROPIC_BASE_URL=http://127.0.0.1:3124"
set "CLAUDE_CODE_ATTRIBUTION_HEADER=false"
set "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true"
set "ANTHROPIC_AUTH_TOKEN=opencode-bridge"
set "ANTHROPIC_API_KEY=opencode-bridge"
set "CLAUDE_CODE_ENTRYPOINT=cli"

"%CLAUDE_BIN%" %*

echo [claude2] Claude Code session ended.
echo [claude2] To stop the proxy: taskkill /f /im node.exe /fi "WindowTitle eq claude2-proxy"
