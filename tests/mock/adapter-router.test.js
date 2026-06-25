import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

import { createAdapterRouter } from '../../src/server/api/adapter/routes.js';
import { registry } from '../../src/backend/registry.js';

async function withServer(handler, run) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        handler(req, res, url.pathname.slice(4)).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('adapter route enqueues task with parsed new-protocol fields', async () => {
    const adapter = {
        id: 'chatgpt',
        name: 'ChatGPT',
        script: 'return input;'
    };
    registry.adapters.set('chatgpt', adapter);
    registry.loaded = true;

    let capturedTask = null;
    const router = createAdapterRouter({
        queueManager: {
            canAcceptNonStreaming: () => true,
            addTask(task) {
                capturedTask = task;
                task.res.writeHead(200, { 'Content-Type': 'application/json' });
                task.res.end(JSON.stringify({ queued: true }));
            },
            getStatus: () => ({ total: 0 }),
            maxQueueSize: 10
        }
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chatgpt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: { prompt: 'hello' }, debug: true })
        });
        assert.equal(response.status, 200);
    });

    assert.equal(capturedTask.adapterId, 'chatgpt');
    assert.deepEqual(capturedTask.input, { prompt: 'hello' });
    assert.equal(capturedTask.debug, true);
});

test('adapter route accepts empty body and defaults input to {}', async () => {
    const adapter = { id: 'gemini', name: 'Gemini', script: 'return 1;' };
    registry.adapters.set('gemini', adapter);
    registry.loaded = true;

    let captured = null;
    const router = createAdapterRouter({
        queueManager: {
            canAcceptNonStreaming: () => true,
            addTask(task) { captured = task; task.res.end(); },
            getStatus: () => ({ total: 0 }),
            maxQueueSize: 10
        }
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/gemini`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: ''
        });
        assert.equal(response.status, 200);
    });

    assert.equal(captured.adapterId, 'gemini');
    assert.deepEqual(captured.input, {});
});
