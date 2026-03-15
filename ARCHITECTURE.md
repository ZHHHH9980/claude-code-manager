# Claude Code Manager 架构文档

## 系统概览

Claude Code Manager 当前是一个“终端优先”的多任务编排界面：

- 前端管理项目与任务
- 任务启动后绑定到独立 PTY 会话
- 首页还会常驻一个主页 Agent Terminal
- 后端按 adapter 启动 Claude Code 或 Codex
- 任务与 Agent 聊天能力仍然存在，但主 UI 交互重心已经是终端而不是聊天面板

运行时采用前后端分离部署：

- 静态前端：`static-server.js`，默认端口 `8080`
- API + socket.io：`server/index.js`，默认端口 `3000`

## 运行拓扑

```text
Browser (React SPA)
├─ ProjectList
├─ TaskBoard
├─ Task Terminal Modal
└─ Home Agent Terminal
        │
        ├─ REST → Express API (:3000)
        ├─ WebSocket → socket.io terminal channel (:3000)
        └─ SSE → agent chat / task chat / terminal stream (:3000)

Static Server (:8080)
└─ serves client/dist

Express API + socket.io (:3000)
├─ Project / Task CRUD
├─ Terminal session endpoints
├─ Agent / Task chat SSE
├─ Adapter registry
├─ PTY manager
├─ SQLite persistence
├─ Notion sync
└─ Deploy / webhook hooks

CLI Processes
├─ claude
└─ codex
```

## 通信模型

当前系统不是“两条通道”，而是三类通信并存：

### 1. REST

用于：

- 项目 CRUD
- 任务 CRUD
- 启动 / 停止任务
- 启动 / 停止主页 Agent Terminal
- 终端状态探测
- deploy / webhook

### 2. WebSocket

用于：

- 任务终端实时输入输出
- 主页 Agent Terminal 实时输入输出
- 终端 attach / resize / reconnect

相关事件：

- `terminal:attach`
- `terminal:input`
- `terminal:resize`
- `terminal:data:{sessionName}`
- `terminal:error`
- `terminal:error:v2`
- `terminal:ready`

### 3. SSE

用于：

- `POST /api/agent`
- `POST /api/tasks/:id/chat`
- `GET /api/terminal/:sessionName/stream`

也就是说，聊天和部分终端读取并不走 WebSocket。

## 前端架构

### 主界面结构

前端主入口是 `client/src/App.jsx`，核心状态包括：

- 当前项目
- 当前任务列表
- 当前打开的任务终端
- 主页 Agent Terminal 会话
- adapter 列表
- 移动端 pane 状态

当前 UI 由四个核心区域组成：

1. `ProjectList`
2. `TaskBoard`
3. `Task Terminal Modal`
4. `CCM Agent Terminal`

### 当前交互特点

- `pending` 任务会展示按 adapter 分类的启动按钮
- `in_progress` 任务会展示 Terminal 入口
- 打开任务时会先调用 `/api/terminal/:sessionName/state` 做健康检查
- 首页 Agent Terminal 在页面加载时自动启动
- 客户端会保存已选项目、已打开任务、Agent mode、主题等本地状态

### Terminal 组件

`client/src/components/Terminal.jsx` 当前已经支持：

- xterm.js 渲染
- attach 时回放 buffer
- socket 重连后自动重新 attach
- 尺寸同步与 resize 防抖
- 结构化 terminal error
- UTF-8 / CJK 字符支持（Unicode11Addon）

这意味着旧文档里“Terminal 不会在重连后重新 attach”的描述已经过期。

### 任务聊天的现状

- 后端仍然保留任务聊天接口与历史记录
- 但当前主 UI 没有活跃的任务聊天面板
- 因此产品表述应是“terminal-first，chat backend 仍可用”

## 后端架构

### 1. Express + socket.io 入口

`server/index.js` 负责：

- CORS 与可选 Bearer Token 鉴权
- REST API
- socket.io 终端事件
- 任务启动 / 停止
- Agent Terminal 启动 / 停止
- Agent / task chat SSE
- 自部署 webhook
- 启动时恢复任务会话

### 2. PTY Manager

`server/pty-manager.js` 负责管理会话生命周期。

核心能力：

- `ensureSession(sessionName, cwd)`
- `attachSession(sessionName)`
- `sendInput(sessionName, data)`
- `resizeSession(sessionName, cols, rows)`
- `killSession(sessionName)`
- `listAliveSessions()`
- `getBufferedOutput(sessionName)`
- `subscribeOutput(sessionName, listener)`

实现特点：

- 使用内存 `Map` 管理会话
- 每个会话维护 `clients` 集合
- 使用 `StringDecoder('utf8')` 解码输出
- 默认保留最近 `300KB` 输出缓冲

### 3. Adapter Registry

`server/adapters/` 目前有两个内置 adapter：

- `claude`
- `codex`

adapter 负责提供：

- CLI 名称
- 默认参数
- 支持的模型
- 默认模型
- UI 元信息（label / color）
- 是否启用 auto confirm

兼容逻辑：

- 历史 `ralph` mode 会 fallback 到 `claude`

### 4. 任务启动流程

任务启动的实际流程是：

1. `POST /api/tasks/:id/start`
2. 按 `mode` 解析 adapter
3. 更新数据库中的 `status / worktree_path / pty_session / mode / model`
4. 尝试在工作目录初始化 `claude-workflow`
5. 创建 PTY 会话
6. 注入项目上下文环境变量
7. 启动 adapter CLI
8. 开始监听 `PROGRESS.md`

注意：

- 任务并不一定真的使用 Git worktree；后端只消费 `worktree_path`
- 当前项目里“任务 = 一个独立 PTY 会话”

### 5. Agent Terminal 与聊天

系统里有两套“Agent”能力：

#### 主页 Agent Terminal

- 走 PTY
- 可切换 `claude` / `codex`
- 通过 `/api/agent/terminal/start` 启动

#### 主页 Agent Chat

- 走 SSE
- 历史消息持久化到 `agent_chat_messages`
- 会话 ID 持久化到 `kv_store`

这意味着旧文档里“agentChatSessionId 只在内存中”的说法已经失效。

### 6. Task Chat Runtime

`server/task-chat-runtime.js` 是后端的聊天 runtime 管理器，特点是：

- 使用长生命周期子进程
- 流式解析 `claude --print --input-format stream-json --output-format stream-json`
- 支持会话续接
- UTF-8 分片安全

重要限制：

- 当前 task chat runtime 实际固定使用 `claude`
- 即使任务自身 terminal mode 是 `codex`，task chat 后端也不是切到 codex

所以 adapter 文档里“`chatMode` 决定 task chat runtime”这种说法并不准确，至少对当前实现不成立。

## 数据持久化

### SQLite 表结构

当前核心表：

- `projects`
- `tasks`
- `task_chat_messages`
- `agent_chat_messages`
- `kv_store`

其中：

- `projects` 已包含 `github_repo`
- `tasks` 已包含 `pty_session`
- `tasks.chat_session_id` 通过迁移逻辑补齐
- 旧字段 `tmux_session` 会迁移到 `pty_session`

### 持久化内容

系统现在会持久化：

- 项目元数据
- 任务元数据
- 任务聊天历史
- 主页 Agent 聊天历史
- 主页 Agent session id
- PTY 输出缓冲区（仅在 `SIGTERM` 时落盘）

## 会话恢复

### 启动恢复

服务启动时会执行 `recoverSessions()`：

1. 读取数据库中的任务
2. 找出 `status = in_progress` 且有 `pty_session` 的任务
3. 如果 PTY 仍在内存里，重新 attach 并恢复 watcher
4. 如果 PTY 不在，则尝试从 `data/sessions/*.buf` 恢复缓冲区
5. 新建 PTY
6. 重新按 adapter 启动 CLI
7. 若失败则把任务标记为 `interrupted`

### 关闭恢复

当前只在 `SIGTERM` 上持久化 PTY buffer：

- 会遍历所有 PTY 会话
- 把 `outputBuffer` 写到 `data/sessions/{sessionName}.buf`

这说明：

- PM2 正常重启场景下恢复能力较好
- 非 `SIGTERM` 退出不保证会保存 buffer

## 文件监听与 Notion

`server/file-watcher.js` 会对每个运行中任务监听：

- `${worktreePath}/PROGRESS.md`

文件内容发生变化时：

- 读取新内容
- 加上时间戳
- 通过 Notion 同步追加进度

因此 Notion 同步不只发生在项目 / 任务创建更新，也会发生在运行中的 `PROGRESS.md` 变更。

## 自部署能力

系统内置：

- `POST /api/deploy`
- `POST /api/webhook/github`

执行逻辑会：

1. `git fetch`
2. 切到 `main`
3. `reset --hard origin/main`
4. `git clean -fd`
5. 安装依赖并构建
6. 重启 PM2 进程

当前代码里重启的 PM2 名称是：

- `claude-manager-api`
- `claude-manager-static`

因此 README 或部署文档应使用这一组名字，而不是旧的 `ccm-api` / `ccm-static`。

## 安全与边界

### 鉴权

当前鉴权是“可选”的：

- 若 `ACCESS_TOKEN` 未配置，则 API 不做 Bearer Token 校验
- `webhook/github` 端点默认豁免

所以“所有端点都必须认证”的说法不准确。

### CORS

`FRONTEND_URL` 未配置或保持本地默认时，逻辑会偏宽松。

这适合开发环境，但文档需要明确这是“默认宽松”而不是“默认严格”。

### 用户隔离

PTY 启动逻辑支持：

- 非 root：直接以当前服务用户运行
- root：可按 `TASK_USER` 切换用户运行

## 当前文档结论

### 与代码一致的部分

- 双端口部署
- adapter 驱动的 Claude / Codex 终端
- SQLite + PTY buffer 恢复
- `ProjectList / TaskBoard / Terminal` 作为核心模块

### 已经过期的旧说法

- “系统只有 REST + WebSocket 两种通信”
- “Terminal 不会在重连后重新 attach”
- “前后端同进程”
- “agentChatSessionId 只在内存中”
- “task-scoped chat 是当前 UI 主路径”
- “PM2 进程名是 ccm-api / ccm-static”

当前正确的描述应是：

> Claude Code Manager 是一个终端优先的多任务管理界面。它以 React + Express + socket.io + SSE + PTY + SQLite 组成，前端管理项目和任务，后端按 adapter 启动 Claude/Codex 会话，并为终端恢复、聊天、文件同步和自部署提供支撑能力。
