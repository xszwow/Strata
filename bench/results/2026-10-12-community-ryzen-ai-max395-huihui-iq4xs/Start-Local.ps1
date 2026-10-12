[CmdletBinding()]
param(
    [string]$ConfigPath,
    [int]$Port = 8080,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $repoRoot 'strata-huihui-iq4xs-q4mtp.json'
}
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$python = Join-Path $repoRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Python environment not found: $python. Run START-HERE.bat first."
}

$arguments = @(
    '-X', 'utf8', '-m', 'serve.server',
    '--engine', 'strata',
    '--config', $ConfigPath,
    '--port', [string]$Port
)
if (-not $NoBrowser) { $arguments += '--open' }

Push-Location $repoRoot
try {
    & $python @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Strata server exited with code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
