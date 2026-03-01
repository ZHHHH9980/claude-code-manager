# PM2 重启会话丢失 Bugfix - 实现任务

## 任务 1: 前后端分离

### 1.1 创建独立静态文件服务器
- [ ] 创建 `static-server.js` 文件
  - 使用 Express 服务 `client/dist` 目录
  - 添加 SPA 路由支持（所有路径返回 index.html）
  - 监听端口 8080（可通过环境变量配置）

### 1.2 修改后端服务器配置
- [ ] 从 `server/index.js` 移除静态文件服务
  - 删除 `app.use(express.static(...))` 行
- [ ] 更新 socket.io CORS 配置
  - 允许来自静态服务器的请求（默认 http://localhost:8080）
  - 支持通过环境变量 FRONTEND_URL 配置

### 1.3 更新客户端配置
- [ ] 修改 `client/vite.config.js`
  - 添加开发代理配置（/api 和 /socket.io）
- [ ] 更新 `package.json`
  - 添加 `static` 脚本用于启动静态服务器

### 1.4 更新部署配置
- [ ] 更新 `deploy.sh`
  - 使用 PM2 管理两个进程：claude-manager-api 和 claude-manager-static
  - 确保两个进程都正确启动
- [ ] 更新 README.md
  - 添加前后端分离的说明
  - 更新启动命令

## 任务 2: Agent 会话 ID 持久化

### 2.1 添加数据库支持
- [ ] 修改 `server/db.js`
  - 创建 kv_store 表（如果不存在）
  - 添加 `getAgentSessionId()` 函数
  - 添加 `setAgentSessionId(sessionId)` 函数
  - 导出新函数

### 2.2 修改服务器代码
- [ ] 修改 `server/index.js`
  - 启动时从数据库恢复 agentChatSessionId
  - 在 `/api/agent` 端点设置会话 ID 时同步到数据库
  - 在 `/api/agent/history` 端点清除历史时也清除持久化的会话 ID

## 任务 3: 测试和验证

### 3.1 前后端分离测试
- [ ] 启动两个进程并验证功能
  - 启动 API 服务器和静态服务器
  - 访问页面，确认正常加载
  - 重启 API 服务器，确认页面仍可访问
  - 验证 socket 重连后功能恢复

### 3.2 Agent 会话持久化测试
- [ ] 测试会话持久化
  - 发送 agent chat 消息
  - 重启服务器
  - 继续发送消息，确认会话保持连续

### 3.3 回归测试
- [ ] 验证现有功能不受影响
  - 测试任务启动和停止
  - 测试终端输入输出
  - 测试多客户端会话共享
  - 测试首次启动初始化

## 任务 4: 文档更新

### 4.1 更新架构文档
- [ ] 更新 `ARCHITECTURE.md`
  - 记录前后端分离的架构变更
  - 更新部署流程说明

### 4.2 更新 README
- [ ] 更新 `README.md`
  - 添加新的启动命令
  - 说明前后端分离的好处
  - 更新环境变量说明

## 可选任务（不在本次 bugfix 范围内）

### 5.1 改进 recoverSessions() 日志
- [ ]* 添加详细的恢复统计日志
  - 记录成功/失败的任务数量
  - 记录每个失败任务的具体原因
  - 帮助用户诊断环境问题

### 5.2 添加健康检查端点
- [ ]* 添加 `/api/health` 端点
  - 返回服务器状态
  - 返回活跃会话列表
  - 用于监控和调试
