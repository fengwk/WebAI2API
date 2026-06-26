/**
 * @fileoverview 脚本执行器单元测试
 *
 * 覆盖：
 *   - 默认脚本执行成功
 *   - overrideScript 覆盖成功
 *   - 注入对象 page/input/api/helpers/runtime 都可用
 *   - 脚本抛错时返回失败 result
 *   - 脚本编译错误时返回 SCRIPT_COMPILE_ERROR
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';

import { compileScriptRunner, createSafeScriptObject } from '../../src/backend/pool/Worker.js';

function fakePage({ url = 'https://example.com', title = 'Example' } = {}) {
    return {
        url: () => url,
        title: async () => title,
        screenshot: async () => Buffer.from('png'),
        content: async () => '<html></html>',
        locator: () => ({ innerText: async () => 'hello' })
    };
}

test('compileScriptRunner executes default script and returns data', async () => {
    const runner = compileScriptRunner("return { value: input.x * 2 };", 'manifest');
    const result = await runner(fakePage(), { x: 21 }, {}, {}, {});
    assert.deepEqual(result, { value: 42 });
});

test('compileScriptRunner respects overrideScript source label in compile errors', () => {
    assert.throws(
        () => compileScriptRunner('return (', 'overrideScript'),
        e => e.code === 'SCRIPT_COMPILE_ERROR' && /overrideScript/.test(e.message)
    );
});

test('compileScriptRunner rejects empty script', () => {
    assert.throws(
        () => compileScriptRunner('   ', 'manifest'),
        e => e.code === 'SCRIPT_EMPTY'
    );
});

test('injected objects are all reachable in the script', async () => {
    const runner = compileScriptRunner(`
        const out = {
            hasPage: typeof page === 'object',
            hasInput: typeof input === 'object',
            hasApi: typeof api === 'object',
            hasHelpers: typeof helpers === 'object',
            hasRuntime: typeof runtime === 'object',
            runtimeWorker: runtime.workerName
        };
        return out;
    `, 'manifest');
    const result = await runner(
        fakePage(),
        { a: 1 },
        { log: () => {} },
        { files: { resolve: async () => ({}) } },
        { workerName: 'w1', meta: {} }
    );
    assert.equal(result.hasPage, true);
    assert.equal(result.hasInput, true);
    assert.equal(result.hasApi, true);
    assert.equal(result.hasHelpers, true);
    assert.equal(result.hasRuntime, true);
    assert.equal(result.runtimeWorker, 'w1');
});

test('script can call api.log and api.step', async () => {
    const logs = [];
    const steps = [];
    const api = {
        log: (level, message) => logs.push({ level, message }),
        step: (name) => steps.push(name)
    };
    const runner = compileScriptRunner(`
        api.log('info', 'hello');
        await api.step('open');
        return { ok: true };
    `, 'manifest');
    const result = await runner(fakePage(), {}, api, {}, {});
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(logs, [{ level: 'info', message: 'hello' }]);
    assert.deepEqual(steps, ['open']);
});

test('createSafeScriptObject catches event-listener exceptions', async () => {
    const emitter = new EventEmitter();
    const captured = [];
    const safeEmitter = createSafeScriptObject(emitter, {
        label: 'emitter',
        onAsyncError: (error, context) => captured.push({ message: error.message, context })
    });

    safeEmitter.on('tick', () => {
        throw new Error('boom');
    });

    emitter.emit('tick');

    assert.equal(captured.length, 1);
    assert.equal(captured[0].message, 'boom');
    assert.deepEqual(captured[0].context, {
        label: 'emitter',
        method: 'on',
        eventName: 'tick'
    });
});
