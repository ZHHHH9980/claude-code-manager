# 需求：移除 AssistantChatWindow 聊天功能

## 背景

AssistantChatWindow 是一个独立于 xterm 终端的聊天气泡界面，通过 SSE 与 Claude 进程通信。目前实际使用中几乎没用到，所有交互都通过终端完成。需要将其完整移除以简化代码。

## 需要删除的内容

### 前端

1. **删除组件文件**: `client/src/components/AssistantChatWindow.jsx`
2. **App.jsx 清理**:
   - 移除 `import { AssistantChatWindow }` (line 5)
   - 移除 `agentPanelTab` state 及相关 tab 切换按钮 (agent 面板的 Terminal/Chat tab)
   - 移除 `taskModalTab` 中 chat 相关逻辑 (任务弹窗的 Terminal/Chat tab)
   - 移除 mobile 端 `mobilePane === 'chat'` 相关逻辑
   - 所有原来 tab 切换的地方直接只渲染 Terminal 组件
   - 清理相关 state: `agentPanelTab`, `taskModalTab` 中 chat 分支

### 后端

3. **删除文件**: `server/task-chat-runtime.js`
4. **server/index.js 清理**:
   - 移除 `POST /api/tasks/:id/chat` 路由
   - 移除 `GET /api/tasks/:id/chat/history` 路由
   - 移除 `DELETE /api/tasks/:id/chat/history` 路由
   - 移除 `POST /api/agent` 路由
   - 移除 `GET /api/agent/history` 路由
   - 移除 `DELETE /api/agent/history` 路由
   - 移除 task-chat-runtime 的 import 和初始化逻辑
5. **server/db.js**: 移除 `task_chat_messages` 和 `agent_chat_messages` 表的建表语句及相关查询函数

### 文档

6. **docs/architecture.md**: 移除 SSE chat 相关描述，更新通信模式图（去掉 SSE chat streaming 部分）
7. **README.md**: 架构图中移除 AssistantChatWindow 和 SSE Stream
8. **CLAUDE.md**: 移除 `/api/tasks/:id/chat` 和 `/api/agent` 相关 API 描述

## 验证

- `npm run build` 前端构建通过，无报错
- 启动服务后，agent 面板直接显示终端（无 tab 切换）
- 任务弹窗直接显示终端（无 tab 切换）
- 移动端布局正常
- 已有的终端功能不受影响
