const DEFAULT_FRONTEND_ORIGINS = new Set(['http://localhost:8080', 'http://127.0.0.1:8080']);

function parseFrontendOrigins(input) {
  return String(input || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function createOriginPolicy({
  frontendUrl = process.env.FRONTEND_URL,
  defaultOrigins = DEFAULT_FRONTEND_ORIGINS,
  logger = console,
}) {
  const configuredFrontendOrigins = parseFrontendOrigins(frontendUrl);
  const allowAnyOrigin = configuredFrontendOrigins.length === 0
    || (configuredFrontendOrigins.length === 1 && defaultOrigins.has(configuredFrontendOrigins[0]));
  const allowedOriginSet = new Set(configuredFrontendOrigins);

  function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (allowAnyOrigin) return true;
    return allowedOriginSet.has(origin);
  }

  return {
    isAllowedOrigin,
    corsOptions: {
      origin(origin, callback) {
        if (isAllowedOrigin(origin)) return callback(null, true);
        logger.warn(`[cors] blocked origin: ${origin}`);
        return callback(null, false);
      },
      credentials: true,
    },
    socketCorsOptions: {
      origin(origin, callback) {
        return callback(null, isAllowedOrigin(origin));
      },
      credentials: true,
    },
  };
}

function isValidAccessToken(req, expectedToken) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ') && auth.slice(7).trim() === expectedToken) {
    return true;
  }
  const queryToken = typeof req.query?.access_token === 'string' ? req.query.access_token.trim() : '';
  return queryToken.length > 0 && queryToken === expectedToken;
}

function createAccessTokenMiddleware({
  accessToken = process.env.ACCESS_TOKEN,
  isExemptPath = (req) => req.path === '/api/webhook/github',
}) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (isExemptPath(req)) return next();
    if (!accessToken) return next();
    if (isValidAccessToken(req, accessToken)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };
}

module.exports = {
  DEFAULT_FRONTEND_ORIGINS,
  parseFrontendOrigins,
  createOriginPolicy,
  isValidAccessToken,
  createAccessTokenMiddleware,
};
