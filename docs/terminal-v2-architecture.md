# Terminal V2 架构方案（Web + iOS 统一）

## 1. 问题定义

当前终端链路混用了 Socket.IO、SSE、HTTP 轮询、WKWebView embed，导致：

- 同一问题在 Web/iOS 表现不一致（例如一直 `connecting...`）。
- 任务状态、PTY 会话、终端视图之间缺少单一状态源。
- 错误不可诊断：401/404/网络中断在 UI 中被同化为同一个连接状态。
- Chat 与 CLI 终端语义混合，用户预期和能力边界不清晰。

## 2. 目标与非目标

### 2.1 目标

- Web 与 iOS 共享同一终端协议与状态机。
- 单会话模型：一个 terminal session 只有一个权威生命周期。
- 支持断线重连、历史回放、错误可诊断、可观测。
- 不影响现有 React/Node 任务主流程（并行迁移，灰度切流）。

### 2.2 非目标

- 不在 V2 首版改造 task/chat 业务语义。
- 不在 V2 首版做多机集群共享会话（先单实例稳定）。

## 3. 目标架构

```text
Web / iOS Client
      |
      | 统一 Terminal Protocol (WebSocket)
      v
Terminal Gateway (server)
  - Session Registry（权威状态）
  - Replay Cursor / Sequence
  - Auth & Error Mapping
      |
      v
PTY Runtime (node-pty)
```

### 3.1 Terminal Gateway 职责

- 管理 session 生命周期：`create -> attach -> ready -> detach -> closed`。
- 维护序列号 `seq`，输出采用增量流：`chunk + seq`。
- 统一错误码映射：`auth_failed / session_not_found / timeout / internal_error`。
- 提供调试状态接口：`GET /api/terminal/:session/state`。

### 3.2 Session Registry（单一真相源）

每个 session 记录：

- `sessionName`
- `taskId`（可空）
- `state`
- `seq`
- `clients`
- `lastActivityAt`
- `bufferBytes`

## 4. 统一协议（V2 草案）

### 4.1 WebSocket 事件

客户端 -> 服务端：

- `terminal.open`
  - `{ sessionName | taskId, cols, rows, replayFromSeq }`
- `terminal.input`
  - `{ sessionName, data }`
- `terminal.resize`
  - `{ sessionName, cols, rows }`
- `terminal.ping`
  - `{ sessionName, ts }`

服务端 -> 客户端：

- `terminal.ready`
  - `{ sessionName, seq, replayed }`
- `terminal.output`
  - `{ sessionName, seqFrom, seqTo, chunk }`
- `terminal.error`
  - `{ code, message, recoverable, sessionName }`
- `terminal.closed`
  - `{ sessionName, reason }`

### 4.2 错误码规范

- `invalid_session_name`
- `auth_failed`
- `session_not_found`
- `input_required`
- `gateway_timeout`
- `internal_error`

### 4.3 HTTP 调试/降级接口

- `GET /api/terminal/:session/state`（状态诊断）
- `GET /api/terminal/:session/read?from=...`（仅调试或降级）
- `POST /api/terminal/:session/input`

## 5. 客户端状态机（Web+iOS 一致）

状态：

- `idle`
- `starting`
- `attaching`
- `ready`
- `reconnecting`
- `fatal`
- `closed`

转移原则：

- `401 -> fatal(auth_failed)`
- `404 -> fatal(session_not_found)`
- 网络中断 -> `reconnecting`（指数退避）
- 显式关闭 -> `closed`

## 6. 迁移计划（并行，不中断）

### Phase 0（止血，已开始）

- embed 页面去掉外部 xterm 依赖，降低 WKWebView 不确定性。
- API 返回结构化错误，便于客户端判断。

### Phase 1（网关基础）

- 引入 Terminal Gateway 层（先挂在现有 server 内）。
- 完成 session registry 与统一错误码。
- 增加 `/state` 观测接口与基础指标。

### Phase 2（Web 切 V2）

- Web 主路径切到统一协议。
- 保留旧链路开关（快速回滚）。

### Phase 3（iOS 切 V2）

- iOS 使用原生 WS 终端视图。
- WebView embed 退化为 fallback，不再主路径。

### Phase 4（收敛）

- 删除旧 SSE/多套轮询逻辑。
- 保留最小调试接口与日志采样。

## 7. 验收标准（必须同时满足）

- 同一任务在 Web/iOS 都可稳定 attach。
- 断线重连后 3 秒内恢复并可看到增量输出。
- 关闭再打开可看到历史（replay）。
- 401/404 能在 UI 明确显示，不再只有 `connecting...`。
- E2E 用例通过：创建任务 -> 打开终端 -> 输入 -> 关闭 -> 重开 -> 重连。

## 8. 回滚策略

- 通过特性开关保留 V1 与 V2 双轨。
- V2 失败时 Web/iOS 可快速切回 V1。
- 不做破坏性数据库变更，保证回滚无迁移成本。

