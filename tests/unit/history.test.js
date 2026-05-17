import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

test('initHistoryDb migrates legacy requests table before runtime writes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webai2api-history-'));
    const previousCwd = process.cwd();

    try {
        process.chdir(tempDir);
        await fs.mkdir(path.join(tempDir, 'data', 'history'), { recursive: true });

        const dbPath = path.join(tempDir, 'data', 'history', 'history.db');
        const legacyDb = new Database(dbPath);
        legacyDb.exec(`
            CREATE TABLE requests (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                duration_ms INTEGER
            );
        `);
        legacyDb.close();

        const historyModuleUrl = `${new URL('../../src/utils/history.js', import.meta.url).href}?case=${Date.now()}`;
        const historyModule = await import(historyModuleUrl);
        const largeBase64 = 'A'.repeat(1500);

        await historyModule.initHistoryDb();
        historyModule.createRecord({
            id: 'req-1',
            adapterId: 'chatgpt',
            endpointPath: '/api/chatgpt',
            requestSummary: '一只小猫',
            requestBody: {
                prompt: '一只小猫',
                images: [{ fileName: 'cat.png', mimeType: 'image/png', base64: largeBase64 }]
            },
            status: 'pending'
        });
        historyModule.updateRecord('req-1', {
            status: 'success',
            responseSummary: '已返回图片',
            responseBody: { image: { fileName: 'cat.png', mimeType: 'image/png', base64: 'Zm9v' } },
            durationMs: 1234
        });

        const detail = historyModule.getDetail('req-1');
        const list = historyModule.getList({}, 1, 20);
        assert.equal(detail.adapter_id, 'chatgpt');
        assert.equal(detail.endpoint_path, '/api/chatgpt');
        assert.equal(detail.request_summary, '一只小猫');
        assert.equal(detail.response_summary, '已返回图片');
        assert.equal(detail.status, 'success');
        assert.equal(detail.request_body_size > 1024, true);
        assert.equal(detail.request_body_truncated, true);
        assert.deepEqual(detail.request_body, {
            prompt: '一只小猫',
            images: [{ fileName: 'cat.png', mimeType: 'image/png', base64: largeBase64 }]
        });
        assert.deepEqual(detail.response_body, {
            image: { fileName: 'cat.png', mimeType: 'image/png', base64: 'Zm9v' }
        });
        assert.equal(list.items.length, 1);
        assert.equal('request_body' in list.items[0], false);
        assert.equal(list.items[0].request_body_truncated, true);
        assert.equal(list.items[0].request_body_preview.length <= 1027, true);
        assert.match(historyModule.getBodyText('req-1', 'request'), /"base64":"A+/);
    } finally {
        process.chdir(previousCwd);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
