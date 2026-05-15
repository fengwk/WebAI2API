import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { openaiChatCompletionsProvider } from '../../src/backend/providers/openaiChatCompletions.js';
import { openaiImagesGenerationsProvider } from '../../src/backend/providers/openaiImagesGenerations.js';
import { openaiImagesEditsProvider } from '../../src/backend/providers/openaiImagesEdits.js';

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('chat provider normalizes prompt into messages for admin input', async () => {
    const tempDir = await createTempDir('webai-chat-');
    const manifest = {
        provider: {
            models: ['gpt-4o-mini']
        }
    };

    const result = await openaiChatCompletionsProvider.normalizeAdminInput({
        input: {
            prompt: 'hello world'
        }
    }, { tempDir, requestId: 'chat-test' }, manifest);

    assert.equal(result.modelId, 'gpt-4o-mini');
    assert.deepEqual(result.input.messages, [
        { role: 'user', content: 'hello world' }
    ]);
    assert.equal(result.promptText, 'user: hello world');
});

test('image generations provider renders url and b64_json responses', async () => {
    const tempDir = await createTempDir('webai-image-');
    const filePath = path.join(tempDir, 'result.png');
    await fs.writeFile(filePath, Buffer.from('hello-image'));

    const urlResponse = await openaiImagesGenerationsProvider.buildSuccessResponse({
        modelName: 'gpt-image-2',
        input: { responseFormat: 'url', model: 'gpt-image-2' },
        result: {
            created: 123,
            images: [{ file: { absolutePath: filePath, url: '/files/result.png', mimeType: 'image/png' } }]
        }
    });
    assert.equal(urlResponse.body.data[0].url, '/files/result.png');

    const b64Response = await openaiImagesGenerationsProvider.buildSuccessResponse({
        modelName: 'gpt-image-2',
        input: { responseFormat: 'b64_json', model: 'gpt-image-2' },
        result: {
            created: 123,
            images: [{ file: { absolutePath: filePath, url: '/files/result.png', mimeType: 'image/png' } }]
        }
    });
    assert.equal(b64Response.body.data[0].b64_json, Buffer.from('hello-image').toString('base64'));
});

test('image edits provider normalizes base64 uploads', async () => {
    const tempDir = await createTempDir('webai-edit-');
    const manifest = {
        provider: {
            models: ['gpt-image-2']
        }
    };
    const dataUrl = 'data:image/png;base64,' + Buffer.from('edit-image').toString('base64');

    const result = await openaiImagesEditsProvider.normalizeAdminInput({
        input: {
            prompt: 'edit this',
            images: [{ fileName: 'image.png', mimeType: 'image/png', dataUrl }],
            mask: { fileName: 'mask.png', mimeType: 'image/png', dataUrl }
        }
    }, { tempDir, requestId: 'edit-test' }, manifest);

    assert.equal(result.modelId, 'gpt-image-2');
    assert.equal(result.input.images.length, 1);
    assert.ok(result.input.images[0].path.includes(tempDir));
    assert.ok(result.input.mask.path.includes(tempDir));
    assert.equal(result.cleanupPaths.length, 2);
});
