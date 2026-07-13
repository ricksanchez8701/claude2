# claude2

Claude Code CLI with opencode as the AI driver — no API key required.

## Architecture

\\\
You type in CLI → claude.exe → ANTHROPIC_BASE_URL → local proxy (Node.js)
    → queue/request_<id>.json → opencode processes it
    → queue/response_<id>.ndjson → proxy formats as SSE events
    → claude.exe renders in UI + executes tools → loop continues
\\\

## Files

| File | Purpose |
|------|---------|
| \server/proxy.mjs\ | Anthropic Messages API-compatible proxy (listens on :3124) |
| \in/claude2.cmd\ | Launcher: starts proxy + claude.exe with \ANTHROPIC_BASE_URL\ |
| \in/respond.mjs\ | Helper to write SSE response events for the proxy |
| \in/watch.ps1\ | Watches for incoming requests from the CLI |

## Usage

### Quick start

\\\powershell
# Terminal 1: Start the proxy
node server/proxy.mjs

# Terminal 2: Launch the CLI connected to the proxy
set ANTHROPIC_BASE_URL=http://127.0.0.1:3124
set ANTHROPIC_API_KEY=opencode-bridge
set CLAUDE_CODE_ATTRIBUTION_HEADER=false
set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true
claude.exe

# When the user types in the CLI, a request appears in queue/
# Respond with:
node bin/respond.mjs <request-id> --text "Your response here" --clean
\\\

### Responding with tool calls

\\\powershell
node bin/respond.mjs <id> --tool Bash '{"command":"ls -la"}' --stop tool_use --clean
\\\

## Binary Patching (for standalone use)

For a fully standalone \claude2.exe\ that doesn't need an opencode session:

1. Install Bun: \
pm install -g bun\
2. Extract the binary: \un-demincer claude.exe ./extracted\
3. Patch \services/api/client.ts\ — remove API key requirement
4. Patch \services/api/claude.ts\ — replace \queryModel\ with opencode backend
5. Re-bundle: \un build --compile ./main.ts --outfile claude2.exe\

The patching gives you the complete CLI UI + tool ecosystem with opencode as the AI.