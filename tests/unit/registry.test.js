import test from 'node:test';
import assert from 'node:assert/strict';

import { AdapterRegistry } from '../../src/backend/registry.js';

function createManifest(overrides = {}) {
    return {
        id: 'chatgpt',
        name: 'ChatGPT',
        inputJsonSchema: {
            type: 'object',
            required: ['prompt'],
            properties: {
                prompt: { type: 'string' }
            }
        },
        script: 'return { message: input.prompt };',
        ...overrides
    };
}

test('registry accepts new-style adapter manifest', () => {
    const registry = new AdapterRegistry();
    assert.deepEqual(registry.getManifestErrors(createManifest()), []);
});

test('registry rejects manifest with both new and old fields', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(createManifest({
        outputJsonSchema: { type: 'object' },
        execute: () => ({})
    }));
    assert.ok(errors.some(item => item.includes('execute')));
    assert.ok(errors.some(item => item.includes('outputJsonSchema')));
});

test('registry stores and returns adapter ids', () => {
    const registry = new AdapterRegistry();
    registry.adapters.set('chatgpt', createManifest());
    assert.equal(registry.hasAdapter('chatgpt'), true);
    assert.deepEqual(registry.getAdapterIds(), ['chatgpt']);
});
