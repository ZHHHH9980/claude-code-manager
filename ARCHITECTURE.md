# Claude Code Manager 架构文档

## 系统概述

Claude Code Manager 是一个任务管理系统，用于管理和监控 Claude Code 任务的执行。系统采用**前后端分离架构**，使用 WebSocket 进行实时通信，PTY（伪终端）管理任务进程。

**关键架构特点**：
- 前端静态文件服务（端口 8080）和后端 API 服务（端口 3000）独立运行
- 两个服务由 PM2 分别管理（claude-manager-static 和 claude-manager-api）
- PM2 重启后端时，前端服务保持可用，用户体验不受影响
- Socket.io 连接会断开并自动重连，应用层处理重连后的状态恢复
- Agent 会话 ID 持久化到数据库，重启后自动恢复

## 核心架构

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser Client                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   React UI   │  │  socket.io   │  │   Terminal   │     │
│  │  Components  │──│    Client    │──│   Component  │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└──────────┬──────────────────┬───────────────────────────────┘
           │ HTTP (8080)      │ WebSocket (3000)
           │                  │
┌──────────▼──────────┐  ┌────▼──────────────────────────────┐
│  Static Server      │  │   API Server (Express)            │
│  (port 8080)        │  │   (port 3000)                     │
│  ┌──────────────┐   │  │  ┌──────────────┐  ┌──────────┐  │
│  │ Static Files │   │  │  │   REST API   │  │socket.io │  │
│  │ (client/dist)│   │  │  │   Endpoints  │  │  Server  │  │
│  └──────────────┘   │  │  └──────────────┘  └──────────┘  │
│                     │  │         │                  │       │
│  PM2: claude-       │  │         └──────────────────┼───┐   │
│  manager-static     │  │                            │   │   │
└─────────────────────┘  │  ┌─────────────────────────▼───▼─┐ │
                         │  │       PTY Manager              │ │
                         │  │  sessions: Map<name, Entry>    │ │
                         │  └────────────────┬───────────────┘ │
                         │                   │                 │
                         │  PM2: claude-manager-api            │
                         └───────────────────┼─────────────────┘
                                             │ node-pty
                         ┌───────────────────▼─────────────────┐
                         │      PTY Processes (bash/claude)    │
                         └─────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                   Persistence Layer                          │
│  ┌──────────────┐  ┌──────────────────────────────────┐     │
│  │   SQLite DB  │  │   Session Buffers (on disk)      │     │
│  │  (metadata + │  │   data/sessions/*.buf            │     │
│  │   kv_store)  │  │                                  │     │
│  └──────────────┘  └──────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

## 关键组件

### 0. Static Server (static-server.js)

**职责**: 独立的静态文件服务器，与 API 服务解耦

**实现**:
```javascript
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.STATIC_PORT || 8080;

app.use(express.static(path.join(__dirname, 'client/dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Static server running on port ${PORT}`);
});
```

**设计决策**:
- 独立进程运行，不受 API 服务重启影响
- 支持 SPA 路由（所有路径返回 index.html）
- 端口可配置（默认 8080）

**PM2 配置**:
```javascript
{
  name: 'claude-manager-static',
  script: 'static-server.js',
  instances: 1,
  autorestart: true
}
```

### 1. PTY Manager (server/pty-manager.js)

**职责**: 管理所有 PTY 会话的生命周期

**核心数据结构**:
```javascript
sessions: Map<sessionName, SessionEntry>

SessionEntry {
  ptyProcess: IPty,           // node-pty 进程实例
  clients: Set<Socket>,       // 连接到此会话的 socket.io 客户端
  outputBuffer: string,       // 输出缓冲区（最近 300KB）
  outputDecoder: StringDecoder, // UTF-8 解码器
  lastCols: number,           // 终端列数
  lastRows: number,           // 终端行数
  closed: boolean,            // 会话是否已关闭
  dataDisposable: Disposable, // 数据事件监听器
  exitDisposable: Disposable  // 退出事件监听器
}
```

**关键方法**:
- `createSession(sessionName, cwd)`: 创建新的 PTY 会话
- `ensureSession(sessionName, cwd)`: 确保会话存在，不存在则创建
- `attachSession(sessionName)`: 附加到现有会话
- `sendInput(sessionName, data)`: 发送输入到 PTY
- `resizeSession(sessionName, cols, rows)`: 调整终端大小
- `killSession(sessionName)`: 终止会话
- `listAliveSessions()`: 列出所有活跃会话
- `getBufferedOutput(sessionName)`: 获取缓冲的输出

**设计决策**:
- 使用内存 Map 存储会话，重启后会丢失（需要恢复机制）
- 输出缓冲区限制为 300KB，防止内存溢出
- 使用 StringDecoder 确保 UTF-8 多字节字符正确解码
- 每个会话维护连接的客户端集合，支持多客户端共享

### 2. Express Server (server/index.js)

**职责**: HTTP API 和 WebSocket 服务器

**REST API 端点**:
- `GET /api/projects`: 获取所有项目
- `POST /api/projects`: 创建项目
- `GET /api/adapters`: 获取可用 Agent 适配器列表
- `GET /api/tasks`: 获取任务列表
- `POST /api/tasks`: 创建任务
- `POST /api/tasks/:id/start`: 启动任务
- `POST /api/tasks/:id/stop`: 停止任务
- `DELETE /api/tasks/:id`: 删除任务
- `POST /api/tasks/:id/chat`: 任务聊天
- `POST /api/agent/terminal/start`: 启动主页 Agent Terminal（支持 `mode`）
- `POST /api/agent/terminal/stop`: 停止主页 Agent Terminal
- `POST /api/agent`: Agent 聊天
- `POST /api/deploy`: 自动部署

**WebSocket 事件**:
- `terminal:attach`: 客户端附加到会话
- `terminal:input`: 客户端发送输入
- `terminal:resize`: 客户端调整终端大小
- `terminal:data:{sessionName}`: 服务器发送输出到客户端
- `terminal:error`: 服务器发送错误到客户端

**会话恢复机制**:
```javascript
// 启动时调用
recoverSessions() {
  // 1. 获取所有活跃的 PTY 会话
  // 2. 遍历数据库中 in_progress 状态的任务
  // 3. 如果 PTY 会话存在，重新附加
  // 4. 如果 PTY 会话不存在，尝试从磁盘恢复缓冲区
  // 5. 创建新的 PTY 会话并按 task.mode 对应 adapter 重新启动 CLI
}

// 优雅关闭时调用
process.on('SIGTERM', () => {
  // 1. 遍历所有 PTY 会话
  // 2. 将 outputBuffer 保存到 data/sessions/{sessionName}.buf
  // 3. 退出进程
})
```

### 2.1 Adapter Registry (server/adapters/*.js)

**职责**: 将不同编码 Agent 的 CLI 配置抽象为可插拔适配器，避免在业务流程中硬编码命令。

**当前内置适配器**:
- `claude`: Claude Code
- `codex`: Codex

**关键能力**:
- 统一的启动参数配置（`cli`、`defaultArgs`、`defaultModel`）
- UI 元信息下发（`label`、`color`、`models`）
- 聊天能力声明（`chatMode`，为 `null` 表示不支持 task chat runtime）
- 历史模式兼容（`ralph -> claude` fallback）

**数据流**:
1. 前端 `GET /api/adapters` 获取 adapter 元信息并渲染按钮/下拉。
2. 启动任务或主页 Agent Terminal 时，后端按 `mode` 解析 adapter。
3. 后端统一拼装启动命令并注入 PTY 会话。
4. 若目标 CLI 缺失，返回 `ptyOk=false + error`，前端不再打开空壳终端。

### 3. Database (server/db.js)

**职责**: 持久化任务和项目元数据

**数据模型**:
```sql
projects {
  id: TEXT PRIMARY KEY,
  name: TEXT,
  repo_path: TEXT,
  ssh_host: TEXT,
  notion_id: TEXT,
  created_at: TEXT
}

tasks {
  id: TEXT PRIMARY KEY,
  title: TEXT,
  status: TEXT,  -- 'pending' | 'in_progress' | 'done' | 'interrupted'
  project_id: TEXT,
  branch: TEXT,
  worktree_path: TEXT,
  pty_session: TEXT,  -- PTY 会话名称
  model: TEXT,
  mode: TEXT,
  chat_session_id: TEXT,
  created_at: TEXT,
  updated_at: TEXT
}

task_chat_messages {
  id: INTEGER PRIMARY KEY,
  task_id: TEXT,
  role: TEXT,  -- 'user' | 'assistant'
  text: TEXT,
  created_at: TEXT
}
```

**设计决策**:
- 使用 SQLite 作为嵌入式数据库，简化部署
- 启用 WAL 模式提高并发性能
- 任务状态与 PTY 会话名称关联，用于恢复

### 4. Socket.io Client (client/src/hooks/useSocket.js)

**职责**: 管理客户端 WebSocket 连接

**当前实现**:
```javascript
export function useSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    socketRef.current = io();  // 使用默认配置
    socketRef.current.on('connect', () => setConnected(true));
    socketRef.current.on('disconnect', () => setConnected(false));
    return () => socketRef.current.disconnect();
  }, []);

  return { socket: socketRef.current, connected };
}
```

**已知问题**:
- 未显式配置自动重连选项
- 未监听 reconnect 事件
- 未提供详细的连接状态（connecting, reconnecting）

## 会话持久化机制

### 当前实现

**保存阶段** (SIGTERM 处理器):
```javascript
process.on('SIGTERM', () => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  for (const [sessionName, entry] of ptyManager.sessions) {
    if (entry.outputBuffer) {
      fs.writeFileSync(
        path.join(SESSIONS_DIR, `${sessionName}.buf`),
        entry.outputBuffer
      );
    }
  }
  process.exit(0);
});
```

**恢复阶段** (recoverSessions):
```javascript
function recoverSessions() {
  const tasks = db.getTasks();
  for (const task of tasks) {
    if (task.status === 'in_progress' && task.pty_session) {
      // 尝试从磁盘加载缓冲区
      const bufFile = path.join(SESSIONS_DIR, `${task.pty_session}.buf`);
      let savedBuffer = '';
      try {
        savedBuffer = fs.readFileSync(bufFile, 'utf8');
      } catch {}

      // 创建新的 PTY 会话
      const entry = ptyManager.ensureSession(
        task.pty_session,
        task.worktree_path
      );
      
      // 恢复缓冲区
      if (savedBuffer) {
        entry.outputBuffer = savedBuffer + '\r\n[session auto-recovered]\r\n';
      }

      // 按 task.mode 解析 adapter 后重新启动对应 CLI
      setTimeout(() => {
        // launchAdapterInSession(task.pty_session, { adapter, model: task.model })
      }, 500);
    }
  }
}
```

### 已知缺陷

#### 缺陷 1: 错误隔离不足

**问题**: recoverSessions() 中的异常处理不够细粒度，一个任务恢复失败可能影响其他任务。

**代码位置**: `server/index.js:770-799`

**架构问题**:
```javascript
// 当前实现
for (const task of tasks) {
  if (task.status === 'in_progress' && task.pty_session) {
    try {
      const entry = ptyManager.ensureSession(task.pty_session, task.worktree_path);
      // ... 恢复逻辑
    } catch (err) {
      db.updateTask(task.id, { status: 'interrupted' });
      // 问题：如果 worktree_path 不存在，ensureSession 会抛出异常
      // 但没有详细日志说明失败原因
    }
  }
}
```

**影响**: 实际测试发现 PM2 重启后所有任务都变成 interrupted，说明异常处理逻辑有问题。

**修复方向**: 
- 为每个任务单独 try-catch
- 在调用 ensureSession 前验证 worktree_path 存在性
- 记录详细的错误日志（任务 ID、会话名称、失败原因）
- 添加恢复统计（成功/失败计数）

#### 缺陷 2: 客户端状态管理缺失

**问题**: Terminal 组件假设 socket 连接是永久的，没有考虑重连场景。

**代码位置**: `client/src/components/Terminal.jsx:60-70`

**架构背景**: 
- 前后端在同一个进程中（Express 服务 `client/dist` 静态文件）
- PM2 重启时，服务器进程重启，但浏览器中的 React 应用**不会刷新**
- Socket.io 连接断开后会自动重连，但 Terminal 组件不知道需要重新 attach

**架构问题**:
```javascript
// 当前实现
useEffect(() => {
  if (!socket || !sessionName) return;
  
  // 问题：只在 mount 时执行一次
  socket.emit('terminal:attach', { sessionName, cols: term.cols, rows: term.rows });
  socket.on(`terminal:data:${sessionName}`, onTerminalData);
  
  return () => {
    socket.off(`terminal:data:${sessionName}`, onTerminalData);
  };
}, [socket, sessionName]); 
// socket 对象引用不变，所以重连不会触发 re-run
```

**影响**: PM2 重启后，socket 虽然自动重连，但 Terminal 组件不会重新 attach，导致：
- 页面本身没有卡住（React 应用还在运行）
- 但 Terminal 无法接收新的输出（数据流中断）
- 用户看到的现象是"终端卡住了"

**修复方向**:
- useSocket.js 暴露 reconnect 事件
- Terminal 组件监听 reconnect 事件
- 重连后自动重新发送 terminal:attach
- 添加重连视觉反馈（"正在重连..."）

#### 缺陷 3: 状态持久化不完整

**问题**: agentChatSessionId 是内存变量，未持久化到数据库。

**代码位置**: `server/index.js:565-567`

**架构问题**:
```javascript
// 当前实现
const AGENT_RUNTIME_KEY = '__agent_home__';
let agentChatSessionId = null; // 问题：内存变量，重启后丢失
```

**对比**: 任务的 chat_session_id 存储在数据库中（tasks 表），但 agent 的会话 ID 只在内存中。

**影响**: PM2 重启后，用户的 agent chat 历史在数据库中，但会话 ID 丢失，无法继续对话。

**修复方向**:
- 创建 kv_store 表存储 agent 会话 ID
- 添加 getAgentSessionId() 和 setAgentSessionId() 函数
- 服务器启动时从数据库恢复 agentChatSessionId
- 会话 ID 更新时自动同步到数据库

### 架构改进总结

| 缺陷 | 违反的设计原则 | 修复策略 | 优先级 |
|-----|--------------|---------|--------|
| 错误隔离不足 | Fault Isolation | 细粒度异常处理 + 详细日志 | P0 |
| 客户端状态管理缺失 | Network Partition Tolerance | 监听重连事件 + 自动 reattach | P0 |
| 状态持久化不完整 | Stateful Service Persistence | 持久化 agentChatSessionId | P1 |

这些缺陷的共同点：**系统设计时没有充分考虑进程重启场景**，假设服务器进程是长期运行的，忽略了 PM2 重启、崩溃恢复等场景。

## PM2 重启流程

### 当前流程（有缺陷）

```
1. PM2 发送信号 (SIGTERM 或 SIGINT)
   ↓
2. SIGTERM 处理器触发（如果是 SIGTERM）
   ↓
3. 保存所有会话缓冲区到磁盘
   ↓
4. 进程退出
   ↓
5. PM2 启动新进程
   ↓
6. recoverSessions() 执行
   ↓
7. 从磁盘加载缓冲区
   ↓
8. 创建新的 PTY 会话
   ↓
9. 按任务 adapter 重新启动对应 CLI
   ↓
10. 客户端？？？（卡死，未重连）
```

### 期望流程（修复后）

```
1. PM2 发送信号 (SIGTERM 或 SIGINT)
   ↓
2. 信号处理器触发（监听两种信号）
   ↓
3. 保存所有会话缓冲区到磁盘（带日志）
   ↓
4. 进程退出
   ↓
5. PM2 启动新进程
   ↓
6. recoverSessions() 执行（增强版）
   ↓
7. 从磁盘加载缓冲区（验证文件存在）
   ↓
8. 创建新的 PTY 会话
   ↓
9. 重新启动 Claude CLI
   ↓
10. 客户端检测到断开连接
   ↓
11. 客户端自动重连（socket.io 配置）
   ↓
12. 客户端重新附加到会话
   ↓
13. 服务器回放缓冲区历史
   ↓
14. 界面恢复正常
```

## 关键设计决策

### 1. 为什么使用内存 Map 存储会话？

**优点**:
- 快速访问，O(1) 查找
- 简单的数据结构，易于维护
- 支持多客户端共享同一会话

**缺点**:
- 重启后会丢失，需要恢复机制
- 内存占用随会话数量增长

**权衡**: 选择内存 Map 是因为 PTY 会话本质上是进程，无法直接序列化。恢复机制通过保存输出缓冲区和重新启动进程来模拟持久化。

### 2. 为什么限制输出缓冲区为 300KB？

**原因**:
- 防止内存溢出（长时间运行的任务可能产生大量输出）
- 300KB 足够显示最近的终端历史
- 超过限制时，保留最新的 300KB（滑动窗口）

**权衡**: 牺牲完整历史记录换取内存安全。

### 3. 为什么使用 socket.io 而不是原生 WebSocket？

**优点**:
- 自动重连机制
- 事件驱动 API，易于使用
- 支持房间和命名空间
- 自动处理心跳和超时

**缺点**:
- 额外的依赖和开销
- 协议比原生 WebSocket 复杂

**权衡**: socket.io 的便利性和可靠性超过了额外开销。

### 4. 为什么使用 SQLite 而不是 PostgreSQL/MySQL？

**优点**:
- 零配置，嵌入式数据库
- 单文件存储，易于备份
- 足够的性能（单用户场景）
- 简化部署

**缺点**:
- 不支持多服务器扩展
- 并发写入性能有限

**权衡**: 对于单用户任务管理系统，SQLite 是最佳选择。

## 性能考虑

### 输出缓冲区管理

- 每个会话维护最近 300KB 输出
- 使用 StringDecoder 确保 UTF-8 正确解码
- 超过限制时，使用 `slice(-MAX_OUTPUT_BUFFER)` 保留最新数据

### WebSocket 心跳

- 每 15 秒发送心跳（`: ping\n\n`）
- 防止连接超时
- 检测客户端断开连接

### 数据库优化

- 启用 WAL 模式提高并发性能
- 使用索引加速查询（外键自动创建索引）
- 限制聊天历史查询数量（200-500 条）

## 安全考虑

### 认证

- 使用 Bearer Token 认证（环境变量 ACCESS_TOKEN）
- Webhook 端点豁免认证
- 所有其他端点需要认证

### 权限隔离

- 支持以特定用户运行任务（TASK_USER 环境变量）
- 如果以 root 运行，使用 `su` 切换到目标用户
- 防止跨用户访问

### 输入验证

- 任务 ID 清理：`replace(/[^a-zA-Z0-9_-]/g, '')`
- 工作目录使用 JSON.stringify 转义
- 防止命令注入

## 故障恢复

### 会话恢复

- 启动时自动恢复 in_progress 任务
- 从磁盘加载缓冲区历史
- 重新启动 Claude CLI 进程

### 错误处理

- PTY 进程退出时自动清理会话
- 客户端断开连接时从 clients 集合移除
- 超时保护（5 分钟）

### 状态同步

- 任务状态存储在数据库
- PTY 会话名称关联到任务
- 恢复失败时标记为 'interrupted'

## 扩展性

### 当前限制

- 单服务器架构，无法水平扩展
- 内存存储会话，受单机内存限制
- SQLite 不支持多服务器共享

### 未来改进方向

1. **分布式会话存储**
   - 使用 Redis 存储会话元数据
   - 支持多服务器共享会话

2. **负载均衡**
   - 使用 sticky session 确保客户端连接到同一服务器
   - 或使用 Redis adapter 实现跨服务器 socket.io

3. **持久化改进**
   - 使用 PostgreSQL 替代 SQLite
   - 实时同步缓冲区到数据库

## 维护指南

### 日志

- 使用 console.log 记录关键事件
- PM2 自动捕获 stdout/stderr
- 查看日志：`pm2 logs claude-manager`

### 监控

- 使用 `pm2 monit` 查看进程状态
- 检查内存使用：`pm2 show claude-manager`
- 数据库大小：`ls -lh data/manager.db`

### 备份

- 数据库：`cp data/manager.db data/manager.db.backup`
- 会话缓冲区：`tar -czf sessions-backup.tar.gz data/sessions/`

### 故障排查

1. **会话丢失**
   - 检查 `data/sessions/` 目录是否存在
   - 检查 PM2 日志中的 SIGTERM 处理器输出
   - 验证任务状态：`sqlite3 data/manager.db "SELECT * FROM tasks WHERE status='in_progress'"`

2. **客户端无法连接**
   - 检查 socket.io 端口是否开放
   - 验证 CORS 配置
   - 检查浏览器控制台错误

3. **PTY 进程僵尸**
   - 列出所有 PTY 进程：`ps aux | grep node-pty`
   - 手动清理：`pkill -f node-pty`

## 相关文档

- [Bug 修复需求文档](.kiro/specs/pm2-restart-session-loss/bugfix.md)
- [Bug 修复设计文档](.kiro/specs/pm2-restart-session-loss/design.md)
- [README.md](README.md)
