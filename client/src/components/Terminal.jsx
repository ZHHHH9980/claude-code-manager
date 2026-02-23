import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function Terminal({ socket, sessionName }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!socket || !sessionName || !containerRef.current) return;

    const container = containerRef.current;
    const rootStyle = getComputedStyle(document.documentElement);
    const termBg = rootStyle.getPropertyValue('--terminal-bg')?.trim() || '#12110f';
    const isMobile = window.matchMedia?.('(max-width: 767px)').matches ?? false;
    const term = new XTerm({
      theme: { background: termBg, foreground: '#f0e6d7', cursor: '#f0e6d7' },
      fontSize: isMobile ? 12 : 13,
      fontFamily: 'IBM Plex Mono, SFMono-Regular, Menlo, monospace',
      lineHeight: isMobile ? 1.25 : 1.2,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    term.focus();

    socket.emit('terminal:attach', sessionName);
    const onTerminalData = (data) => term.write(data);
    const onTerminalError = (msg) => term.writeln(`\r\n[terminal error] ${msg}`);
    socket.on('terminal:data', onTerminalData);
    socket.on('terminal:error', onTerminalError);
    const inputDisposable = term.onData((data) => socket.emit('terminal:input', data));
    const focusHandler = () => term.focus();
    container.addEventListener('mousedown', focusHandler);

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(container);

    return () => {
      inputDisposable.dispose();
      term.dispose();
      observer.disconnect();
      socket.off('terminal:data', onTerminalData);
      socket.off('terminal:error', onTerminalError);
      container.removeEventListener('mousedown', focusHandler);
    };
  }, [socket, sessionName]);

  return <div ref={containerRef} className="w-full h-full terminal-host" />;
}
