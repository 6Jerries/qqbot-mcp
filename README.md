# qqbot-mcp

QQ 机器人 MCP 服务器。替代旧的 `cascade-qqbot-bridge` 浏览器注入插件——AI 直接通过 MCP 工具主动推送消息到 QQ 并等待远程指令，不再依赖 DOM 注入。

## 工具

| 工具 | 说明 |
|------|------|
| `qq_send_message` | 发送文本和/或本地图片（`image_paths` 绝对路径数组） |
| `qq_notify_and_wait` | 推送「标题+摘要+可选选项+可选图片」到 QQ，阻塞等待用户回复并返回指令文本 |
| `qq_get_messages` | 读取无等待期间堆积的入站消息 |
| `qq_get_status` | 网关连接状态 / 最近会话目标 / 沙箱模式 |

## 配置（环境变量）

- `QQBOT_APP_ID` / `QQBOT_APP_SECRET`：QQ 开放平台机器人凭证（必填）
- `QQBOT_SANDBOX`：`1`=沙箱环境（默认），`0`=正式
- `QQBOT_DEFAULT_USER` / `QQBOT_DEFAULT_GROUP`：兜底发送目标 openid（可选，未配时需用户先给机器人发条消息建立会话）

## 使用

在 `mcp_config.json` 注册（Windsurf 与 Devin 均已配置）：

```json
"qqbot": {
  "command": "node",
  "args": ["/Users/liujiarui/qqbot-mcp/server.js"],
  "env": {
    "QQBOT_APP_ID": "...",
    "QQBOT_APP_SECRET": "...",
    "QQBOT_SANDBOX": "1"
  }
}
```

## 注意

- QQ 被动回复（msg_id）有 5 分钟时限，超时后自动降级为主动发送（msg_seq，沙箱有月度额度限制）
- 同一机器人凭证同时只能有一个 gateway 会话正常收消息——请确保旧的 `cascade-qqbot-bridge` 插件已禁用（`cascadeQQBot.enabled: false`）
- 沙箱环境需要用户/群已加入沙箱白名单
