import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

import { handleVncUpgrade } from '../../src/server/api/admin/vncProxy.js';

function createIpcServer(ipcPath, vncPort) {
    if (fs.existsSync(ipcPath)) {
        fs.unlinkSync(ipcPath);
    }

    return net.createServer((socket) => {
        socket.on('data', (data) => {
            if (data.toString().trim() === 'GET_VNC_INFO') {
                socket.write(JSON.stringify({ enabled: true, port: vncPort, display: ':50', xvfbMode: true }) + '\n');
                socket.end();
            }
        });
    });
}

test('VNC proxy accepts auth-disabled websocket connection', async () => {
    const ipcPath = path.join(os.tmpdir(), `webai2api-vnc-test-${process.pid}.sock`);
    process.env.SUPERVISOR_IPC = ipcPath;

    const vncServer = net.createServer((socket) => {
        socket.write(Buffer.from([0x52, 0x46, 0x42, 0x20]));
    });
    await new Promise(resolve => vncServer.listen(0, '127.0.0.1', resolve));
    const vncPort = vncServer.address().port;

    const ipcServer = createIpcServer(ipcPath, vncPort);
    await new Promise(resolve => ipcServer.listen(ipcPath, resolve));

    const server = http.createServer((req, res) => {
        res.writeHead(404);
        res.end();
    });
    server.on('upgrade', async (req, socket, head) => {
        await handleVncUpgrade(req, socket, head, '');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const result = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/admin/vnc`, ['binary']);
        ws.binaryType = 'arraybuffer';

        ws.onmessage = (event) => {
            resolve({
                protocol: ws.protocol,
                data: Array.from(new Uint8Array(event.data))
            });
            ws.close(1000, 'done');
        };
    });

    assert.equal(result.protocol, 'binary');
    assert.deepEqual(result.data, [0x52, 0x46, 0x42, 0x20]);

    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => ipcServer.close(resolve));
    await new Promise(resolve => vncServer.close(resolve));
    if (fs.existsSync(ipcPath)) {
        fs.unlinkSync(ipcPath);
    }
    delete process.env.SUPERVISOR_IPC;
});
