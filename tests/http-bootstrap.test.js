const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFrontendOrigins,
  createOriginPolicy,
  isValidAccessToken,
  createAccessTokenMiddleware,
} = require('../server/http-bootstrap');

describe('http-bootstrap', () => {
  it('parses configured frontend origins', () => {
    assert.deepEqual(
      parseFrontendOrigins(' http://a.test, http://b.test ,, '),
      ['http://a.test', 'http://b.test'],
    );
  });

  it('allows any origin when frontend url is empty', () => {
    const policy = createOriginPolicy({ frontendUrl: '' });
    assert.equal(policy.isAllowedOrigin('http://random.test'), true);
  });

  it('validates bearer and query access tokens', () => {
    assert.equal(
      isValidAccessToken({ headers: { authorization: 'Bearer secret' }, query: {} }, 'secret'),
      true,
    );
    assert.equal(
      isValidAccessToken({ headers: {}, query: { access_token: 'secret' } }, 'secret'),
      true,
    );
    assert.equal(
      isValidAccessToken({ headers: {}, query: {} }, 'secret'),
      false,
    );
  });

  it('creates access-token middleware with webhook exemption', () => {
    const middleware = createAccessTokenMiddleware({ accessToken: 'secret' });
    let nextCalled = false;
    middleware(
      { method: 'POST', path: '/api/webhook/github', headers: {}, query: {} },
      {
        status() { throw new Error('should not reject'); },
      },
      () => { nextCalled = true; },
    );
    assert.equal(nextCalled, true);
  });
});
