const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');

const app = express();
const server = http.createServer(app);
const sessionProxy = httpProxy.createProxyServer({
  target: process.env.SESSION_MANAGER_URL || 'http://127.0.0.1:3001',
  ws: true,
  xfwd: true,
});
const chatProxy = httpProxy.createProxyServer({
  target: process.env.CHAT_MANAGER_URL || 'http://127.0.0.1:3002',
  ws: false,
  xfwd: true,
});

function writeProxyError(res, err) {
  if (res.headersSent) return;
  res.statusCode = 502;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: err?.message || 'proxy unavailable' }));
}

sessionProxy.on('error', (err, req, res) => writeProxyError(res, err));
chatProxy.on('error', (err, req, res) => writeProxyError(res, err));

function proxyTo(proxy) {
  return (req, res) => proxy.web(req, res);
}

app.use('/socket.io', proxyTo(sessionProxy));
app.use('/api/terminal', proxyTo(sessionProxy));
app.get('/healthz/session', (req, res) => {
  req.url = '/healthz';
  sessionProxy.web(req, res);
});
app.get('/healthz/chat', (req, res) => {
  req.url = '/healthz';
  chatProxy.web(req, res);
});
app.use(/^\/api\/tasks\/[^/]+\/chat(?:\/history)?$/, proxyTo(chatProxy));
app.use('/api/agent', proxyTo(chatProxy));

// Serve static files from client/dist
app.use(express.static(path.join(__dirname, 'client/dist')));

// SPA fallback - serve index.html for all routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

const PORT = process.env.STATIC_PORT || 8080;
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/socket.io/')) {
    sessionProxy.ws(req, socket, head);
    return;
  }
  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Static server running on http://localhost:${PORT}`);
});
