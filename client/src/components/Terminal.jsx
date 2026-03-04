import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { TerminalKeyboard } from './TerminalKeyboard';

function safeFit(fitAddon) {
  try { fitAddon.fit(); } catch {}
}

function normalizeTerminalError(raw) {
  if (raw && typeof raw === 'object') {
    return {
      sessionName: typeof raw.sessionName === 'string' ? raw.sessionName : null,
      code: typeof raw.code === 'string' ? raw.code : '',
      message: typeof raw.message === 'string' ? raw.message : 'terminal error',
      recoverable: Boolean(raw.recoverable),
    };
  }
  return {
    sessionName: null,
    code: '',
    message: typeof raw === 'string' && raw.trim() ? raw : 'terminal error',
    recoverable: false,
  };
}

export function Terminal({
  socket,
  sessionName,
  replayOnAttach = true,
  forceRedrawOnAttach = true,
  onStatusChange,
  onFatalError,
  isMobile = false,
}) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  const resizeTimerRef = useRef(null);
  const lastAttachAtRef = useRef(0);
  const lastStructuredErrorAtRef = useRef(0);
  const statusCbRef = useRef(onStatusChange);
  const fatalCbRef = useRef(onFatalError);

  useEffect(() => {
    statusCbRef.current = onStatusChange;
    fatalCbRef.current = onFatalError;
  }, [onStatusChange, onFatalError]);

  useEffect(() => {
    if (!socket || !sessionName || !containerRef.current) return;

    const container = containerRef.current;
    const rootStyle = getComputedStyle(document.documentElement);
    const termBg = rootStyle.getPropertyValue('--terminal-bg')?.trim() || '#12110f';
    const isMobile = window.matchMedia?.('(max-width: 767px)').matches ?? false;
    const term = new XTerm({
      theme: { background: termBg, foreground: '#f0e6d7', cursor: '#f0e6d7' },
      fontSize: isMobile ? 13 : 15,
      fontFamily: 'Menlo, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "WenQuanYi Micro Hei", Consolas, "Courier New", monospace',
      lineHeight: isMobile ? 1.25 : 1.2,
      scrollback: 5000,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch {}
    term.open(container);
    termRef.current = term;
    statusCbRef.current?.('initializing terminal...');

    const syncSize = (force = false) => {
      const cols = term.cols;
      const rows = term.rows;
      const last = lastSizeRef.current;
      if (!force && last.cols === cols && last.rows === rows) return;
      lastSizeRef.current = { cols, rows };
      socket.emit('terminal:resize', { sessionName, cols, rows });
    };

    const scheduleSyncSize = (force = false) => {
      if (force) {
        if (resizeTimerRef.current) {
          clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = null;
        }
        syncSize(true);
        return;
      }
      if (resizeTimerRef.current) return;
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        syncSize();
      }, 90);
    };

    const attachSession = (reason = 'attach') => {
      const now = Date.now();
      if (now - lastAttachAtRef.current < 250) return;
      lastAttachAtRef.current = now;
      safeFit(fitAddon);
      socket.emit('terminal:attach', {
        sessionName,
        cols: term.cols,
        rows: term.rows,
        replayBuffer: Boolean(replayOnAttach),
        forceRedraw: Boolean(forceRedrawOnAttach),
      });
      scheduleSyncSize(true);
      if (reason === 'reconnect') statusCbRef.current?.('reconnecting terminal...');
      else statusCbRef.current?.('connecting terminal...');
    };

    // Set up listeners BEFORE attaching so we don't miss initial data.
    const onTerminalData = (data) => term.write(data);
    const handleTerminalError = (rawError, source = 'legacy') => {
      if (source === 'legacy' && Date.now() - lastStructuredErrorAtRef.current < 300) return;
      const err = normalizeTerminalError(rawError);
      if (err.sessionName && err.sessionName !== sessionName) return;
      term.writeln(`\r\n[terminal error] ${err.message}`);
      const statusText = err.code ? `terminal ${err.code}` : `terminal error: ${err.message}`;
      statusCbRef.current?.(statusText);
      if (!err.recoverable || err.code === 'session_not_found' || err.code === 'invalid_session_name') {
        fatalCbRef.current?.(err);
      }
    };
    const onTerminalError = (msg) => handleTerminalError(msg, 'legacy');
    const onTerminalErrorV2 = (payload) => {
      lastStructuredErrorAtRef.current = Date.now();
      handleTerminalError(payload, 'v2');
    };
    const onTerminalReady = (payload) => {
      if (!payload || payload.sessionName !== sessionName) return;
      statusCbRef.current?.('terminal connected');
    };
    const onSocketConnect = () => attachSession('reconnect');
    const onSocketDisconnect = () => statusCbRef.current?.('socket disconnected, waiting reconnect...');

    socket.on(`terminal:data:${sessionName}`, onTerminalData);
    socket.on('terminal:error', onTerminalError);
    socket.on('terminal:error:v2', onTerminalErrorV2);
    socket.on('terminal:ready', onTerminalReady);
    socket.on('connect', onSocketConnect);
    socket.on('disconnect', onSocketDisconnect);

    // Initial attach
    attachSession('attach');

    // Focus after a short delay (container may not be fully visible yet)
    const initTimer = setTimeout(() => {
      safeFit(fitAddon);
      scheduleSyncSize();
      term.scrollToBottom();
      term.focus();
    }, 200);

    const inputDisposable = term.onData((data) => socket.emit('terminal:input', { sessionName, data }));
    const focusHandler = () => term.focus();
    container.addEventListener('mousedown', focusHandler);

    let resizeDebounce = null;
    const observer = new ResizeObserver(() => {
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        safeFit(fitAddon);
        scheduleSyncSize();
      }, 100);
    });
    observer.observe(container);

    return () => {
      clearTimeout(initTimer);
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (resizeDebounce) clearTimeout(resizeDebounce);
      inputDisposable.dispose();
      term.dispose();
      observer.disconnect();
      socket.off(`terminal:data:${sessionName}`, onTerminalData);
      socket.off('terminal:error', onTerminalError);
      socket.off('terminal:error:v2', onTerminalErrorV2);
      socket.off('terminal:ready', onTerminalReady);
      socket.off('connect', onSocketConnect);
      socket.off('disconnect', onSocketDisconnect);
      container.removeEventListener('mousedown', focusHandler);
      termRef.current = null;
    };
  }, [socket, sessionName, replayOnAttach, forceRedrawOnAttach]);

  const handleKeyboardInput = (data) => {
    if (socket && sessionName) {
      socket.emit('terminal:input', { sessionName, data });
      termRef.current?.focus();
    }
  };

  return (
    <div className="w-full h-full" style={{ overflow: 'hidden' }}>
      <div
        ref={containerRef}
        className="terminal-host w-full h-full"
        style={{ overflow: 'hidden' }}
      />
      {isMobile && <TerminalKeyboard visible onKeyPress={handleKeyboardInput} />}
    </div>
  );
}
