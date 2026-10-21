param([int]$Port = 8765, [switch]$Demo)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
uv sync --locked
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not (Test-Path -LiteralPath "$PSScriptRoot/frontend/dist/index.html") -or -not (Test-Path -LiteralPath "$PSScriptRoot/frontend/dist-mcp/index.html")) {
    Push-Location -LiteralPath "$PSScriptRoot/frontend"
    try {
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        npm.cmd run build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally { Pop-Location }
}
$launchArgs = @('run', 'library', 'serve', '--port', "$Port", '--open')
if ($Demo) { $launchArgs += '--demo' }
uv @launchArgs
