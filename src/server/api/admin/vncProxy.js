/**
 * @fileoverview VNC WebSocket 代理模块
 * @description 将 VNC TCP 连接转发到 WebSocket
 */

import net from 'net';
import { getVncInfo } from '../../../utils/ipc.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_PROTOCOL_ERROR = 1002;
const WS_CLOSE_INTERNAL_ERROR = 1011;

function negotiateSubprotocol(req) {
    const requested = String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

    if (requested.includes('binary')) {
        return 'binary';
    }

    return null;
}

function writeCloseFrame(socket, code = WS_CLOSE_NORMAL, reason = '') {
    if (socket.destroyed || socket.writableEnded) return;

    const reasonBuffer = Buffer.from(String(reason || ''), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    socket.write(encodeWebSocketFrame(payload, 0x08));
}

/**
 * 处理 VNC WebSocket 升级请求
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @param {import('net').Socket} socket - 原始 TCP socket
 * @param {Buffer} head - 升级请求的头部数据
 */
export async function handleVncUpgrade(req, socket, head) {
    const protocol = negotiateSubprotocol(req);
    if (req.headers['sec-websocket-protocol'] && !protocol) {
        socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n');
        socket.destroy();
        return;
    }

    // 获取 VNC 信息
    const vncInfo = await getVncInfo();
    if (!vncInfo || !vncInfo.enabled) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
    }

    // 手动完成 WebSocket 握手
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    const crypto = await import('crypto');
    const acceptKey = crypto.createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

    // 发送 WebSocket 握手响应
    const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`
    ];
    if (protocol) {
        headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);

    // 连接到 VNC 服务器
    const vncSocket = net.createConnection({
        host: '127.0.0.1',
        port: vncInfo.port
    });
    let websocketClosed = false;

    vncSocket.on('error', (err) => {
        console.error('[VNC Proxy] VNC 连接错误:', err.message);
        writeCloseFrame(socket, WS_CLOSE_INTERNAL_ERROR, 'VNC backend error');
        socket.destroy();
    });

    vncSocket.on('connect', () => {
        // 发送升级请求时可能附带的数据
        if (head && head.length > 0) {
            const data = decodeWebSocketFrame(head);
            if (data) vncSocket.write(data);
        }
    });

    // VNC -> WebSocket
    vncSocket.on('data', (data) => {
        try {
            const frame = encodeWebSocketFrame(data);
            socket.write(frame);
        } catch {
            socket.destroy();
        }
    });

    // WebSocket -> VNC
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= 2) {
            const result = decodeWebSocketFrame(buffer);
            if (!result) break;

            const { data, bytesConsumed, opcode } = result;
            buffer = buffer.slice(bytesConsumed);

            // 关闭帧
            if (opcode === 0x08) {
                websocketClosed = true;
                writeCloseFrame(socket, WS_CLOSE_NORMAL);
                vncSocket.destroy();
                socket.end();
                return;
            }

            if (opcode === 0x09) {
                socket.write(encodeWebSocketFrame(data, 0x0A));
                continue;
            }

            if (opcode === 0x0A) {
                continue;
            }

            // 二进制数据或文本
            if (data && data.length > 0) {
                vncSocket.write(data);
            }
        }
    });

    socket.on('close', () => vncSocket.destroy());
    socket.on('error', () => vncSocket.destroy());
    vncSocket.on('close', () => {
        if (!websocketClosed) {
            writeCloseFrame(socket, WS_CLOSE_NORMAL);
        }
        socket.end();
    });
}

/**
 * 编码 WebSocket 帧（服务端发送，无掩码）
 * @param {Buffer} data - 要发送的数据
 * @returns {Buffer} WebSocket 帧
 */
function encodeWebSocketFrame(data, opcode = 0x02) {
    const length = data.length;
    let header;

    if (length <= 125) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | (opcode & 0x0F);
        header[1] = length;
    } else if (length <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | (opcode & 0x0F);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | (opcode & 0x0F);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }

    return Buffer.concat([header, data]);
}

/**
 * 解码 WebSocket 帧（客户端发送，有掩码）
 * @param {Buffer} buffer - 接收到的数据
 * @returns {{data: Buffer, bytesConsumed: number, opcode: number} | null}
 */
function decodeWebSocketFrame(buffer) {
    if (buffer.length < 2) return null;

    const firstByte = buffer[0];
    const secondByte = buffer[1];
    const opcode = firstByte & 0x0F;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    if (payloadLength === 126) {
        if (buffer.length < 4) return null;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
    } else if (payloadLength === 127) {
        if (buffer.length < 10) return null;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }

    let maskKey = null;
    if (masked) {
        if (buffer.length < offset + 4) return null;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
    }

    if (buffer.length < offset + payloadLength) return null;

    let data = buffer.slice(offset, offset + payloadLength);

    if (masked && maskKey) {
        data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) {
            data[i] ^= maskKey[i % 4];
        }
    }

    return {
        data,
        bytesConsumed: offset + payloadLength,
        opcode
    };
}
