const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildClaudeEnv } = require('../server/claude-env');

describe('claude-env', () => {
  it('uses .bashrc values to override stale process env', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-claude-env-'));
    fs.writeFileSync(path.join(tmpHome, '.bash_profile'), [
      'export ANTHROPIC_BASE_URL="https://old.example.com/api"',
      'export ANTHROPIC_AUTH_TOKEN="old-token"',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpHome, '.bashrc'), [
      'export APIURL="https://new.example.com/api"',
      'export APIKEY="new-token"',
    ].join('\n'));

    const env = buildClaudeEnv({
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://stale.example.com/api',
      ANTHROPIC_AUTH_TOKEN: 'stale-token',
    }, { homeDir: tmpHome });

    assert.equal(env.ANTHROPIC_BASE_URL, 'https://new.example.com/api');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'new-token');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(env.PATH.startsWith(path.join(tmpHome, '.nvm/versions/node/v22.22.0/bin')));
  });

  it('falls back to existing env vars when no shell files exist', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-claude-env-empty-'));
    const env = buildClaudeEnv({
      PATH: '/bin',
      APIURL: 'https://env.example.com/api',
      APIKEY: 'env-token',
    }, { homeDir: tmpHome });

    assert.equal(env.ANTHROPIC_BASE_URL, 'https://env.example.com/api');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'env-token');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });
});
