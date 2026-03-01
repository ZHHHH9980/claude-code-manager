import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export function useSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // In production, connect to API server on port 3000
    // In development, vite proxy handles this
    const socketUrl = import.meta.env.DEV ? undefined : `${window.location.protocol}//${window.location.hostname}:3000`;
    socketRef.current = io(socketUrl);
    socketRef.current.on('connect', () => setConnected(true));
    socketRef.current.on('disconnect', () => setConnected(false));
    return () => socketRef.current.disconnect();
  }, []);

  return { socket: socketRef.current, connected };
}
