const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

const { createDeployService } = require('../server/deploy-service');

describe('deploy-service', () => {
  it('runs deploy commands and resolves stdout', async () => {
    const exec = mock.fn((...args) => {
      const cb = typeof args[2] === 'function'
        ? args[2]
        : typeof args[1] === 'function'
          ? args[1]
          : null;
      if (cb) cb(null, 'deploy ok', '');
    });
    const service = createDeployService({
      exec,
      rootDir: '/tmp/app',
      apiProcessName: 'api-service',
      staticProcessName: 'static-service',
    });

    const result = await service.selfDeploy();

    assert.equal(result, 'deploy ok');
    assert.match(exec.mock.calls[0].arguments[0], /git fetch origin/);
    assert.match(exec.mock.calls[0].arguments[0], /cd \/tmp\/app/);
  });

  it('returns already deploying when a deploy is in progress', async () => {
    let complete;
    const exec = mock.fn((cmd, opts, cb) => {
      complete = () => cb(null, 'done', '');
    });
    const service = createDeployService({
      exec,
      rootDir: '/tmp/app',
    });

    const first = service.selfDeploy();
    const second = await service.selfDeploy();
    complete();
    await first;

    assert.equal(second, 'already deploying');
    assert.equal(exec.mock.calls.length, 1);
  });
});
