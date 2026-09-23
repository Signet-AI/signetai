& {
	$ErrorActionPreference = "Stop"
	Set-StrictMode -Version Latest

	function Get-EnvironmentValue {
		param(
			[Parameter(Mandatory = $true)][string]$Name,
			[string]$Default = ""
		)

		$value = [Environment]::GetEnvironmentVariable($Name)
		if ([string]::IsNullOrWhiteSpace($value)) {
			return $Default
		}
		return $value
	}

	function ConvertTo-ReleaseTag {
		param([Parameter(Mandatory = $true)][string]$Value)

		$trimmed = $Value.Trim()
		if ([string]::IsNullOrWhiteSpace($trimmed)) {
			throw "Signet release version cannot be empty."
		}
		if ($trimmed.StartsWith("v", [StringComparison]::OrdinalIgnoreCase)) {
			return $trimmed
		}
		return "v$trimmed"
	}

	function Join-DownloadUrl {
		param(
			[Parameter(Mandatory = $true)][string]$Base,
			[Parameter(Mandatory = $true)][string]$Asset
		)

		return "{0}/{1}" -f $Base.TrimEnd("/"), $Asset.TrimStart("/")
	}

	function Download-File {
		param(
			[Parameter(Mandatory = $true)][string]$Url,
			[Parameter(Mandatory = $true)][string]$Path
		)

		Write-Host "Downloading $Url"
		Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
	}

	function Get-Sha256 {
		param([Parameter(Mandatory = $true)][string]$Path)

		return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
	}

	function Get-ComparableWindowsPath {
		param([Parameter(Mandatory = $true)][string]$Path)

		$expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
		return $expanded.TrimEnd([char[]]"/\").ToLowerInvariant()
	}

	function Add-UserPathEntry {
		param([Parameter(Mandatory = $true)][string]$Directory)

		$normalizedDirectory = Get-ComparableWindowsPath $Directory
		$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
		$userEntries = @()
		if (-not [string]::IsNullOrWhiteSpace($userPath)) {
			$userEntries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
		}

		$alreadyPersisted = $userEntries | Where-Object {
			(Get-ComparableWindowsPath ([string]$_)) -eq $normalizedDirectory
		}
		if ($null -eq $alreadyPersisted) {
			$updatedUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
				$Directory
			} else {
				"$Directory;$userPath"
			}
			[Environment]::SetEnvironmentVariable("Path", $updatedUserPath, "User")
		}

		$currentEntries = @()
		if (-not [string]::IsNullOrWhiteSpace($env:Path)) {
			$currentEntries = @($env:Path -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
		}
		$alreadyCurrent = $currentEntries | Where-Object {
			(Get-ComparableWindowsPath ([string]$_)) -eq $normalizedDirectory
		}
		if ($null -eq $alreadyCurrent) {
			$env:Path = if ([string]::IsNullOrWhiteSpace($env:Path)) {
				$Directory
			} else {
				"$Directory;$env:Path"
			}
		}
	}

	# Windows PowerShell 5.1 may default to TLS 1.0 on older hosts. GitHub and
	# signetai.sh require TLS 1.2 or newer.
	[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

	$repo = Get-EnvironmentValue "SIGNET_RELEASE_REPO" "Signet-AI/signetai"
	$releasesApiBase = Get-EnvironmentValue "SIGNET_RELEASES_API_BASE" "https://api.github.com/repos/$repo/releases"
	$releasesDownloadBase = Get-EnvironmentValue "SIGNET_RELEASES_DOWNLOAD_BASE" "https://github.com/$repo/releases/download"
	$latestReleaseApi = Get-EnvironmentValue "SIGNET_LATEST_RELEASE_API" "$releasesApiBase/latest"
	$nightlyVersionApi = Get-EnvironmentValue "SIGNET_NIGHTLY_VERSION_API" "https://registry.npmjs.org/signetai/next"
	$channel = Get-EnvironmentValue "SIGNET_CHANNEL" "stable"

	if ($channel -ne "stable" -and $channel -ne "nightly") {
		throw "SIGNET_CHANNEL must be stable or nightly."
	}

	$downloadBase = Get-EnvironmentValue "SIGNET_DOWNLOAD_BASE"
	if ([string]::IsNullOrWhiteSpace($downloadBase)) {
		$releaseTag = Get-EnvironmentValue "SIGNET_RELEASE_TAG"
		if ([string]::IsNullOrWhiteSpace($releaseTag)) {
			$explicitVersion = Get-EnvironmentValue "SIGNET_VERSION"
			if ([string]::IsNullOrWhiteSpace($explicitVersion)) {
				$explicitVersion = Get-EnvironmentValue "VERSION"
			}
			if (-not [string]::IsNullOrWhiteSpace($explicitVersion)) {
				$releaseTag = ConvertTo-ReleaseTag $explicitVersion
			}
		}
		if ([string]::IsNullOrWhiteSpace($releaseTag)) {
			if ($channel -eq "stable") {
				$release = Invoke-RestMethod -UseBasicParsing -Uri $latestReleaseApi
				$releaseTag = [string]$release.tag_name
			} else {
				$nightly = Invoke-RestMethod -UseBasicParsing -Uri $nightlyVersionApi
				$releaseTag = ConvertTo-ReleaseTag ([string]$nightly.version)
			}
		}
		if ([string]::IsNullOrWhiteSpace($releaseTag)) {
			throw "Could not resolve the latest Signet $channel release."
		}
		$downloadBase = Join-DownloadUrl $releasesDownloadBase (ConvertTo-ReleaseTag $releaseTag)
	}

	$architecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITEW6432")
	if ([string]::IsNullOrWhiteSpace($architecture)) {
		$architecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
	}
	if ($architecture -notmatch "^(AMD64|x64)$") {
		throw "Signet's Windows installer currently supports Windows x64 only (detected: $architecture)."
	}

	$platform = "win32-x64"
	$expectedAssetName = "signet-win32-x64.exe"
	$downloadRoot = Get-EnvironmentValue "SIGNET_DOWNLOAD_DIR" (Join-Path (Get-EnvironmentValue "TEMP" ([IO.Path]::GetTempPath())) "signet")
	$workDir = Join-Path $downloadRoot ("install-" + [Guid]::NewGuid().ToString("N"))
	$binaryPath = $null
	$connectorPath = $null
	$daemonJsPath = $null

	try {
		New-Item -ItemType Directory -Force -Path $workDir | Out-Null

		$manifestPath = Join-Path $workDir "native-manifest.json"
		Download-File (Join-DownloadUrl $downloadBase "native-manifest.json") $manifestPath
		$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

		$matchingAssets = @($manifest.assets | Where-Object { $_.platform -eq $platform })
		if ($matchingAssets.Count -ne 1) {
			throw "No unique Signet native binary was found for $platform in native-manifest.json."
		}
		$asset = $matchingAssets[0]
		$assetName = [string]$asset.name
		$expectedSha256 = ([string]$asset.sha256).ToLowerInvariant()
		if ($assetName -ne $expectedAssetName -or $expectedSha256 -notmatch "^[a-f0-9]{64}$") {
			throw "The Signet Windows release manifest contains an invalid native asset."
		}
		$assetPropertyNames = @($asset.PSObject.Properties | ForEach-Object { $_.Name })
		if ($assetPropertyNames -notcontains "size" -or [int64]$asset.size -le 0) {
			throw "The Signet Windows release manifest is missing the native asset size."
		}

		$binaryPath = Join-Path $workDir $assetName
		Download-File (Join-DownloadUrl $downloadBase $assetName) $binaryPath
		$binaryInfo = Get-Item -LiteralPath $binaryPath
		if ([int64]$binaryInfo.Length -ne [int64]$asset.size) {
			throw "Signet native binary size verification failed."
		}
		if ((Get-Sha256 $binaryPath) -ne $expectedSha256) {
			throw "Signet native binary SHA-256 verification failed."
		}

		$connector = $null
		$manifestPropertyNames = @($manifest.PSObject.Properties | ForEach-Object { $_.Name })
		$componentPropertyNames = @()
		if ($manifestPropertyNames -contains "components" -and $null -ne $manifest.components) {
			$componentPropertyNames = @($manifest.components.PSObject.Properties | ForEach-Object { $_.Name })
		}
		if ($componentPropertyNames -contains "connectors") {
			$connector = $manifest.components.connectors
		}
		if ($null -ne $connector) {
			$connectorUrl = [string]$connector.url
			$connectorSha256 = ([string]$connector.sha256).ToLowerInvariant()
			if ([string]::IsNullOrWhiteSpace($connectorUrl) -or $connectorSha256 -notmatch "^[a-f0-9]{64}$") {
				throw "The Signet connector asset entry is invalid."
			}

			if ($connectorUrl -match "^https?://") {
				$connectorDownloadUrl = $connectorUrl
				$connectorName = [IO.Path]::GetFileName(([Uri]$connectorUrl).AbsolutePath)
			} else {
				if ($connectorUrl -match "\.\.") {
					throw "The Signet connector asset path is invalid."
				}
				$connectorDownloadUrl = Join-DownloadUrl $downloadBase $connectorUrl
				$connectorName = [IO.Path]::GetFileName(($connectorUrl -split "\?")[0])
			}
			if ($connectorName -notmatch "^[A-Za-z0-9._-]+$") {
				throw "The Signet connector asset name is invalid."
			}
			$connectorPropertyNames = @($connector.PSObject.Properties | ForEach-Object { $_.Name })
			if ($connectorPropertyNames -notcontains "size" -or [int64]$connector.size -le 0) {
				throw "The Signet connector asset entry is missing a valid size."
			}
			$connectorPath = Join-Path $workDir $connectorName
			Download-File $connectorDownloadUrl $connectorPath
			$connectorInfo = Get-Item -LiteralPath $connectorPath
			if ([int64]$connectorInfo.Length -ne [int64]$connector.size) {
				throw "Signet connector asset size verification failed."
			}
			if ((Get-Sha256 $connectorPath) -ne $connectorSha256) {
				throw "Signet connector asset SHA-256 verification failed."
			}
		}

		$daemonJs = $null
		if ($componentPropertyNames -contains "daemonJs") {
			$daemonJs = $manifest.components.daemonJs
		}
		if ($null -ne $daemonJs) {
			$daemonJsUrl = [string]$daemonJs.url
			$daemonJsSha256 = ([string]$daemonJs.sha256).ToLowerInvariant()
			if ([string]::IsNullOrWhiteSpace($daemonJsUrl) -or $daemonJsSha256 -notmatch "^[a-f0-9]{64}$") {
				throw "The Signet Bun JavaScript daemon asset entry is invalid."
			}

			if ($daemonJsUrl -match "^https?://") {
				$daemonJsDownloadUrl = $daemonJsUrl
				$daemonJsName = [IO.Path]::GetFileName(([Uri]$daemonJsUrl).AbsolutePath)
			} else {
				if ($daemonJsUrl -match "\.\.") {
					throw "The Signet Bun JavaScript daemon asset path is invalid."
				}
				$daemonJsDownloadUrl = Join-DownloadUrl $downloadBase $daemonJsUrl
				$daemonJsName = [IO.Path]::GetFileName(($daemonJsUrl -split "\?")[0])
			}
			if ($daemonJsName -notmatch "^[A-Za-z0-9._-]+$") {
				throw "The Signet Bun JavaScript daemon asset name is invalid."
			}
			$daemonJsPropertyNames = @($daemonJs.PSObject.Properties | ForEach-Object { $_.Name })
			if ($daemonJsPropertyNames -notcontains "size" -or [int64]$daemonJs.size -le 0) {
				throw "The Signet Bun JavaScript daemon asset entry is missing a valid size."
			}
			$daemonJsPath = Join-Path $workDir $daemonJsName
			Download-File $daemonJsDownloadUrl $daemonJsPath
			$daemonJsInfo = Get-Item -LiteralPath $daemonJsPath
			if ([int64]$daemonJsInfo.Length -ne [int64]$daemonJs.size) {
				throw "Signet Bun JavaScript daemon asset size verification failed."
			}
			if ((Get-Sha256 $daemonJsPath) -ne $daemonJsSha256) {
				throw "Signet Bun JavaScript daemon asset SHA-256 verification failed."
			}
		}

		$localAppData = Get-EnvironmentValue "LOCALAPPDATA" (Join-Path (Get-EnvironmentValue "USERPROFILE" $HOME) "AppData\Local")
		$installDir = Get-EnvironmentValue "SIGNET_BIN_DIR" (Join-Path $localAppData "Programs\Signet")
		$installArguments = @("install", "--bin-dir", $installDir, "--force")
		if ($null -ne $connectorPath) {
			$installArguments += @("--connector-assets", $connectorPath)
		}
		if ($null -ne $daemonJsPath) {
			$installArguments += @("--daemon-js-assets", $daemonJsPath)
		}

		Write-Host "Installing Signet to $installDir"
		& $binaryPath @installArguments
		if ($LASTEXITCODE -ne 0) {
			throw "Signet installation failed with exit code $LASTEXITCODE."
		}

		if ((Get-EnvironmentValue "SIGNET_PERSIST_PATH" "1") -ne "0") {
			try {
				Add-UserPathEntry $installDir
				Write-Host "Added $installDir to the user PATH."
			} catch {
				Write-Warning "Signet was installed, but the user PATH could not be updated. Add this directory manually: $installDir"
			}
		}

		Write-Host "Signet is installed. Open a new PowerShell window, then run: signet setup"
	} finally {
		if ($null -ne $workDir -and (Test-Path -LiteralPath $workDir)) {
			Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
		}
	}
}
