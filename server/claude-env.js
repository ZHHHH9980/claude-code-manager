const fs = require('fs');
const path = require('path');

const BASH_ENV_FILES = ['.profile', '.bash_profile', '.bashrc'];

function firstNonEmpty(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function unquote(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const quote = raw[0];
  if ((quote === '"' || quote === '\'') && raw.endsWith(quote) && raw.length >= 2) {
    const inner = raw.slice(1, -1);
    if (quote === '"') {
      return inner
        .replace(/\\"/g, '"')
        .replace(/\\'/g, '\'')
        .replace(/\\\\/g, '\\');
    }
    return inner;
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

function readShellOverrides(homeDir = process.env.HOME) {
  const overrides = {};
  if (!homeDir) return overrides;

  const wanted = new Set([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'APIURL',
    'API_URL',
    'APIKEY',
    'API_KEY',
    'CLAUDE_CODE_API_URL',
    'CLAUDE_CODE_API_KEY',
  ]);

  for (const fileName of BASH_ENV_FILES) {
    const filePath = path.join(homeDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (!match) continue;
      const key = match[1];
      if (!wanted.has(key)) continue;
      const value = unquote(match[2]);
      if (!value) continue;
      overrides[key] = value;
    }
  }

  return overrides;
}

function buildClaudeEnv(baseEnv = process.env, { homeDir = process.env.HOME } = {}) {
  const nvmNode = path.join(homeDir || '/root', '.nvm/versions/node/v22.22.0/bin');
  const pathParts = [nvmNode];
  if (baseEnv.PATH) pathParts.push(baseEnv.PATH);
  const env = { ...baseEnv, PATH: pathParts.join(':') };

  const shellOverrides = readShellOverrides(homeDir);

  const baseUrl = firstNonEmpty([
    shellOverrides.APIURL,
    shellOverrides.API_URL,
    shellOverrides.CLAUDE_CODE_API_URL,
    shellOverrides.ANTHROPIC_BASE_URL,
    env.ANTHROPIC_BASE_URL,
    env.APIURL,
    env.API_URL,
    env.CLAUDE_CODE_API_URL,
  ]);

  const token = firstNonEmpty([
    shellOverrides.APIKEY,
    shellOverrides.API_KEY,
    shellOverrides.CLAUDE_CODE_API_KEY,
    shellOverrides.ANTHROPIC_AUTH_TOKEN,
    shellOverrides.ANTHROPIC_API_KEY,
    env.APIKEY,
    env.API_KEY,
    env.CLAUDE_CODE_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
    env.ANTHROPIC_API_KEY,
  ]);

  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (token) {
    env.ANTHROPIC_AUTH_TOKEN = token;
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.APIKEY;
  delete env.API_KEY;

  return env;
}

module.exports = {
  buildClaudeEnv,
  readShellOverrides,
};
