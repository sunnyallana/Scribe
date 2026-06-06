# Scribe — bring up Redis + Rust API + Tauri desktop shell together on Windows.
#
# Behaviour:
#   - Starts Redis if it isn't already listening on 127.0.0.1:6379.
#   - Starts the Rust API (`cargo run -p scribe-server`).
#   - Starts the Tauri desktop (`pnpm --filter @scribe/desktop tauri dev`).
#     Tauri itself spawns the Vite SPA on :5173 via `beforeDevCommand`,
#     so we don't start it separately.
#   - Tags each line of output with [api] or [tauri] so they're readable
#     side by side.
#   - Ctrl+C tears everything down cleanly.
#
# Use this instead of run.ps1 when you want the native window. The
# regular `run.ps1` is still right for browser-only development.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "▶ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
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
  # Outer `@(...)` keeps the result an array even when Where-Object
  # returns one match; otherwise PowerShell unwraps it to a string and
  # `$candidates[0]` returns the first character of the path ("C").
  $candidates = @(
    @(
      "$env:USERPROFILE\scribe-tools\redis-5.0.14.1\redis-server.exe",
      (Get-Command redis-server -ErrorAction SilentlyContinue).Source,
      (Get-Command memurai -ErrorAction SilentlyContinue).Source
    ) | Where-Object { $_ -and (Test-Path $_) }
  )

  if ($candidates.Count -eq 0) {
    Fail "Redis isn't running and no redis-server.exe / memurai.exe found. Run .\scripts\windows\setup.ps1 first."
  }
  $redisBin = $candidates[0]
  Info "Starting Redis ($redisBin)..."
  $RedisProcess = Start-Process -FilePath $redisBin `
    -WorkingDirectory (Split-Path $redisBin -Parent) `
    -ArgumentList '--port', '6379', '--save', '""', '--appendonly', 'no' `
    -RedirectStandardOutput (Join-Path $RepoRoot 'runtime.redis.log') `
    -RedirectStandardError  (Join-Path $RepoRoot 'runtime.redis.err.log') `
    -WindowStyle Hidden -PassThru
  $StartedRedis = $true
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline -and -not (Listening 6379)) { Start-Sleep -Milliseconds 200 }
  if (-not (Listening 6379)) { Fail "Redis failed to start. See runtime.redis.log" }
}

# ---- Vite port pre-check --------------------------------------------------
# Tauri's `beforeDevCommand` runs vite with strictPort:true. Catching
# port 5173 here gives a clearer error than the failure deep in the
# Tauri build output.
if (Listening 5173) {
  if ($StartedRedis -and $RedisProcess) {
    Stop-Process -Id $RedisProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Fail "Port 5173 is already in use. Stop the other Vite dev server (or run.ps1) before running run-desktop.ps1."
}

# ---- Workspace packages ----------------------------------------------------
# Tauri's `beforeDevCommand` spawns the web SPA, whose @scribe/* deps
# resolve through their built dist/ outputs. A fresh clone or `pnpm clean`
# leaves those missing and Vite's dep-scan dies with "Failed to resolve
# entry for package @scribe/ui". Build once when any are missing.
$pkgNames = 'shared', 'ui', 'compiler-client', 'yjs-provider', 'editor'
$pkgMissing = @($pkgNames | Where-Object { -not (Test-Path (Join-Path $RepoRoot "packages\$_\dist\index.js")) })
if ($pkgMissing.Count -gt 0) {
  Info "Building workspace packages (missing dist: $($pkgMissing -join ', '))..."
  $env:CI = 'true'
  & pnpm --filter "@scribe/web^..." build
  if ($LASTEXITCODE -ne 0) { Fail "Workspace package build failed" }
}

# ---- Spawn API + Tauri as background jobs --------------------------------
Info "Starting Rust API..."
# `$using:RepoRoot` is the PSScriptAnalyzer-blessed form for shipping an
# outer-scope variable into a `Start-Job` script block. The
# `param(...) + -ArgumentList` alternative trips
# PSUseUsingScopeModifierInNewRunspaces.
$apiJob = Start-Job -Name 'scribe-api' -ScriptBlock {
  Set-Location $using:RepoRoot
  & cargo run --manifest-path "servers\rust\Cargo.toml" -p scribe-server 2>&1
}

Info "Starting Tauri desktop (window opens after Rust links)..."
$tauriJob = Start-Job -Name 'scribe-desktop' -ScriptBlock {
  Set-Location $using:RepoRoot
  # CI=true keeps pnpm from prompting on first-run; the desktop package
  # already has @tauri-apps/cli installed after pnpm install.
  $env:CI = 'true'
  & pnpm --filter '@scribe/desktop' tauri dev 2>&1
}

Write-Host ""
Write-Host "Up." -ForegroundColor Green
Write-Host "  - API     http://localhost:3000   (or PORT from .env)"
Write-Host "  - SPA     http://localhost:5173   (served by Tauri's vite child)"
Write-Host "  - Redis   127.0.0.1:6379"
Write-Host "  - Desktop window opens when cargo finishes linking"
Write-Host ""
Write-Host "Ctrl+C to stop everything." -ForegroundColor DarkGray
Write-Host ""

# ---- Stream output --------------------------------------------------------
$stopRequested = $false
$null = Register-EngineEvent -SourceIdentifier ConsoleCancelEventHandler -Action { $script:stopRequested = $true }

try {
  while (-not $stopRequested) {
    foreach ($line in (Receive-Job $apiJob)) {
      Write-Host "[api] "   -ForegroundColor Cyan    -NoNewline; Write-Host $line
    }
    foreach ($line in (Receive-Job $tauriJob)) {
      Write-Host "[tauri] " -ForegroundColor Magenta -NoNewline; Write-Host $line
    }
    if ($apiJob.State -eq 'Failed' -or $apiJob.State -eq 'Completed') {
      Warn "API job exited (state: $($apiJob.State))"; break
    }
    if ($tauriJob.State -eq 'Failed' -or $tauriJob.State -eq 'Completed') {
      Warn "Tauri job exited (state: $($tauriJob.State))"; break
    }
    Start-Sleep -Milliseconds 200
  }
} finally {
  Write-Host ""
  Write-Host "⏻ Shutting down..." -ForegroundColor Yellow
  Stop-Job  $apiJob, $tauriJob -ErrorAction SilentlyContinue
  Remove-Job $apiJob, $tauriJob -Force -ErrorAction SilentlyContinue
  # Kill the cargo + node + scribe-desktop child processes the jobs
  # spawned — Stop-Job signals the runspace but doesn't propagate to
  # grandchildren.
  Get-Process -Name 'scribe-server','scribe-desktop','node','cargo' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($RepoRoot) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  if ($StartedRedis -and $RedisProcess) {
    Stop-Process -Id $RedisProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
