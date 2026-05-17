import test from 'node:test';
import assert from 'node:assert/strict';

import { AdapterRegistry } from '../../src/backend/registry.js';

function createManifest() {
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
        outputJsonSchema: {
            type: 'object',
            required: ['message'],
            properties: {
                message: { type: 'string' }
            }
        },
        async execute() {
            return { message: 'ok' };
        }
    };
}

test('registry accepts single-endpoint adapter manifest', () => {
    const registry = new AdapterRegistry();
    assert.deepEqual(registry.getManifestErrors(createManifest()), []);
});

test('registry rejects invalid schema manifest', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors({
        id: 'broken',
        name: 'Broken',
        inputJsonSchema: { type: 'unsupported' },
        outputJsonSchema: {},
        execute: null
    });
    assert.ok(errors.some(item => item.includes('inputJsonSchema.type')));
    assert.ok(errors.some(item => item.includes('execute')));
});

test('registry stores and returns adapter ids', () => {
    const registry = new AdapterRegistry();
    registry.adapters.set('chatgpt', createManifest());
    assert.equal(registry.hasAdapter('chatgpt'), true);
    assert.deepEqual(registry.getAdapterIds(), ['chatgpt']);
});
