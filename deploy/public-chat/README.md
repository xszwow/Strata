# 公网聊天停止与续传修复

此目录对应单独部署的 IVYUN 聊天前端和 Linux 反向 SSH 转发。网页补丁适用于已有按任务编号进行取消、保存和事件续传的 IVYUN 版本。Strata 自带网页有独立的前端。

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
