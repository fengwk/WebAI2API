import test from 'node:test';
import assert from 'node:assert/strict';

import { PoolManager } from '../../src/backend/pool/PoolManager.js';

function createWorker(name, adapterId, resultSequence) {
    let index = 0;
    const worker = {
        name,
        type: adapterId,
        busyCount: 0,
        load: 0,
        supports(targetAdapterId) { return targetAdapterId === adapterId; },
        isHealthy() { return true; },
        isLocalQueueFull() { return false; },
        async executeTask() {
            const result = resultSequence[Math.min(index, resultSequence.length - 1)];
            index++;
            return result;
        }
    };
    return worker;
}

test('PoolManager does not switch worker when failover is disabled', async () => {
    const manager = new PoolManager({
        backend: { pool: { strategy: 'least_busy', failover: { enabled: false, maxRetries: 2 } } }
    });
    manager.workers = [
        createWorker('first', 'chatgpt', [{ success: false, data: null, error: { message: 'timeout', retryable: true } }]),
        createWorker('second', 'chatgpt', [{ success: true, data: { ok: true }, error: null }])
    ];

    const result = await manager.executeTask({}, { adapterId: 'chatgpt', input: {} });
    assert.equal(result.success, false);
    assert.equal(result.error.message, 'timeout');
});

test('PoolManager switches worker when failover is enabled', async () => {
    const manager = new PoolManager({
        backend: { pool: { strategy: 'least_busy', failover: { enabled: true, maxRetries: 2 } } }
    });
    manager.workers = [
        createWorker('first', 'chatgpt', [{ success: false, data: null, error: { message: 'timeout', retryable: true } }]),
        createWorker('second', 'chatgpt', [{ success: true, data: { ok: true }, error: null }])
    ];

    const result = await manager.executeTask({}, { adapterId: 'chatgpt', input: {} });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { ok: true });
});

test('PoolManager with explicit workerId routes to the specified worker only', async () => {
    const manager = new PoolManager({
        backend: { pool: { strategy: 'least_busy', failover: { enabled: true, maxRetries: 2 } } }
    });
    let firstCalled = 0;
    let secondCalled = 0;
    const first = {
        name: 'first',
        type: 'chatgpt',
        supports: id => id === 'chatgpt',
        isHealthy: () => true,
        isLocalQueueFull: () => false,
        load: 0,
        async executeTask() { firstCalled++; return { success: true, data: { from: 'first' } }; }
    };
    const second = {
        name: 'second',
        type: 'chatgpt',
        supports: id => id === 'chatgpt',
        isHealthy: () => true,
        isLocalQueueFull: () => false,
        load: 0,
        async executeTask() { secondCalled++; return { success: true, data: { from: 'second' } }; }
    };
    manager.workers = [first, second];

    const result = await manager.executeTask({}, { adapterId: 'chatgpt', input: {}, workerId: 'second' });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { from: 'second' });
    assert.equal(firstCalled, 0);
    assert.equal(secondCalled, 1);
});

test('PoolManager rejects unknown workerId with WORKER_NOT_FOUND', async () => {
    const manager = new PoolManager({
        backend: { pool: { strategy: 'least_busy', failover: { enabled: false, maxRetries: 0 } } }
    });
    manager.workers = [createWorker('first', 'chatgpt', [{ success: true, data: {} }])];
    const result = await manager.executeTask({}, { adapterId: 'chatgpt', input: {}, workerId: 'nonexistent' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'WORKER_NOT_FOUND');
});

test('PoolManager rejects workerId whose type does not match adapterId', async () => {
    const manager = new PoolManager({
        backend: { pool: { strategy: 'least_busy', failover: { enabled: false, maxRetries: 0 } } }
    });
    manager.workers = [createWorker('gemini-worker', 'gemini', [{ success: true, data: {} }])];
    const result = await manager.executeTask({}, { adapterId: 'chatgpt', input: {}, workerId: 'gemini-worker' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'WORKER_TYPE_MISMATCH');
});

test('PoolManager returns WORKER_BUSY when all supporting workers local queue full', async () => {
    const manager = new PoolManager({
        backend: { pool: { strategy: 'least_busy', failover: { enabled: false, maxRetries: 0 } } }
    });
    manager.workers = [{
        name: 'busy-worker',
        type: 'chatgpt',
        load: 11,
        supports: id => id === 'chatgpt',
        isHealthy: () => true,
        isLocalQueueFull: () => true,
        async executeTask() { throw new Error('should not be called'); }
    }];

    const result = await manager.executeTask({}, { adapterId: 'chatgpt', input: {} });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'WORKER_BUSY');
});

test('PoolManager returns WORKER_UNAVAILABLE when supporting workers are unhealthy', async () => {
    const manager = new PoolManager({
        backend: { pool: { strategy: 'least_busy', failover: { enabled: false, maxRetries: 0 } } }
    });
    manager.workers = [{
        name: 'down-worker',
        type: 'chatgpt',
        load: 0,
        supports: id => id === 'chatgpt',
        isHealthy: () => false,
        isLocalQueueFull: () => false,
        async executeTask() { throw new Error('should not be called'); }
    }];

    const result = await manager.executeTask({}, { adapterId: 'chatgpt', input: {} });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'WORKER_UNAVAILABLE');
});

test('PoolManager.dispose 会调用所有 worker.dispose 并清空 workers', async () => {
    const manager = new PoolManager({
        backend: { pool: { strategy: 'least_busy', failover: { enabled: false, maxRetries: 0 } } }
    });
    const disposed = [];
    manager.initialized = true;
    manager.workers = [
        { name: 'first', async dispose(reason) { disposed.push(['first', reason]); } },
        { name: 'second', async dispose(reason) { disposed.push(['second', reason]); } }
    ];

    await manager.dispose('fatal-runtime');

    assert.equal(manager.initialized, false);
    assert.deepEqual(manager.workers, []);
    assert.deepEqual(disposed, [
        ['first', 'fatal-runtime'],
        ['second', 'fatal-runtime']
    ]);
});
