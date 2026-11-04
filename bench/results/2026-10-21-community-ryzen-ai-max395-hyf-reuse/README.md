# Ryzen AI Max+ 395：HyF 草稿词表、分词器与前缀复用核验

测试日期为 **2026-10-19、2026-10-21（America/Los_Angeles）**，报告于 **2026-11-04** 同步到本 fork。
这不是 11 月 4 日重新运行的性能测试。环境为 Windows、Ryzen AI Max+ 395 / Radeon 8060S、128 GiB
统一内存，Huihui/Unsloth UD-IQ4_XS 主模型、原生 Q4 MTP，`spec 8 / spec-min-p 0.6 / mtp-window 8192`。

## 采用的配置

10 月 19 日实测后已采用 HyF 的 **56,919 项 MTP 草稿词表**。主模型仍使用原来的 248,320 项完整词表，
主分词器不变。日用配置保留 `prompt-cache 6`，**跨会话内存缓存保持关闭：`--conversation-cache-mib 0`**。

内附的 [draft_vocab_zh57k.bin](draft_vocab_zh57k.bin) 是日用模型依赖的同一份副本，共 227,676 字节，
格式为 56,919 个 little-endian uint32 token ID；无重复，全部位于主词表范围内。SHA-256：

```text
cab9ddf26b779bbfc2882371da6ace6c68820a2f037883c07aa955253b3b287e
```

文件来自 [HyFengine-v3 的 v3.0-gfx1151 发布](https://github.com/hfan95091-coder/HyFengine-v3/releases/tag/v3.0-gfx1151)，
致谢 hfan95091-coder 的草稿词表与部署分享。发布包成员名、CRC 和哈希见
[draft-vocab-provenance.json](draft-vocab-provenance.json)；来源仓库保留了 Strata 的
[MIT 许可证](https://github.com/hfan95091-coder/HyFengine-v3/blob/df922a8286e6c09e539ac9e8aa178f5294a30f83/LICENSE)，
本仓库根目录保留同一许可证声明。

复现方法见[安装教程的可选 57K 配置步骤](../../../docs/WINDOWS_RYZEN_AI_MAX395.md#本次实测的-57k-草稿词表)。
`New-LocalConfig.ps1 -UseHyf57K` 是显式选项；省略时不改变基础配置的草稿词表选择。

## 10 月 19 日：草稿词表和参数对照

在同一机器和模型上比较六个候选方案，并于开始、末尾测原配置。每个方案预热五题，每题两次正式测量，
共 40 次预热、80 次正式请求。速度比较统一关闭 prompt cache，各请求 `cache_n = 0`。

| 方案 | 代码 TPS | 推理 TPS | 中文 TPS | 工具调用 TPS | 三项均衡吞吐相对起始基线 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原配置（开始） | 54.95 | 51.65 | 31.25 | 70.10 | 基线 |
| HyF 56,919 项 + spec 8 / 0.6 | 56.55 | 51.70 | 31.90 | 72.25 | +1.73% |
| HyF 56,919 项 + spec 5 / 0.35 | 51.90 | 48.95 | 31.90 | 61.70 | -2.09% |
| 原配置（末尾） | 55.00 | 51.80 | 31.30 | 70.70 | +0.18% |

三项均衡吞吐是代码、推理、中文各自两次中位数的等权调和平均，工具调用不进入综合值。
每题仅两次，约 1.73% 的差异不是统计显著性的证明。代码与推理输出上限为 512 tokens，部分输出随草稿
词表改变；未验证完整代码正确性、全面质量等价或 256K 长上下文质量。不能与首页此前不同题集的 64.63 TPS 混算。

全部候选、方法和限制见 [optimization-20261019.txt](optimization-20261019.txt)，
逐题聚合结果见 [optimization-comparison.json](optimization-comparison.json)。

## 10 月 21 日：HyF v4 是否带来额外收益

针对 [v4.0-gfx1151](https://github.com/hfan95091-coder/HyFengine-v3/releases/tag/v4.0-gfx1151)，
读取发布 ZIP 索引和 17 个相关成员，传输 4,082,318 字节并校验成员 CRC；没有下载完整引擎包，
因此没有重新验证完整 ZIP 的 SHA-256，也没有替换或重编译引擎。

- 14 个文件与日用部署完全相同：5 个主分词器文件、57K 草稿词表、expert profile、调优表、6 个复用检查工具。
- 主词表的 248,320 项映射、247,587 条合并规则及 token 类型一致；思考开/关两种聊天模板渲染一致。
- 1,016 个多语言、代码、emoji、控制/工具标记样例，在 `parse_special` 开/关各测一次，2,032 组 token ID 和回译均通过。
- 本 fork 已有重复片段 BPE 缓存和 plain-span 扫描优化；替换成发布包的 Python 分词实现会丢失这些优化。

同一资产下交替运行 12 次预热后的 CPU 分词中位耗时如下。所有输出 ID 一致；这是合成样例分词计时，
不能换算成模型生成吞吐倍数。

| 样例 | tokens | 当前实现 | HyF v4 实现 |
| --- | ---: | ---: | ---: |
| 中文资料 | 6,159 | 1.08 ms | 15.05 ms |
| 中英混合代码 | 2,969 | 0.91 ms | 4.36 ms |
| 较长中文资料 | 24,636 | 4.20 ms | 59.80 ms |

## 当前前缀缓存的实机结果

未重启的日用服务上运行 3 轮 `A / A重复 / A追问 / 独立B / 返回A`，共 15 次合成请求，全部校验码正确。
跨会话内存缓存在测试前、每次请求和测试后均为 0 MiB；未测开启后的收益。

| 场景 | 新输入 / 复用 tokens | 首个正文 token 中位延迟 |
| --- | --- | ---: |
| A 首次资料 | 6,247 / 0 | 5.770 秒 |
| A 相同请求 | 7 / 6,240 | 0.139 秒 |
| A 连续追问 | 23～38 / 6,240～6,255 | 0.321 秒 |
| 独立 B 后返回 A | 6,278 / 0 | 5.764 秒 |

这是现有前缀缓存的效果，不是换用 v4 得到的增益。首字延迟包含本地 HTTP、分词和预填充等待；
每组仅 3 次且输出 6～7 tokens，不能代表所有生产请求。返回 A 的 miss 符合跨会话缓存关闭的配置。

## 留存资料与发布核对

- [report.txt](report.txt)：10 月 21 日完整报告。
- [summary.json](summary.json)：检查汇总、分组中位数。
- [asset-comparison.json](asset-comparison.json)：来源、ZIP 成员 CRC、SHA-256 和参数对照。
- [tokenizer-checks.json](tokenizer-checks.json)：分词兼容结果。
- [tokenizer-code-benchmark.json](tokenizer-code-benchmark.json)：CPU 分词的逐次计时。
- [tokenizer-code.diff](tokenizer-code.diff)：发布包到当前实现的代码差异，作为报告附件。
- [live-cache-results.json](live-cache-results.json)：15 次合成请求的计时、复用计数及进程核验。

公开副本以 `<DeploymentRoot>` 替换部署绝对路径；报告没有携带密钥、用户会话正文或模型权重。
临时测试脚本和下载副本已清理，此次仅发布报告、结果及实际使用的草稿词表依赖。
11 月 4 日逐个比较了本机安装树与此 fork 的已跟踪文件：分词器、服务端和原生引擎代码相同；
本机 README 是原安装版本，视觉文件仅注释差异，因此保留 GitHub 上已有说明。

本次发布验证通过：PowerShell 语法检查；省略 `-UseHyf57K` 时生成配置与原脚本逐字节相同；
启用时仅增加或替换草稿词表参数，已有词表可保留，prompt cache 为 6、跨会话缓存为 0。
另核对了词表哈希与全部 ID、JSON 格式、15 次结果的分组中位数和本地文档链接。
这些是发布检查，不是新一轮模型性能或 CUDA/SYCL 兼容性测试；本次未修改原生源码。
