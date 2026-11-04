[CmdletBinding()]
param(
    [int]$Jobs = [Math]::Max(1, [Environment]::ProcessorCount / 2),
    [string]$BuildDirectory,
    [string]$LlamaDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not $BuildDirectory) {
    $BuildDirectory = Join-Path $repoRoot 'build-vision-vulkan'
}
$BuildDirectory = [IO.Path]::GetFullPath($BuildDirectory)

$venvCmake = Join-Path $repoRoot '.venv\Lib\site-packages\cmake\data\bin\cmake.exe'
$venvNinja = Join-Path $repoRoot '.venv\Scripts\ninja.exe'
$cmake = if (Test-Path -LiteralPath $venvCmake) { $venvCmake } else { (Get-Command cmake.exe -ErrorAction Stop).Source }
$ninja = if (Test-Path -LiteralPath $venvNinja) { $venvNinja } else { (Get-Command ninja.exe -ErrorAction Stop).Source }

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw 'cl.exe is not available. Open Developer PowerShell for VS 2022, return to the repository, and rerun this script.'
}

if (-not $env:VULKAN_SDK) {
    throw 'VULKAN_SDK is not set. Install the LunarG Vulkan SDK, then open a new Developer PowerShell.'
}
$spirvHeaders = Join-Path $env:VULKAN_SDK 'Lib\cmake\SPIRV-Headers'
if (-not (Test-Path -LiteralPath $spirvHeaders -PathType Container)) {
    throw "SPIR-V CMake package not found under VULKAN_SDK: $spirvHeaders"
}

# Reuse the dependency downloaded by the current HIP build; older local layouts
# may instead keep it under third_party. An explicit path takes precedence.
if (-not $LlamaDirectory) {
    $llamaCandidates = @()
    if ($env:STRATA_GGML_DIR) { $llamaCandidates += $env:STRATA_GGML_DIR }
    if ($env:BUILD_DIR) { $llamaCandidates += (Join-Path $env:BUILD_DIR '_deps\strata_llamacpp-src') }
    $llamaCandidates += (Join-Path $repoRoot 'build-hip-win\_deps\strata_llamacpp-src')
    $llamaCandidates += (Join-Path $repoRoot 'third_party\llama.cpp')
    foreach ($candidate in $llamaCandidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'tools\mtmd\CMakeLists.txt') -PathType Leaf) {
            $LlamaDirectory = $candidate
            break
        }
    }
}
if (-not $LlamaDirectory -or -not (Test-Path -LiteralPath (Join-Path $LlamaDirectory 'tools\mtmd\CMakeLists.txt') -PathType Leaf)) {
    throw 'llama.cpp with tools/mtmd is missing. Complete the HIP build first, or pass -LlamaDirectory with its dependency checkout.'
}
$LlamaDirectory = (Resolve-Path -LiteralPath $LlamaDirectory).Path

$configure = @(
    '-G', 'Ninja',
    '-S', (Join-Path $repoRoot 'tools\vision'),
    '-B', $BuildDirectory,
    '-DCMAKE_BUILD_TYPE=Release',
    "-DCMAKE_MAKE_PROGRAM=$ninja",
    "-DLLAMA_DIR=$LlamaDirectory",
    '-DSTRATA_VISION_CUDA=OFF',
    '-DSTRATA_PORTABLE=ON',
    '-DGGML_VULKAN=ON',
    "-DSPIRV-Headers_DIR=$spirvHeaders"
)

& $cmake @configure
if ($LASTEXITCODE -ne 0) { throw "Vision CMake configuration failed with exit code $LASTEXITCODE" }
& $cmake --build $BuildDirectory --target strata-vision --parallel $Jobs
if ($LASTEXITCODE -ne 0) { throw "Vision build failed with exit code $LASTEXITCODE" }

$visionExe = Join-Path $BuildDirectory 'bin\strata-vision.exe'
if (-not (Test-Path -LiteralPath $visionExe -PathType Leaf)) {
    throw "Vision build finished without the expected executable: $visionExe"
}
Write-Host "Vulkan vision helper ready: $visionExe"
Write-Output $visionExe
