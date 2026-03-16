import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export function useSocket(socketUrl) {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!socketUrl) return undefined;
    socketRef.current = io(socketUrl);
    socketRef.current.on('connect', () => setConnected(true));
    socketRef.current.on('disconnect', () => setConnected(false));
    return () => {
      setConnected(false);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [socketUrl]);

  return { socket: socketRef.current, connected };
}
