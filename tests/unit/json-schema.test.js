import test from 'node:test';
import assert from 'node:assert/strict';

import { validateJsonSchema, validateSchemaDefinition } from '../../src/utils/jsonSchema.js';

test('validateSchemaDefinition accepts supported schema subset', () => {
    const errors = validateSchemaDefinition({
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: { type: 'string' },
            count: { type: 'integer', default: 1 },
            files: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['fileName', 'mimeType', 'base64'],
                    properties: {
                        fileName: { type: 'string' },
                        mimeType: { type: 'string' },
                        base64: { type: 'string' }
                    }
                }
            }
        }
    });

    assert.deepEqual(errors, []);
});

test('validateJsonSchema reports nested validation errors', () => {
    const errors = validateJsonSchema({
        type: 'object',
        required: ['prompt', 'images'],
        properties: {
            prompt: { type: 'string' },
            images: {
                type: 'array',
                minItems: 1,
                items: {
                    type: 'object',
                    required: ['fileName', 'mimeType', 'base64'],
                    properties: {
                        fileName: { type: 'string' },
                        mimeType: { type: 'string' },
                        base64: { type: 'string' }
                    }
                }
            }
        }
    }, {
        prompt: '',
        images: [{}]
    });

    assert.ok(errors.some(item => item.includes('$.images[0].fileName')));
    assert.ok(errors.some(item => item.includes('$.images[0].mimeType')));
    assert.ok(errors.some(item => item.includes('$.images[0].base64')));
});
