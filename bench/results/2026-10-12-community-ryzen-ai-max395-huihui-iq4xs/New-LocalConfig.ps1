[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BaseConfig,

    [Parameter(Mandatory = $true)]
    [string]$MtpRuntime,

    [Parameter(Mandatory = $true)]
    [string]$VisionExe,

    [Parameter(Mandatory = $true)]
    [string]$VisionMmproj,

    [string]$OutputPath,

    [string]$ModelName = 'huihui-qwen3.8-flash-next-iq4-xs'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$baseConfigPath = (Resolve-Path -LiteralPath $BaseConfig).Path
$mtpRuntimePath = (Resolve-Path -LiteralPath $MtpRuntime).Path
$visionExePath = (Resolve-Path -LiteralPath $VisionExe).Path
$visionMmprojPath = (Resolve-Path -LiteralPath $VisionMmproj).Path

if (-not $OutputPath) {
    $OutputPath = Join-Path $repoRoot 'strata-huihui-iq4xs-q4mtp.json'
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)

$config = Get-Content -LiteralPath $baseConfigPath -Raw | ConvertFrom-Json
if (-not $config.exe -or -not $config.args -or -not $config.tokenizer) {
    throw 'BaseConfig is not a Strata setup-generated engine configuration.'
}

function Set-Property($Object, [string]$Name, $Value) {
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $Object.$Name = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Set-Option([Collections.Generic.List[string]]$Items, [string]$Name, [string]$Value) {
    $index = $Items.IndexOf($Name)
    if ($index -ge 0) {
        if ($index + 1 -ge $Items.Count) { throw "Missing value after $Name in the base config" }
        $Items[$index + 1] = $Value
    } else {
        $Items.Add($Name)
        $Items.Add($Value)
    }
}

function Add-Flag([Collections.Generic.List[string]]$Items, [string]$Name) {
    if (-not $Items.Contains($Name)) { $Items.Add($Name) }
}

function Remove-Option([Collections.Generic.List[string]]$Items, [string]$Name) {
    while (($index = $Items.IndexOf($Name)) -ge 0) {
        $Items.RemoveAt($index)
        if ($index -lt $Items.Count -and -not $Items[$index].StartsWith('--')) {
            $Items.RemoveAt($index)
        }
    }
}

$arguments = [Collections.Generic.List[string]]::new()
foreach ($argument in $config.args) { $arguments.Add([string]$argument) }

Set-Option $arguments '--expert-cache' '24576'
Set-Option $arguments '--prefill' '16384'
Set-Option $arguments '--spec' '8'
Set-Option $arguments '--max-context' '262144'
Set-Option $arguments '--kv' 'int8'
Set-Option $arguments '--pool-workers' '8'
Set-Option $arguments '--pcie-frac' '0'
Set-Option $arguments '--adapt-every' '0'
Set-Option $arguments '--vram-reserve-mib' '4096'
Set-Option $arguments '--prompt-cache' '6'
Set-Option $arguments '--conversation-cache-mib' '0'
Set-Option $arguments '--mtp' $mtpRuntimePath
Set-Option $arguments '--mtp-window' '8192'
Set-Option $arguments '--resident-budget-gib' '1'
Set-Option $arguments '--spec-min-p' '0.6'
Add-Flag $arguments '--mmap-experts'
Add-Flag $arguments '--no-prefill-borrow'
Add-Flag $arguments '--vision'
Remove-Option $arguments '--lookup-chain'

$nativeIndex = $arguments.IndexOf('--native')
if ($nativeIndex -lt 0 -or $nativeIndex + 1 -ge $arguments.Count) {
    throw 'The setup-generated config has no --native model path.'
}
$mainModel = (Resolve-Path -LiteralPath $arguments[$nativeIndex + 1]).Path

$environment = [ordered]@{}
if ($config.env) {
    foreach ($property in $config.env.PSObject.Properties) {
        $environment[$property.Name] = [string]$property.Value
    }
}
$tuning = Join-Path $repoRoot 'tools\hip\gfx1151-hipblaslt-100500.txt'
if (Test-Path -LiteralPath $tuning -PathType Leaf) {
    $environment['STRATA_HIPBLASLT_TUNING'] = $tuning
}
$environment['STRATA_PF_FUSED'] = '1'
$environment['STRATA_PF_GEMM'] = '1'
$environment['STRATA_HC_UPMIX'] = '1'
$environment['STRATA_PA_FAST'] = '1'
$environment['STRATA_HIP_WMMA'] = '1'
$environment['STRATA_SELECT_WMMA'] = '1'
$environment['STRATA_HC_Q8'] = '1'
$environment['STRATA_PF_SWITCH_MIN_T'] = '4096'
$environment['STRATA_PREFILL_STREAM_MIN'] = '128'
$environment['STRATA_FILE_RELEASE'] = '1'
$environment['STRATA_UNBUFFERED_LOAD'] = '1'

if ($config.lib_dirs -and $config.lib_dirs.Count -gt 0) {
    $tensile = Join-Path ([string]$config.lib_dirs[0]) 'hipblaslt\library\gfx1151'
    if (Test-Path -LiteralPath $tensile -PathType Container) {
        $environment['HIPBLASLT_TENSILE_LIBPATH'] = $tensile
    }
}

Set-Property $config 'args' $arguments.ToArray()
Set-Property $config 'model_name' $ModelName
Set-Property $config 'parallel' 1
Set-Property $config 'codex_compaction_cache' $true
Set-Property $config 'reasoning_effort' 'high'
Set-Property $config 'reasoning_budget_tokens' 8192
Set-Property $config 'env' ([pscustomobject]$environment)
Set-Property $config 'sampling' ([pscustomobject][ordered]@{
    temperature = 0.0
    top_p = 0.95
    top_k = 20
    min_p = 0.0
    seed = 12345
})
Set-Property $config 'vision' ([pscustomobject][ordered]@{
    exe = $visionExePath
    mmproj = $visionMmprojPath
    model = $mainModel
    gpu = $true
    threads = 16
    min_tokens = 1024
    max_tokens = 8192
})

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
$json = $config | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($OutputPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$null = Get-Content -LiteralPath $OutputPath -Raw | ConvertFrom-Json

Write-Host "Generated local configuration: $OutputPath"
Write-Output $OutputPath
