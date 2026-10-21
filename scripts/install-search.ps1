param([string]$StateDirectory = (Join-Path $PSScriptRoot '../.library'))
$ErrorActionPreference = 'Stop'
$runtimeDirectory = Join-Path ([IO.Path]::GetFullPath($StateDirectory)) 'search-runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Copy-Item (Join-Path $PSScriptRoot '../search-runtime/package.json') -Destination $runtimeDirectory
Copy-Item (Join-Path $PSScriptRoot '../search-runtime/package-lock.json') -Destination $runtimeDirectory
# QMD ships its current native runtime; OHS requires the older SQLite ABI binary.
# Fetch that binary from the package author's release API when direct release
# downloads fail. No compiler or global npm installation is required.
npm ci --prefix $runtimeDirectory --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Search package installation failed' }
$abi = (node -p 'process.versions.modules').Trim()
$platform = (node -p 'process.platform').Trim()
$architecture = (node -p 'process.arch').Trim()
$sqliteDirectory = Join-Path $runtimeDirectory 'node_modules/obsidian-hybrid-search/node_modules/better-sqlite3'
$metadata = Get-Content (Join-Path $sqliteDirectory 'package.json') -Raw | ConvertFrom-Json
$release = Invoke-RestMethod "https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v$($metadata.version)"
$assetName = "better-sqlite3-v$($metadata.version)-node-v$abi-$platform-$architecture.tar.gz"
$asset = $release.assets | Where-Object name -eq $assetName
if (-not $asset) { throw "No official native asset exists for $assetName" }
$archive = Join-Path $runtimeDirectory $assetName
Invoke-WebRequest -Uri ($asset.url + '?download=1') -Headers @{ Accept = 'application/octet-stream' } -OutFile $archive -TimeoutSec 90
tar -xzf $archive -C $sqliteDirectory
if ($LASTEXITCODE -ne 0) { throw 'SQLite native archive extraction failed' }
node (Join-Path $runtimeDirectory 'node_modules/@tobilu/qmd/bin/qmd') --version
if ($LASTEXITCODE -ne 0) { throw 'QMD startup failed' }
node (Join-Path $runtimeDirectory 'node_modules/obsidian-hybrid-search/dist/src/cli.js') --version
if ($LASTEXITCODE -ne 0) { throw 'Hybrid Search startup failed' }
Write-Output 'Search runtimes installed. Local semantic models are downloaded when indexing is requested.'
