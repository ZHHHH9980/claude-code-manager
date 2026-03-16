const { Readable } = require('stream');

async function proxySessionManagerRequest({
  req,
  res,
  sessionManagerUrl,
  targetPath,
  accessToken = process.env.SESSION_MANAGER_ACCESS_TOKEN || process.env.ACCESS_TOKEN,
  fetchImpl = globalThis.fetch,
}) {
  if (!sessionManagerUrl) {
    res.status(500).json({ error: 'session manager url not configured' });
    return;
  }

  const url = new URL(`${sessionManagerUrl}${targetPath}`);
  for (const [key, value] of Object.entries(req.query || {})) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
      continue;
    }
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const headers = {};
  if (req.headers.accept) headers.accept = req.headers.accept;
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
    });
  } catch (err) {
    if (!res.writableEnded) {
      res.status(502).json({ error: err?.message || 'session manager unavailable' });
    }
    return;
  }

  res.status(response.status);
  const forwardHeaders = ['content-type', 'cache-control'];
  for (const headerName of forwardHeaders) {
    const value = response.headers.get(headerName);
    if (value) res.setHeader(headerName, value);
  }

  if (!response.body) {
    res.end();
    return;
  }

  Readable.fromWeb(response.body).pipe(res);
}

module.exports = {
  proxySessionManagerRequest,
};
