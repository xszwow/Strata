[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DataRoot,

    [string]$PythonPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$resolvedDataRoot = [IO.Path]::GetFullPath($DataRoot)

if (-not $PythonPath) {
    $PythonPath = Join-Path $repoRoot '.venv\Scripts\python.exe'
}
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "Python environment not found: $PythonPath. Run START-HERE.bat once before this script."
}

$modelRoot = Join-Path $resolvedDataRoot 'models\strata'
$source = Join-Path $modelRoot 'mtp-source'
$gguf = Join-Path $modelRoot 'mtp-q4_0.gguf'
$runtime = Join-Path $modelRoot 'mtp-rt-q4_0'
New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null

function Invoke-PythonTool([string]$Tool, [string[]]$Arguments) {
    & $PythonPath -X utf8 (Join-Path $repoRoot $Tool) @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Tool failed with exit code $LASTEXITCODE"
    }
}

Invoke-PythonTool 'tools\mtp_fetch.py' @('fetch', '--out', $source)
Invoke-PythonTool 'tools\mtp_fetch.py' @('verify', '--out', $source)
Invoke-PythonTool 'tools\mtp_pack.py' @('--src', $source, '--experts', 'q4_0', '--out', $gguf)
Invoke-PythonTool 'tools\mtp_rt.py' @('--gguf', $gguf, '--out', $runtime)

$draftVocabulary = Join-Path $repoRoot 'data\draft_vocab.bin'
if (-not (Test-Path -LiteralPath $draftVocabulary -PathType Leaf)) {
    throw "Draft vocabulary is missing: $draftVocabulary"
}
Copy-Item -LiteralPath $draftVocabulary -Destination (Join-Path $runtime 'draft_vocab.bin') -Force

$required = @('dense.bin', 'dense.txt', 'draft_vocab.bin', 'experts.bin', 'experts.txt')
foreach ($name in $required) {
    $path = Join-Path $runtime $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "MTP runtime is incomplete; missing $path"
    }
}

Write-Host "Native Q4_0 MTP runtime ready: $runtime"
Write-Output $runtime
