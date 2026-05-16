import test from 'node:test';
import assert from 'node:assert/strict';

import { PoolManager } from '../../src/backend/pool/PoolManager.js';

function createWorker(name, resultSequence) {
    let index = 0;
    return {
        name,
        busyCount: 0,
        supports(providerType, modelId) {
            return providerType === 'openai-images-generations' && modelId === 'gpt-image-2';
        },
        async executeTask() {
            const result = resultSequence[Math.min(index, resultSequence.length - 1)];
            index++;
            return result;
        }
    };
}

test('PoolManager does not switch worker when failover is disabled', async () => {
    const manager = new PoolManager({
        backend: {
            pool: {
                strategy: 'least_busy',
                failover: {
                    enabled: false,
                    maxRetries: 2
                }
            }
        }
    });

    const firstWorker = createWorker('first', [{
        success: false,
        data: null,
        error: { message: 'timeout', retryable: true }
    }]);
    const secondWorker = createWorker('second', [{
        success: true,
        data: { ok: true },
        error: null
    }]);

    manager.workers = [firstWorker, secondWorker];
    const result = await manager.executeTask({}, {
        providerType: 'openai-images-generations',
        modelId: 'gpt-image-2',
        input: {}
    });

    assert.equal(result.success, false);
    assert.equal(result.error.message, 'timeout');
});

test('PoolManager switches worker when failover is enabled', async () => {
    const manager = new PoolManager({
        backend: {
            pool: {
                strategy: 'least_busy',
                failover: {
                    enabled: true,
                    maxRetries: 2
                }
            }
        }
    });

    const firstWorker = createWorker('first', [{
        success: false,
        data: null,
        error: { message: 'timeout', retryable: true }
    }]);
    const secondWorker = createWorker('second', [{
        success: true,
        data: { ok: true },
        error: null
    }]);

    manager.workers = [firstWorker, secondWorker];
    const result = await manager.executeTask({}, {
        providerType: 'openai-images-generations',
        modelId: 'gpt-image-2',
        input: {}
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.data, { ok: true });
});
