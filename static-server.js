const express = require('express');
const path = require('path');

const app = express();

// Serve static files from client/dist
app.use(express.static(path.join(__dirname, 'client/dist')));

// SPA fallback - serve index.html for all routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

const PORT = process.env.STATIC_PORT || 8080;
app.listen(PORT, () => {
  console.log(`Static server running on http://localhost:${PORT}`);
});
