// API base URL configuration
// In development: use relative URLs (vite proxy handles it)
// In production: use absolute URL to API server on port 3000
export const API_BASE_URL = import.meta.env.DEV 
  ? '' 
  : `${window.location.protocol}//${window.location.hostname}:3000`;

export const DEFAULT_TERMINAL_SOCKET_URL = import.meta.env.DEV
  ? `${window.location.protocol}//${window.location.hostname}:3000`
  : API_BASE_URL;
