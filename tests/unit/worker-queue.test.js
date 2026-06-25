/**
 * @fileoverview Worker 本地 FIFO 队列测试
 *
 * 通过 monkey-patch `_runTask` 来注入可观察的执行函数，
 * 验证同一 worker 上的串行性、FIFO 顺序、容量上限、等待超时。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Worker } from '../../src/backend/pool/Worker.js';

function makeWorker({ workerMaxPending = 10, workerWaitTimeout = 300000, name = 'w1', type = 'demo' } = {}) {
    const globalConfig = {
        queue: { workerMaxPending, workerWaitTimeout },
        paths: { tempDir: '/tmp' },
        browser: { humanizeCursor: false }
    };
    const workerConfig = {
        name,
        type,
        instanceName: 'inst1',
        userDataDir: '/tmp/none',
        resolvedProxy: null
    };
    const worker = new Worker(globalConfig, workerConfig);
    worker.initialized = true;
    worker.browser = { isClosed: () => false };
    worker.page = { isClosed: () => false, url: () => 'about:blank', title: async () => '' };
    worker.error = null;
    return worker;
}

// 用 taskIndex -> resolver 的 map，确保每个任务的 resolve 独立
function patchRunTask(worker, factory) {
    const resolvers = new Map();
    worker._runTask = function (item) {
        const idx = item.task.input?.i ?? 0;
        return new Promise((resolve) => {
            resolvers.set(idx, resolve);
            // factory 是同步/异步函数，调用方需自己 resolve
            factory(item, resolve);
        });
    };
    return resolvers;
}

test('同一 worker 串行执行（FIFO 顺序）', async () => {
    const worker = makeWorker();
    const order = [];
    const resolvers = patchRunTask(worker, (item, resolve) => {
        order.push(`start:${item.task.input.i}`);
        setTimeout(() => {
            order.push(`end:${item.task.input.i}`);
            resolve({
                success: true,
                data: { i: item.task.input.i },
                workerId: worker.name,
                instanceId: worker.instanceName,
                page: { url: 'about:blank', title: '' }
            });
        }, 10);
    });

    const results = await Promise.all([
        worker.executeTask({}, { adapterId: 'demo', input: { i: 1 } }, { id: 'r1' }),
        worker.executeTask({}, { adapterId: 'demo', input: { i: 2 } }, { id: 'r2' }),
        worker.executeTask({}, { adapterId: 'demo', input: { i: 3 } }, { id: 'r3' })
    ]);

    assert.deepEqual(results.map(r => r.data.i), [1, 2, 3]);
    assert.deepEqual(order, [
        'start:1', 'end:1',
        'start:2', 'end:2',
        'start:3', 'end:3'
    ]);
});

test('超过 workerMaxPending 直接返回 busy', async () => {
    const worker = makeWorker({ workerMaxPending: 1 });
    const resolvers = patchRunTask(worker, (item, resolve) => {
        // 阻塞，等待测试代码主动 resolve
        resolvers.set(`pending-${item.task.input?.i}`, resolve);
    });

    const p1 = worker.executeTask({}, { adapterId: 'demo', input: { i: 1 } }, { id: 'r1' });
    // 等到 p1 进入 active
    await new Promise(r => setTimeout(r, 5));
    assert.equal(worker._activeCount, 1);

    // 第 2 个应该入队（pending=1）
    const p2Promise = worker.executeTask({}, { adapterId: 'demo', input: { i: 2 } }, { id: 'r2' });
    await new Promise(r => setTimeout(r, 5));
    assert.equal(worker._pending.length, 1);

    // 第 3 个超过 workerMaxPending=1，应该立即返回 busy
    const r3 = await worker.executeTask({}, { adapterId: 'demo', input: { i: 3 } }, { id: 'r3' });
    assert.equal(r3.success, false);
    assert.equal(r3.error.code, 'WORKER_BUSY');

    // 释放 p1
    resolvers.get('pending-1')({
        success: true, data: {}, workerId: worker.name,
        instanceId: worker.instanceName, page: { url: '', title: '' }
    });
    // p2 已经在执行中（activeCount=1），它需要 resolver 来完成
    await p1;
    // 等 p2 进入 active
    await new Promise(r => setTimeout(r, 5));
    resolvers.get('pending-2')({
        success: true, data: {}, workerId: worker.name,
        instanceId: worker.instanceName, page: { url: '', title: '' }
    });
    const p2 = await p2Promise;
    assert.equal(p2.success, true);
});

test('workerWaitTimeout 触发后丢弃超时任务', async () => {
    const worker = makeWorker({ workerMaxPending: 5, workerWaitTimeout: 50 });
    const resolvers = patchRunTask(worker, (item, resolve) => {
        resolvers.set(`pending-${item.task.input?.i}`, resolve);
    });

    const p1 = worker.executeTask({}, { adapterId: 'demo', input: { i: 1 } }, { id: 'r1' });
    await new Promise(r => setTimeout(r, 5));
    const p2 = worker.executeTask({}, { adapterId: 'demo', input: { i: 2 } }, { id: 'r2' });

    // 等 p2 超时
    const r2 = await p2;
    assert.equal(r2.success, false);
    assert.equal(r2.error.code, 'WORKER_TIMEOUT');

    // 释放 p1
    resolvers.get('pending-1')({
        success: true, data: {}, workerId: worker.name,
        instanceId: worker.instanceName, page: { url: '', title: '' }
    });
    const r1 = await p1;
    assert.equal(r1.success, true);
});

test('不支持的 adapterId 直接返回失败（不进队列）', async () => {
    const worker = makeWorker();
    const r = await worker.executeTask({}, { adapterId: 'OTHER', input: {} }, {});
    assert.equal(r.success, false);
    assert.match(r.error.message, /不支持/);
});

test('isLocalQueueFull 在容量达上限时返回 true', () => {
    const worker = makeWorker({ workerMaxPending: 2 });
    assert.equal(worker.isLocalQueueFull(), false);
    worker._pending.push({});
    assert.equal(worker.isLocalQueueFull(), false);
    worker._pending.push({});
    assert.equal(worker.isLocalQueueFull(), true);
});
