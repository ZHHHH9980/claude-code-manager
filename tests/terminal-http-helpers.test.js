const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSessionName,
  getTerminalState,
  sendTerminalJSONError,
  emitSSE,
  buildTerminalEmbedPage,
} = require('../server/terminal-http-helpers');

describe('terminal-http-helpers', () => {
  it('normalizes valid session names and rejects unsafe values', () => {
    assert.equal(normalizeSessionName('  task-1:main  '), 'task-1:main');
    assert.equal(normalizeSessionName(''), '');
    assert.equal(normalizeSessionName('../bad-session'), '');
    assert.equal(normalizeSessionName('bad session'), '');
  });

  it('builds terminal state with task ownership and buffered output size', () => {
    const clients = new Set(['client-a', 'client-b']);
    const state = getTerminalState('task-123', {
      ptyManager: {
        sessions: new Map([['task-123', { clients }]]),
        sessionExists(sessionName) {
          return sessionName === 'task-123';
        },
        getBufferedOutput() {
          return 'hello terminal';
        },
      },
      db: {
        getTasks() {
          return [
            { id: 't1', pty_session: 'task-123', status: 'in_progress' },
            { id: 't2', pty_session: 'other-session', status: 'done' },
          ];
        },
      },
    });

    assert.deepEqual(state, {
      sessionName: 'task-123',
      exists: true,
      state: 'attached',
      code: 'ok',
      attachedClients: 2,
      bufferBytes: 'hello terminal'.length,
      taskId: 't1',
      taskStatus: 'in_progress',
      runningTaskId: 't1',
      recoverable: true,
    });
  });

  it('sends terminal json errors with code and extra payload', () => {
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
      },
    };

    sendTerminalJSONError(res, 404, 'session_not_found', 'session not found', { retryable: false });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
      error: 'session not found',
      code: 'session_not_found',
      retryable: false,
    });
  });

  it('emits SSE frames unless the response already ended', () => {
    const chunks = [];
    emitSSE({
      writableEnded: false,
      write(chunk) {
        chunks.push(chunk);
      },
    }, { type: 'ready', sessionName: 'task-123' });
    emitSSE({
      writableEnded: true,
      write() {
        throw new Error('should not write');
      },
    }, { type: 'ignored' });

    assert.deepEqual(chunks, ['data: {"type":"ready","sessionName":"task-123"}\n\n']);
  });

  it('builds an embed page with encoded read/input endpoints', () => {
    const html = buildTerminalEmbedPage('task/123:main', 'secret token');

    assert.match(html, /Web Terminal/);
    assert.match(html, /task\/123:main/);
    assert.match(html, /\/api\/terminal\/task%2F123%3Amain\/read\?access_token=secret%20token/);
    assert.match(html, /\/api\/terminal\/task%2F123%3Amain\/input\?access_token=secret%20token/);
  });
});
