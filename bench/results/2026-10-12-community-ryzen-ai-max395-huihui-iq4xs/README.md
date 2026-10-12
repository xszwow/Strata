# Ryzen AI Max+ 395：Huihui IQ4_XS + Q4 MTP + 视觉完整部署

这是一套在 **Windows 11、AMD Ryzen AI Max+ 395、Radeon 8060S（`gfx1151`）、约 128 GB
统一内存**上实测过的 Strata 配置。目标是让 Codex、浏览器自动化、代码项目和长上下文会话能够直接使用：

- Huihui Qwen3.8 Flash-Next `UD-IQ4_XS` 主模型；
- 原生 `Q4_0` MTP，`spec 8 / spec-min-p 0.6 / window 8192`；
- 262K 总上下文、INT8 KV、6 份内存 prompt cache；
- Windows Vulkan 视觉编码器，单图 1,024～8,192 image tokens；
- OpenAI Chat Completions、Responses、Anthropic Messages 兼容接口；
- `codex_compaction_cache` 已开启。

本仓库**不包含约 95 GB 的模型文件**。下面的脚本会把模型放到你指定的数据目录，所有本机路径都在运行时计算，
没有写死原作者电脑的盘符或用户名。模型仓库、不可变 revision、文件大小和 SHA-256 则是有意固定的，保证下载到
与实测相同的权重；下载站点可以切换。

> 这不是官方 Strata 的通用一键安装页，而是这个 fork 的可复现部署。要使用原生 Q4 MTP 和 Windows
> Vulkan 视觉，必须克隆本文指定的分支并按顺序执行。

## 1. 准备条件

推荐与实测机器尽量一致：

| 项目 | 要求 |
| --- | --- |
| 系统 | 64 位 Windows 10/11；实测为 Windows 11 |
| 处理器 / GPU | Ryzen AI Max+ 395 / Radeon 8060S，`gfx1151` |
| 内存 | 128 GB 统一内存档；约 125 GiB 可用 |
| 磁盘 | NVMe SSD，开始前至少留出 150 GB 空间 |
| AMD 驱动 | 当前版本 AMD Software: Adrenalin Edition |
| 构建工具 | Git、Python 3.10+、CMake、Ninja、Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”工作负载 |
| 视觉组件 | [LunarG Vulkan SDK](https://vulkan.lunarg.com/sdk/home#windows)，安装后重新打开终端 |
| 虚拟内存 | 建议保持“系统管理”，或手动给足 64 GB 以上 pagefile，避免 Windows commit limit 不足 |

其他 Radeon、内存容量或驱动版本可以尝试，但缓存规模、稳定性和 TPS 需要重新验证，不能直接套用本文的速度结论。

## 2. 克隆这个分支并定义目录

在 PowerShell 中运行：

```powershell
git clone --branch feature/mtp-native-q4-q8 --single-branch https://github.com/xszwow/Strata.git
Set-Location .\Strata

$RepoRoot = (Get-Location).Path
$DataRoot = Join-Path (Split-Path $RepoRoot -Parent) 'Strata-data-huihui'
$Guide = Join-Path $RepoRoot 'bench\results\2026-10-12-community-ryzen-ai-max395-huihui-iq4xs'
```

`$DataRoot` 只是默认示例：要把 100 GB 以上的数据放到别的 SSD，改这一行即可，后续命令不需要再改路径。

## 3. 下载并校验主模型和视觉 projector

直连 Hugging Face：

```powershell
& "$Guide\Get-Models.ps1" -DataRoot $DataRoot
```

中国大陆网络可改用镜像；如果 Clash 更稳定，也可以保留默认站点并让 PowerShell 走你的系统代理：

```powershell
& "$Guide\Get-Models.ps1" -DataRoot $DataRoot -Endpoint 'https://hf-mirror.com'
```

脚本使用 `.part` 临时文件并支持断点续传。每个文件下载后都会核对大小和 SHA-256；中断后重新运行同一条命令即可。
只想先看 URL、目标路径和哈希而不下载，可加 `-ListOnly`。

下载结果位于：

```text
<DataRoot>\models\huihui-ud-iq4-xs\*.gguf
<DataRoot>\models\vision\mmproj-Qwen3.8-Flash-Next-BF16.gguf
```

## 4. 构建并安装这个分支的 HIP 引擎

原生 Q4 MTP 是这个分支的源码改动，不能用上游旧的预编译引擎代替。在仓库根目录运行：

```powershell
& .\tools\hip\build_windows.bat
```

首次构建会下载私有 ROCm/TheRock 构建环境，大约占 7 GB，并生成：

```text
dist\strata-windows-x64-hip.zip
```

然后让 Strata 用本地 GGUF 和刚构建的引擎完成基础安装。此步骤会创建 `.venv`、准备主模型 pack，并生成一份
基础 JSON 配置；视觉先选 `no`，稍后换成本分支的 Vulkan 视觉组件：

```powershell
$MainModelDir = Join-Path $DataRoot 'models\huihui-ud-iq4-xs'

& .\START-HERE.bat `
  --backend hip `
  --prebuilt .\dist\ `
  --family unsloth `
  --model UD-IQ4_XS `
  --context 262144 `
  --vision no `
  --gguf-dir $MainModelDir `
  --data-dir $DataRoot `
  --no-start `
  --yes
```

如果 Windows 阻止本地编译出的程序运行，在“Windows 安全中心 → 应用和浏览器控制”中查看拦截记录；不要从未知来源
下载同名可执行文件替换它。

## 5. 制作原生 Q4_0 MTP

默认使用 Hugging Face 的 range request，只下载原始 Qwen checkpoint 中 MTP 所需的张量，不会下载整个
BF16 模型：

```powershell
& "$Guide\Prepare-Q4Mtp.ps1" -DataRoot $DataRoot
```

需要镜像时，先在当前 PowerShell 会话设置端点：

```powershell
$env:HF_ENDPOINT = 'https://hf-mirror.com'
& "$Guide\Prepare-Q4Mtp.ps1" -DataRoot $DataRoot
Remove-Item Env:HF_ENDPOINT
```

镜像必须正确支持 HTTP Range。脚本会核对 31 个源张量，并依次运行 `mtp_pack.py --experts q4_0` 和
`mtp_rt.py`。完成目录是：

```text
<DataRoot>\models\strata\mtp-rt-q4_0
```

其中必须有 `dense.bin`、`dense.txt`、`draft_vocab.bin`、`experts.bin` 和 `experts.txt`。这里不能换成单个
llama.cpp MTP GGUF。

## 6. 构建 Windows Vulkan 视觉组件

安装 Vulkan SDK 后，打开 **Developer PowerShell for VS 2022**，进入同一个仓库根目录，再运行：

```powershell
& "$Guide\Build-Vision-Vulkan.ps1" -Jobs 12
```

默认输出：

```text
build-vision-vulkan\bin\strata-vision.exe
```

这个分支包含高 image-token cap 的 GPU warm-up 修正。若不需要看图，可以跳过本节，但生成配置时仍需去掉
`--vision` 和 `vision` 对象；当前自动配置脚本按“启用视觉”生成。

## 7. 生成不含硬编码路径的本机配置

下面会自动选取第 4 步刚生成、最近修改的基础配置，并将所有路径解析为你电脑上的实际位置：

```powershell
$BaseConfig = Get-ChildItem $RepoRoot -Filter 'strata-*.json' |
  Where-Object { $_.Name -notlike '*.shared-settings.json' -and $_.Name -ne 'strata-huihui-iq4xs-q4mtp.json' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $BaseConfig) { throw '没有找到 START-HERE.bat 生成的基础配置' }

$MtpRuntime = Join-Path $DataRoot 'models\strata\mtp-rt-q4_0'
$VisionExe = Join-Path $RepoRoot 'build-vision-vulkan\bin\strata-vision.exe'
$VisionMmproj = Join-Path $DataRoot 'models\vision\mmproj-Qwen3.8-Flash-Next-BF16.gguf'
$Config = Join-Path $RepoRoot 'strata-huihui-iq4xs-q4mtp.json'

& "$Guide\New-LocalConfig.ps1" `
  -BaseConfig $BaseConfig.FullName `
  -MtpRuntime $MtpRuntime `
  -VisionExe $VisionExe `
  -VisionMmproj $VisionMmproj `
  -OutputPath $Config
```

如果仓库里原本就装了多个模型，不要依赖“最近修改”；把 `$BaseConfig` 手动设为本次
`UD-IQ4_XS` 安装生成的 JSON 文件即可。

生成结果保留基础配置里的 HIP 引擎、tokenizer 和主模型路径，同时写入这组已测参数：

| 参数 | 值 |
| --- | --- |
| 上下文 / KV | 262,144 / INT8 |
| 并发生成 | 1（8 个 worker 是内部 worker pool，不是 8 路满速并发） |
| Prefill chunk | 16,384 |
| Expert cache | 24,576 |
| Prompt cache | 6 个内存 checkpoint |
| Host conversation parking | 关闭，`0 MiB` |
| MTP | Q4_0、`spec 8`、`spec-min-p 0.6`、window 8,192 |
| Sampling | temperature 0、top-p 0.95、top-k 20、seed 12345 |
| Codex compaction cache | 开启 |
| `lookup-chain` | 关闭；实测真实工具轨迹平均慢约 0.85% |
| Vision | Vulkan GPU，1,024～8,192 image tokens，16 threads |

## 8. 启动、检查和接入

启动服务：

```powershell
& "$Guide\Start-Local.ps1" -ConfigPath $Config
```

看到服务 ready 后，新开一个 PowerShell 检查：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8080/health' | ConvertTo-Json -Depth 8
Invoke-RestMethod 'http://127.0.0.1:8080/v1/models' | ConvertTo-Json -Depth 8
```

`/health` 应显示 `status: ok`、`loaded: true`、`images: true` 和 `max_context: 262144`。浏览器页面是
<http://127.0.0.1:8080>，停止服务按 `Ctrl+C`。

应用或 Codex 的连接参数：

| 项目 | 值 |
| --- | --- |
| OpenAI base URL | `http://127.0.0.1:8080/v1` |
| Chat Completions | `POST /v1/chat/completions` |
| Responses / Codex | `POST /v1/responses` |
| Anthropic-compatible | `http://127.0.0.1:8080/v1/messages` |
| API key | 仅限本机监听时可填任意非空字符串 |
| Model | `huihui-qwen3.8-flash-next-iq4-xs` |

不要把无 API key 的 `127.0.0.1` 服务直接暴露到局域网或公网。需要远程访问时，请按主文档配置 `--host` 和
强 API key。

## 实测速度与适用范围

以下都是这台实测机器的 **decode TPS**，不是保证值：

| 测试 | 结果 |
| --- | ---: |
| 4 个固定短 Codex 工具调用任务，3 次/题，窄样本平均 | 64.63 tok/s |
| 同组各题中位数范围 | 61.94～67.96 tok/s |
| 更广的 temperature 0 混合题加权平均 | 51.29 tok/s |
| 代码题 | 51.8～55.3 tok/s |
| 长推理题 | 约 52.0 tok/s |
| 中文题 | 约 31.2 tok/s |
| 单次代码 smoke test | 59.7 tok/s，11 项检查通过 |

64.63 tok/s 来自一组固定、偏短、适合 speculative decoding 的工具调用题，**开启 tool calls，但没有开启
`--lookup-chain`**。不同问题会改变 MTP 接受率、MoE 路由和输出长度，因此 30～60+ tok/s 的波动是正常的；
不能把 60～65 tok/s 当成每道题都能达到的持续速度。同配置电脑仍会受内存频率、BIOS、驱动、后台程序、散热和
prompt 内容影响。

长上下文方面，实测完成过 260,934 input tokens 的冷读取并找回全部 3 个标记；这个结果证明容量，不代表
接近满上下文时仍有相同 decode TPS。视觉路径验证过高于 4,096 的 image-token cap，配置默认上限为 8,192。

## 缓存到底有什么

- 6 个 prompt cache checkpoint 在内存中，可复用相同长前缀；
- `codex_compaction_cache: true` 可复用匹配的 Codex compaction。一次受控 smoke test 中，2,410 个输入 token
  复用了 2,383 个，耗时 1.046 秒；关闭时为 3.328 秒；
- 没有磁盘持久化 KV，也不能在 Strata 重启后恢复 KV；
- host RAM conversation parking 当前关闭；
- 这些设置不会创建 Halogen 风格的 256 GiB 磁盘 KV lineage。

## 常见问题

### 报错不支持 Q4 MTP，或 `experts.txt` 缺失

确认使用的是本文分支自己构建的 `dist\strata-windows-x64-hip.zip`，不要被 `START-HERE.bat` 换回上游旧引擎。
然后重新运行第 5 步；脚本会验证 Q4 runtime 的 5 个必需文件。

### `/health` 中 `images` 是 `false`

检查 `build-vision-vulkan\bin\strata-vision.exe` 和 mmproj 是否存在，然后重新执行第 7 步生成配置。视觉组件必须
用 Vulkan SDK 构建，不能拿通用 Windows HIP 包里缺失或旧的视觉程序代替。

### 下载慢或断开

主模型脚本可以在 `huggingface.co` 与 `hf-mirror.com` 间切换，并会保留 `.part`。MTP 下载使用 HTTP Range；
若镜像不支持正确的 206/`Content-Range`，请改回 Hugging Face 并通过 Clash 代理访问。

### 启动时内存不足或系统卡死

关闭大型浏览器、游戏和其他 GPU 程序，检查 pagefile 与 Windows commit limit。这里是统一内存机器，模型、KV、GPU
分配和系统进程共享同一池内存，“显存看起来还有”不等于 commit 一定足够。

### 有多个 JSON，不知道该启动哪个

本文最终配置固定命名为 `strata-huihui-iq4xs-q4mtp.json`。`Start-Local.ps1` 默认也寻找这个文件；第 4 步生成的
基础 JSON 只用于保留安装器检测出的引擎和模型路径。

## 文件与来源记录

| 文件 | 用途 |
| --- | --- |
| [`Get-Models.ps1`](Get-Models.ps1) | 可换 endpoint、可续传、带 SHA-256 的主模型与 mmproj 下载器 |
| [`Prepare-Q4Mtp.ps1`](Prepare-Q4Mtp.ps1) | 下载并验证 MTP 张量，打包原生 Q4_0 runtime |
| [`Build-Vision-Vulkan.ps1`](Build-Vision-Vulkan.ps1) | 构建 Windows Vulkan 视觉组件 |
| [`New-LocalConfig.ps1`](New-LocalConfig.ps1) | 从本机基础配置生成生产配置，不携带原作者绝对路径 |
| [`Start-Local.ps1`](Start-Local.ps1) | 启动 OpenAI/Anthropic 兼容服务 |
| [`models.json`](models.json) | 模型 revision、大小、哈希和产物哈希 |
| [`mtp-source-manifest.json`](mtp-source-manifest.json) | 31 个 BF16 MTP 源张量的范围与哈希 |
| [`codex-compaction-cache.json`](codex-compaction-cache.json) | compaction cache smoke test 原始记录 |

主要权重来自
[`huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF`](https://huggingface.co/huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF)，
MTP 源张量来自
[`Qwen/Qwen3.8-Flash-Next`](https://huggingface.co/Qwen/Qwen3.8-Flash-Next)。各模型和源仓库的许可证仍然适用。
