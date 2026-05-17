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

test('adapter route validates body and enqueues task', async () => {
    const adapter = {
        id: 'chatgpt',
        name: 'ChatGPT',
        inputJsonSchema: {
            type: 'object',
            required: ['prompt'],
            properties: { prompt: { type: 'string' } }
        },
        outputJsonSchema: {
            type: 'object',
            required: ['message'],
            properties: { message: { type: 'string' } }
        },
        async execute() {
            return { message: 'ok' };
        }
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
            body: JSON.stringify({ prompt: 'hello' })
        });
        assert.equal(response.status, 200);
    });

    assert.equal(capturedTask.adapterId, 'chatgpt');
    assert.deepEqual(capturedTask.input, { prompt: 'hello' });
});

test('adapter route returns validation error for bad input', async () => {
    const adapter = {
        id: 'gemini',
        name: 'Gemini',
        inputJsonSchema: {
            type: 'object',
            required: ['prompt'],
            properties: { prompt: { type: 'string' } }
        },
        outputJsonSchema: {
            type: 'object',
            required: ['message'],
            properties: { message: { type: 'string' } }
        },
        async execute() {
            return { message: 'ok' };
        }
    };
    registry.adapters.set('gemini', adapter);
    registry.loaded = true;

    const router = createAdapterRouter({
        queueManager: {
            canAcceptNonStreaming: () => true,
            addTask() {
                throw new Error('should not queue');
            },
            getStatus: () => ({ total: 0 }),
            maxQueueSize: 10
        }
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/gemini`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.match(body.error.message, /prompt/);
    });
});
