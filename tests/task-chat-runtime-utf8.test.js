const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

let TaskChatRuntimeManager;
let fakeChild = null;

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: mock.fn(),
    end: mock.fn(),
  };
  child.kill = mock.fn(() => {
    child.killed = true;
  });
  child.killed = false;
  child.pid = 12345;
  return child;
}

function loadFreshRuntimeModule() {
  const runtimePath = require.resolve('../server/task-chat-runtime');
  delete require.cache[runtimePath];

  const cpPath = require.resolve('child_process');
  const realCP = require('child_process');
  require.cache[cpPath] = {
    id: cpPath,
    filename: cpPath,
    loaded: true,
    exports: {
      ...realCP,
      spawn: mock.fn(() => {
        fakeChild = createFakeChild();
        return fakeChild;
      }),
    },
  };

  ({ TaskChatRuntimeManager } = require('../server/task-chat-runtime'));
}

function emitSplitUtf8(stream, text, splitOffset = 1) {
  const buf = Buffer.from(text, 'utf8');
  const splitAt = Math.max(1, Math.min(buf.length - 1, splitOffset));
  stream.emit('data', buf.subarray(0, splitAt));
  stream.emit('data', buf.subarray(splitAt));
}

describe('task-chat-runtime UTF-8 decoding', () => {
  beforeEach(() => {
    fakeChild = null;
    loadFreshRuntimeModule();
  });

  afterEach(() => {
    delete require.cache[require.resolve('../server/task-chat-runtime')];
    delete require.cache[require.resolve('child_process')];
  });

  it('keeps Chinese assistant text intact when bytes split across chunks', async () => {
    const manager = new TaskChatRuntimeManager({ logMetric: () => {} });
    const pieces = [];

    const turnPromise = manager.send({
      taskId: 'task-utf8-1',
      cwd: process.cwd(),
      sessionId: null,
      resumeSession: false,
      prompt: 'test',
      timeoutMs: 2000,
      onAssistantText: (text) => pieces.push(text),
    });

    await new Promise((resolve) => setImmediate(resolve));

    const text = '中文输出正常';
    const assistantLine = `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    })}\n`;
    const firstChar = Buffer.from('中', 'utf8');
    const splitAt = Buffer.from(assistantLine, 'utf8').indexOf(firstChar) + 1;
    emitSplitUtf8(fakeChild.stdout, assistantLine, splitAt);

    fakeChild.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: '', subtype: 'success' })}\n`, 'utf8'));

    const result = await turnPromise;
    assert.equal(result, text);
    assert.deepEqual(pieces, [text]);
    assert.equal(result.includes('�'), false);
    manager.stopTask('task-utf8-1', 'test_done');
  });

  it('parses trailing JSON without newline on close and preserves Chinese', async () => {
    const manager = new TaskChatRuntimeManager({ logMetric: () => {} });

    const turnPromise = manager.send({
      taskId: 'task-utf8-2',
      cwd: process.cwd(),
      sessionId: null,
      resumeSession: false,
      prompt: 'test',
      timeoutMs: 2000,
    });

    await new Promise((resolve) => setImmediate(resolve));

    const tailLine = JSON.stringify({ type: 'result', result: '完成', subtype: 'success' });
    const firstChar = Buffer.from('完', 'utf8');
    const splitAt = Buffer.from(tailLine, 'utf8').indexOf(firstChar) + 1;
    emitSplitUtf8(fakeChild.stdout, tailLine, splitAt);
    fakeChild.emit('close', 0, null);

    const result = await turnPromise;
    assert.equal(result, '完成');
  });
});
