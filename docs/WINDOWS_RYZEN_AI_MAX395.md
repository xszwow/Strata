# Windows Ryzen AI Max+ 395 安装指南

**当前版本：上游源码 0.2.10 / 引擎 0.1.56 + 本 fork 原生 Q4/Q8 MTP 补丁。更新日期：2026-11-04。**

这份指南安装本 fork 在 Windows 11、Ryzen AI Max+ 395 / Radeon 8060S（gfx1151）、约 128 GB 统一内存上实测的配置：
Huihui UD-IQ4_XS 主模型、Q4 MTP + 57K 草稿词表、262,144 上下文、INT8 KV、16K prefill 和独立 Vulkan 视觉。

[返回首页](../README.md) · [最新同题复测](../bench/results/2026-11-04-community-ryzen-ai-max395-current-performance/README.md) · [安装脚本](../deploy/windows-gfx1151/)

脚本位于固定目录 `deploy/windows-gfx1151/`。主模型与 projector 沿用已核验的权重；[来源、revision 和哈希](../bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/models.json) 保留最初记录日期。
仓库不包含模型权重，安装时会下载约 95 GB 的主模型和视觉文件，另需 MTP 与编译依赖空间。

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
git clone https://github.com/xszwow/Strata.git
Set-Location .\Strata

$RepoRoot = (Get-Location).Path
$DataRoot = Join-Path (Split-Path $RepoRoot -Parent) 'Strata-data-huihui'
$Guide = Join-Path $RepoRoot 'deploy\windows-gfx1151'
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

原生 Q4 MTP 是这个 fork 的源码改动，不能用上游旧的预编译引擎代替。在仓库根目录运行：

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
  --drafter mtp `
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

脚本会复用第 4 步 HIP 构建下载的 `build-hip-win/_deps/strata_llamacpp-src`；若自定义了依赖位置，可传 `-LlamaDirectory`。

默认输出：

```text
build-vision-vulkan\bin\strata-vision.exe
```

这个 fork 包含高 image-token cap 的 GPU warm-up 修正。若不需要看图，可以跳过本节，但生成配置时仍需去掉
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
  -OutputPath $Config `
  -UseHyf57K
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
| `lookup-chain` | 关闭 |
| Vision | Vulkan GPU，1,024～8,192 image tokens，16 threads |

### 本次实测的 57K 草稿词表

上面的命令用 `-UseHyf57K` 启用 **56,919 项草稿词表**，对应 2026-11-04 正式服务的实测配置。
生成器核对文件大小和 SHA-256，明确设置 `drafting: mtp` 并移除 DFlash2 参数。该文件只影响 MTP 草稿头，主模型 tokenizer 不变。

该开关仍是可选项：省略时保留基础配置的词表选择；若基础配置已含 `--mtp-draft-vocab`，省略开关不会移除它。
[词表来源和 10 月对照记录](../bench/results/2026-10-21-community-ryzen-ai-max395-hyf-reuse/README.md) 保留原始日期。

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

## 常见问题

### 报错不支持 Q4 MTP，或 `experts.txt` 缺失

确认使用的是本 fork 自己构建的 `dist\strata-windows-x64-hip.zip`，安装时通过 `--prebuilt` 指定本 fork 的构建产物。
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

## 下载器的已知限制

Windows venv 启动链下，上游下载器的“父进程结束后退出”测试仍有失败；使用基础 Python 解释器并加载同一组依赖后测试通过。
取消安装后应确认下载子进程已停止。本次整理没有修改该下载器行为；详见 [验证记录](../bench/results/2026-11-04-community-ryzen-ai-max395-engine0156/sync-validation.json)。

## 文件与数据

| 文件 | 用途 |
| --- | --- |
| [Get-Models.ps1](../deploy/windows-gfx1151/Get-Models.ps1) | 主模型、projector 下载与哈希校验 |
| [Prepare-Q4Mtp.ps1](../deploy/windows-gfx1151/Prepare-Q4Mtp.ps1) | 下载 MTP 张量，打包 Q4 runtime |
| [Build-Vision-Vulkan.ps1](../deploy/windows-gfx1151/Build-Vision-Vulkan.ps1) | 构建独立 Vulkan 视觉编码器 |
| [New-LocalConfig.ps1](../deploy/windows-gfx1151/New-LocalConfig.ps1) | 按本机路径生成 MTP 配置，支持 57K 词表 |
| [Start-Local.ps1](../deploy/windows-gfx1151/Start-Local.ps1) | 启动 API 服务 |
| [新版测试数据](../bench/results/2026-11-04-community-ryzen-ai-max395-engine0156/) | 同日对照、原始回复、失败样例、输入及构建记录 |
| [历史测试归档](BENCHMARK_ARCHIVE.md) | 10 月性能、视觉、词表和缓存测试 |
