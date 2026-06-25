import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

import { createAdapterRouter, normalizeRequestBody } from '../../src/server/api/adapter/routes.js';
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

function buildQueueMock(captured) {
    return {
        canAcceptNonStreaming: () => true,
        addTask(task) {
            captured.task = task;
            task.res.writeHead(200, { 'Content-Type': 'application/json' });
            task.res.end(JSON.stringify({ queued: true }));
        },
        getStatus: () => ({ total: 0 }),
        maxQueueSize: 10
    };
}

function newAdapter(id = 'demo') {
    return {
        id,
        name: 'Demo',
        inputJsonSchema: null,
        script: 'return 1;'
    };
}

test('normalizeRequestBody parses new request shape', () => {
    assert.deepEqual(normalizeRequestBody({ input: { a: 1 }, debug: true, workerId: 'w1' }), {
        input: { a: 1 }, debug: true, workerId: 'w1', overrideScript: null
    });
});

test('normalizeRequestBody tolerates empty body and wrong types', () => {
    const out = normalizeRequestBody(null);
    assert.deepEqual(out, { input: {}, debug: false, workerId: null, overrideScript: null });

    const out2 = normalizeRequestBody({ input: 'not-object', workerId: 123, overrideScript: '   ' });
    assert.deepEqual(out2, { input: {}, debug: false, workerId: null, overrideScript: null });
});

test('adapter router forwards parsed fields to queue task', async () => {
    const adapter = newAdapter('chatgpt');
    registry.adapters.set('chatgpt', adapter);
    registry.loaded = true;

    const captured = { task: null };
    const router = createAdapterRouter({ queueManager: buildQueueMock(captured) });

    await withServer(router, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/chatgpt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input: { prompt: 'hi' },
                debug: true,
                workerId: 'chatgpt-page',
                overrideScript: 'return 42;'
            })
        });
        assert.equal(res.status, 200);
    });

    const task = captured.task;
    assert.equal(task.adapterId, 'chatgpt');
    assert.deepEqual(task.input, { prompt: 'hi' });
    assert.equal(task.debug, true);
    assert.equal(task.workerId, 'chatgpt-page');
    assert.equal(task.overrideScript, 'return 42;');
    assert.equal(task.endpointPath, '/api/chatgpt');
    assert.match(task.id, /^[0-9a-f-]+/);
});

test('adapter router rejects non-JSON content type', async () => {
    const adapter = newAdapter('chatgpt');
    registry.adapters.set('chatgpt', adapter);
    registry.loaded = true;

    const router = createAdapterRouter({
        queueManager: {
            canAcceptNonStreaming: () => true,
            addTask() { throw new Error('should not be called'); },
            getStatus: () => ({ total: 0 }),
            maxQueueSize: 10
        }
    });

    await withServer(router, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/chatgpt`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'plain text'
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.match(body.error.message, /application\/json/);
    });
});

test('adapter router returns 404 for unknown adapter', async () => {
    registry.adapters.clear();
    registry.loaded = true;

    const router = createAdapterRouter({
        queueManager: {
            canAcceptNonStreaming: () => true,
            addTask() { throw new Error('should not be called'); },
            getStatus: () => ({ total: 0 }),
            maxQueueSize: 10
        }
    });

    await withServer(router, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/missing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: {} })
        });
        assert.equal(res.status, 404);
    });
});
