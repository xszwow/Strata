[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DataRoot,

    [string]$Endpoint = 'https://huggingface.co',

    [switch]$ListOnly
)

$ErrorActionPreference = 'Stop'
$resolvedDataRoot = [IO.Path]::GetFullPath($DataRoot)
$endpointRoot = $Endpoint.TrimEnd('/')

$artifacts = @(
    [pscustomobject]@{
        Repository = 'huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF'
        Revision = 'c219df4f109fa42c402c44c702c4e33e2ce05fe2'
        RemotePath = 'unsloth-UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf'
        LocalPath = 'models/huihui-ud-iq4-xs/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf'
        Size = [int64]10946624
        Sha256 = '5ce89370720f8bf90890f439361282104c1aa1482d4013bb9a50923e758e71a4'
    },
    [pscustomobject]@{
        Repository = 'huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF'
        Revision = 'c219df4f109fa42c402c44c702c4e33e2ce05fe2'
        RemotePath = 'unsloth-UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-00002-of-00003.gguf'
        LocalPath = 'models/huihui-ud-iq4-xs/Qwen3.8-Flash-Next-UD-IQ4_XS-00002-of-00003.gguf'
        Size = [int64]49835229856
        Sha256 = 'c67b468b3b83bc12a987e455ec4a0c2c3937250da1c234ae1638d9505180c161'
    },
    [pscustomobject]@{
        Repository = 'huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF'
        Revision = 'c219df4f109fa42c402c44c702c4e33e2ce05fe2'
        RemotePath = 'unsloth-UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-00003-of-00003.gguf'
        LocalPath = 'models/huihui-ud-iq4-xs/Qwen3.8-Flash-Next-UD-IQ4_XS-00003-of-00003.gguf'
        Size = [int64]43836407744
        Sha256 = '130560b6a447e0febf61de9b03476f52143160bc4bcbacc9bfa07d9538718e2c'
    },
    [pscustomobject]@{
        Repository = 'huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF'
        Revision = 'c219df4f109fa42c402c44c702c4e33e2ce05fe2'
        RemotePath = 'mmproj-Qwen3.8-Flash-Next-BF16.gguf'
        LocalPath = 'models/vision/mmproj-Qwen3.8-Flash-Next-BF16.gguf'
        Size = [int64]907543008
        Sha256 = 'b1a82259702816a5330d7bd7607cd9676b11780e79ff7348c21103ff3ce49bd0'
    }
)

foreach ($artifact in $artifacts) {
    $artifact | Add-Member -NotePropertyName Url -NotePropertyValue (
        '{0}/{1}/resolve/{2}/{3}?download=true' -f
        $endpointRoot, $artifact.Repository, $artifact.Revision, $artifact.RemotePath
    )
    $artifact | Add-Member -NotePropertyName Target -NotePropertyValue (
        Join-Path $resolvedDataRoot ($artifact.LocalPath.Replace('/', [IO.Path]::DirectorySeparatorChar))
    )
}

if ($ListOnly) {
    $artifacts | Select-Object Repository, Revision, RemotePath, Size, Sha256, Target, Url
    return
}

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($null -eq $curl) {
    throw 'curl.exe is required. It is included with current Windows 10 and Windows 11.'
}

function Test-Artifact([string]$Path, [int64]$Size, [string]$Sha256) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -ne $Size) {
        return $false
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ieq $Sha256
}

foreach ($artifact in $artifacts) {
    if (Test-Artifact $artifact.Target $artifact.Size $artifact.Sha256) {
        Write-Host "Verified existing file: $($artifact.Target)"
        continue
    }

    if (Test-Path -LiteralPath $artifact.Target -PathType Leaf) {
        throw "Existing final file has the wrong size or SHA256: $($artifact.Target)"
    }

    $targetDirectory = Split-Path -Parent $artifact.Target
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    $partial = $artifact.Target + '.part'
    if ((Test-Path -LiteralPath $partial) -and (Get-Item -LiteralPath $partial).Length -gt $artifact.Size) {
        throw "Partial file is larger than the expected artifact: $partial"
    }

    Write-Host "Downloading $($artifact.RemotePath)"
    & $curl.Source --location --fail --retry 20 --retry-all-errors --retry-delay 3 `
        --continue-at - --output $partial $artifact.Url
    if ($LASTEXITCODE -ne 0) {
        throw "curl failed with exit code $LASTEXITCODE; keep the .part file and rerun the command."
    }
    if (-not (Test-Artifact $partial $artifact.Size $artifact.Sha256)) {
        throw "Downloaded file failed size or SHA256 verification: $partial"
    }
    Move-Item -LiteralPath $partial -Destination $artifact.Target
    Write-Host "Installed and verified: $($artifact.Target)"
}

Write-Host "All main-model and vision files are ready under $resolvedDataRoot"
