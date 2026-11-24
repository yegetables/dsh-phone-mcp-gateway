# dsh-phone-mcp-gateway

DSH 插件。把 Android 版 dsh-Go 的手机控制能力（读屏、点击、输入、打开应用等）作为标准 MCP Streamable HTTP 服务开放给外部 agent（opencode、Hermes、Claude Code 等）。

## 工作方式

```
外部 agent ──HTTP(S) / MCP──▶ 本插件（DSH 进程内，默认 0.0.0.0:3847/mcp）
                                  │  按行分隔的 JSON-RPC + hello 鉴权
                                  ▼
                       Android PhoneBridge（抽象 Unix 套接字，失败时退回 127.0.0.1 TCP）
```

- 插件读取 `bridge.json`（默认 `/var/lib/dsh-app/phone/bridge.json`）获取 PhoneBridge 的套接字名、TCP 端口和 token。文件轮换后自动重连。
- 每个外部 MCP 会话映射为一个手机侧调用者 `<clientName>@<来源IP>`，调用时注入 `dsh-go/phone-caller` 元数据。手机上的确认弹窗和“正在被控制”提示显示这个名字。
- 会话空闲超时、客户端断开或发送 `notifications/cancelled` 时，插件向手机发送 `dsh-go/phone-run-end`，释放手机控制权，并为下一次调用换新的 runId。
- 工具调用耗时较长时（如 `handoff`、等待手机确认），插件改用 SSE 响应并定期发送心跳，避免客户端超时。

## 安全模型

请求按以下顺序检查，任一项不通过即拒绝：

| 检查 | 不通过时 |
| --- | --- |
| 路径等于 `endpointPath` | 404 |
| `Origin` 头不存在，或其主机为 `localhost`、在 `allowedCidrs` 内、与请求的 `Host` 相同（防 DNS 重绑定） | 403 |
| 来源 IP 在 `allowedCidrs` 内 | 403 |
| 凭据库中已配置 `DSH_PHONE_MCP_TOKEN` | 503（未配置密钥时拒绝全部请求） |
| `Authorization: Bearer <token>` 与凭据一致（常量时间比较） | 401 |
| 工具在 `tools` 策略允许范围内 | 工具不出现在 `tools/list`，调用返回错误 |

- 密钥只存放在 DSH 凭据库。配置文件里的 `auth.token` 字段只接受空值，填入明文会被拒绝。
- 修改凭据后立即生效，无需重载插件。
- 手机端原有的逐条确认机制不受影响。

## 安装与配置

1. 在 DSH 中安装本插件。
2. 在 DSH 凭据服务中写入 `DSH_PHONE_MCP_TOKEN`（建议使用 32 字节以上的随机字符串）。
3. 在 DSH 会话中执行 `/phone-mcp` 查看运行状态和可用地址；执行 `/phone-mcp config` 获取客户端配置片段。

### 配置项

| 字段 | 默认值 | 生效方式 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `true` | 立即 | 开关 HTTP 监听 |
| `bindHost` | `0.0.0.0` | 重载 | 只通过 `adb forward` 访问时可改为 `127.0.0.1` |
| `port` | `3847` | 重载 | 监听端口 |
| `endpointPath` | `/mcp` | 重载 | MCP 路径 |
| `auth.credentialRef` | `DSH_PHONE_MCP_TOKEN` | — | 固定值 |
| `allowedCidrs` | 回环、Tailscale（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`）、私有网段 | 立即 | 留空则拒绝全部 |
| `tools.*` | 见下表 | 立即 | 改动后向已连接客户端发送 `notifications/tools/list_changed` |
| `session.idleTimeoutSec` | `300` | 立即 | 空闲多久释放手机控制权（30–3600） |
| `session.maxSessions` | `4` | 立即 | 最大并发会话数（1–16）；满了时踢掉最久未活动且没有进行中调用的会话；全部都在调用中则返回 503 |
| `session.heartbeatIntervalSec` | `15` | 立即 | SSE 心跳间隔（5–120） |
| `bridgeConfigPath` | `/var/lib/dsh-app/phone/bridge.json` | 重载 | PRoot 与 Direct 模式都能用默认值 |

### 工具策略

| 开关 | 默认 | 包含的工具 |
| --- | --- | --- |
| `screen` | 开 | `screen` `collect` `tap` `type` `scroll` `key` `tap_xy` `handoff` |
| `apps` | 开 | `apps` `open` `intent` |
| `notify` | 开 | `notify` |
| `clipboard` | 开 | `clipboard` |
| `calendar` | 开 | `calendar_list` |
| `chat` | 开 | `ask_dsh`（插件自带，见下） |
| `androidShell` | 关 | `android_shell` |
| `diagnostics` | 关 | `diagnostics` |
| `allowUnknownTools` | 关 | 手机端将来新增、本插件尚未收录的工具 |
| `disabledTools` | `[]` | 按名字单独禁用，优先级高于以上开关 |

## 客户端配置

通用格式（`/phone-mcp config` 输出的就是这一段，地址按当前网络填好）：

```json
{
  "mcpServers": {
    "dsh-phone": {
      "type": "streamable-http",
      "url": "http://<手机IP>:3847/mcp",
      "headers": { "Authorization": "Bearer <YOUR_DSH_PHONE_MCP_TOKEN>" }
    }
  }
}
```

opencode（`opencode.json`）：

```json
{
  "mcp": {
    "dsh-phone": {
      "type": "remote",
      "url": "http://<手机IP>:3847/mcp",
      "headers": { "Authorization": "Bearer {env:DSH_PHONE_MCP_TOKEN}" }
    }
  }
}
```

通过 USB 连接时，可以先执行 `adb forward tcp:3847 tcp:3847`，再使用 `http://127.0.0.1:3847/mcp`。

## 开发

```sh
npm test
```

- 测试使用 Node 内置测试框架，`test/helpers/mock-phone-bridge.mjs` 模拟 Android PhoneBridge。
- `test/loader.mjs` 优先从本机安装的 `dsh` 中解析 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-credentials`；找不到时使用 `test/stubs/` 下的简化实现。可用环境变量 `DSH_NODE_MODULES` 指定路径。

## 和手机上的 dsh 对话（`ask_dsh`）

插件跑在手机的 dsh 引擎进程里，所以除了代理手机操控工具，它还能直接调 dsh 自己的会话服务，开一条真正的对话通道：

```
外部 agent ──ask_dsh(message)──▶ 插件 ──sessionController.prompt()──▶ 手机里的 dsh
                                   ◀──wait() 拿这一轮的助手记录──────┘
```

- **入参**：`message`（必填）、`session`（可选，dsh 会话 id）、`timeout_sec`（可选）
- **返回**：这一轮助手产生的文本，首行为 `[会话 id]`；等待超时会标注「以下是已产生的部分答复」
- **不走手机操控那条路**：不点屏幕、不弹确认框，也不占用手机任务租约
- **会话策略**：不填 `session` 时用插件自己的专用会话（首次自动新建并复用），不会动你正在聊的那个对话；想指定会话就在配置里填 `chat.sessionId`
- **依赖**：宿主 dsh 必须提供 `sessionController`（`prompt` / `wait` / `create`）。没有时 `ask_dsh` 不会出现在工具表里，`/phone-mcp` 也会提示一行原因
- **可取消**：客户端发 `notifications/cancelled` 或断开时，会 abort 等待并在支持时调用 `sessionController.cancel`

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `chat.sessionId` | 空 | 固定对话的 dsh 会话 id；留空用插件自建会话 |
| `chat.timeoutSec` | `300` | 单次最长等待（30–3600 秒） |
| `chat.allowNewSession` | `true` | 关闭后必须填 `chat.sessionId` |

## 已知限制

- `type` 工具的 `submit` 在 dsh-Go 的输入框上不一定生效（回车发送可能拿不到系统确认）。要发送消息请再点一次发送控件；这条通道不用于对话，对话请用 `ask_dsh`。
- 手机息屏/锁屏时 dsh-Go 会中止手机操控任务，`ask_dsh` 不受此限但仍需手机有电、引擎在跑。

## 兼容性

针对 DSH 0.2.2 系列的两处适配（0.1.1 起）：

1. **`apply` 必须 resolve 成 void。** Cordis 把插件回调的返回值当 effect 校验：返回对象会抛 `TypeError: Invalid effect`（只有函数、thenable、迭代器合法）。所以 `apply` 只转发，真正的初始化在 `start()` 里，由测试和调试调用。
2. **`ctx.credentials.resolve()` 返回 `{ value, source } | undefined`**，不是字符串。`lib/credentials.js` 两种形式都接受，避免把已配置的密钥误判成未配置（那样网关会一直返回 503）。

## 许可

MIT
