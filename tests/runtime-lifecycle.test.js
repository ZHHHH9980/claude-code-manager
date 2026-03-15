const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  persistSessionBuffers,
  registerSigtermPersistence,
  startServerAndRecover,
} = require('../server/runtime-lifecycle');

describe('runtime-lifecycle', () => {
  it('persists non-empty session buffers to disk', () => {
    const mkdirSync = mock.fn();
    const writeFileSync = mock.fn();

    persistSessionBuffers({
      fs: { mkdirSync, writeFileSync },
      sessionsDir: '/tmp/sessions',
      ptyManager: {
        sessions: new Map([
          ['a', { outputBuffer: 'hello' }],
          ['b', { outputBuffer: '' }],
        ]),
      },
      logger: { error: () => {} },
    });

    assert.equal(mkdirSync.mock.calls.length, 1);
    assert.equal(writeFileSync.mock.calls.length, 1);
    assert.match(writeFileSync.mock.calls[0].arguments[0], /a\.buf$/);
    assert.equal(writeFileSync.mock.calls[0].arguments[1], 'hello');
  });

  it('registers a SIGTERM handler that persists and exits', () => {
    let sigtermHandler = null;
    const persist = mock.fn();
    const exit = mock.fn();

    registerSigtermPersistence({
      processObject: {
        on(event, handler) {
          if (event === 'SIGTERM') sigtermHandler = handler;
        },
      },
      persist,
      exit,
    });

    sigtermHandler();

    assert.equal(persist.mock.calls.length, 1);
    assert.equal(exit.mock.calls.length, 1);
  });

  it('starts the server and runs session recovery on listen', async () => {
    const recoverSessions = mock.fn();
    const log = mock.fn();

    await new Promise((resolve) => {
      startServerAndRecover({
        server: {
          listen(port, handler) {
            assert.equal(port, 3000);
            handler();
            resolve();
          },
        },
        port: 3000,
        logger: { log },
        recoverSessions,
      });
    });

    assert.equal(log.mock.calls.length, 1);
    assert.equal(recoverSessions.mock.calls.length, 1);
  });
});
