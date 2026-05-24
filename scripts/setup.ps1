# Scribe — one-shot setup for Windows.
#
# Installs every runtime tool the project needs:
#   • Node 22+ (corepack -> pnpm; pnpm 11.x requires Node >=22.13)
#   • Visual Studio Build Tools (MSVC + Windows SDK)        — cargo's linker
#   • WebView2 Runtime                                       — Tauri's webview host
#   • Rust toolchain (rustup-init)
#   • Redis (Microsoft port, pinned to 5.0.14.1 from tporadowski/redis)
#   • Tectonic (LaTeX engine)
#   • Optional: pandoc, chktex
#
# Then runs `pnpm install` and `cargo build` to materialise every
# project-level dependency.
#
# Idempotent: re-running skips anything already present.
#
# Usage:
#   .\scripts\setup.ps1
#   .\scripts\setup.ps1 -SkipRust          # if rustup is already installed
#   .\scripts\setup.ps1 -NoOptional        # skip pandoc + chktex
#   .\scripts\setup.ps1 -NoDesktop         # skip MSVC + WebView2 (web-only)
#   .\scripts\setup.ps1 -SkipBuild         # skip the final cargo build pre-warm
#
# Requires Windows 10+ with winget. If winget isn't installed, run
# `App Installer` from the Microsoft Store first.

[CmdletBinding()]
param(
  [switch]$SkipRust,
  [switch]$NoOptional,
  [switch]$NoDesktop,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # suppress noisy progress bars

# ---- pretty output --------------------------------------------------------
function Info($m)  { Write-Host "▶ $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "! $m" -ForegroundColor Yellow }
function Fail($m)  { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }
function Skip($m)  { Write-Host "· $m" -ForegroundColor DarkGray }

function Has-Cmd($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Reload PATH from the registry in this session — winget installs land on
# the system PATH but the current process inherits the older one until we
# re-read it. Without this, `Has-Cmd` returns false right after install.
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

# Project root = parent of this script's directory.
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RepoRoot
Info "Project root: $RepoRoot"

# ---- winget sanity --------------------------------------------------------
if (-not (Has-Cmd 'winget')) {
  Fail "winget not found. Install 'App Installer' from the Microsoft Store, sign out / back in, then re-run."
}

function Winget-Install($id, $label) {
  Info "Installing $label (winget id: $id)..."
  # `--accept-source-agreements --accept-package-agreements` is what makes
  # this non-interactive. `--silent` keeps installer windows hidden where
  # the publisher supports it.
  winget install --id $id --silent --accept-source-agreements --accept-package-agreements -e | Out-Host
  Refresh-Path
}

# ---- Node 22+ + corepack/pnpm ---------------------------------------------
# pnpm 11.x dropped Node 20 support; 22.13 is the minimum it'll boot
# against. winget's OpenJS.NodeJS.LTS currently resolves to 22.x.
$nodeMajor = 0
if (Has-Cmd 'node') {
  try { $nodeMajor = [int]((node -p "process.versions.node.split('.')[0]") 2>$null) } catch {}
}
if ($nodeMajor -lt 22) {
  Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS'
} else {
  Skip "Node $((node -v)) present"
}

if (-not (Has-Cmd 'pnpm')) {
  Info "Enabling pnpm via corepack..."
  & corepack enable
  # Pre-shim so the next pnpm call doesn't pause for the corepack
  # first-run prompt (matches the CI=true pattern on Linux/Mac).
  $env:CI = 'true'
  & pnpm --version | Out-Null
} else {
  Skip "pnpm $((pnpm --version)) present"
}

# ---- Visual Studio Build Tools (MSVC + Windows SDK) -----------------------
# cargo on `x86_64-pc-windows-msvc` shells out to `link.exe` from the
# MSVC linker. Without the Build Tools workload, the rustup installer
# warns and `cargo build` then fails with the cryptic
#   error: linker `link.exe` not found
# message. Detect either a real Visual Studio install OR the standalone
# Build Tools; install only when both are missing.
function Test-MsvcPresent {
  # `vswhere.exe` is the canonical detector (shipped with any modern
  # VS install). Falls back to a path probe for the Build Tools when
  # vswhere is missing.
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $found = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($LASTEXITCODE -eq 0 -and $found) { return $true }
  }
  # Last-resort path probe — covers `--add-only` Build Tools installs
  # done by an org's image preparation.
  return Test-Path "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
}

if (-not $NoDesktop) {
  if (Test-MsvcPresent) {
    Skip "Visual Studio MSVC tools present"
  } else {
    Info "Installing Visual Studio Build Tools (MSVC linker + Windows 10/11 SDK)..."
    # winget's --override threads the VS Installer's own quiet-install
    # flags through. `VCTools` is the C++ workload; `Windows11SDK_22621`
    # is the matched SDK component (the 22621 build is the latest
    # 11 SDK as of 2024-Q4).
    winget install --id Microsoft.VisualStudio.2022.BuildTools `
      --silent --accept-source-agreements --accept-package-agreements -e `
      --override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --includeRecommended' | Out-Host
    Refresh-Path
  }

  # WebView2 — Tauri's host. Pre-installed on Windows 11 and 10 21H2+,
  # but explicit installs make the desktop window blank on older
  # builds. winget package id is `Microsoft.EdgeWebView2Runtime`.
  $webview2 = Get-ItemProperty `
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" `
    -ErrorAction SilentlyContinue
  if ($webview2 -and $webview2.pv) {
    Skip "WebView2 Runtime present ($($webview2.pv))"
  } else {
    Info "Installing WebView2 Runtime (Tauri host)..."
    Winget-Install 'Microsoft.EdgeWebView2Runtime' 'WebView2 Runtime'
  }
}

# ---- Rust toolchain --------------------------------------------------------
if (-not $SkipRust) {
  if (-not (Has-Cmd 'cargo')) {
    Info "Installing Rust via rustup..."
    # Two valid paths: winget (Rustlang.Rustup) or the official rustup-init
    # exe. winget is faster and supports unattended install; fall back to
    # the exe if winget refuses (corporate-locked machines).
    try {
      Winget-Install 'Rustlang.Rustup' 'Rust toolchain'
    } catch {
      $tmp = Join-Path $env:TEMP 'rustup-init.exe'
      Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $tmp
      & $tmp -y --profile minimal
      Remove-Item $tmp -Force
      Refresh-Path
    }
    # rustup drops cargo in %USERPROFILE%\.cargo\bin — make sure it's on
    # PATH for the rest of this script.
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
  } else {
    Skip "Rust $((cargo --version)) present"
  }
}

# ---- Redis (Windows port) --------------------------------------------------
# There's no official Windows redis-server; we use tporadowski's
# maintained Windows port, same artefact most Windows tutorials point at.
# Memurai is the commercial alternative — if you already have it, this
# block detects it and skips.
$RedisExe = "$env:USERPROFILE\scribe-tools\redis-5.0.14.1\redis-server.exe"
if ((Has-Cmd 'memurai') -or (Test-Path $RedisExe)) {
  Skip "Redis-compatible server present"
} else {
  Info "Downloading Redis 5.0.14.1 (Windows port)..."
  $zipUrl  = 'https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip'
  $zipPath = Join-Path $env:TEMP 'redis.zip'
  $destDir = "$env:USERPROFILE\scribe-tools\redis-5.0.14.1"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
  if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir | Out-Null }
  Expand-Archive -Path $zipPath -DestinationPath $destDir -Force
  Remove-Item $zipPath -Force
  if (-not (Test-Path $RedisExe)) {
    Warn "Redis archive extracted but redis-server.exe not at $RedisExe — check $destDir"
  }
}

# ---- Tectonic --------------------------------------------------------------
if (-not (Has-Cmd 'tectonic')) {
  # Tectonic ships a static Windows .exe via GitHub releases. We don't
  # try winget here because the Tectonic.Tectonic package lags releases.
  Info "Downloading Tectonic (LaTeX engine)..."
  $tecVer  = '0.16.0'
  $tecZip  = "tectonic-$tecVer-x86_64-pc-windows-msvc.zip"
  $tecUrl  = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic@$tecVer/$tecZip"
  $tecTmp  = Join-Path $env:TEMP $tecZip
  $tecDir  = "$env:USERPROFILE\scribe-tools\tectonic-$tecVer"
  Invoke-WebRequest -Uri $tecUrl -OutFile $tecTmp
  if (-not (Test-Path $tecDir)) { New-Item -ItemType Directory -Path $tecDir | Out-Null }
  Expand-Archive -Path $tecTmp -DestinationPath $tecDir -Force
  Remove-Item $tecTmp -Force
  $env:Path = "$tecDir;$env:Path"
  Skip "Tectonic extracted to $tecDir. Add to PATH or set TECTONIC_BIN in .env."
} else {
  Skip "Tectonic present"
}

# ---- Optional: pandoc + chktex --------------------------------------------
if (-not $NoOptional) {
  if (-not (Has-Cmd 'pandoc')) {
    Winget-Install 'JohnMacFarlane.Pandoc' 'Pandoc'
  } else { Skip "Pandoc present" }
  # chktex ships with MiKTeX / TeX Live; there isn't a clean winget id.
  # Surface a hint rather than try to download MiKTeX (multi-GB).
  if (-not (Has-Cmd 'chktex')) {
    Warn "chktex not found. Install via MiKTeX/TeX Live if you want the style linter."
  } else { Skip "chktex present" }
}

# ---- .env scaffold --------------------------------------------------------
$envFile = Join-Path $RepoRoot '.env'
$envExample = Join-Path $RepoRoot '.env.example'
if (-not (Test-Path $envFile)) {
  if (Test-Path $envExample) {
    Info "No .env found - copying from .env.example"
    Copy-Item $envExample $envFile
    Warn "Edit .env and fill in SUPABASE_* keys + DATABASE_URL before running the API."
  } else {
    Warn "No .env or .env.example present. The API will start in degraded mode."
  }
}

# ---- Project deps ----------------------------------------------------------
Info "Installing JS workspace dependencies (pnpm install)..."
$env:CI = 'true'
& pnpm install
if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed" }

if (-not $SkipBuild) {
  Info "Pre-building Rust workspace (cargo build, slow on first run)..."
  & cargo build --manifest-path "servers\rust\Cargo.toml" --workspace --quiet
  if ($LASTEXITCODE -ne 0) { Fail "cargo build failed" }
} else {
  Skip "Skipping cargo pre-build (-SkipBuild)"
}

# ---- .env sanity check ----------------------------------------------------
$envMissing = @()
if (Test-Path $envFile) {
  $requiredKeys = @(
    'SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_JWT_SECRET',
    'DATABASE_URL','VITE_SUPABASE_URL','VITE_SUPABASE_ANON_KEY'
  )
  $envLines = Get-Content $envFile
  foreach ($k in $requiredKeys) {
    $line = $envLines | Where-Object { $_ -match "^\s*$k\s*=" } | Select-Object -First 1
    if ($null -eq $line) { $envMissing += $k; continue }
    $value = ($line -split '=', 2)[1]
    if ([string]::IsNullOrWhiteSpace($value) -or $value -eq 'http://127.0.0.1:54321') {
      $envMissing += $k
    }
  }
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
if ($envMissing.Count -gt 0) {
  Write-Host "  ! .env still has placeholder values for:" -ForegroundColor Yellow
  Write-Host "      $($envMissing -join ' ')" -ForegroundColor Yellow
  Write-Host "    See docs/env-vars.md for where to obtain each value." -ForegroundColor Yellow
}
Write-Host "  - Apply Supabase migrations against your project:"
Write-Host "      supabase db push       (or: pnpm supabase:start for the local stack)" -ForegroundColor White
Write-Host "  - Browser dev:"
Write-Host "      .\scripts\run.ps1               (Redis + Rust API + Vite SPA)" -ForegroundColor White
Write-Host "  - Native desktop dev:"
Write-Host "      .\scripts\run-desktop.ps1       (Redis + Rust API + Tauri shell)" -ForegroundColor White
Write-Host ""
Write-Host "Optional knobs (add to .env):"
if (Has-Cmd 'tectonic') {
  Write-Host "  TECTONIC_BIN=$((Get-Command tectonic).Source)"
} else {
  Write-Host "  TECTONIC_BIN=$env:USERPROFILE\scribe-tools\tectonic-0.16.0\tectonic.exe"
}
if (Has-Cmd 'chktex') {
  Write-Host "  CHKTEX_BIN=$((Get-Command chktex).Source)"
} else {
  Write-Host "  CHKTEX_BIN=<path-to-chktex>   (enables style linter)"
}
