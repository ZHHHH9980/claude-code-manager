import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function Terminal({ socket, sessionName }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!socket || !sessionName || !containerRef.current) return;

    const term = new XTerm({ theme: { background: '#1a1a1a' }, fontSize: 14 });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    socket.emit('terminal:attach', sessionName);
    socket.on('terminal:data', (data) => term.write(data));
    term.onData((data) => socket.emit('terminal:input', data));

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(containerRef.current);

    return () => {
      term.dispose();
      observer.disconnect();
      socket.off('terminal:data');
    };
  }, [socket, sessionName]);

  return <div ref={containerRef} className="w-full h-full" />;
}
