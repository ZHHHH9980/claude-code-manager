const path = require('path');
const { randomUUID } = require('crypto');

function createTaskChatService({
  db,
  sessionClient,
  taskChatRuntimeManager,
  ensureTaskProcess,
  buildTaskSessionPrompt,
  isTaskStatusQuery,
  buildTaskStatusReply,
  rootDir = path.join(__dirname, '..'),
}) {
  function prepareSSE(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`data: ${JSON.stringify({ ready: true })}\n\n`);
  }

  function getHistory(taskId, limit = 300) {
    return db.getTaskChatMessages(taskId, limit);
  }

  function clearHistory(taskId) {
    taskChatRuntimeManager.stopTask(taskId, 'clear_history');
    db.clearTaskChatMessages(taskId);
    db.updateTask(taskId, { chatSessionId: null });
  }

  async function streamResponse(taskId, message, res) {
    const safeMessage = String(message || '').trim();
    if (!safeMessage) {
      return {
        handled: false,
        httpStatus: 400,
        body: { error: 'message required' },
      };
    }

    const task = db.getTask(taskId);
    if (!task) {
      return {
        handled: false,
        httpStatus: 404,
        body: { error: 'task not found' },
      };
    }

    const runtime = await ensureTaskProcess(task, { ensurePty: false });
    if (!runtime) {
      return {
        handled: false,
        httpStatus: 400,
        body: { error: 'task worktree/repo path missing' },
      };
    }

    const project = task.project_id ? db.getProject(task.project_id) : null;
    if (isTaskStatusQuery(safeMessage)) {
      const quickReply = buildTaskStatusReply(task, project, await sessionClient.sessionExists(runtime.sessionName));
      db.appendTaskChatMessage(taskId, 'user', safeMessage);
      db.appendTaskChatMessage(taskId, 'assistant', quickReply);
      prepareSSE(res);
      res.write(`data: ${JSON.stringify({ text: quickReply })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, code: 0, signal: null, shortcut: 'task_status' })}\n\n`);
      res.end();
      return { handled: true };
    }

    const hasSession = Boolean(task.chat_session_id);
    const chatSessionId = task.chat_session_id || randomUUID();
    if (!hasSession) db.updateTask(taskId, { chatSessionId });
    db.appendTaskChatMessage(taskId, 'user', safeMessage);
    const scopedMessage = buildTaskSessionPrompt(task, project, safeMessage, !hasSession);

    prepareSSE(res);
    let clientClosed = false;
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    const cleanup = () => clearInterval(heartbeat);
    res.on('close', () => {
      clientClosed = true;
      cleanup();
    });

    try {
      const assistantOutput = await taskChatRuntimeManager.send({
        taskId,
        cwd: runtime.cwd || rootDir,
        sessionId: chatSessionId,
        resumeSession: hasSession,
        prompt: scopedMessage,
        timeoutMs: 300000,
        onAssistantText: (text) => {
          if (clientClosed || res.writableEnded) return;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        },
      });

      cleanup();
      if (assistantOutput.trim()) db.appendTaskChatMessage(taskId, 'assistant', assistantOutput);
      if (!clientClosed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true, code: 0, signal: null })}\n\n`);
        res.end();
      }
      return { handled: true };
    } catch (err) {
      cleanup();
      if (res.writableEnded || clientClosed) return { handled: true };
      res.write(`data: ${JSON.stringify({
        error: true,
        error_code: 'TASK_CHAT_RUNTIME_ERROR',
        text: err?.message || 'task chat runtime error',
        done: true,
      })}\n\n`);
      res.end();
      return { handled: true };
    }
  }

  return {
    getHistory,
    clearHistory,
    streamResponse,
  };
}

module.exports = {
  createTaskChatService,
};
