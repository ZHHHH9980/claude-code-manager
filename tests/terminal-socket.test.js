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
  onData(cb) {
    mockOnDataCallbacks.push(cb);
    return { dispose: mock.fn() };
  },
  resize(c, r) { lastResizeCols = c; lastResizeRows = r; this.cols = c; this.rows = r; },
  write(data) { lastInputData = data; },
};

const mockSessions = new Map();
mockSessions.set('test-session', {
  ptyProcess: mockPtyProcess,
  clients: new Set(),
});

const mockPtyManager = {
  sessions: mockSessions,
  // Simulated screen content per session (set in tests to control capture-pane output)
  screenContent: new Map(),
  capturePane(sessionName) {
    return this.screenContent.get(sessionName) || '';
  },
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
const allClients = [];

function setupServer() {
  return new Promise((resolve) => {
    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: '*' } });

    io.on('connection', (socket) => {
      const attachedSessions = new Set();

      socket.on('terminal:attach', (payload) => {
        const sessionName = typeof payload === 'string' ? payload : payload?.sessionName;
        const initCols = typeof payload === 'object' && payload?.cols > 0 ? payload.cols : null;
        const initRows = typeof payload === 'object' && payload?.rows > 0 ? payload.rows : null;
        const replayBuffer = typeof payload === 'object' && typeof payload?.replayBuffer === 'boolean'
          ? payload.replayBuffer
          : true;
        const forceRedraw = typeof payload === 'object' && typeof payload?.forceRedraw === 'boolean'
          ? payload.forceRedraw
          : true;

        const entry = mockPtyManager.sessions.get(sessionName);
        if (!entry) return socket.emit('terminal:error', 'Session not found');
        attachedSessions.add(sessionName);
        entry.clients.add(socket);
        entry.ptyProcess.onData((data) => socket.emit(`terminal:data:${sessionName}`, data));
        // Replay current screen content
        if (replayBuffer) {
          const captured = mockPtyManager.capturePane(sessionName);
          if (captured && captured.trim()) socket.emit(`terminal:data:${sessionName}`, captured);
        }
        // Resize PTY to client dimensions BEFORE SIGWINCH
        if (initCols && initRows) {
          mockPtyManager.resizeSession(sessionName, initCols, initRows);
        }
        // SIGWINCH toggle
        if (forceRedraw) {
          const { cols, rows } = entry.ptyProcess;
          if (cols > 1 && rows > 1) {
            entry.ptyProcess.resize(cols - 1, rows);
            setTimeout(() => entry.ptyProcess.resize(cols, rows), 50);
          }
        }
      });

      socket.on('terminal:input', ({ sessionName: sn, data }) => {
        if (sn) mockPtyManager.sendInput(sn, data);
      });

      socket.on('terminal:resize', ({ sessionName: sn, cols, rows }) => {
        if (sn && cols > 0 && rows > 0) {
          mockPtyManager.resizeSession(sn, cols, rows);
        }
      });

      socket.on('disconnect', () => {
        for (const sessionName of attachedSessions) {
          const entry = mockPtyManager.sessions.get(sessionName);
          if (entry) entry.clients.delete(socket);
        }
        attachedSessions.clear();
      });
    });

    httpServer.listen(0, () => {
      serverPort = httpServer.address().port;
      resolve();
    });
  });
}

function connectClient() {
  const { io: ioClient } = require('socket.io-client');
  const client = ioClient(`http://localhost:${serverPort}`, { transports: ['websocket'], forceNew: true });
  allClients.push(client);
  return client;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('terminal socket handlers', () => {
  before(async () => { await setupServer(); });
  after(() => {
    allClients.forEach(c => { try { c.disconnect(); } catch {} });
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
    const dataPromise = new Promise(r => client.on('terminal:data:test-session', r));
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
    client.emit('terminal:input', { sessionName: 'test-session', data: 'user typed this' });
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
    await wait(150); // wait for SIGWINCH toggle (50ms setTimeout) to complete first
    client.emit('terminal:resize', { sessionName: 'test-session', cols: 200, rows: 60 });
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
    await wait(150);
    // Reset after attach resize + SIGWINCH toggle completes
    lastResizeCols = null;
    client.emit('terminal:resize', { sessionName: 'test-session', cols: 0, rows: -1 });
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

  // CRITICAL: terminal must show content after close/reopen (modal close = disconnect + reconnect)
  it('[CRITICAL] re-attach after disconnect still receives pty data', async () => {
    // First connection — attach and verify data flows
    const client1 = connectClient();
    await new Promise(r => client1.on('connect', r));
    client1.emit('terminal:attach', 'test-session');
    await wait(100);
    const cb1 = mockOnDataCallbacks[mockOnDataCallbacks.length - 1];
    const data1Promise = new Promise(r => client1.on('terminal:data:test-session', r));
    cb1('first session data');
    const d1 = await data1Promise;
    assert.equal(d1, 'first session data');
    // Simulate modal close — client disconnects
    client1.disconnect();
    await wait(150);

    // Second connection — simulate modal reopen
    const client2 = connectClient();
    await new Promise(r => client2.on('connect', r));
    const data2Promise = new Promise(r => client2.on('terminal:data:test-session', r));
    client2.emit('terminal:attach', 'test-session');
    await wait(100);
    // Simulate pty output after re-attach
    const cb2 = mockOnDataCallbacks[mockOnDataCallbacks.length - 1];
    cb2('second session data');
    const d2 = await data2Promise;
    assert.equal(d2, 'second session data', 'must receive data after re-attach');
    client2.disconnect();
  });

  it('[CRITICAL] SIGWINCH toggle fires on attach (cols-1 then cols)', async () => {
    lastResizeCols = null;
    lastResizeRows = null;
    // Reset to known initial size so SIGWINCH expectations are deterministic
    mockPtyProcess.cols = 120;
    mockPtyProcess.rows = 30;
    const resizes = [];
    const origResize = mockPtyProcess.resize.bind(mockPtyProcess);
    mockPtyProcess.resize = (c, r) => { resizes.push({ cols: c, rows: r }); origResize(c, r); };
    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    client.emit('terminal:attach', 'test-session');
    await wait(150); // wait for both resize calls (immediate + 50ms setTimeout)
    mockPtyProcess.resize = origResize;
    // Should have at least 2 resizes: cols-1 then cols (SIGWINCH toggle)
    assert.ok(resizes.length >= 2, `expected >=2 resizes for SIGWINCH toggle, got ${resizes.length}`);
    const first = resizes[0];
    const second = resizes[resizes.length - 1];
    assert.equal(first.cols, 119, 'first resize should be cols-1');
    assert.equal(second.cols, 120, 'second resize should restore original cols');
    client.disconnect();
  });

  // CRITICAL: when attach includes {sessionName, cols, rows}, PTY must be resized to those
  // dimensions BEFORE the SIGWINCH toggle so tmux redraws at the correct size.
  it('[CRITICAL] terminal:attach with {sessionName,cols,rows} resizes PTY before SIGWINCH', async () => {
    // Reset to known initial size
    mockPtyProcess.cols = 120;
    mockPtyProcess.rows = 30;
    const resizes = [];
    const origResize = mockPtyProcess.resize.bind(mockPtyProcess);
    mockPtyProcess.resize = (c, r) => { resizes.push({ cols: c, rows: r }); origResize(c, r); };

    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    // Send attach with explicit client dimensions (110 cols × 23 rows)
    client.emit('terminal:attach', { sessionName: 'test-session', cols: 110, rows: 23 });
    await wait(150);
    mockPtyProcess.resize = origResize;

    // First resize must be to client dimensions (110×23), not cols-1
    assert.ok(resizes.length >= 3, `expected >=3 resizes, got ${resizes.length}: ${JSON.stringify(resizes)}`);
    assert.equal(resizes[0].cols, 110, 'first resize must set PTY to client cols (110)');
    assert.equal(resizes[0].rows, 23, 'first resize must set PTY to client rows (23)');
    // Then SIGWINCH toggle: cols-1 then cols (now 110)
    assert.equal(resizes[1].cols, 109, 'SIGWINCH: second resize must be cols-1 (109)');
    assert.equal(resizes[2].cols, 110, 'SIGWINCH: third resize must restore cols (110)');
    client.disconnect();
  });

  // CRITICAL: screen content must be replayed on attach (page refresh scenario)
  it('[CRITICAL] screen content replayed on attach (page refresh / modal reopen)', async () => {
    const SCREEN = '\x1b[32mClaude Code v2.1.50\x1b[0m\r\n> hello\r\nHey! How can I help?\r\n';
    mockPtyManager.screenContent.set('test-session', SCREEN);

    const client = connectClient();
    await new Promise(r => client.on('connect', r));

    // Collect all terminal:data events received on attach
    const received = [];
    client.on('terminal:data:test-session', (d) => received.push(d));
    client.emit('terminal:attach', 'test-session');
    await wait(150);

    mockPtyManager.screenContent.delete('test-session');
    client.disconnect();

    assert.ok(
      received.some(d => d.includes('Claude Code')),
      `screen content must be sent on attach — got: ${JSON.stringify(received)}`
    );
  });

  it('terminal:attach supports replayBuffer=false to skip history replay', async () => {
    const SCREEN = 'history line 1\r\nhistory line 2\r\n';
    mockPtyManager.screenContent.set('test-session', SCREEN);

    const client = connectClient();
    await new Promise(r => client.on('connect', r));

    const received = [];
    client.on('terminal:data:test-session', (d) => received.push(d));
    client.emit('terminal:attach', { sessionName: 'test-session', replayBuffer: false });
    await wait(150);

    mockPtyManager.screenContent.delete('test-session');
    client.disconnect();

    assert.equal(received.some(d => d.includes('history line 1')), false, `should not replay history: ${JSON.stringify(received)}`);
  });

  it('terminal:attach supports forceRedraw=false to skip SIGWINCH toggle', async () => {
    // Reset to known initial size
    mockPtyProcess.cols = 120;
    mockPtyProcess.rows = 30;
    const resizes = [];
    const origResize = mockPtyProcess.resize.bind(mockPtyProcess);
    mockPtyProcess.resize = (c, r) => { resizes.push({ cols: c, rows: r }); origResize(c, r); };

    const client = connectClient();
    await new Promise(r => client.on('connect', r));
    client.emit('terminal:attach', { sessionName: 'test-session', forceRedraw: false });
    await wait(150);
    mockPtyProcess.resize = origResize;
    client.disconnect();

    assert.equal(resizes.length, 0, `expected no resize when forceRedraw=false, got ${JSON.stringify(resizes)}`);
  });
});
