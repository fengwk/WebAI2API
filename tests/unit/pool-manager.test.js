import test from 'node:test';
import assert from 'node:assert/strict';

import { PoolManager } from '../../src/backend/pool/PoolManager.js';

function createWorker(name, adapterId, resultSequence) {
    let index = 0;
    return {
        name,
        busyCount: 0,
        supports(targetAdapterId) {
            return targetAdapterId === adapterId;
        },
        async executeTask() {
            const result = resultSequence[Math.min(index, resultSequence.length - 1)];
            index++;
            return result;
        },
        getAdapterMeta() {
            return { id: adapterId, name: adapterId };
        }
    };
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
