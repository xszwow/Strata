<h1 align="center">Strata · Ryzen AI Max+ 395 Windows Edition</h1>

<p align="center"><b>在 128 GB 统一内存的 Ryzen AI Max+ 395 / Radeon 8060S 上运行 Qwen3.8 Flash-Next</b><br>
Huihui UD-IQ4_XS · 原生 Q4 MTP · 262K 上下文容量验证（不同阶段配置） · Vulkan 视觉 · Codex / OpenAI / Anthropic API</p>

<p align="center">
<a href="bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/README.md"><b>完整安装教程</b></a> ·
<a href="bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/README.md#实测速度与适用范围">实测结果</a> ·
<a href="bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/tps-infographic.svg">TPS 数据图</a> ·
<a href="bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/performance-results.json">测试数据 JSON</a> ·
<a href="https://github.com/Niko1221/Strata">上游 Strata</a>
</p>

这是 [`Niko1221/Strata`](https://github.com/Niko1221/Strata) 的社区 fork，专门整理和验证了 **Windows +
Ryzen AI Max+ 395（Strix Halo / `gfx1151`）** 的本地部署。它不是只保存测试笔记：这个仓库包含所需源码修改、
可移植安装脚本、模型来源与哈希、完整配置生成器，以及实际 API 测试结果。

English summary: this community fork provides a reproducible Windows deployment for Ryzen AI Max+ 395 with native
Q4_0 MTP, Vulkan vision, 262K context and OpenAI-compatible APIs. See the
[step-by-step guide](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/README.md).

如果这套配置帮你复现成功，欢迎给仓库点一个 **Star**；遇到硬件或部署差异，也欢迎带上驱动、内存和日志反馈。

## 这套版本解决了什么

- 在 Windows HIP 后端加入 MTP 专家的原生 `Q4_0` / `Q8_0` 布局支持；
- 使用 Huihui Qwen3.8 Flash-Next `UD-IQ4_XS` 主模型；
- 在 Windows 上构建独立 Vulkan 视觉编码器，并修正高于 4,096 image tokens 时的 GPU warm-up；
- 固定并验证 `spec 8 / spec-min-p 0.6 / mtp-window 8192`；
- 支持 262,144 tokens 总上下文、INT8 KV 和 6 份内存 prompt cache；
- 开启 `codex_compaction_cache`，适合持续代码会话；
- 提供 `/v1/chat/completions`、`/v1/responses` 和 `/v1/messages`；
- 下载脚本支持断点续传、Hugging Face / 镜像切换，以及文件大小和 SHA-256 校验；
- 本机路径运行时生成，不包含原作者电脑的盘符或用户名。

## 已验证硬件

| 项目 | 实测环境 |
| --- | --- |
| CPU / APU | AMD Ryzen AI Max+ 395，16 核 32 线程 |
| GPU | Radeon 8060S，`gfx1151` |
| 内存 | 约 128 GB 统一内存 |
| 系统 | Windows 11 |
| 主模型 | Huihui Qwen3.8 Flash-Next Abliterated，Unsloth `UD-IQ4_XS` |
| MTP | Strata runtime，原生 Q4_0 experts |
| 视觉 | BF16 mmproj + Vulkan `strata-vision` |
| Strata 基线 | 0.1.42 |

其他 Radeon、内存容量或驱动版本可以尝试，但需要重新验证缓存规模和速度。

## 实测性能

![Ryzen AI Max+ 395 实测 TPS 汇总，区分最终配置与早期容量测试](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/tps-infographic.svg)

**测试口径：**以下均为本仓库记录的测试结果，尚非第三方独立复测。常规任务 TPS 为最多输出 512 tokens 的三次中位数；`xhigh` 是测试用例标签，不代表已经与云端 Codex 的思考档位进行了同等条件对比。混合题 51.29 TPS 是预设权重（代码 A 35%、代码 B 35%、xhigh 25%、中文 5%）的**加权调和平均**，并非通用性能或质量评分。Codex 的 64.63 TPS 为四类固定工具轨迹、每类三次的**合并生成吞吐**，不包括所有实际代理任务的端到端耗时。


下面是这台机器的 decode TPS；不同问题的 MTP 接受率、MoE 路由和输出长度不同，因此不能把单一峰值当成所有任务的
固定速度。

| 工作负载 | 实测结果 |
| --- | ---: |
| 代码生成 A，3 次中位数 | **55.3 TPS** |
| 代码生成 B，3 次中位数 | **51.8 TPS** |
| xhigh 长推理，3 次中位数 | **52.0 TPS** |
| 中文长文，3 次中位数 | **31.2 TPS** |
| 混合题加权调和平均 | **51.29 TPS** |
| 完整且通过正确性检查的代码任务 | **52.0～58.2 TPS** |
| 生产配置代码 smoke test | **59.7 TPS** |
| Codex / Playwright 固定工具轨迹 | **61.94～67.96 TPS** |
| 12 次 Codex 工具轨迹 micro-average | **64.63 TPS** |
| 63,954-token 输入 prefill | **1,087.2 TPS** |
| 260K 级输入 prefill（早期 Q2 MTP / 视觉专项，非当前 Q4 spec 8 正面对比） | **约 942～960 TPS** |

**上下文验证边界：**最终 Q4 MTP `spec 8 / spec-min-p 0.6` 配置有 63,954-token 输入测试（1,087.2 prefill TPS）。260,934-token 容量测试使用较早 `Q2 MTP / spec 4` 配置（960.3 prefill TPS）；260,881-token 含图片测试使用视觉专项配置（942.5 prefill TPS）。这证明相应测试当时可以处理接近 262K 的输入，不代表最终 Q4 spec 8 在 260K 上下文有相同吞吐或已完成长期稳定性验证。两项 260K 试验分别只输出了 31 和 81 tokens。

64.63 TPS 来自偏短、投机命中较好的固定工具任务，不代表中文、任意代码或长推理都能保持 60～65 TPS。完整页面还列出：

- 每种题型的 3 次范围和 MTP 接受率；
- temperature `0 / 0.3 / 0.6 / 1.0` 的重复测试；
- 完整正确性测试与失败样本；
- `lookup-chain 3` 对比：整体慢 0.85%，因此默认关闭；
- 64K、260K 和带图片近满上下文结果；
- 1,024 / 2,048 / 4,096 / 8,192 image-token 视觉精度、prefill、decode 和端到端等待。

查看[完整测试表](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/README.md#实测速度与适用范围)或
下载[结构化聚合数据](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/performance-results.json)。

## 下载后怎么用

仓库不包含约 95 GB 的模型权重，也不提交任何本机绝对路径。先安装 Git、Python 3.10+、CMake、Ninja、
Visual Studio 2022 C++ Build Tools、当前 AMD 驱动和 LunarG Vulkan SDK，然后在 PowerShell 中执行：

```powershell
git clone https://github.com/xszwow/Strata.git
Set-Location .\Strata
```

接下来严格按照：

> **[Ryzen AI Max+ 395 完整安装教程：从模型下载到 API 可用](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/README.md)**

教程按顺序完成：

1. 定义可自由更换的 `$DataRoot`；
2. 断点续传并校验主模型和视觉 projector；
3. 构建这个 fork 的 Windows HIP 引擎；
4. 生成原生 Q4_0 MTP runtime；
5. 构建 Windows Vulkan 视觉组件；
6. 从安装器检测出的路径生成本机 JSON；
7. 启动服务并检查 `/health` 和 `/v1/models`。

不要直接使用上游旧预编译引擎搭配 Q4 MTP：它不包含这个 fork 的原生 Q4/Q8 MTP 支持。

## 当前生产配置

| 参数 | 值 |
| --- | --- |
| 总上下文 | 262,144 tokens |
| 默认最大输出 | 由客户端请求控制；本机 Codex 使用 reasoning budget 8,192 |
| KV | INT8 |
| Prefill chunk | 16,384 |
| Generation concurrency | 1 |
| Worker pool | 8 |
| Expert cache | 24,576 |
| MTP | Q4_0、`spec 8`、`spec-min-p 0.6`、window 8,192 |
| Sampling | temperature 0、top-p 0.95、top-k 20 |
| Prompt cache | 6 个内存 checkpoint |
| Codex compaction cache | 开启 |
| Host conversation parking | 关闭 |
| `lookup-chain` | 关闭 |
| Vision | Vulkan GPU，1,024～8,192 image tokens |

## 接入 Codex 和其他客户端

服务启动后使用：

| 客户端协议 | 地址 |
| --- | --- |
| OpenAI base URL | `http://127.0.0.1:8080/v1` |
| Chat Completions | `POST /v1/chat/completions` |
| Responses / Codex | `POST /v1/responses` |
| Anthropic-compatible | `http://127.0.0.1:8080/v1/messages` |
| 浏览器界面 | `http://127.0.0.1:8080` |

默认只监听本机。不要把无 API key 的服务直接暴露到局域网或公网。

## 缓存边界

当前已经有：

- 内存 prompt cache；
- 相同长前缀复用；
- Codex compaction cache；
- 图片嵌入缓存。

当前没有：

- 磁盘持久化 KV；
- 跨 Strata 重启恢复 KV；
- Halogen 风格的 256 GiB KV lineage；
- 当前启用的 host RAM conversation parking。

因此“262K 上下文”是单请求容量，不等于所有会话 KV 都能永久保存在磁盘。

## 仓库中的复现材料

| 文件 | 内容 |
| --- | --- |
| [完整部署教程](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/README.md) | 环境、命令、验证与排错 |
| [TPS 信息图](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/tps-infographic.svg) | 数据源对齐的 SVG 图片，分别标明早期配置与最终配置 |
| [模型来源](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/models.json) | revision、大小和 SHA-256 |
| [性能数据](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/performance-results.json) | 各题型、长上下文、温度和视觉聚合结果 |
| [MTP manifest](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/mtp-source-manifest.json) | 31 个源张量的范围与哈希 |
| [模型下载脚本](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/Get-Models.ps1) | 续传、镜像切换与校验 |
| [Q4 MTP 脚本](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/Prepare-Q4Mtp.ps1) | 下载、打包、生成 runtime |
| [视觉构建脚本](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/Build-Vision-Vulkan.ps1) | Windows Vulkan vision 构建 |
| [配置生成器](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/New-LocalConfig.ps1) | 按本机实际路径生成 JSON |
| [启动脚本](bench/results/2026-10-12-community-ryzen-ai-max395-huihui-iq4xs/Start-Local.ps1) | 启动兼容 API 服务 |

## 与上游的关系

本仓库是公开 fork，不冒充独立原创项目。通用 Strata 引擎、安装器、服务端、Web UI 和大量文档来自
[`Niko1221/Strata`](https://github.com/Niko1221/Strata)。本 fork 主要维护 Ryzen AI Max+ 395 Windows 部署、原生
Q4/Q8 MTP 支持、Vulkan 高 image-token warm-up，以及对应的复现脚本和测试记录。

- 通用硬件和上游安装方式：[上游 README](https://github.com/Niko1221/Strata#readme)
- Strata 技术细节：[docs/DETAILS.md](docs/DETAILS.md)
- AMD HIP：[docs/AMD_HIP.md](docs/AMD_HIP.md)
- 许可证：[MIT License](LICENSE)

Qwen、Huihui、Unsloth、视觉 projector 和其他依赖仍分别受各自许可证与使用条款约束。模型权重不包含在本仓库中。
