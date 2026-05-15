import test from 'node:test';
import assert from 'node:assert/strict';

import { AdapterRegistry } from '../../src/backend/registry.js';

function createManifest() {
    return {
        id: 'chatgpt',
        name: 'ChatGPT',
        providers: [
            {
                type: 'openai-images-generations',
                models: ['gpt-image-2'],
                async execute() {
                    return { success: true, data: {} };
                }
            },
            {
                type: 'openai-images-edits',
                models: ['gpt-image-2'],
                async execute() {
                    return { success: true, data: {} };
                }
            }
        ]
    };
}

test('registry accepts multi-provider adapter manifest', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(createManifest());
    assert.deepEqual(errors, []);
});

test('registry resolves provider entry by type and model', () => {
    const registry = new AdapterRegistry();
    registry.adapters.set('chatgpt', createManifest());

    const generationEntry = registry.resolveProviderEntry('chatgpt', 'openai-images-generations', 'gpt-image-2');
    const editEntry = registry.resolveProviderEntry('chatgpt', 'openai-images-edits', 'gpt-image-2');

    assert.equal(generationEntry?.type, 'openai-images-generations');
    assert.equal(editEntry?.type, 'openai-images-edits');
    assert.equal(registry.supportsTask('chatgpt', 'openai-images-generations', 'gpt-image-2'), true);
    assert.equal(registry.supportsTask('chatgpt', 'openai-chat-completions', 'gpt-4o'), false);
});

test('registry returns deduplicated model list per adapter', () => {
    const registry = new AdapterRegistry();
    registry.adapters.set('chatgpt', createManifest());

    const models = registry.getModelsForAdapter('chatgpt').data.map(item => item.id);
    assert.deepEqual(models, ['gpt-image-2']);
});
