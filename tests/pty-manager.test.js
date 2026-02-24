/**
 * Smoke tests for pty-manager — the core of task terminal sessions.
 * Uses node:test + node:assert (zero dependencies).
 *
 * These tests mock node-pty and execSync to verify logic without tmux.
 * Run: node --test tests/pty-manager.test.js
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// --- Mocks ---
const mockPtyProcess = {
  cols: 120, rows: 30,
  onData: mock.fn(),
  write: mock.fn(),
  resize: mock.fn(),
  kill: mock.fn(),
};

// We need to intercept require('node-pty') and require('child_process')
// Use a fresh pty-manager for each test by clearing the module cache.

let ptyManager;
let execSyncCalls;

function loadFreshPtyManager() {
  // Clear cached module
  const modPath = require.resolve('../server/pty-manager');
  delete require.cache[modPath];

  // Mock node-pty
  const ptyModPath = require.resolve('node-pty');
  require.cache[ptyModPath] = {
    id: ptyModPath,
    filename: ptyModPath,
    loaded: true,
    exports: {
      spawn: mock.fn(() => ({ ...mockPtyProcess, onData: mock.fn(), write: mock.fn(), resize: mock.fn(), kill: mock.fn() })),
    },
  };

  // Mock child_process.execSync
  execSyncCalls = [];
  const cpModPath = require.resolve('child_process');
  const realCP = require('child_process');
  require.cache[cpModPath] = {
    id: cpModPath,
    filename: cpModPath,
    loaded: true,
    exports: {
      ...realCP,
      execSync: mock.fn((cmd) => {
        execSyncCalls.push(cmd);
        // tmux has-session: throw = not exists, return = exists
        if (cmd.includes('has-session')) throw new Error('no session');
        // tmux new-session: succeed
        if (cmd.includes('new-session')) return '';
        // tmux list-sessions
        if (cmd.includes('list-sessions')) return 'test-session\n';
        // tmux kill-session
        if (cmd.includes('kill-session')) return '';
        return '';
      }),
    },
  };

  ptyManager = require('../server/pty-manager');
  return ptyManager;
}

describe('pty-manager', () => {
  beforeEach(() => {
    loadFreshPtyManager();
  });

  afterEach(() => {
    // Clean up sessions map
    ptyManager.sessions.clear();
  });

  it('sessionExists returns false when tmux session does not exist', () => {
    assert.equal(ptyManager.sessionExists('nonexistent'), false);
  });

  it('ensureSession creates a new session and returns entry with ptyProcess', () => {
    const entry = ptyManager.ensureSession('test-sess', '/tmp');
    assert.ok(entry, 'should return an entry');
    assert.ok(entry.ptyProcess, 'entry should have ptyProcess');
    assert.ok(entry.clients instanceof Set, 'entry should have clients Set');
    assert.ok(ptyManager.sessions.has('test-sess'), 'session should be in sessions map');
    // Should have called tmux new-session
    const newSessionCmd = execSyncCalls.find(c => c.includes('new-session'));
    assert.ok(newSessionCmd, 'should call tmux new-session');
    assert.ok(newSessionCmd.includes('test-sess'), 'session name in command');
  });

  it('ensureSession returns existing entry on second call', () => {
    const entry1 = ptyManager.ensureSession('test-sess', '/tmp');
    // Make has-session succeed for second call
    const cpModPath = require.resolve('child_process');
    require.cache[cpModPath].exports.execSync = mock.fn((cmd) => {
      execSyncCalls.push(cmd);
      if (cmd.includes('has-session')) return ''; // exists now
      return '';
    });
    // Re-require to pick up new mock — but sessions map persists
    const entry2 = ptyManager.ensureSession('test-sess', '/tmp');
    assert.strictEqual(entry1, entry2, 'should return same entry');
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
    const killCmd = execSyncCalls.find(c => c.includes('kill-session'));
    assert.ok(killCmd, 'should call tmux kill-session');
  });

  it('getTmuxAttachCmd returns correct command', () => {
    const cmd = ptyManager.getTmuxAttachCmd('my-session');
    assert.ok(cmd.includes('my-session'), 'command must include session name');
    assert.ok(cmd.includes('tmux') && cmd.includes('attach'), 'command must include tmux attach');
  });

  it('listAliveSessions returns parsed session names', () => {
    const sessions = ptyManager.listAliveSessions();
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.includes('test-session'));
  });

  it('createSession sets LANG=en_US.UTF-8 in tmux new-session command', () => {
    ptyManager.ensureSession('utf8-test', '/tmp');
    const newSessionCmd = execSyncCalls.find(c => c.includes('new-session'));
    assert.ok(newSessionCmd, 'should call tmux new-session');
    assert.ok(newSessionCmd.includes('LANG=en_US.UTF-8'), 'tmux new-session must set UTF-8 locale');
  });

  it('attachSession passes UTF-8 locale env to pty.spawn', () => {
    ptyManager.ensureSession('env-test', '/tmp');
    const ptyMod = require('node-pty');
    const spawnCall = ptyMod.spawn.mock.calls[0];
    assert.ok(spawnCall, 'pty.spawn should have been called');
    // Now spawns `su` as the command (not tmux directly)
    assert.equal(spawnCall.arguments[0], 'su', 'must spawn su to run as non-root user');
    const opts = spawnCall.arguments[2];
    assert.ok(opts.env, 'spawn options must include env');
    assert.equal(opts.env.LANG, 'en_US.UTF-8', 'LANG must be en_US.UTF-8');
    assert.equal(opts.env.LC_ALL, 'en_US.UTF-8', 'LC_ALL must be en_US.UTF-8');
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
