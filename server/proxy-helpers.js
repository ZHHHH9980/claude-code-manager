function writeProxyError(res, err) {
  if (res.headersSent) return;
  res.statusCode = 502;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: err?.message || 'proxy unavailable' }));
}

function proxyTo(proxy) {
  return (req, res) => {
    if (req.originalUrl) req.url = req.originalUrl;
    proxy.web(req, res);
  };
}

module.exports = {
  proxyTo,
  writeProxyError,
};
