const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

const { createTaskChatService } = require('../server/task-chat-service');

function createMockResponse() {
  const chunks = [];
  const listeners = new Map();
  return {
    chunks,
    writableEnded: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    flushHeaders() {},
    write(chunk) {
      chunks.push(chunk);
    },
    end() {
      this.writableEnded = true;
    },
    on(event, handler) {
      listeners.set(event, handler);
    },
  };
}

describe('task-chat-service', () => {
  it('returns 404 when the task does not exist', async () => {
    const service = createTaskChatService({
      db: { getTask: () => null },
      sessionClient: {},
      taskChatRuntimeManager: {},
      ensureTaskProcess: () => null,
      buildTaskSessionPrompt: () => '',
      isTaskStatusQuery: () => false,
      buildTaskStatusReply: () => '',
      rootDir: '/tmp/app',
    });

    const result = await service.streamResponse('missing', 'hello', createMockResponse());
    assert.deepEqual(result, {
      handled: false,
      httpStatus: 404,
      body: { error: 'task not found' },
    });
  });

  it('returns a shortcut status SSE reply for progress queries', async () => {
    const appendTaskChatMessage = mock.fn();
    const service = createTaskChatService({
      db: {
        getTask: () => ({ id: 't1', project_id: 'p1', title: 'Refactor server', chat_session_id: null }),
        getProject: () => ({ id: 'p1', name: 'CCM' }),
        appendTaskChatMessage,
      },
      sessionClient: { sessionExists: async () => true },
      taskChatRuntimeManager: {},
      ensureTaskProcess: async () => ({ sessionName: 'task-session', cwd: '/tmp/repo' }),
      buildTaskSessionPrompt: () => '',
      isTaskStatusQuery: () => true,
      buildTaskStatusReply: () => 'Current task progress summary',
      rootDir: '/tmp/app',
    });
    const res = createMockResponse();

    const result = await service.streamResponse('t1', 'what is the progress?', res);

    assert.deepEqual(result, { handled: true });
    assert.equal(appendTaskChatMessage.mock.calls.length, 2);
    assert.match(res.chunks.join(''), /Current task progress summary/);
    assert.match(res.chunks.join(''), /"shortcut":"task_status"/);
    assert.equal(res.writableEnded, true);
  });

  it('streams assistant output for a normal task chat turn', async () => {
    const appendTaskChatMessage = mock.fn();
    const updateTask = mock.fn();
    const send = mock.fn(async ({ onAssistantText }) => {
      onAssistantText('part 1');
      onAssistantText(' part 2');
      return 'part 1 part 2';
    });
    const service = createTaskChatService({
      db: {
        getTask: () => ({ id: 't1', project_id: 'p1', title: 'Refactor server', chat_session_id: null }),
        getProject: () => ({ id: 'p1', name: 'CCM' }),
        appendTaskChatMessage,
        updateTask,
      },
      sessionClient: { sessionExists: async () => true },
      taskChatRuntimeManager: { send },
      ensureTaskProcess: async () => ({ sessionName: 'task-session', cwd: '/tmp/repo' }),
      buildTaskSessionPrompt: () => 'scoped prompt',
      isTaskStatusQuery: () => false,
      buildTaskStatusReply: () => '',
      rootDir: '/tmp/app',
    });
    const res = createMockResponse();

    const result = await service.streamResponse('t1', 'continue', res);

    assert.deepEqual(result, { handled: true });
    assert.equal(updateTask.mock.calls.length, 1);
    assert.equal(appendTaskChatMessage.mock.calls[0].arguments[1], 'user');
    assert.equal(appendTaskChatMessage.mock.calls[0].arguments[2], 'continue');
    assert.equal(appendTaskChatMessage.mock.calls[1].arguments[1], 'assistant');
    assert.equal(appendTaskChatMessage.mock.calls[1].arguments[2], 'part 1 part 2');
    assert.match(res.chunks.join(''), /part 1/);
    assert.equal(res.writableEnded, true);
  });
});
