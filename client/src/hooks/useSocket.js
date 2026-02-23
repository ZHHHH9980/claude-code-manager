import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export function useSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    socketRef.current = io();
    socketRef.current.on('connect', () => setConnected(true));
    socketRef.current.on('disconnect', () => setConnected(false));
    return () => socketRef.current.disconnect();
  }, []);

  return { socket: socketRef.current, connected };
}
