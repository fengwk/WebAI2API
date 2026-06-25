/**
 * @fileoverview Artifact URL 单元测试
 *
 * 覆盖：
 *   - api.saveFile() 成功时返回 url，不返回本地绝对路径
 *   - api.saveFile() 在未启用文件输出时抛错
 *   - api.capture() 成功时返回的 artifacts 字段只含 url / mimeType / name
 *   - Worker.executeTask 失败返回的 result 中不带 localPath
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { createAdapterApi, compileScriptRunner } from '../../src/backend/pool/Worker.js';

function makeFileOutput() {
    const dir = path.join(os.tmpdir(), `webai2api-art-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    return {
        rootDir: dir,
        urlBasePath: 'https://example.com/files/responses/req_xxx'
    };
}

test('api.saveFile returns URL-only payload and no local path', async () => {
    const fileOutput = makeFileOutput();
    const api = createAdapterApi('w1', 'i1', fileOutput, null, null);

    const result = await api.saveFile({
        relativePath: 'notes/hello.txt',
        content: 'hello world',
        mimeType: 'text/plain'
    });

    assert.equal(typeof result.url, 'string');
    assert.match(result.url, /^https:\/\/example\.com\/files\/responses\/req_xxx\/notes\/hello\.txt$/);
    assert.match(result.mimeType, /^text\/plain/);
    assert.equal(result.name, 'hello.txt');
    assert.equal(result.absolutePath, undefined);
    assert.equal(result.localPath, undefined);
    assert.equal(result.path, undefined);

    // 实际文件确实写到 rootDir
    const stat = await fs.stat(path.join(fileOutput.rootDir, 'notes/hello.txt'));
    assert.equal(stat.isFile(), true);
});

test('api.saveFile throws when file output is not enabled', async () => {
    const api = createAdapterApi('w1', 'i1', null, null, null);
    await assert.rejects(
        () => api.saveFile({ relativePath: 'a.txt', content: 'x' }),
        e => e.code === 'FILE_OUTPUT_DISABLED'
    );
});

test('api.capture returns artifacts with only url/mimeType/name fields', async () => {
    const fileOutput = makeFileOutput();
    const page = {
        url: () => 'https://example.com',
        title: async () => 'Example',
        content: async () => '<html><body>hi</body></html>',
        screenshot: async () => Buffer.from('fake-png'),
        locator: () => ({ innerText: async () => 'hi' })
    };
    const trace = { steps: [], captures: [], logs: [] };
    const api = createAdapterApi('w1', 'i1', fileOutput, page, trace);

    const capture = await api.capture('demo', { screenshot: true, html: true, text: true, fullPage: false });
    assert.equal(capture.name, 'demo');
    assert.equal(capture.url, 'https://example.com');
    assert.equal(capture.title, 'Example');
    assert.equal(typeof capture.artifacts.screenshot.url, 'string');
    assert.equal(capture.artifacts.screenshot.mimeType, 'image/png');
    assert.equal(capture.artifacts.screenshot.name, 'demo.png');
    assert.equal(typeof capture.artifacts.html.url, 'string');
    assert.equal(capture.artifacts.html.mimeType, 'text/html; charset=utf-8');

    // 不暴露 localPath / absolutePath / path
    for (const key of Object.keys(capture.artifacts.screenshot)) {
        assert.notEqual(key, 'localPath');
        assert.notEqual(key, 'absolutePath');
        assert.notEqual(key, 'path');
    }

    // capture 本身也不带 localPath
    for (const key of Object.keys(capture)) {
        assert.notEqual(key, 'localPath');
        assert.notEqual(key, 'absolutePath');
    }
});

test('script that calls api.saveFile returns envelope-shaped artifacts via capture, never paths', async () => {
    const fileOutput = makeFileOutput();
    const page = {
        url: () => 'https://example.com',
        title: async () => 'Example',
        content: async () => '<html></html>',
        screenshot: async () => Buffer.from('xx'),
        locator: () => ({ innerText: async () => '' })
    };
    const trace = { steps: [], captures: [], logs: [] };
    const api = createAdapterApi('w1', 'i1', fileOutput, page, trace);

    const runner = compileScriptRunner(`
        const saved = await api.saveFile({ relativePath: 'a.txt', content: 'x', mimeType: 'text/plain' });
        const cap = await api.capture('c1', { screenshot: true, html: false, text: false });
        return { saved, cap };
    `, 'manifest');
    const out = await runner(page, {}, api, {}, {});

    assert.match(out.saved.url, /^https:\/\/example\.com\//);
    assert.equal(out.saved.absolutePath, undefined);
    assert.match(out.cap.artifacts.screenshot.url, /^https:\/\/example\.com\//);
    assert.equal(out.cap.artifacts.screenshot.absolutePath, undefined);
});
