# Signet - PowerShell installer for Windows
# Usage: irm https://signetai.sh/install.ps1 | iex

$ErrorActionPreference = "Stop"

function Write-Info($msg)  { Write-Host "  $msg" }
function Write-Ok($msg)    { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "  [X] $msg" -ForegroundColor Red }

function Add-UserPathEntry($dir) {
    if (-not $dir) { return }

    $parts = @($env:PATH -split ';' | Where-Object { $_ })
    if ($parts -notcontains $dir) {
        $env:PATH = "$dir;$env:PATH"
    }

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $userParts = @($userPath -split ';' | Where-Object { $_ })
    $alreadyPersisted = $false
    foreach ($entry in $userParts) {
        if ([string]::Equals($entry.TrimEnd('\'), $dir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            $alreadyPersisted = $true
            break
        }
    }

    if (-not $alreadyPersisted) {
        $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $dir } else { "$userPath;$dir" }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Info "Added $dir to the user PATH for future terminals"
    }
}

# --- Banner ---
Write-Host ""
Write-Host ([char]0x2501 * 50)
Write-Host ""
Write-Info "Signet installer"
Write-Info "Portable AI agent identity"
Write-Host ""

# --- Arch detection ---
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
Write-Ok "OS: Windows ($Arch)"

# --- Check for bun ---
$HasBun = $false
try {
    $bunVersion = & bun --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Bun: v$bunVersion"
        $bunCommand = Get-Command bun -ErrorAction SilentlyContinue
        if ($bunCommand -and $bunCommand.Source) {
            Add-UserPathEntry (Split-Path -Parent $bunCommand.Source)
        }
        $HasBun = $true
    }
} catch {}

# --- Check for node 18+ ---
$HasNode = $false
try {
    $nodeVersion = & node --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nodeVersion) {
        $major = [int]($nodeVersion -replace '^v(\d+).*', '$1')
        if ($major -ge 18) {
            Write-Ok "Node.js: $nodeVersion"
            $HasNode = $true
        } else {
            Write-Warn "Node.js $nodeVersion found (need >= 18)"
        }
    }
} catch {}

# --- Install bun if missing ---
if (-not $HasBun) {
    if (-not $HasNode) {
        Write-Host ""
        Write-Info "No JavaScript runtime found. Installing Bun..."
        Write-Info "(Bun is required for the Signet daemon)"
        Write-Host ""
    } else {
        Write-Host ""
        Write-Info "Installing Bun (required for the Signet daemon)..."
        Write-Host ""
    }

    # Download the Bun installer to a temp file, verify its SHA256 hash,
    # then execute via iex (not & $file) to avoid execution-policy blocks
    # on machines with RemoteSigned/AllSigned policies.
    $BunInstallerUrl = "https://bun.sh/install.ps1"
    $BunInstallerPath = Join-Path $env:TEMP "bun-install-$(Get-Random).ps1"
    try {
        Invoke-RestMethod -Uri $BunInstallerUrl -OutFile $BunInstallerPath -ErrorAction Stop
        $actualHash = (Get-FileHash -Path $BunInstallerPath -Algorithm SHA256).Hash
        # Verify the downloaded installer against a known-good SHA256 hash.
        # This blocks tampered downloads by default — the hash must match.
        # Known-good SHA256 of the Bun installer (pinned 2026-03-18).
        # To refresh: curl -sL bun.sh/install.ps1 | sha256sum
        # Override via env var if needed (e.g. testing a newer Bun release).
        $expectedHash = if ($env:SIGNET_BUN_INSTALLER_SHA256) {
            $env:SIGNET_BUN_INSTALLER_SHA256
        } else {
            "54FD5C34E08D2E363E9EE4CC52F58ECA72B3C307C170869EEC1E394C16FB7744"
        }
        if ($actualHash -ne $expectedHash) {
            Write-Err "Bun installer SHA256 mismatch"
            Write-Info "  Expected: $expectedHash"
            Write-Info "  Actual:   $actualHash"
            Write-Info "The installer may have been updated. Verify at https://bun.sh"
            Write-Info "Override: `$env:SIGNET_BUN_INSTALLER_SHA256 = '$actualHash'"
            Remove-Item $BunInstallerPath -Force -ErrorAction SilentlyContinue
            exit 1
        }
        # Read file content and execute via iex — this preserves the same
        # execution-policy bypass behavior as the original irm | iex pattern.
        Get-Content $BunInstallerPath -Raw | iex
    } catch {
        Write-Err "Bun installation failed"
        Write-Info "Install manually: https://bun.sh"
        exit 1
    } finally {
        Remove-Item $BunInstallerPath -Force -ErrorAction SilentlyContinue
    }

    # Refresh PATH
    $bunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME ".bun" }
    $bunBin = Join-Path $bunInstall "bin"
    if (Test-Path (Join-Path $bunBin "bun.exe")) {
        Add-UserPathEntry $bunBin
    }

    try {
        $bunVersion = & bun --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Bun installed: v$bunVersion"
            $HasBun = $true
        }
    } catch {}

    if (-not $HasBun) {
        Write-Err "Bun installed but not found in PATH"
        Write-Info "Restart your terminal and re-run this script."
        exit 1
    }
}

Write-Host ""

# --- Install signetai ---
Write-Info "Installing signetai..."
Write-Host ""

if ($HasBun) {
    & bun add -g signetai
    if ($LASTEXITCODE -ne 0) {
        Write-Err "bun install failed"
        if ($HasNode) {
            Write-Info "Falling back to npm..."
            Add-UserPathEntry (Join-Path $env:APPDATA "npm")
            & npm install -g signetai
            if ($LASTEXITCODE -ne 0) {
                Write-Err "npm install also failed"
                exit 1
            }
        } else {
            exit 1
        }
    }
} elseif ($HasNode) {
    Add-UserPathEntry (Join-Path $env:APPDATA "npm")
    & npm install -g signetai
    if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install failed"
        exit 1
    }
}

Write-Host ""

# --- Verify installation ---
try {
    $signetVersion = & signet --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "signet installed: v$signetVersion"
    } else {
        throw "not found"
    }
} catch {
    # Check common global bin paths
    $binDirs = @(
        (Join-Path $HOME ".bun\bin"),
        (Join-Path $env:APPDATA "npm")
    )
    $found = $false
    foreach ($dir in $binDirs) {
        if (Test-Path (Join-Path $dir "signet.exe") -or Test-Path (Join-Path $dir "signet.cmd")) {
            Write-Warn "signet installed to $dir but not in PATH"
            Write-Info "Restart your terminal or add $dir to your PATH"
            $found = $true
            break
        }
    }
    if (-not $found) {
        Write-Err "signet not found after install"
        Write-Info "Try restarting your terminal and running: signet --version"
        exit 1
    }
}

# --- Success ---
Write-Host ""
Write-Host ([char]0x2501 * 50)
Write-Host ""
Write-Ok "Ready! Run the setup wizard to get started:"
Write-Host ""
Write-Info "  signet setup"
Write-Host ""
Write-Info "Docs: https://signetai.sh"
Write-Info "Dashboard: http://localhost:3850 (after setup)"
Write-Host ""
Write-Host ([char]0x2501 * 50)
Write-Host ""
