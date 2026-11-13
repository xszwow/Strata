# Windows gfx1151 部署工具

对应本 fork 的 **源码 0.2.10 / 引擎 0.1.56 + Q4 MTP**。按 [当前安装指南](../../docs/WINDOWS_RYZEN_AI_MAX395.md) 顺序执行。

| 脚本 | 用途 |
| --- | --- |
| [Get-Models.ps1](Get-Models.ps1) | 下载并校验主模型和 projector；`-ListOnly` 只显示清单 |
| [Prepare-Q4Mtp.ps1](Prepare-Q4Mtp.ps1) | 生成原生 Q4 MTP runtime |
| [Build-Vision-Vulkan.ps1](Build-Vision-Vulkan.ps1) | 构建 Vulkan 视觉编码器 |
| [New-LocalConfig.ps1](New-LocalConfig.ps1) | 生成本机配置；`-UseHyf57K` 对应本次实测词表 |
| [Start-Local.ps1](Start-Local.ps1) | 启动生成的配置 |

模型来源和历史测量保留在 `bench/results/`。这些是部署工具；临时基准执行脚本已清理，测试输入和结果继续归档。

## Codex 工具调用

从本 fork 启动服务时，`/v1/responses` 会根据当前请求声明的工具处理历史调用。例如，客户端只声明外层 `functions.exec`，且描述中列出了内部 `tools.exec_command` 时，模型看到的旧 shell 调用会使用当前入口，保留命令参数和对应的工具结果。客户端仍负责判断工具是否可用、鉴权和执行。

已有配置要使用与实测部署一致的模式，可把下面两项合并到 Strata 服务配置，然后重启服务。新版 `New-LocalConfig.ps1` 已写入这两项。基础服务省略 `undeclared_tool_calls` 时默认为 `"text"`。选择 `"call"` 时，格式完整但名称未声明的调用会交给客户端处理，适用于能拒绝未知工具的客户端。

```json
{
  "tool_call_recovery": true,
  "undeclared_tool_calls": "call"
}
```

三个真实长上下文样本都返回了结构化 `functions.exec`，输入通过 JavaScript 语法检查，一次客户端往返收到对应的工具结果。单独回放旧输出时，仍有一个样本的输入无法通过语法检查，另一个样本在 `"call"` 模式下保留了未知工具名。[实测与回放记录](codex-tool-validation.json)

11 月 13 日追加了两项上游协议修复。多工具强制调用使用完整的工具调用开头，由模型继续生成函数标签。Anthropic 并行结果按 `tool_use_id` 恢复顺序，再交给模型模板。真实 Qwen 对照中，四组倒序工具结果从全部配错变为全部正确。六个强制调用任务覆盖两种接口和两种返回格式，修复前后均为 24/24。测试使用现有 0.1.56 引擎、Q4 MTP 和温度 0。[请求、回复及合并后检查](tool-protocol-validation-20261113/summary.json) · [上游 #4828](https://github.com/Niko1221/Strata/pull/4828) · [上游 #4832](https://github.com/Niko1221/Strata/pull/4832)
