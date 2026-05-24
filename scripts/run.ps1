# Scribe - bring up Redis + Rust API + Vite SPA together on Windows.
#
# Behaviour:
#   - Starts Redis if it isn't already listening on 127.0.0.1:6379
#     (looks for the bundled `scribe-tools\redis-5.0.14.1\redis-server.exe`,
#      then falls back to anything named `redis-server` on PATH, then
#      `memurai`).
#   - Starts the Rust API (`cargo run -p scribe-server`).
#   - Starts the SPA (`pnpm --filter @scribe/web dev`).
#   - Tags each line of output with [api] or [web] so they're readable
#     side by side.
#   - Ctrl+C tears everything down cleanly.
#
# Idempotent - running twice doesn't duplicate processes; the script
# only stops things it started.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "▶ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RepoRoot

function Listening($port) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  return $null -ne $c
}

# ---- Redis ----------------------------------------------------------------
$StartedRedis = $false
$RedisProcess = $null
if (Listening 6379) {
  Write-Host "✓ Redis already running on :6379" -ForegroundColor Green
} else {
  # Try the path the setup script installed to, then PATH lookups.
  $candidates = @(
    "$env:USERPROFILE\scribe-tools\redis-5.0.14.1\redis-server.exe",
    (Get-Command redis-server -ErrorAction SilentlyContinue).Source,
    (Get-Command memurai -ErrorAction SilentlyContinue).Source
  ) | Where-Object { $_ -and (Test-Path $_) }

  if (-not $candidates) {
    Fail "Redis isn't running and no redis-server.exe / memurai.exe found. Run .\scripts\setup.ps1 first."
  }
  $redisBin = $candidates[0]
  Info "Starting Redis ($redisBin)..."
  # WindowStyle Hidden so the redis console doesn't steal focus; logs
  # go to runtime.redis.log alongside the other runtime logs.
  $RedisProcess = Start-Process -FilePath $redisBin `
    -WorkingDirectory (Split-Path $redisBin -Parent) `
    -ArgumentList '--port', '6379', '--save', '""', '--appendonly', 'no' `
    -RedirectStandardOutput (Join-Path $RepoRoot 'runtime.redis.log') `
    -RedirectStandardError  (Join-Path $RepoRoot 'runtime.redis.err.log') `
    -WindowStyle Hidden -PassThru
  $StartedRedis = $true
  # Wait until it actually accepts TCP connections - the API's
  # queue-init runs once at startup and gives up after one failure.
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline -and -not (Listening 6379)) { Start-Sleep -Milliseconds 200 }
  if (-not (Listening 6379)) { Fail "Redis failed to start. See runtime.redis.log" }
}

# ---- Spawn API + SPA as background jobs ----------------------------------
# Using Start-Job rather than Start-Process lets us capture both
# stdout + stderr through Receive-Job into the same prefixed stream.
Info "Starting Rust API..."
$apiJob = Start-Job -Name 'scribe-api' -ScriptBlock {
  param($root)
  Set-Location $root
  & cargo run --manifest-path "servers\rust\Cargo.toml" -p scribe-server 2>&1
} -ArgumentList $RepoRoot

Info "Starting Vite SPA on :5173..."
$webJob = Start-Job -Name 'scribe-web' -ScriptBlock {
  param($root)
  Set-Location $root
  $env:CI = 'true'
  & pnpm --filter @scribe/web dev 2>&1
} -ArgumentList $RepoRoot

Write-Host ""
Write-Host "Up." -ForegroundColor Green
Write-Host "  - API   http://localhost:3000   (or PORT from .env)"
Write-Host "  - SPA   http://localhost:5173"
Write-Host "  - Redis 127.0.0.1:6379"
Write-Host ""
Write-Host "Ctrl+C to stop everything." -ForegroundColor DarkGray
Write-Host ""

# ---- Stream output --------------------------------------------------------
$stopRequested = $false
$null = Register-EngineEvent -SourceIdentifier ConsoleCancelEventHandler -Action { $script:stopRequested = $true }

try {
  while (-not $stopRequested) {
    # Drain any new output from both jobs. Receive-Job is non-blocking
    # when -Keep is omitted, so we poll every 200 ms; that's a fine
    # tradeoff between latency and CPU.
    foreach ($line in (Receive-Job $apiJob)) {
      Write-Host "[api] " -ForegroundColor Cyan -NoNewline; Write-Host $line
    }
    foreach ($line in (Receive-Job $webJob)) {
      Write-Host "[web] " -ForegroundColor Magenta -NoNewline; Write-Host $line
    }
    if ($apiJob.State -eq 'Failed' -or $apiJob.State -eq 'Completed') {
      Warn "API job exited (state: $($apiJob.State))"; break
    }
    if ($webJob.State -eq 'Failed' -or $webJob.State -eq 'Completed') {
      Warn "Web job exited (state: $($webJob.State))"; break
    }
    Start-Sleep -Milliseconds 200
  }
} finally {
  Write-Host ""
  Write-Host "⏻ Shutting down..." -ForegroundColor Yellow
  Stop-Job  $apiJob, $webJob -ErrorAction SilentlyContinue
  Remove-Job $apiJob, $webJob -Force -ErrorAction SilentlyContinue
  # Kill the cargo + node child processes the jobs spawned — Stop-Job
  # signals the runspace but doesn't propagate to grandchildren.
  Get-Process -Name 'scribe-server','node','cargo' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($RepoRoot) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  if ($StartedRedis -and $RedisProcess) {
    Stop-Process -Id $RedisProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
