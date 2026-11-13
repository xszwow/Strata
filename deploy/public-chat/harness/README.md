# IVYUN 通用助手的任务与上下文管理

多步骤任务可以保存待办，再次提问和历史压缩后重新载入。工具失败当轮返回模型供修正，较早的失败尝试在压缩时省略参数与报错。结果不明的写操作保留待核验提示，继续前需要检查实际状态。

本更新适用于已有浏览器桥接、IndexedDB 会话、生成编号和事件续传的 IVYUN 应用。此目录的 `files/` 提供 40 个源码和测试文件，目录结构与 IVYUN 项目根目录一致。源码校验值在 [manifest.json](manifest.json)。其中包括此前尚未单独发布的工具参数校验、执行回执持久化和历史上下文传递改动。

## 安装到已有 IVYUN

使用 Node.js 24 或更新版本。先等待当前任务完成并停止 IVYUN 后端，再将 `files/` 的文件按相同相对路径更新到应用。可用下面的 PowerShell 命令校验下载包并复制，两个路径需要替换为自己的目录。

```powershell
$harnessPackage = 'D:\Strata\deploy\public-chat\harness'
$ivyunApp = 'D:\IVYUN'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $harnessPackage 'manifest.json') | ConvertFrom-Json
foreach ($entry in $manifest.files.PSObject.Properties) {
    $source = Join-Path (Join-Path $harnessPackage 'files') $entry.Name
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) {
        throw "源码校验失败 $($entry.Name)"
    }
}
Copy-Item -Path (Join-Path $harnessPackage 'files/*') -Destination $ivyunApp -Recurse
Set-Location (Join-Path $ivyunApp 'server')
node --test tests/task-list.test.js tests/task-resume-browser.test.js tests/conversation-memory.test.js tests/browser-context.test.js
npm run test:tasks-ui
npm run check
```

浏览器测试需要现有 Playwright 依赖及 Chrome 或 Playwright Chromium。后端启动时自动创建任务检查点表。随后重启 IVYUN 后端并发布完整 `public/` 静态文件及对应 gzip 资源，浏览器刷新后使用新客户端。

## 行为与恢复

- `task_update` 支持批量增改待办，稳定标识关联同一事项。状态包括待处理、进行中、待跟进和已完成，清单最多 32 项，每项备注最多 320 字符。简单问答可以直接回答。
- 清单随当前会话分支传递，模型完成记录操作后，服务端先提交 SQLite，再发送清单事件。前端将事件保存到当前消息。压缩对话后会重新载入最新清单。
- 历史摘要保留有效工具用法、成功结果、较新的网页事实节选与待核验状态。大量历史操作时优先保留待核验记录和较新的结果，同时提供省略数量。原始会话保存在当前浏览器 IndexedDB。
- 本次 9,000 次操作样例的发送上下文由 935,212 字符降到 116,103 字符，接口上限为 150,000 字符。当前消息或附件自身超过可发送容量时，需要缩小该次输入。
- 提交请求前先保存准备状态，关闭页面后可重建尚未提交的请求。提交后的任务只通过原生成编号续传。已执行的外部操作需要根据实际回执和当前页面核验。
- 服务端任务恢复副本保留 24 小时。服务重启后原事件流不可续传时，客户端取回该任务已提交的待办并显示中断状态，后续由用户继续提问。完整聊天历史仍在原浏览器。

任务跨压缩保留和计划重新载入参考 Claude Code 的公开说明。本项目使用上述轻量待办接口和已有 Strata 浏览器执行循环。[Claude Code 任务列表](https://code.claude.com/docs/en/interactive-mode#task-list) · [压缩与上下文](https://code.claude.com/docs/en/context-window)

## 会话待办界面

输入框上方只有一行进度，普通问答没有清单时不显示。入口读取当前会话分支中最近一次已保存的 `task_update` 清单；正在接收的参数、保存失败和模型口头计划都不会创建入口。

- 点击打开底部半屏清单，可点「展开」或向上拖动顶部把手扩展。长清单在面板内部滚动，关闭按钮、遮罩和 Escape 均可收起；键盘焦点在面板内循环，关闭后返回入口。
- 进度更新只修改清单和进度文字，不自动展开面板，也不移动用户阅读的位置。输入键盘弹起后入口仍保持一行，长标题截断显示。
- 未完成和等待事项跨轮保留，停止显示「已暂停」，出错显示「已中断」。完成后当轮保留完成数量，下次发送新问题时入口隐藏，历史消息中的清单仍可展开。
- 展开/收起及面板高度偏好随当前浏览器中的会话保存，切换会话各自恢复；刷新打开详情不会重新调用模型或工具。清空待办时关闭入口和面板。

2026-11-13 新增 3 个浏览器集成场景通过，另复查任务/生成恢复 11 项、消息操作 10 项和布局 12 项。覆盖 320、390、768、1440px 宽度、键盘高度与 VisualViewport 平移、长清单滚动、无效和分片工具调用、停止、刷新、会话隔离和完成后隐藏。检查通过 108 个 JavaScript 文件和 141 个静态引用。手机交互使用 Chromium 仿真，未做 iOS/Android 真机验收。

公网实际 Qwen 的清单创建、完成、下一轮隐藏和刷新恢复结果，以及已部署文件校验值见 [task-ui-verification.json](task-ui-verification.json)。截图：[单行入口](images/task-entry-mobile.png) · [半屏清单](images/task-sheet-mobile.png)。

## 验证范围

2026-11-13 本机相关自动测试 100 项通过，另有手机网络续传 1 项、消息编辑与分支 10 项、图表修复流程 6 项通过。浏览器测试覆盖压缩前关页、执行后关页、SQLite 检查点恢复、过期事件流和再次刷新；对应动作总计执行一次。

接入部署中的本地 Qwen 后，普通算术直接回答；模型实际调用待办工具记录材料调研、采购说明和对比图。加入 110 轮模拟讨论后仍正确回答原代号、预算与单位。公网另外验证了学校客户、PUB-731 编号、700 元预算，以及按生成编号重新读取完全相同的事件流。这些验证使用合成数据。

原始结果见 [verification.json](verification.json)，长历史输入在 `files/server/tests/conversation-memory.test.js` 中。公开结果包含回复与静态文件校验值。
