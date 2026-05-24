# Scribe — one-shot setup for Windows.
#
# Installs every runtime tool the project needs:
#   • Node 20+ (corepack -> pnpm)
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
#
# Requires Windows 10+ with winget. If winget isn't installed, run
# `App Installer` from the Microsoft Store first.

[CmdletBinding()]
param(
  [switch]$SkipRust,
  [switch]$NoOptional
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

# ---- Node 20+ + corepack/pnpm ---------------------------------------------
$nodeMajor = 0
if (Has-Cmd 'node') {
  try { $nodeMajor = [int]((node -p "process.versions.node.split('.')[0]") 2>$null) } catch {}
}
if ($nodeMajor -lt 20) {
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

Info "Pre-building Rust workspace (cargo build, slow on first run)..."
& cargo build --manifest-path "servers\rust\Cargo.toml" --workspace --quiet
if ($LASTEXITCODE -ne 0) { Fail "cargo build failed" }

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
Write-Host "  - Confirm .env has DATABASE_URL + SUPABASE_* keys filled in."
Write-Host "  - Run Redis + API + SPA together with:"
Write-Host "      .\scripts\run.ps1" -ForegroundColor White
Write-Host ""
Write-Host "Optional knobs (add to .env):"
if (Has-Cmd 'tectonic') {
  Write-Host "  TECTONIC_BIN=$((Get-Command tectonic).Source)"
} else {
  Write-Host "  TECTONIC_BIN=$env:USERPROFILE\scribe-tools\tectonic-0.16.0\tectonic.exe"
}
if (Has-Cmd 'chktex') {
  Write-Host "  CHKTEX_BIN=$((Get-Command chktex).Source)"
}
