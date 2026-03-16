const { normalizeBaseUrl } = require('./session-service-config');

function createChatRuntimeControl({
  taskChatRuntimeManager,
  baseUrl = process.env.CHAT_MANAGER_URL,
  accessToken = process.env.CHAT_MANAGER_ACCESS_TOKEN || process.env.ACCESS_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    return {
      isRemote() {
        return false;
      },
      async stopTask(taskId, reason = 'stop_task') {
        taskChatRuntimeManager.stopTask(taskId, reason);
      },
      getBaseUrl() {
        return '';
      },
    };
  }

  async function post(pathname, body) {
    const response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body || {}),
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const err = new Error(payload?.error || `chat manager request failed (${response.status})`);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  return {
    isRemote() {
      return true;
    },
    async stopTask(taskId, reason = 'stop_task') {
      return post(`/internal/chat/tasks/${encodeURIComponent(taskId)}/stop`, { reason });
    },
    getBaseUrl() {
      return normalizedBaseUrl;
    },
  };
}

module.exports = {
  createChatRuntimeControl,
};
