# PM2 重启会话丢失 Bugfix 设计

## 概述

本次修复解决 PM2 重启导致的两个核心问题：

1. **前后端耦合导致页面不可用**：Express 同时服务 API 和静态文件，重启时前端不可用
2. **Agent 会话 ID 未持久化**：agentChatSessionId 是内存变量，重启后丢失

修复策略：
1. 前后端分离：使用 nginx 或独立静态文件服务器（最小化改动方案）
2. 持久化 agentChatSessionId：存储到数据库

关于"所有任务 interrupted"：代码审查显示 recoverSessions() 已有正确的错误隔离，建议添加详细日志诊断用户环境问题，而非修改核心逻辑。

## 术语表

- **前后端分离**: 前端静态文件和后端 API 由不同的服务提供
- **agentChatSessionId**: Agent chat 的会话标识符，用于保持对话上下文
- **PM2**: Node.js 进程管理器，用于管理服务器进程

## Bug 详情

### Bug 1: 前后端耦合导致页面不可用

**代码位置**: `server/index.js:38`

**当前实现**:
```javascript
app.use(express.static(path.join(__dirname, '../client/dist')));
```

**问题**:
- Express 同时服务 API 和静态文件
- PM2 重启时，整个进程重启，静态文件服务中断
- 用户刷新页面会失败（无法加载 HTML/JS/CSS）

**影响**: 用户必须等待服务器完全启动才能访问页面

### Bug 2: Agent 会话 ID 未持久化

**代码位置**: `server/index.js:565-567`

**当前实现**:
```javascript
const AGENT_RUNTIME_KEY = '__agent_home__';
let agentChatSessionId = null; // 内存变量
```

**问题**:
- agentChatSessionId 存储在内存中
- PM2 重启后，变量丢失
- 用户的 chat 历史在数据库中，但会话 ID 丢失

**影响**: 用户无法继续之前的对话，必须清除历史重新开始

## 修复实现

### 修复 1: 前后端分离（最小化改动方案）

**方案**: 使用独立的 Node.js 进程服务静态文件

**文件 1**: 新建 `static-server.js`

```javascript
const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'client/dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

const PORT = process.env.STATIC_PORT || 8080;
app.listen(PORT, () => {
  console.log(`Static server running on http://localhost:${PORT}`);
});
```

**文件 2**: `server/index.js`

移除静态文件服务：
```javascript
// 删除这一行
// app.use(express.static(path.join(__dirname, '../client/dist')));
```

更新 CORS 配置：
```javascript
const io = new Server(server, { 
  cors: { 
    origin: process.env.FRONTEND_URL || 'http://localhost:8080',
    credentials: true
  } 
});
```

**文件 3**: `client/vite.config.js`

添加开发代理：
```javascript
export default {
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true
      }
    }
  }
}
```

**文件 4**: `package.json`

添加脚本：
```json
{
  "scripts": {
    "dev": "node server/index.js",
    "static": "node static-server.js"
  }
}
```

**部署**: 使用 PM2 管理两个进程
```bash
pm2 start server/index.js --name claude-manager-api
pm2 start static-server.js --name claude-manager-static
pm2 save
```

### 修复 2: 持久化 agentChatSessionId

**文件 1**: `server/db.js`

添加 kv_store 表和相关函数：
```javascript
// 创建表（如果不存在）
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

function getAgentSessionId() {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('agent_session_id');
  return row?.value || null;
}

function setAgentSessionId(sessionId) {
  db.prepare(`
    INSERT INTO kv_store (key, value, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
  `).run('agent_session_id', sessionId, sessionId);
}

module.exports = {
  // ... 现有导出
  getAgentSessionId,
  setAgentSessionId,
};
```

**文件 2**: `server/index.js`

使用持久化的 agentChatSessionId：
```javascript
// 启动时从数据库恢复
let agentChatSessionId = db.getAgentSessionId();

// 设置会话 ID 时同步到数据库
app.post('/api/agent', (req, res) => {
  // ...
  const hasSession = Boolean(agentChatSessionId);
  const sessionId = agentChatSessionId || randomUUID();
  if (!hasSession) {
    agentChatSessionId = sessionId;
    db.setAgentSessionId(sessionId); // 持久化
  }
  // ...
});

// 清除历史时也清除持久化的会话 ID
app.delete('/api/agent/history', (req, res) => {
  resetAgentChat('agent_clear_history');
  db.clearAgentChatMessages();
  db.setAgentSessionId(null); // 清除持久化
  res.json({ ok: true });
});
```

## 测试策略

### 测试 1: 前后端分离

**步骤**:
1. 启动两个进程：`pm2 start server/index.js` 和 `pm2 start static-server.js`
2. 访问 `http://localhost:8080`，确认页面正常加载
3. 执行 `pm2 restart claude-manager-api`
4. 刷新页面，确认页面仍然可以加载（静态文件服务未中断）
5. 确认 API 功能恢复正常（socket 重连）

**预期结果**: 页面在后端重启期间保持可用

### 测试 2: Agent 会话持久化

**步骤**:
1. 发送 agent chat 消息，记录会话 ID
2. 执行 `pm2 restart claude-manager-api`
3. 继续发送 agent chat 消息
4. 确认会话 ID 保持不变，对话可以继续

**预期结果**: Agent chat 会话在重启后保持连续性

### 回归测试

- 测试任务启动和停止
- 测试终端输入输出
- 测试多客户端会话共享
- 测试首次启动初始化

## 关于"所有任务 interrupted"的建议

**代码审查结果**: recoverSessions() 已经为每个任务使用独立的 try-catch，错误隔离是正确的。

**建议改进**（可选，不在本次 bugfix 范围内）:

添加详细的恢复日志：
```javascript
function recoverSessions() {
  const aliveSessions = ptyManager.listAliveSessions();
  const tasks = db.getTasks();
  
  let successCount = 0;
  let failCount = 0;
  const failedTasks = [];
  
  for (const task of tasks) {
    if (task.status !== 'in_progress' || !task.pty_session) continue;
    
    try {
      // ... 恢复逻辑
      successCount++;
      console.log(`✓ Task ${task.id}: recovered`);
    } catch (err) {
      failCount++;
      failedTasks.push({ id: task.id, error: err.message });
      console.error(`✗ Task ${task.id}: ${err.message}`);
      db.updateTask(task.id, { status: 'interrupted' });
    }
  }
  
  console.log(`\nRecovery: ${successCount} success, ${failCount} failed`);
  if (failedTasks.length > 0) {
    console.log('Failed tasks:', failedTasks);
  }
}
```

这样可以帮助用户诊断为什么任务恢复失败（worktree 不存在、权限问题等）。
