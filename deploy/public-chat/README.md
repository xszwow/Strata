# 公网 IVYUN 网页与隧道维护

此目录对应单独部署的 IVYUN 聊天前端和 Linux 反向 SSH 转发。网页补丁适用于已有按任务编号进行取消、保存和事件续传的 IVYUN 版本。Strata 自带网页有独立的前端。

## SVG 预览与代码块复制（2026-11-13）

[ivyun-svg-code-actions.patch](ivyun-svg-code-actions.patch) 补齐模型输出的 SVG 预览和普通代码块复制。SVG 和代码块都调用现有的 `Artifacts.card`，使用 Mermaid 的图内悬浮操作栏与手机交互；SVG 的放大查看也复用同一套 `DiagramOverlay` 和 Panzoom。没有增加顶栏或独立的悬浮按钮布局。

SVG 的右上角菜单提供源码查看、复制、SVG 下载、PNG 导出和原始源码文本下载。支持 `svg` 围栏，以及内容以 SVG 开始的 `xml` 围栏。普通代码块在右上角显示复制图标，支持流式生成期间复制当前内容。手机上与 Mermaid 一样，滑动或滚动时显示操作按钮，闲置后淡出。

在已有 IVYUN 项目根目录应用并检查：

```sh
git apply --check /path/to/ivyun-svg-code-actions.patch
git apply /path/to/ivyun-svg-code-actions.patch
cd server
npm run test:svg
npm run test:ui
npm run test:artifacts
node --test tests/prompts.test.js tests/chat-streams.test.js tests/generation-recovery-browser.test.js
npm run check
```

发布完整 `public/` 并更新预压缩资源，刷新网页后生效。本次是前端更新，模型服务无需重启。[测试范围、限制与公网截图](svg-validation-20261113/README.md)

## 更新 IVYUN 网页

在 IVYUN 项目根目录执行以下命令，把路径替换成下载的补丁。补丁包含两处前端修改，以及原测试套件的三个回归用例。

```sh
git apply --check /path/to/ivyun-stop-reconnect.patch
git apply /path/to/ivyun-stop-reconnect.patch
cd server
node --test tests/chat-streams.test.js tests/generation-recovery-browser.test.js
```

按现有流程发布 `public/` 静态文件。如果启用了预压缩静态资源，同时更新两个修改过的 JavaScript 文件的 gzip 版本。刷新网页后，发送前保存任务编号期间按停止会在本地结束这条消息。已经提交的任务要等服务器确认取消。回答已生成、仍在渲染或处理图表时按停止也能正确结束。

## 安装隧道恢复服务

此配置用于已经运行的 OpenSSH 反向转发。Linux 公网服务器上的专用 SSH 账号是 `strata-tunnel`，SSH 传输端口是 22，转发监听地址是 `127.0.0.1:18080`。本地隧道客户端应已配置断开后自动重连。检查程序使用 Linux 的 `ss`、`pidfd` 和系统 Python 3。如果部署使用其他账号或端口，先对应修改检查程序。

在 Linux 服务器的本目录中安装并启用：

```sh
sudo install -D -m 0644 tunnel-recovery/check_tunnel.py /opt/strata-public/check_tunnel.py
sudo install -m 0644 tunnel-recovery/strata-tunnel-recovery.service tunnel-recovery/strata-tunnel-recovery.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now strata-tunnel-recovery.timer
sudo systemctl restart strata-tunnel-recovery.timer
systemctl list-timers strata-tunnel-recovery.timer
```

检查程序在同一条专用连接持续无 SSH 数据时，通过转发探测三次网关。每次都会复核端口归属和 SSH 接收计数，三次均无响应才释放旧监听。网关单独停机、SSH 还能回复时会保留该连接。

原部署的网页与续传回归测试共 22 项通过。公网浏览器在第 7 个事件后断流，按原任务编号接回了全部 157 个连续事件。隔离环境中隧道约 54 秒恢复，公网实际恢复时间还取决于网络和客户端重连间隔。[补丁](ivyun-stop-reconnect.patch) · [验证记录](verification.json)
