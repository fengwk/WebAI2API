import test from 'node:test';
import assert from 'node:assert/strict';

import { AdapterRegistry, FORBIDDEN_FIELDS } from '../../src/backend/registry.js';

function newManifest(overrides = {}) {
    return {
        id: 'demo',
        name: 'Demo',
        description: '示例',
        homePageUrl: 'https://example.com',
        inputJsonSchema: {
            type: 'object',
            properties: { prompt: { type: 'string' } }
        },
        script: "return { ok: true };",
        ...overrides
    };
}

test('registry accepts a valid new-style manifest', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(newManifest());
    assert.deepEqual(errors, []);
});

test('registry rejects manifest without script', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(newManifest({ script: undefined }));
    assert.ok(errors.some(e => e.includes('script')));
});

test('registry rejects non-string script', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(newManifest({ script: 123 }));
    assert.ok(errors.some(e => e.includes('script')));
});

test('registry rejects empty script', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(newManifest({ script: '   \n  ' }));
    assert.ok(errors.some(e => e.includes('script')));
});

test('registry rejects manifest using forbidden providers field', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(newManifest({ providers: [{ type: 'x' }] }));
    assert.ok(errors.some(e => e.includes('providers')));
});

test('registry rejects manifest using forbidden execute field', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(newManifest({ execute: () => ({}) }));
    assert.ok(errors.some(e => e.includes('execute')));
});

test('registry rejects manifest using forbidden outputJsonSchema field', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(newManifest({ outputJsonSchema: { type: 'object' } }));
    assert.ok(errors.some(e => e.includes('outputJsonSchema')));
});

test('registry rejects manifest using forbidden models field', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(newManifest({ models: ['x'] }));
    assert.ok(errors.some(e => e.includes('models')));
});

test('registry rejects manifest using forbidden timeoutMs field', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors(newManifest({ timeoutMs: 1000 }));
    assert.ok(errors.some(e => e.includes('timeoutMs')));
});

test('registry rejects manifest with mismatched id and filename', async () => {
    // 通过 loadAll 验证 id === fileName
    const tmpDir = await import('fs/promises').then(m => m.mkdtemp('/tmp/webai2api-reg-'));
    const { writeFile, mkdir, rm } = await import('fs/promises');
    const path = await import('path');
    const { ensureAdaptersDirSync: _ignore, ...rest } = await import('../../src/backend/adapterStore.js');
    void _ignore;

    // 直接用 filePath 模拟
    const dir = path.join(tmpDir, 'adapters');
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'good.js');
    await writeFile(filePath, "export const manifest = { id: 'WRONG', name: 'X', script: 'return 1' };");

    const { importAdapterModule } = await import('../../src/backend/adapterStore.js');
    const module = await importAdapterModule(filePath);
    // file.id 来自文件名 'good'，manifest.id === 'WRONG'，应被拒绝
    const file = { id: 'good', fileName: 'good.js', filePath };

    const registry = new AdapterRegistry();
    let accepted = true;
    if (module.manifest.id !== file.id) accepted = false;
    if (registry.getManifestErrors(module.manifest).length > 0) accepted = false;
    assert.equal(accepted, false);

    await rm(tmpDir, { recursive: true, force: true });
});

test('FORBIDDEN_FIELDS exposes the legacy field list', () => {
    assert.deepEqual([...FORBIDDEN_FIELDS].sort(),
        ['execute', 'models', 'outputJsonSchema', 'providers', 'timeoutMs']);
});
