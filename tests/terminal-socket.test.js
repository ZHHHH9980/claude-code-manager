/**
 * Smoke test for the terminal socket flow.
 * Tests: terminal:attach → terminal:data, terminal:input, terminal:resize
 *
 * This test creates a real socket.io server with the terminal handlers
 * and verifies the data flow using mocked pty-manager.
 *
 * Run: node --test tests/terminal-socket.test.js
 */
const { describe, it, after, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Server } = require('socket.io');

// --- Mock pty-manager ---
let lastResizeCols = null;
let lastResizeRows = null;
let lastInputData = null;
const mockOnDataCallbacks = [];

const mockPtyProcess = {
  cols: 120,
  rows: 30,
  onData(cb) { mockOnDataCallbacks.push(cb); },
  resize(c, r) { lastResizeCols = c; lastResizeRows = r; },
  write(data) { lastInputData = data; },
};

const mockSessions = new Map();
mockSessions.set('test-session', {
  ptyProcess: mockPtyProcess,
  clients: new Set(),
});

const mockPtyManager = {
  sessions: mockSessions,
  resizeSession(name, cols, rows) {
    const entry = mockSessions.get(name);
    if (entry) entry.ptyProcess.resize(cols, rows);
  },
  sendInput(name, data) {
    const entry = mockSessions.get(name);
    if (entry) entry.ptyProcess.write(data);
  },
};

// --- Set up socket.io server with terminal handlers (mirrors server/index.js:649-679) ---
let httpServer, io, serverPort;

function setupServer() {
  return new Promise((resolve) => {
    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: '*' } });

    io.on('connection', (socket) => {
      let currentSession = null;

      socket.on('terminal:attach', (sessionName) => {
        currentSession = sessionName;
        const entry = mockPtyManager.sessions.get(sessionName);
        if (!entry) return socket.emit('terminal:error', 'Session not found');
        entry.clients.add(socket);
        entry.ptyProcess.onData((data) => socket.emit('terminal:data', data));
        const { cols, rows } = entry.ptyProcess;
        if (cols > 0 && rows > 0) entry.ptyProcess.resize(cols, rows);
      });

      socket.on('terminal:input', (data) => {
        if (currentSession) mockPtyManager.sendInput(currentSession, data);
      });

      socket.on('terminal:resize', ({ cols, rows }) => {
        if (currentSession && cols > 0 && rows > 0) {
          mockPtyManager.resizeSession(currentSession, cols, rows);
        }
      });

      socket.on('disconnect', () => {
        if (currentSession) {
          const entry = mockPtyManager.sessions.get(currentSession);
          if (entry) entry.clients.delete(socket);
        }
      });
    });

    httpServer.listen(0, () => {
      serverPort = httpServer.address().port;
      resolve();
    });
  });
}

function connectClient() {
  // Dynamic import socket.io-client (installed in client/)
  const { io: ioClient } = require('socket.io-client');
  return ioClient(`http://localhost:${serverPort}`, { transports: ['websocket'] });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('terminal socket handlers', () => {
  before(async () => { await setupServer(); });
  after(() => {
    io?.close();
    httpServer?.close();
  });

  it('terminal:attach emits terminal:error for unknown session', async () => {
    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    const errorPromise = new Promise(r => client.on('terminal:error', r));
    client.emit('terminal:attach', 'nonexistent-session');
    const msg = await errorPromise;
    assert.equal(msg, 'Session not found');
    client.disconnect();
  });

  it('terminal:attach succeeds and triggers SIGWINCH resize', async () => {
    lastResizeCols = null;
    lastResizeRows = null;
    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    client.emit('terminal:attach', 'test-session');
    await wait(100);
    // Should have called resize to trigger SIGWINCH
    assert.equal(lastResizeCols, 120);
    assert.equal(lastResizeRows, 30);
    // Client should be in the clients set
    const entry = mockSessions.get('test-session');
    assert.ok(entry.clients.size > 0, 'client should be added to clients set');
    client.disconnect();
  });

  it('terminal:data flows from pty to client', async () => {
    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    const dataPromise = new Promise(r => client.on('terminal:data', r));
    client.emit('terminal:attach', 'test-session');
    await wait(50);
    // Simulate pty output
    const latestCb = mockOnDataCallbacks[mockOnDataCallbacks.length - 1];
    latestCb('hello from pty');
    const received = await dataPromise;
    assert.equal(received, 'hello from pty');
    client.disconnect();
  });

  it('terminal:input flows from client to pty', async () => {
    lastInputData = null;
    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    client.emit('terminal:attach', 'test-session');
    await wait(50);
    client.emit('terminal:input', 'user typed this');
    await wait(50);
    assert.equal(lastInputData, 'user typed this');
    client.disconnect();
  });

  it('terminal:resize updates pty dimensions', async () => {
    lastResizeCols = null;
    lastResizeRows = null;
    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    client.emit('terminal:attach', 'test-session');
    await wait(50);
    client.emit('terminal:resize', { cols: 200, rows: 60 });
    await wait(50);
    assert.equal(lastResizeCols, 200);
    assert.equal(lastResizeRows, 60);
    client.disconnect();
  });

  it('terminal:resize ignores invalid dimensions', async () => {
    lastResizeCols = null;
    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    client.emit('terminal:attach', 'test-session');
    await wait(50);
    // Reset after attach resize
    lastResizeCols = null;
    client.emit('terminal:resize', { cols: 0, rows: -1 });
    await wait(50);
    assert.equal(lastResizeCols, null, 'should not resize with invalid dims');
    client.disconnect();
  });

  it('disconnect removes client from session clients set', async () => {
    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    client.emit('terminal:attach', 'test-session');
    await wait(50);
    const entry = mockSessions.get('test-session');
    const sizeBefore = entry.clients.size;
    client.disconnect();
    await wait(100);
    assert.ok(entry.clients.size < sizeBefore, 'client should be removed on disconnect');
  });
});
