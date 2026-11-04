<h1 align="center">Strata · Ryzen AI Max+ 395 Windows Edition</h1>
<p align="center"><b>源码 0.2.10 · 引擎 0.1.56 · 更新于 2026-11-04</b><br>
Huihui UD-IQ4_XS · 原生 Q4 MTP + 57K 草稿词表 · 262K 上下文 · Vulkan 视觉</p>

<p align="center">
<a href="docs/WINDOWS_RYZEN_AI_MAX395.md"><b>当前安装指南</b></a> ·
<a href="deploy/windows-gfx1151/">部署工具</a> ·
<a href="bench/results/2026-11-04-community-ryzen-ai-max395-current-performance/README.md">新版实测报告</a> ·
<a href="bench/results/2026-11-04-community-ryzen-ai-max395-current-performance/summary.json">测试数据</a> ·
<a href="docs/BENCHMARK_ARCHIVE.md">历史归档</a>
</p>

本仓库是 [Niko1221/Strata](https://github.com/Niko1221/Strata) 的社区 fork，维护 **Windows 11 + Ryzen AI Max+ 395 / Radeon 8060S（gfx1151）+ 128 GB 统一内存**上的本地部署。
当前代码基于上游 **v0.2.10 / engine 0.1.56**，加入本 fork 的原生 Q4/Q8 MTP 支持与 Vulkan 高分辨率预热修正。

The current fork uses Strata 0.2.10 / engine 0.1.56 with native Q4 MTP and a 57K draft vocabulary. See the [Windows installation guide](docs/WINDOWS_RYZEN_AI_MAX395.md) and [current benchmark results](bench/results/2026-11-04-community-ryzen-ai-max395-current-performance/README.md).

## 当前性能（2026-11-04 重新实测）

按首页原来的 10 月题目重测当前部署。四类吞吐题各 3 次、最多输出 512 tokens，temperature 0；代码与中文关闭思考，xhigh 开启。提示词缓存全部为 0。

| 同题工作负载 | 10 月中位 TPS | 当前中位 TPS | 当前三次范围 | 相对历史变化 |
| --- | ---: | ---: | ---: | ---: |
| 代码 A：分块 SHA256 | 55.3 | **60.2** | 59.1～60.3 | +8.9% |
| 代码 B：LRU cache | 51.8 | **62.4** | 62.0～62.8 | +20.5% |
| xhigh 思考吞吐 | 52.0 | **60.4** | 59.7～60.4 | +16.2% |
| 中文说明 | 31.2 | **38.5** | 38.3～38.9 | +23.4% |
| **原权重加权调和平均** | **51.29** | **59.31** | — | **+15.6%** |

权重为代码 A / B 各 35%、xhigh 25%、中文 5%。这是跨日期、完整部署的同题速度对照，包含新版服务、引擎及 57K 词表等变化；不代表所有任务，也不代表质量同步提升。

**完整质量有失败，已保留：**编辑距离、加权调度和 xhigh 各 2/2 通过；拓扑排序 0/2（输出含禁止的 import）；生产代码 smoke 也违反了禁止函数调用的要求。不能把这些失败样本写成“完整正确代码”的成绩。

新建的四类工具/Playwright 脚本题共 12 次，结构与要求检查通过，合并生成吞吐 **78.93 TPS**。由于旧工具 messages 未完整保留，不与历史 64.63 TPS 算同题提速；这些是输出检查，未执行真实浏览器任务。

**长上下文与图片：**原 63,954-token 输入 prefill **51.16 秒**；原 260,934-token 输入 **233.72 秒**，三处校验码全部找回。
近满上下文加图片的实际输入为 **260,791 tokens**，三处校验码与图片六行文字均通过。4K 金额表两次均为 **44/44**。

[完整本轮报告、逐项速度和失败说明](bench/results/2026-11-04-community-ryzen-ai-max395-current-performance/README.md) · [汇总 JSON](bench/results/2026-11-04-community-ryzen-ai-max395-current-performance/summary.json) · [原始请求与回复](bench/results/2026-11-04-community-ryzen-ai-max395-current-performance/responses/)

此前用于选择 Q4 MTP / DFlash2 等方案的 256-token 升级对照保存在 [升级方案报告](bench/results/2026-11-04-community-ryzen-ai-max395-engine0156/README.md)，与本轮 512-token 同题复测分开。

## 合入的优化与采用的配置

- 更新到新版 HIP 引擎与服务代码，引入工具调用解析和恢复、图片取消、提示词编码缓存及 Strix Halo 优化。
- 将本 fork 的原生 **Q4_0 / Q8_0 MTP** 支持移植到新引擎，日用仍选择 Q4 MTP + 56,919 项草稿词表。
- 配置生成器明确设置 `drafting: mtp`，清除基础配置中的 DFlash2 参数，并自动查找 hipBLASLt 运行库目录。
- 保留 **spec 8 / spec-min-p 0.6、16K prefill、INT8 KV、262,144 总上下文**和关闭跨会话 RAM 停放的设置。
- Vulkan 视觉继续支持约 1,024～8,192 image tokens；主模型保持 Huihui UD-IQ4_XS。

DFlash2、DFlash2 + 57K、关闭 FP16 prefill、spec 4 + 32K 分块均有对照记录。本机这组中英混合任务选择 Q4 MTP + 57K；各候选的收益和失败样例见 [完整报告](bench/results/2026-11-04-community-ryzen-ai-max395-engine0156/README.md)。

## 安装与启动

```powershell
git clone https://github.com/xszwow/Strata.git
Set-Location .\Strata
```

按照 **[当前 Windows 安装指南](docs/WINDOWS_RYZEN_AI_MAX395.md)** 完成模型下载、构建本 fork HIP 引擎、准备 Q4 MTP、构建 Vulkan 视觉和生成本机配置。
部署工具统一位于 **[deploy/windows-gfx1151](deploy/windows-gfx1151/)**。指南中的 `-UseHyf57K` 对应本次正式服务的实测配置。

仓库提供源码、部署工具和测试数据。模型权重需按指南下载；使用本 fork 的构建产物才能得到这里测量的原生 Q4 MTP 支持。

## 当前日用参数

| 参数 | 当前值 |
| --- | --- |
| 源码 / 引擎 | **0.2.10 / 0.1.56 + 本 fork MTP 补丁** |
| 主模型 | Huihui Qwen3.8 Flash-Next UD-IQ4_XS |
| 草稿器 | 原生 Q4_0 MTP，57K 草稿词表，`spec 8`，`spec-min-p 0.6`，window 8,192 |
| 总上下文 / KV | 262,144 tokens / INT8 |
| Prefill / 并发 | 16,384 / 1 个生成槽位 |
| 专家驻留 / 内部 worker | 24,576 / 8 |
| 采样 | temperature 0、top-p 0.95、top-k 20、seed 12345 |
| 默认思考 | high，reasoning budget 8,192；客户端可覆盖 |
| Prompt cache / Codex compaction cache | 6 份内存 checkpoint / 开启 |
| 跨会话 RAM 停放 / lookup-chain | 关闭 / 关闭 |
| 视觉 | Vulkan GPU，约 1,024～8,192 image tokens |

缓存位于内存，不能在服务重启后恢复 KV。262K 是单请求总容量，输入、思考和输出共同占用。

## 接入与验证

| 用途 | 本机地址 |
| --- | --- |
| 网页 | `http://127.0.0.1:8080` |
| OpenAI base URL | `http://127.0.0.1:8080/v1` |
| Chat Completions | `POST /v1/chat/completions` |
| Responses / Codex | `POST /v1/responses` |
| Anthropic Messages | `POST /v1/messages` |

先前升级验收涵盖代码、算术、工具调用、图片、前缀缓存和近满上下文；本轮按历史严格代码题复测发现上述约束失败，当前结论以两批报告的实际任务范围为准。
工具解析固定语料为 **164/164**（旧版 88/164），这不等于模型的通用工具准确率。
公网与 IVYUN 的验收来自额外部署的兼容层，详见报告中的适用范围。

已知限制仍保留：关闭思考的一道算术题在原版和新版均答错；Windows venv 启动链下的下载器退出测试也有失败。
[原始回复与失败样例](bench/results/2026-11-04-community-ryzen-ai-max395-engine0156/) 和 [同步验证记录](bench/results/2026-11-04-community-ryzen-ai-max395-engine0156/sync-validation.json) 均可查阅。

## 数据与历史记录

本页展示 **2026-11-04 正式新版**的结果。10 月的速度表、旧性能图、词表与缓存对照保存在 [历史测试归档](docs/BENCHMARK_ARCHIVE.md)。
旧测试输入、原始回复、日志和配置记录继续保留；临时测试执行脚本及本机旧运行文件已清理。

上游通用安装与产品介绍见 [上游文档快照](README.upstream.md)；本 fork 的当前部署以本页和当前安装指南为准。
引擎、服务和通用功能来自 [Niko1221/Strata](https://github.com/Niko1221/Strata)。本 fork 维护 Windows gfx1151 部署、原生 Q4/Q8 MTP、Vulkan 预热补丁及对应测试记录。
代码采用 [MIT License](LICENSE)；模型及依赖分别遵守各自许可证。
