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
