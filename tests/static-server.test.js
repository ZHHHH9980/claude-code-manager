const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let proxyTo;

describe('static-server proxy middleware', () => {
  before(() => {
    ({ proxyTo } = require('../server/proxy-helpers'));
  });

  it('forwards the original mounted path to the upstream proxy', () => {
    const calls = [];
    const middleware = proxyTo({
      web(req, res) {
        calls.push({ url: req.url, res });
      },
    });
    const req = {
      url: '/?EIO=4&transport=polling',
      originalUrl: '/socket.io/?EIO=4&transport=polling',
    };
    const res = {};

    middleware(req, res);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/socket.io/?EIO=4&transport=polling');
  });
});
