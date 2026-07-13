# watch.ps1 — Check for incoming requests from the Claude Code CLI
# Run this from opencode to see what the user typed
#
# Usage: .\watch.ps1 [--last] [--all] [--poll]
#   --last    Show only the most recent request
#   --all     Show all pending requests
#   --poll    Keep polling every 2 seconds for new requests
#   --clean   Remove completed response files

param(
  [switch]$last,
  [switch]$all,
  [switch]$poll,
  [switch]$clean
)

$queueDir = "$PSScriptRoot\..\queue"
if (-not (Test-Path $queueDir)) { New-Item -ItemType Directory -Force -Path $queueDir | Out-Null }

function Show-Requests {
  $requests = Get-ChildItem "$queueDir\request_*.json" | Sort-Object LastWriteTime -Descending

  if (-not $requests) {
    Write-Host "`n[watch] No pending requests. Waiting for user input in the CLI..." -ForegroundColor DarkGray
    return
  }

  $target = if ($last) { @($requests[0]) } elseif ($all) { $requests } else { @($requests[0]) }

  foreach ($r in $target) {
    $id = $r.Name -replace 'request_', '' -replace '\.json', ''
    $age = [math]::Round(((Get-Date) - $r.LastWriteTime).TotalSeconds)
    Write-Host "`n$('='*60)" -ForegroundColor Cyan
    Write-Host "  REQUEST: $id  (${age}s ago)" -ForegroundColor Yellow
    Write-Host "$('='*60)" -ForegroundColor Cyan
    try {
      $data = Get-Content $r.FullName -Raw | ConvertFrom-Json
      Write-Host "  From: $($data.model)" -ForegroundColor DarkGray
      Write-Host "  Message: `"$(($data.userMessage -replace "`n", "`n           ").Substring(0, [Math]::Min(200, $data.userMessage.Length)))`"" -ForegroundColor White
      if ($data.fullMessages.Count -gt 1) {
        Write-Host "  History: $($data.fullMessages.Count) messages (last user message shown)" -ForegroundColor DarkGray
      }
      if ($data.tools.Count -gt 0) {
        Write-Host "  Available tools: $($data.tools.Count)" -ForegroundColor DarkGray
      }
      Write-Host ""
      Write-Host "  To respond:" -ForegroundColor Green
      Write-Host "    node `"$PSScriptRoot\respond.mjs`" $id --text `"<your response>`" --clean" -ForegroundColor Green
      Write-Host "  To respond with a tool call:" -ForegroundColor Green
      Write-Host "    node `"$PSScriptRoot\respond.mjs`" $id --tool Bash `"{`"command`":`"<cmd>`"}`" --clean" -ForegroundColor Green
    } catch {
      Write-Host "  Error reading request: $_" -ForegroundColor Red
    }
  }
}

function Clean-Responses {
  $done = Get-ChildItem "$queueDir\*.done" -ErrorAction SilentlyContinue
  foreach ($f in $done) {
    $id = $f.Name -replace '\.done', '' -replace 'response_', ''
    $resp = "$queueDir\response_$id.ndjson"
    $req = "$queueDir\request_$id.json"
    Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
    Remove-Item $resp -Force -ErrorAction SilentlyContinue
    Remove-Item $req -Force -ErrorAction SilentlyContinue
    Write-Host "[watch] Cleaned up $id" -ForegroundColor DarkGray
  }
}

if ($clean) { Clean-Responses; return }

if ($poll) {
  Write-Host "[watch] Polling for requests every 2s. Ctrl+C to stop." -ForegroundColor Yellow
  while ($true) {
    Show-Requests
    if ($clean) { Clean-Responses }
    Start-Sleep -Seconds 2
    Clear-Host
  }
} else {
  Show-Requests
}
