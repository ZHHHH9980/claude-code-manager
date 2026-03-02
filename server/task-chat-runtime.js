const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { buildClaudeEnv } = require('./claude-env');

function extractAssistantText(payload) {
  const content = payload?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

class TaskChatRuntime {
  constructor({ taskId, cwd, sessionId, resumeSession, logMetric }) {
    this.taskId = taskId;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.resumeSession = Boolean(resumeSession);
    this.logMetric = typeof logMetric === 'function' ? logMetric : () => {};
    this.child = null;
    this.stdoutBuf = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
    this.closed = false;
    this.queue = Promise.resolve();
    this.pending = null;
    this.startedAt = null;
    this.spawn();
  }

  spawn() {
    const env = buildClaudeEnv();

    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    ];
    if (this.sessionId) {
      if (this.resumeSession) args.push('--resume', this.sessionId);
      else args.push('--session-id', this.sessionId);
    }

    this.child = spawn('claude', args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.startedAt = Date.now();
    this.logMetric('runtime_spawned', {
      task_id: this.taskId,
      session_id: this.sessionId,
      resume: this.resumeSession,
      cwd: this.cwd,
      pid: this.child.pid,
    });

    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => this.onStderr(chunk));
    this.child.on('error', (err) => this.handleRuntimeError(err));
    this.child.on('close', (code, signal) => this.handleRuntimeClose(code, signal));
  }

  isAlive() {
    return !this.closed && this.child && !this.child.killed;
  }

  destroy(reason = 'destroy') {
    this.closed = true;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timeout);
      pending.reject(new Error(`task chat runtime destroyed: ${reason}`));
    }
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch {}
    }
    this.logMetric('runtime_destroyed', {
      task_id: this.taskId,
      session_id: this.sessionId,
      reason,
      uptime_ms: this.startedAt ? Date.now() - this.startedAt : null,
    });
  }

  sendTurn({ prompt, timeoutMs = 300000, onAssistantText }) {
    this.queue = this.queue
      .catch(() => {})
      .then(() => this.runTurn({ prompt, timeoutMs, onAssistantText }));
    return this.queue;
  }

  runTurn({ prompt, timeoutMs, onAssistantText }) {
    if (!this.isAlive()) {
      return Promise.reject(new Error('task chat runtime is not alive'));
    }
    if (this.pending) {
      return Promise.reject(new Error('task chat runtime pending turn exists'));
    }

    return new Promise((resolve, reject) => {
      const started = Date.now();
      this.pending = {
        started,
        promptLen: String(prompt || '').length,
        text: '',
        onAssistantText,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const pending = this.pending;
          if (!pending) return;
          this.pending = null;
          this.logMetric('turn_timeout', {
            task_id: this.taskId,
            session_id: this.sessionId,
            ms: Date.now() - pending.started,
          });
          reject(new Error(`task chat turn timeout after ${timeoutMs}ms`));
          this.destroy('turn_timeout');
        }, timeoutMs),
      };

      const payload = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: String(prompt || '') }],
        },
      };

      this.logMetric('turn_sent', {
        task_id: this.taskId,
        session_id: this.sessionId,
        prompt_len: this.pending.promptLen,
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  onStdout(chunk) {
    this.consumeStdout(this.stdoutDecoder.write(chunk));
  }

  consumeStdout(text, { flush = false } = {}) {
    if (text) this.stdoutBuf += text;
    while (true) {
      const idx = this.stdoutBuf.indexOf('\n');
      if (idx < 0) break;
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleOutput(payload);
    }

    if (!flush) return;
    const tail = this.stdoutBuf.trim();
    this.stdoutBuf = '';
    if (!tail) return;
    try {
      const payload = JSON.parse(tail);
      this.handleOutput(payload);
    } catch {}
  }

  onStderr(chunk) {
    const text = this.stderrDecoder.write(chunk).trim();
    if (!text) return;
    this.logMetric('runtime_stderr', {
      task_id: this.taskId,
      session_id: this.sessionId,
      text: text.slice(0, 400),
    });
  }

  handleOutput(payload) {
    const pending = this.pending;
    if (!pending) return;

    if (payload?.type === 'assistant') {
      const assistantText = extractAssistantText(payload);
      if (assistantText) {
        pending.text += assistantText;
        if (typeof pending.onAssistantText === 'function') {
          try { pending.onAssistantText(assistantText); } catch {}
        }
      }
      return;
    }

    if (payload?.type !== 'result') return;

    clearTimeout(pending.timeout);
    this.pending = null;

    if (payload.is_error || payload.subtype === 'error') {
      const msg = String(payload.result || payload.error || 'unknown task chat runtime error');
      this.logMetric('turn_error', {
        task_id: this.taskId,
        session_id: this.sessionId,
        ms: Date.now() - pending.started,
        text: msg.slice(0, 400),
      });
      pending.reject(new Error(msg));
      return;
    }

    const finalText = pending.text.trim() || String(payload.result || '').trim();
    this.logMetric('turn_done', {
      task_id: this.taskId,
      session_id: this.sessionId,
      ms: Date.now() - pending.started,
      text_len: finalText.length,
      duration_ms: payload.duration_ms ?? null,
      duration_api_ms: payload.duration_api_ms ?? null,
    });
    pending.resolve(finalText);
  }

  handleRuntimeError(err) {
    const pending = this.pending;
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending = null;
      pending.reject(err);
    }
    this.closed = true;
    this.logMetric('runtime_error', {
      task_id: this.taskId,
      session_id: this.sessionId,
      error: err?.message || 'unknown',
    });
  }

  handleRuntimeClose(code, signal) {
    this.consumeStdout(this.stdoutDecoder.end(), { flush: true });
    const stderrTail = this.stderrDecoder.end().trim();
    if (stderrTail) {
      this.logMetric('runtime_stderr', {
        task_id: this.taskId,
        session_id: this.sessionId,
        text: stderrTail.slice(0, 400),
      });
    }

    const pending = this.pending;
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending = null;
      pending.reject(new Error(`task chat runtime closed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    }
    this.closed = true;
    this.logMetric('runtime_closed', {
      task_id: this.taskId,
      session_id: this.sessionId,
      code: code ?? null,
      signal: signal ?? null,
      uptime_ms: this.startedAt ? Date.now() - this.startedAt : null,
    });
  }
}

class TaskChatRuntimeManager {
  constructor({ logMetric }) {
    this.logMetric = typeof logMetric === 'function' ? logMetric : () => {};
    this.runtimes = new Map();
  }

  getOrCreate({ taskId, cwd, sessionId, resumeSession }) {
    const existing = this.runtimes.get(taskId);
    if (existing && existing.isAlive()) return existing;
    if (existing) this.runtimes.delete(taskId);

    const runtime = new TaskChatRuntime({
      taskId,
      cwd,
      sessionId,
      resumeSession,
      logMetric: this.logMetric,
    });
    this.runtimes.set(taskId, runtime);
    return runtime;
  }

  async send({ taskId, cwd, sessionId, resumeSession, prompt, timeoutMs, onAssistantText }) {
    const runtime = this.getOrCreate({ taskId, cwd, sessionId, resumeSession });
    return runtime.sendTurn({ prompt, timeoutMs, onAssistantText });
  }

  stopTask(taskId, reason = 'stop_task') {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return;
    runtime.destroy(reason);
    this.runtimes.delete(taskId);
  }

  stopAll(reason = 'stop_all') {
    for (const [taskId, runtime] of this.runtimes.entries()) {
      runtime.destroy(reason);
      this.runtimes.delete(taskId);
    }
  }
}

module.exports = { TaskChatRuntimeManager };
