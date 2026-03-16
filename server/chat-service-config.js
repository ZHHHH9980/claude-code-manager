const { normalizeBaseUrl } = require('./session-service-config');

function stripPort(host) {
  const value = String(host || '').trim();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end >= 0 ? value.slice(0, end + 1) : value;
  }
  return value.replace(/:\d+$/, '');
}

function createChatServiceConfig({
  internalUrl = process.env.CHAT_MANAGER_URL,
  publicUrl = process.env.PUBLIC_CHAT_MANAGER_URL,
  publicPort = process.env.CHAT_MANAGER_PUBLIC_PORT || process.env.CHAT_MANAGER_PORT || 3002,
} = {}) {
  const normalizedInternalUrl = normalizeBaseUrl(internalUrl);
  const normalizedPublicUrl = normalizeBaseUrl(publicUrl);
  const safePublicPort = Number(publicPort) || 3002;

  function getBrowserUrl(req) {
    if (!normalizedInternalUrl && !normalizedPublicUrl) return '';
    if (normalizedPublicUrl) return normalizedPublicUrl;
    const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').trim() || 'http';
    const hostHeader = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').trim();
    const hostname = stripPort(hostHeader);
    if (!hostname) return '';
    return `${proto}://${hostname}:${safePublicPort}`;
  }

  return {
    enabled: Boolean(normalizedInternalUrl),
    internalUrl: normalizedInternalUrl,
    publicUrl: normalizedPublicUrl,
    publicPort: safePublicPort,
    getBrowserUrl,
  };
}

module.exports = {
  createChatServiceConfig,
};
