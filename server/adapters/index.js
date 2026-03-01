const claude = require('./claude');
const codex = require('./codex');

const adapters = new Map();
const LEGACY_MODE_ALIASES = {
  ralph: 'claude',
};

function register(config) {
  if (!config || !config.name) return;
  adapters.set(String(config.name).toLowerCase(), config);
}

function resolveAdapter(name) {
  const requestedName = String(name || '').trim().toLowerCase();
  const mappedName = LEGACY_MODE_ALIASES[requestedName] || requestedName || 'claude';
  const adapter = adapters.get(mappedName) || adapters.get('claude');
  return {
    adapter,
    requestedName,
    resolvedName: adapter?.name || 'claude',
    usedLegacyAlias: Boolean(LEGACY_MODE_ALIASES[requestedName]),
  };
}

function getAdapter(name) {
  return resolveAdapter(name).adapter;
}

function listAdapters() {
  return Array.from(adapters.values());
}

register(claude);
register(codex);

module.exports = {
  register,
  resolveAdapter,
  getAdapter,
  listAdapters,
};
