import test from 'node:test';
import assert from 'node:assert/strict';

import { Worker } from '../../src/backend/pool/Worker.js';
import { registry } from '../../src/backend/registry.js';

function makeWorker(type = 'demo') {
  const globalConfig = {
    queue: { workerMaxPending: 10, workerWaitTimeout: 300000 },
    paths: { tempDir: '/tmp' },
    browser: { humanizeCursor: false }
  };
  const workerConfig = {
    name: 'w1',
    type,
    instanceName: 'inst1',
    userDataDir: '/tmp/none',
    resolvedProxy: null
  };
  return new Worker(globalConfig, workerConfig);
}

test('worker init with shared browser opens manifest.homePageUrl on resident page', async () => {
  registry.adapters.set('demo', {
    id: 'demo',
    name: 'Demo',
    homePageUrl: 'https://example.com/app',
    script: 'return {}'
  });

  let gotoCalledWith = null;
  const fakePage = {
    goto: async (url, options) => { gotoCalledWith = { url, options }; },
    on: () => {},
    authState: null,
    isClosed: () => false
  };
  const fakeBrowser = {
    newPage: async () => fakePage
  };

  const worker = makeWorker('demo');
  await worker._initWithSharedBrowser(fakeBrowser);

  assert.deepEqual(gotoCalledWith, {
    url: 'https://example.com/app',
    options: { waitUntil: 'domcontentloaded' }
  });
});

test('worker init skips homepage navigation when manifest has no homePageUrl', async () => {
  registry.adapters.set('no-home', {
    id: 'no-home',
    name: 'NoHome',
    script: 'return {}'
  });

  let gotoCount = 0;
  const fakePage = {
    goto: async () => { gotoCount++; },
    on: () => {},
    authState: null,
    isClosed: () => false
  };
  const fakeBrowser = {
    newPage: async () => fakePage
  };

  const worker = makeWorker('no-home');
  await worker._initWithSharedBrowser(fakeBrowser);
  assert.equal(gotoCount, 0);
});
