import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMultipartForm } from '../../src/server/api/openai/multipart.js';

test('parses multipart fields and files', () => {
    const boundary = '----test-boundary';
    const body = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
        `draw cat\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="cat.png"\r\n` +
        `Content-Type: image/png\r\n\r\n` +
        `PNGDATA\r\n` +
        `--${boundary}--\r\n`
    );

    const result = parseMultipartForm(body, boundary);
    assert.equal(result.fields.prompt, 'draw cat');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, 'image');
    assert.equal(result.files[0].fileName, 'cat.png');
    assert.equal(result.files[0].buffer.toString('utf8'), 'PNGDATA');
});
