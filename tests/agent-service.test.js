const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

const { createAgentService } = require('../server/agent-service');

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
    emit(event) {
      const handler = listeners.get(event);
      if (handler) handler();
    },
  };
}

describe('agent-service', () => {
  it('returns a CLI error payload when adapter command is missing', () => {
    const service = createAgentService({
      db: { getAgentSessionId: () => null },
      ptyManager: {},
      taskChatRuntimeManager: { stopTask: () => {} },
      resolveAdapter: () => ({ adapter: { name: 'codex', cli: 'codex', defaultModel: 'gpt-5.4' }, usedLegacyAlias: false }),
      isCommandAvailable: () => false,
      launchAdapterInSession: () => {},
      rootDir: '/tmp/app',
      terminalSessionName: 'agent-home',
    });

    const result = service.startTerminal('codex');
    assert.deepEqual(result, {
      sessionName: 'agent-home',
      ptyOk: false,
      mode: 'codex',
      error: 'CLI not found: codex',
    });
  });

  it('clears history and resets persisted session state', () => {
    const stopTask = mock.fn();
    const setAgentSessionId = mock.fn();
    const clearAgentChatMessages = mock.fn();
    const service = createAgentService({
      db: {
        getAgentSessionId: () => 'session-1',
        setAgentSessionId,
        clearAgentChatMessages,
      },
      ptyManager: {},
      taskChatRuntimeManager: { stopTask },
      resolveAdapter: () => ({ adapter: { name: 'claude', cli: 'claude', defaultModel: 'claude-sonnet-4-5' }, usedLegacyAlias: false }),
      isCommandAvailable: () => true,
      launchAdapterInSession: () => {},
      rootDir: '/tmp/app',
      terminalSessionName: 'agent-home',
    });

    service.clearHistory();

    assert.equal(stopTask.mock.calls[0].arguments[0], '__agent_home__');
    assert.equal(stopTask.mock.calls[0].arguments[1], 'agent_clear_history');
    assert.equal(setAgentSessionId.mock.calls[0].arguments[0], null);
    assert.equal(clearAgentChatMessages.mock.calls.length, 1);
  });

  it('streams assistant output and persists chat session state', async () => {
    const appendAgentChatMessage = mock.fn();
    const setAgentSessionId = mock.fn();
    const send = mock.fn(async ({ onAssistantText }) => {
      onAssistantText('hello');
      onAssistantText(' world');
    });
    const service = createAgentService({
      db: {
        getAgentSessionId: () => null,
        setAgentSessionId,
        appendAgentChatMessage,
      },
      ptyManager: {},
      taskChatRuntimeManager: { send, stopTask: () => {} },
      resolveAdapter: () => ({ adapter: { name: 'claude', cli: 'claude', defaultModel: 'claude-sonnet-4-5' }, usedLegacyAlias: false }),
      isCommandAvailable: () => true,
      launchAdapterInSession: () => {},
      rootDir: '/tmp/app',
      terminalSessionName: 'agent-home',
    });
    const res = createMockResponse();

    const result = await service.streamResponse('hi', res);

    assert.deepEqual(result, { handled: true });
    assert.equal(setAgentSessionId.mock.calls.length, 1);
    assert.equal(appendAgentChatMessage.mock.calls[0].arguments[0], 'user');
    assert.equal(appendAgentChatMessage.mock.calls[0].arguments[1], 'hi');
    assert.equal(appendAgentChatMessage.mock.calls[1].arguments[0], 'assistant');
    assert.equal(appendAgentChatMessage.mock.calls[1].arguments[1], 'hello world');
    assert.match(res.chunks[0], /"ready":true/);
    assert.match(res.chunks.join(''), /hello/);
    assert.equal(res.writableEnded, true);
  });
});
