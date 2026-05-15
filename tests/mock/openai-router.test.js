import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';

import { createOpenAIRouter } from '../../src/server/api/openai/routes.js';

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function withServer(handler, run) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        handler(req, res, url.pathname.slice(3), url).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        });
    });

    await new Promise(resolve => server.listen(0, resolve));
    try {
        const address = server.address();
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('chat completions route queues normalized task', async () => {
    const tempDir = await createTempDir('webai-router-chat-');
    let capturedTask = null;
    const router = createOpenAIRouter({
        getModels: () => ({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model', created: 1, owned_by: 'webai-2api' }] }),
        getDefaultModel: () => 'gpt-4o-mini',
        hasModel: () => true,
        tempDir,
        queueManager: {
            canAcceptNonStreaming: () => true,
            addTask(task) {
                capturedTask = task;
                task.res.writeHead(200, { 'Content-Type': 'application/json' });
                task.res.end(JSON.stringify({ queued: true }));
            },
            getStatus: () => ({ total: 0 }),
            getPoolContext: () => ({ poolManager: {} }),
            getWorkerCookies: async () => ({ worker: 'default', cookies: [] }),
            maxQueueSize: 10
        }
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'hello' }]
            })
        });
        assert.equal(response.status, 200);
    });

    assert.equal(capturedTask.providerType, 'openai-chat-completions');
    assert.equal(capturedTask.modelId, 'gpt-4o-mini');
    assert.deepEqual(capturedTask.input.messages, [{ role: 'user', content: 'hello' }]);
});

test('images edits route parses multipart uploads into temp files', async () => {
    const tempDir = await createTempDir('webai-router-edit-');
    let capturedTask = null;
    const router = createOpenAIRouter({
        getModels: () => ({ object: 'list', data: [{ id: 'gpt-image-2', object: 'model', created: 1, owned_by: 'webai-2api' }] }),
        getDefaultModel: () => 'gpt-image-2',
        hasModel: () => true,
        tempDir,
        queueManager: {
            canAcceptNonStreaming: () => true,
            addTask(task) {
                capturedTask = task;
                task.res.writeHead(200, { 'Content-Type': 'application/json' });
                task.res.end(JSON.stringify({ queued: true }));
            },
            getStatus: () => ({ total: 0 }),
            getPoolContext: () => ({ poolManager: {} }),
            getWorkerCookies: async () => ({ worker: 'default', cookies: [] }),
            maxQueueSize: 10
        }
    });

    await withServer(router, async (baseUrl) => {
        const form = new FormData();
        form.set('prompt', 'edit image');
        form.set('model', 'gpt-image-2');
        form.append('image', new Blob(['PNGDATA'], { type: 'image/png' }), 'cat.png');

        const response = await fetch(`${baseUrl}/v1/images/edits`, {
            method: 'POST',
            body: form
        });
        assert.equal(response.status, 200);
    });

    assert.equal(capturedTask.providerType, 'openai-images-edits');
    assert.equal(capturedTask.modelId, 'gpt-image-2');
    assert.equal(capturedTask.input.images.length, 1);
    assert.ok(capturedTask.input.images[0].path.includes(tempDir));
    for (const filePath of capturedTask.cleanupPaths) {
        await fs.unlink(filePath).catch(() => {});
    }
});

test('returns invalid model for unsupported explicit model', async () => {
    const tempDir = await createTempDir('webai-router-model-');
    const router = createOpenAIRouter({
        getModels: () => ({ object: 'list', data: [] }),
        getDefaultModel: () => 'gpt-image-2',
        hasModel: () => false,
        tempDir,
        queueManager: {
            canAcceptNonStreaming: () => true,
            addTask() {
                throw new Error('should not queue');
            },
            getStatus: () => ({ total: 0 }),
            getPoolContext: () => ({ poolManager: {} }),
            getWorkerCookies: async () => ({ worker: 'default', cookies: [] }),
            maxQueueSize: 10
        }
    });

    await withServer(router, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/images/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'unknown-model', prompt: 'cat' })
        });
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.match(body.error.message, /模型无效/);
    });
});
