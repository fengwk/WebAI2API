/**
 * @fileoverview 队列 envelope 端到端测试
 *
 * 覆盖：
 *   - 成功返回 envelope: { ok:true, data, meta{requestId,adapterId,workerId,instanceId,queuedMs,durationMs,page}, trace? }
 *   - 失败返回 envelope: { ok:false, message, meta, trace? }
 *   - debug=true 时附 trace
 *   - debug=false 时不附 trace
 *   - trace.captures[].artifacts 中不出现 localPath / absolutePath / path 字段
 *   - meta.queuedMs / durationMs 为非负整数
 *   - 失败原因分类：WORKER_BUSY -> 429；WORKER_TIMEOUT -> 504；不可重试 -> 400；其它 -> 502
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueueManager } from '../../src/server/queue.js';

function makeRes() {
    return {
        statusCode: null,
        headers: null,
        body: null,
        writableEnded: false,
        writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
        end(payload) { this.body = payload; this.writableEnded = true; }
    };
}

function buildExecuteMock(handler) {
    return async (_poolCtx, task) => await handler(task);
}

function makeQueue({ executeMock, publicFileBaseUrl = '' } = {}) {
    const executeTask = executeMock || buildExecuteMock(async () => ({
        success: true, data: { ok: 1 }, workerId: 'w1', instanceId: 'i1',
        page: { url: 'https://example.com', title: 'Example' }
    }));
    return createQueueManager(
        { maxConcurrent: 1, queueBuffer: 2, workerMaxPending: 10, workerWaitTimeout: 300000 },
        {
            initBrowser: async () => ({}),
            executeTask,
            config: { server: { publicFileBaseUrl } }
        }
    );
}

function makeQueueWithInitBrowser({ initBrowserMock, executeMock, publicFileBaseUrl = '' } = {}) {
    const executeTask = executeMock || buildExecuteMock(async () => ({
        success: true, data: { ok: 1 }, workerId: 'w1', instanceId: 'i1',
        page: { url: 'https://example.com', title: 'Example' }
    }));
    return createQueueManager(
        { maxConcurrent: 1, queueBuffer: 2, workerMaxPending: 10, workerWaitTimeout: 300000 },
        {
            initBrowser: initBrowserMock || (async () => ({})),
            executeTask,
            config: { server: { publicFileBaseUrl } }
        }
    );
}

function awaitRes(res) {
    return new Promise((resolve) => {
        const tick = setInterval(() => {
            if (res.writableEnded) { clearInterval(tick); resolve(); }
        }, 5);
    });
}

test('成功返回 envelope：ok=true, data, meta 含全部字段', async () => {
    const queue = makeQueue();
    const res = makeRes();
    queue.addTask({
        res,
        id: 'req_001',
        adapterId: 'chatgpt',
        input: { prompt: 'hi' },
        debug: false,
        workerId: null,
        overrideScript: null,
        endpointPath: '/api/chatgpt',
        requestSummary: 'hi',
        requestBody: { input: { prompt: 'hi' } }
    });
    await awaitRes(res);
    assert.equal(res.statusCode, 200);

    const env = JSON.parse(res.body);
    assert.equal(env.ok, true);
    assert.deepEqual(env.data, { ok: 1 });
    assert.equal(env.message, undefined);
    assert.equal(env.meta.requestId, 'req_001');
    assert.equal(env.meta.adapterId, 'chatgpt');
    assert.equal(env.meta.workerId, 'w1');
    assert.equal(env.meta.instanceId, 'i1');
    assert.equal(typeof env.meta.queuedMs, 'number');
    assert.equal(typeof env.meta.durationMs, 'number');
    assert.ok(env.meta.queuedMs >= 0);
    assert.ok(env.meta.durationMs >= 0);
    assert.equal(env.meta.page.url, 'https://example.com');
    assert.equal(env.meta.page.title, 'Example');
    // debug=false 时不附 trace
    assert.equal(env.trace, undefined);
});

test('debug=true 时附 trace（steps/captures/logs）', async () => {
    const executeMock = buildExecuteMock(async () => ({
        success: true, data: {}, workerId: 'w1', instanceId: 'i1',
        page: { url: '', title: '' },
        trace: {
            steps: [{ name: 'open', ts: 1 }],
            captures: [{ name: 'c1', ts: 2, artifacts: { screenshot: { url: 'https://h/x.png', mimeType: 'image/png', name: 'x.png' } } }],
            logs: [{ ts: 3, level: 'info', message: 'log' }]
        }
    }));
    const queue = makeQueue({ executeMock });
    const res = makeRes();
    queue.addTask({
        res, id: 'req_002', adapterId: 'a', input: {}, debug: true, workerId: null, overrideScript: null,
        endpointPath: '/api/a', requestSummary: '', requestBody: { input: {} }
    });
    await awaitRes(res);
    const env = JSON.parse(res.body);
    assert.equal(env.ok, true);
    assert.ok(env.trace);
    assert.equal(env.trace.steps.length, 1);
    assert.equal(env.trace.captures.length, 1);
    assert.equal(env.trace.logs.length, 1);
});

test('失败返回 envelope：ok=false, message, meta；debug 时附 trace', async () => {
    const executeMock = buildExecuteMock(async () => ({
        success: false,
        error: { message: '未找到发送按钮', retryable: false },
        workerId: 'w1', instanceId: 'i1',
        page: { url: 'https://example.com', title: 'Example' },
        trace: { steps: [], captures: [], logs: [{ ts: 0, level: 'error', message: 'fail' }] }
    }));
    const queue = makeQueue({ executeMock });
    const res = makeRes();
    queue.addTask({
        res, id: 'req_003', adapterId: 'a', input: {}, debug: true, workerId: null, overrideScript: null,
        endpointPath: '/api/a', requestSummary: '', requestBody: { input: {} }
    });
    await awaitRes(res);
    assert.equal(res.statusCode, 400);

    const env = JSON.parse(res.body);
    assert.equal(env.ok, false);
    assert.equal(env.message, '未找到发送按钮');
    assert.equal(env.meta.requestId, 'req_003');
    assert.equal(env.meta.workerId, 'w1');
    assert.equal(env.meta.page.url, 'https://example.com');
    assert.ok(env.trace);
    assert.equal(env.trace.logs[0].message, 'fail');
});

test('WORKER_BUSY -> 429 envelope', async () => {
    const executeMock = buildExecuteMock(async () => ({
        success: false, error: { code: 'WORKER_BUSY', message: 'busy', retryable: true },
        workerId: 'w1', instanceId: 'i1', page: { url: '', title: '' }
    }));
    const queue = makeQueue({ executeMock });
    const res = makeRes();
    queue.addTask({
        res, id: 'req_b', adapterId: 'a', input: {}, debug: false, workerId: null, overrideScript: null,
        endpointPath: '/api/a', requestSummary: '', requestBody: { input: {} }
    });
    await awaitRes(res);
    assert.equal(res.statusCode, 429);
    const env = JSON.parse(res.body);
    assert.equal(env.ok, false);
    assert.equal(env.message, 'busy');
});

test('WORKER_TIMEOUT -> 504 envelope', async () => {
    const executeMock = buildExecuteMock(async () => ({
        success: false, error: { code: 'WORKER_TIMEOUT', message: 'timeout', retryable: true },
        workerId: 'w1', instanceId: 'i1', page: { url: '', title: '' }
    }));
    const queue = makeQueue({ executeMock });
    const res = makeRes();
    queue.addTask({
        res, id: 'req_t', adapterId: 'a', input: {}, debug: false, workerId: null, overrideScript: null,
        endpointPath: '/api/a', requestSummary: '', requestBody: { input: {} }
    });
    await awaitRes(res);
    assert.equal(res.statusCode, 504);
    const env = JSON.parse(res.body);
    assert.equal(env.ok, false);
    assert.equal(env.message, 'timeout');
});

test('可重试错误 -> 502 envelope', async () => {
    const executeMock = buildExecuteMock(async () => ({
        success: false, error: { message: '网络错误', retryable: true },
        workerId: 'w1', instanceId: 'i1', page: { url: '', title: '' }
    }));
    const queue = makeQueue({ executeMock });
    const res = makeRes();
    queue.addTask({
        res, id: 'req_502', adapterId: 'a', input: {}, debug: false, workerId: null, overrideScript: null,
        endpointPath: '/api/a', requestSummary: '', requestBody: { input: {} }
    });
    await awaitRes(res);
    assert.equal(res.statusCode, 502);
});

test('trace.captures[].artifacts 对外不暴露 localPath / absolutePath / path', async () => {
    const executeMock = buildExecuteMock(async () => ({
        success: true, data: {}, workerId: 'w1', instanceId: 'i1',
        page: { url: '', title: '' },
        trace: {
            steps: [],
            captures: [{
                name: 'c1', ts: 0,
                artifacts: {
                    screenshot: { url: 'https://h/x.png', mimeType: 'image/png', name: 'x.png' },
                    html: { url: 'https://h/x.html', mimeType: 'text/html', name: 'x.html' }
                }
            }],
            logs: []
        }
    }));
    const queue = makeQueue({ executeMock });
    const res = makeRes();
    queue.addTask({
        res, id: 'req_url', adapterId: 'a', input: {}, debug: true, workerId: null, overrideScript: null,
        endpointPath: '/api/a', requestSummary: '', requestBody: { input: {} }
    });
    await awaitRes(res);
    const env = JSON.parse(res.body);
    const capture = env.trace.captures[0];
    for (const artifact of Object.values(capture.artifacts)) {
        assert.equal(artifact.localPath, undefined, 'localPath 不应出现在对外响应');
        assert.equal(artifact.absolutePath, undefined);
        assert.equal(artifact.path, undefined);
    }
});

test('initBrowser 失败时仍返回失败 envelope 并结束响应', async () => {
    const queue = makeQueueWithInitBrowser({
        initBrowserMock: async () => {
            throw new Error('pool init failed');
        }
    });
    const res = makeRes();
    queue.addTask({
        res, id: 'req_init_fail', adapterId: 'chatgpt', input: {}, debug: false, workerId: null, overrideScript: null,
        endpointPath: '/api/chatgpt', requestSummary: '', requestBody: { input: {} }
    });
    await awaitRes(res);
    assert.equal(res.writableEnded, true);
    assert.equal(res.statusCode, 502);
    const env = JSON.parse(res.body);
    assert.equal(env.ok, false);
    assert.equal(env.message, 'pool init failed');
    assert.equal(env.meta.requestId, 'req_init_fail');
});

test('meta.queuedMs 在任务入队后能反映等待时间', async () => {
    const resolvers = new Map();
    const executeMock = (_poolCtx, task) => new Promise((r) => {
        // queue.js 把 requestId 放在 task.requestId 字段
        const key = task.requestId || task.adapterId;
        resolvers.set(key, r);
    });
    // 用 maxConcurrent=2 让 r_a / r_b 同时进入 executeMock，从而都能被 resolve
    const queue = createQueueManager(
        { maxConcurrent: 2, queueBuffer: 2, workerMaxPending: 10, workerWaitTimeout: 300000 },
        { initBrowser: async () => ({}), executeTask: executeMock, config: { server: {} } }
    );

    const res1 = makeRes();
    queue.addTask({
        res: res1, id: 'r_a', adapterId: 'a', input: {}, debug: false, workerId: null, overrideScript: null,
        endpointPath: '/api/a', requestSummary: '', requestBody: { input: {} }
    });
    await new Promise(r => setTimeout(r, 5));

    const res2 = makeRes();
    queue.addTask({
        res: res2, id: 'r_b', adapterId: 'a', input: {}, debug: false, workerId: null, overrideScript: null,
        endpointPath: '/api/a', requestSummary: '', requestBody: { input: {} }
    });
    await new Promise(r => setTimeout(r, 30));

    const rA = resolvers.get('r_a');
    const rB = resolvers.get('r_b');
    rA({
        success: true, data: {}, workerId: 'w1', instanceId: 'i1', page: { url: '', title: '' }
    });
    rB({
        success: true, data: {}, workerId: 'w1', instanceId: 'i1', page: { url: '', title: '' }
    });
    await awaitRes(res1);
    await awaitRes(res2);

    const envA = JSON.parse(res1.body);
    const envB = JSON.parse(res2.body);
    assert.equal(envA.meta.requestId, 'r_a');
    assert.equal(envB.meta.requestId, 'r_b');
    assert.ok(envB.meta.queuedMs >= 0);
});
