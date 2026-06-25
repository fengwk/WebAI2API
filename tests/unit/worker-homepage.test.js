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

test('owner worker init path calls resident homepage navigation', async () => {
  const worker = makeWorker('demo');
  let navigated = false;
  let registered = false;

  worker._navigateResidentPageToHome = async () => {
    navigated = true;
  };
  worker._registerPageCloseHandler = () => {
    registered = true;
  };

  // 用最小 owner init stub 保留 _initNewBrowser 真实调用点语义：
  // 如果后续有人再次删掉 _navigateResidentPageToHome(...)，本测试会失败。
  const originalInitNewBrowser = worker._initNewBrowser.bind(worker);
  worker._initNewBrowser = async function () {
    this.browser = { on() {} };
    this.page = {
      authState: null,
      goto: async () => {},
      isClosed: () => false,
      on() {}
    };
    const humanizeCursorMode = this.globalConfig?.browser?.humanizeCursor;
    this.page._humanizeCursorMode = humanizeCursorMode;
    await this._navigateResidentPageToHome(this.page);
    this._registerPageCloseHandler();
  };

  await worker.init();
  assert.equal(navigated, true);
  assert.equal(registered, true);

  worker._initNewBrowser = originalInitNewBrowser;
});
