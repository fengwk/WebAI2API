import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { createUploadRouter } from '../../src/server/api/uploads/routes.js';
import { saveInputValueToTempFile } from '../../src/utils/inputFiles.js';

async function withServer(handler, run) {
    const server = http.createServer((req, res) => {
        handler(req, res).catch(err => {
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

test('upload router accepts multipart form-data and returns upload descriptors', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webai2api-upload-test-'));
    const router = createUploadRouter({ tempDir });

    try {
        await withServer(router, async (baseUrl) => {
            const form = new FormData();
            form.append('attachments', new File(['hello world'], 'hello.txt', { type: 'text/plain' }));
            form.append('attachments', new File(['%PDF'], 'demo.pdf', { type: 'application/pdf' }));

            const res = await fetch(`${baseUrl}`, {
                method: 'POST',
                body: form
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.ok, true);
            assert.equal(Array.isArray(body.uploads), true);
            assert.equal(body.uploads.length, 2);

            const [first, second] = body.uploads;
            assert.ok(first.uploadId);
            assert.equal(first.fileName, 'hello.txt');
            assert.equal(first.mimeType, 'text/plain');
            assert.equal(first.fieldName, 'attachments');

            const resolved = await saveInputValueToTempFile(first, { tempDir, prefix: 'input' });
            const content = await fs.readFile(resolved.path, 'utf8');
            assert.equal(content, 'hello world');

            assert.ok(second.uploadId);
            assert.equal(second.fileName, 'demo.pdf');
            assert.equal(second.mimeType, 'application/pdf');
        });
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('upload router rejects non-multipart content type', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webai2api-upload-test-'));
    const router = createUploadRouter({ tempDir });

    try {
        await withServer(router, async (baseUrl) => {
            const res = await fetch(`${baseUrl}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x: 1 })
            });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.match(body.error.message, /multipart\/form-data/);
        });
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
