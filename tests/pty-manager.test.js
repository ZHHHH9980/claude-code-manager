/**
 * Smoke tests for pty-manager — the core of task terminal sessions.
 * Uses node:test + node:assert (zero dependencies).
 *
 * These tests mock node-pty to verify logic without starting real shells.
 * Run: node --test tests/pty-manager.test.js
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let ptyManager;
let spawned;

function loadFreshPtyManager() {
  const modPath = require.resolve('../server/pty-manager');
  delete require.cache[modPath];

  const ptyModPath = require.resolve('node-pty');
  spawned = [];
  require.cache[ptyModPath] = {
    id: ptyModPath,
    filename: ptyModPath,
    loaded: true,
    exports: {
      spawn: mock.fn((cmd, args, opts) => {
        let onExitCb = null;
        let onDataCb = null;
        const proc = {
          pid: spawned.length + 1000,
          cols: 120,
          rows: 30,
          killed: false,
          onData: mock.fn((cb) => {
            onDataCb = cb;
            return { dispose: mock.fn(() => { onDataCb = null; }) };
          }),
          onExit: mock.fn((cb) => {
            onExitCb = cb;
            return { dispose: mock.fn(() => { onExitCb = null; }) };
          }),
          write: mock.fn(),
          resize: mock.fn(function resize(c, r) { this.cols = c; this.rows = r; }),
          kill: mock.fn(function kill() {
            this.killed = true;
            if (onExitCb) onExitCb({ exitCode: 0, signal: 15 });
          }),
          _emitData(data) {
            if (onDataCb) onDataCb(data);
          },
          _emitExit(evt = { exitCode: 0, signal: 0 }) {
            if (onExitCb) onExitCb(evt);
          },
        };
        spawned.push({ cmd, args, opts, proc });
        return proc;
      }),
    },
  };
  ptyManager = require('../server/pty-manager');
}

describe('pty-manager', () => {
  beforeEach(() => loadFreshPtyManager());

  afterEach(() => {
    ptyManager.sessions.clear();
  });

  it('sessionExists returns false when session is missing', () => {
    assert.equal(ptyManager.sessionExists('nonexistent'), false);
  });

  it('ensureSession creates a new session and returns entry with ptyProcess', () => {
    const entry = ptyManager.ensureSession('test-sess', '/tmp');
    assert.ok(entry, 'should return an entry');
    assert.ok(entry.ptyProcess, 'entry should have ptyProcess');
    assert.ok(entry.clients instanceof Set, 'entry should have clients Set');
    assert.ok(ptyManager.sessions.has('test-sess'), 'session should be in sessions map');
    assert.equal(spawned.length, 1, 'should spawn one PTY');
  });

  it('ensureSession returns existing entry on second call', () => {
    const entry1 = ptyManager.ensureSession('test-sess', '/tmp');
    const entry2 = ptyManager.ensureSession('test-sess', '/tmp');
    assert.strictEqual(entry1, entry2, 'should return same entry');
    assert.equal(spawned.length, 1, 'should not spawn another PTY');
  });

  it('resizeSession calls ptyProcess.resize with correct dimensions', () => {
    const entry = ptyManager.ensureSession('resize-test', '/tmp');
    ptyManager.resizeSession('resize-test', 200, 50);
    assert.equal(entry.ptyProcess.resize.mock.calls.length, 1);
    assert.deepEqual(entry.ptyProcess.resize.mock.calls[0].arguments, [200, 50]);
  });

  it('resizeSession is a no-op for unknown session', () => {
    // Should not throw
    ptyManager.resizeSession('unknown-session', 100, 40);
  });

  it('sendInput writes data to ptyProcess', () => {
    const entry = ptyManager.ensureSession('input-test', '/tmp');
    ptyManager.sendInput('input-test', 'hello\n');
    assert.equal(entry.ptyProcess.write.mock.calls.length, 1);
    assert.deepEqual(entry.ptyProcess.write.mock.calls[0].arguments, ['hello\n']);
  });

  it('killSession removes session from map and kills pty', () => {
    const entry = ptyManager.ensureSession('kill-test', '/tmp');
    ptyManager.killSession('kill-test');
    assert.equal(ptyManager.sessions.has('kill-test'), false);
    assert.equal(entry.ptyProcess.kill.mock.calls.length, 1);
  });

  it('getTmuxAttachCmd returns correct command', () => {
    const cmd = ptyManager.getTmuxAttachCmd('my-session');
    assert.equal(cmd, 'direct-pty:my-session');
  });

  it('listAliveSessions returns only active in-memory sessions', () => {
    ptyManager.ensureSession('a', '/tmp');
    ptyManager.ensureSession('b', '/tmp');
    ptyManager.killSession('b');
    const sessions = ptyManager.listAliveSessions();
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.includes('a'));
    assert.ok(!sessions.includes('b'));
  });

  it('createSession starts UTF-8 login shell as TASK_USER in requested cwd', () => {
    ptyManager.ensureSession('env-test', '/tmp');
    const spawnCall = spawned[0];
    assert.ok(spawnCall, 'pty.spawn should have been called');
    assert.equal(spawnCall.cmd, 'su', 'must spawn su to run as non-root user');
    assert.equal(spawnCall.args[0], '-');
    assert.ok(spawnCall.args[3].includes('cd "/tmp"'), 'bootstrap command should cd into task cwd');
    const opts = spawnCall.opts;
    assert.ok(opts.env, 'spawn options must include env');
    assert.equal(opts.env.LANG, 'en_US.UTF-8', 'LANG must be en_US.UTF-8');
    assert.equal(opts.env.LC_ALL, 'en_US.UTF-8', 'LC_ALL must be en_US.UTF-8');
  });

  it('attachSession throws when session does not exist', () => {
    assert.throws(() => ptyManager.attachSession('missing'), /not found/);
  });

  it('session auto-removes when pty exits', () => {
    ptyManager.ensureSession('auto-exit', '/tmp');
    assert.equal(ptyManager.sessionExists('auto-exit'), true);
    spawned[0].proc._emitExit({ exitCode: 0, signal: 0 });
    assert.equal(ptyManager.sessionExists('auto-exit'), false);
  });

  it('buffers output and replays it to newly attached client', () => {
    ptyManager.ensureSession('replay', '/tmp');
    spawned[0].proc._emitData('hello\r\n');
    spawned[0].proc._emitData('world\r\n');
    assert.equal(ptyManager.getBufferedOutput('replay').includes('hello'), true);
    assert.equal(ptyManager.getBufferedOutput('replay').includes('world'), true);
  });

  it('broadcasts live output to attached clients', () => {
    const entry = ptyManager.ensureSession('live', '/tmp');
    const payloads = [];
    entry.clients.add({ emit: (evt, text) => payloads.push({ evt, text }) });
    spawned[0].proc._emitData('line-1');
    assert.deepEqual(payloads, [{ evt: 'terminal:data', text: 'line-1' }]);
  });
});

// --- Font / rendering guards (static analysis of Terminal.jsx) ---
const fs = require('node:fs');

describe('Terminal.jsx font guards', () => {
  const terminalSrc = fs.readFileSync(
    path.join(__dirname, '../client/src/components/Terminal.jsx'), 'utf8'
  );

  // Fonts known to lack CJK glyphs — must never appear in fontFamily
  const CJK_BROKEN_FONTS = [
    'Hack Nerd Font',
    'IBM Plex Mono',
    'SFMono-Regular',
    'Fira Code',
    'JetBrains Mono',
  ];

  // Extract the full fontFamily value (handles nested quotes like "Courier New")
  function getFontFamily() {
    const match = terminalSrc.match(/fontFamily:\s*'([^']+)'/);
    assert.ok(match, 'Terminal.jsx must define fontFamily');
    return match[1];
  }

  it('fontFamily must not contain fonts without CJK support', () => {
    const fontFamily = getFontFamily();
    for (const bad of CJK_BROKEN_FONTS) {
      assert.ok(
        !fontFamily.includes(bad),
        `fontFamily must not contain "${bad}" (no CJK glyphs) — found: "${fontFamily}"`
      );
    }
  });

  // xterm.js canvas renderer does NOT do font fallback — CJK fonts must be explicitly listed
  it('fontFamily must include at least one explicit CJK font', () => {
    const fontFamily = getFontFamily();
    const CJK_FONTS = ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'WenQuanYi', 'Noto Sans CJK', 'Source Han'];
    const hasCJK = CJK_FONTS.some(f => fontFamily.includes(f));
    assert.ok(
      hasCJK,
      `fontFamily must include an explicit CJK font (e.g. "PingFang SC") — xterm.js canvas renderer does not fall back automatically. Found: "${fontFamily}"`
    );
  });

  it('fontFamily must end with generic monospace fallback', () => {
    const fontFamily = getFontFamily();
    assert.ok(
      fontFamily.trim().endsWith('monospace'),
      `fontFamily must end with "monospace" for CJK fallback — found: "${fontFamily}"`
    );
  });

  it('Unicode11Addon must be loaded for CJK double-width support', () => {
    assert.ok(
      terminalSrc.includes('Unicode11Addon'),
      'Terminal.jsx must load Unicode11Addon for CJK double-width characters'
    );
    assert.ok(
      terminalSrc.includes("activeVersion = '11'"),
      'Terminal.jsx must set unicode.activeVersion to 11'
    );
  });
});
