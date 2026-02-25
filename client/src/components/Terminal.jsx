import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

function safeFit(fitAddon) {
  try { fitAddon.fit(); } catch {}
}

export function Terminal({ socket, sessionName }) {
  const containerRef = useRef(null);
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  const resizeTimerRef = useRef(null);

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

    // Set up listeners BEFORE attaching so we don't miss initial data
    const onTerminalData = (data) => term.write(data);
    const onTerminalError = (msg) => term.writeln(`\r\n[terminal error] ${msg}`);
    socket.on(`terminal:data:${sessionName}`, onTerminalData);
    socket.on('terminal:error', onTerminalError);

    // Fit to container first so we send correct dimensions with attach.
    safeFit(fitAddon);
    socket.emit('terminal:attach', { sessionName, cols: term.cols, rows: term.rows });
    scheduleSyncSize(true);

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

    const observer = new ResizeObserver(() => {
      safeFit(fitAddon);
      scheduleSyncSize();
    });
    observer.observe(container);

    return () => {
      clearTimeout(initTimer);
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      inputDisposable.dispose();
      term.dispose();
      observer.disconnect();
      socket.off(`terminal:data:${sessionName}`, onTerminalData);
      socket.off('terminal:error', onTerminalError);
      container.removeEventListener('mousedown', focusHandler);
    };
  }, [socket, sessionName]);

  return <div ref={containerRef} className="w-full h-full terminal-host" style={{ overflow: 'hidden' }} />;
}
