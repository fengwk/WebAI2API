/**
 * @fileoverview 旧入口/旧结构已删除的回归测试
 *
 * 覆盖：
 *   - /admin/debug/run 端点不存在
 *   - /admin/debug/artifacts/* 端点不存在
 *   - PoolManager.runDebugScript 已被删除
 *   - Worker.runDebugScript 已被删除
 *   - Worker.executeTask 不会因为残留的 providers/execute/outputJsonSchema 被调用
 *   - 旧 manifest 不会被 registry 加载
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

import { PoolManager } from '../../src/backend/pool/PoolManager.js';
import { Worker } from '../../src/backend/pool/Worker.js';
import { AdapterRegistry } from '../../src/backend/registry.js';

function callHandler(handler, pathname, method = 'POST', body = null) {
    return new Promise((resolve, reject) => {
        const req = new http.IncomingMessage({});
        req.method = method;
        req.url = pathname;
        req.headers = body ? { 'content-type': 'application/json' } : {};
        // 简单的请求模拟
        const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
        let i = 0;
        req[Symbol.asyncIterator] = async function* () {
            for (const c of chunks) yield c;
        };

        const res = {
            writeHead: function (status, headers) { this.statusCode = status; this.headers = headers || {}; },
            end: function (payload) { this.body = payload; resolve(this); },
            writableEnded: false
        };
        Promise.resolve(handler(req, res, pathname)).catch(reject);
    });
}

test('PoolManager.runDebugScript 已被删除', () => {
    const proto = PoolManager.prototype;
    assert.equal(typeof proto.runDebugScript, 'undefined');
});

test('Worker.runDebugScript 已被删除', () => {
    const proto = Worker.prototype;
    assert.equal(typeof proto.runDebugScript, 'undefined');
});

test('registry 拒绝旧 manifest（providers / execute / outputJsonSchema）', () => {
    const registry = new AdapterRegistry();
    const oldManifest = {
        id: 'old',
        name: 'Old',
        providers: [{ type: 'x', async execute() { return {}; } }],
        inputJsonSchema: { type: 'object' },
        outputJsonSchema: { type: 'object' }
    };
    const errors = registry.getManifestErrors(oldManifest);
    assert.ok(errors.some(e => e.includes('providers')));
    assert.ok(errors.some(e => e.includes('outputJsonSchema')));
});

test('registry 拒绝 execute 函数（即便没有 providers）', () => {
    const registry = new AdapterRegistry();
    const errors = registry.getManifestErrors({
        id: 'old2',
        name: 'Old2',
        script: 'return 1;',
        execute: () => ({})
    });
    assert.ok(errors.some(e => e.includes('execute')));
});

test('compileScriptRunner 仍然可用（替代 compileDebugRunner）', async () => {
    const { compileScriptRunner } = await import('../../src/backend/pool/Worker.js');
    const runner = compileScriptRunner('return 1;', 'manifest');
    const page = { url: () => '', title: async () => '' };
    const out = await runner(page, {}, {}, {}, {});
    assert.equal(out, 1);
});

// 端点级别的测试：admin 路由不暴露 /debug/run 与 /debug/artifacts
// 这部分通过直接对 admin 路由处理器发起请求并断言 404 来验证
import { createAdminRouter } from '../../src/server/api/admin/routes.js';

test('admin 路由不再暴露 /debug/run 端点', async () => {
    const handlers = createAdminRouter({
        config: { backend: { pool: { instances: [], workers: [] } }, queue: { queueBuffer: 2, workerMaxPending: 10, workerWaitTimeout: 300000 }, server: {} },
        queueManager: {
            getStatus: () => ({ processing: 0, queueLength: 0, total: 0 }),
            getDetailedStatus: () => ({ processing: [], waiting: [] }),
            canAcceptNonStreaming: () => true,
            initializePool: async () => ({}),
            getPoolContext: () => null
        },
        tempDir: '/tmp',
        getSafeMode: () => ({ enabled: false, reason: null })
    });

    const res = await callHandler(handlers, '/debug/run', 'POST', { script: 'return 1;' });
    assert.equal(res.statusCode, 404);
    assert.match(String(res.body || ''), /Not Found/);
});

test('admin 路由不再暴露 /debug/artifacts 端点', async () => {
    const handlers = createAdminRouter({
        config: { backend: { pool: { instances: [], workers: [] } }, queue: { queueBuffer: 2, workerMaxPending: 10, workerWaitTimeout: 300000 }, server: {} },
        queueManager: {
            getStatus: () => ({ processing: 0, queueLength: 0, total: 0 }),
            getDetailedStatus: () => ({ processing: [], waiting: [] }),
            canAcceptNonStreaming: () => true,
            initializePool: async () => ({}),
            getPoolContext: () => null
        },
        tempDir: '/tmp',
        getSafeMode: () => ({ enabled: false, reason: null })
    });

    const res = await callHandler(handlers, '/debug/artifacts/abc/anything.png', 'GET');
    assert.equal(res.statusCode, 404);
});
