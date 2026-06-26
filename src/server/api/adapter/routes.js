/**
 * @fileoverview 动态适配器 API 路由（新协议）
 * @description
 *   POST /api/{adapterId}
 *
 *   请求体（全部可选，input 透传给脚本）：
 *     {
 *       "input":           { ... },   // 业务输入
 *       "debug":           false,     // 是否返回 trace
 *       "workerId":        "xxx",     // 指定 worker（必须 type === adapterId）
 *       "overrideScript":  "..."      // 本次执行时覆盖 manifest.script
 *     }
 *
 *   返回 envelope：
 *     {
 *       "ok": true,
 *       "data":  ...,
 *       "meta":  { requestId, adapterId, workerId, instanceId, queuedMs, durationMs, page: { url, title } },
 *       "trace": { steps, captures, logs }   // 仅 debug=true 时返回
 *     }
 *
 *   失败：
 *     {
 *       "ok": false,
 *       "message": "...",
 *       "meta":   { ... },
 *       "trace":  { ... }   // 仅 debug=true 时返回
 *     }
 */

import crypto from 'crypto';
import { registry } from '../../../backend/registry.js';
import { logger } from '../../../utils/logger.js';
import { ERROR_CODES } from '../../errors.js';
import { sendApiError, sendJson } from '../../respond.js';

function buildRequestId() {
    return crypto.randomUUID().slice(0, 8);
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return body ? JSON.parse(body) : {};
}

function summarizeRequestBody(input) {
    if (!input || typeof input !== 'object') return '';
    if (typeof input.prompt === 'string' && input.prompt.trim()) {
        return input.prompt.trim();
    }
    return JSON.stringify(input, (key, value) => {
        if (typeof value === 'string' && value.length > 160) {
            return `${value.slice(0, 160)}...`;
        }
        return value;
    });
}

function summarizeResponseBody(data) {
    if (data === null || data === undefined) return '';
    if (typeof data === 'string') return data;
    return JSON.stringify(data, (key, value) => {
        if (typeof value === 'string' && value.length > 200) {
            return `${value.slice(0, 200)}...`;
        }
        return value;
    });
}

function normalizeRequestBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { input: {}, debug: false, workerId: null, overrideScript: null };
    }

    const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input)
        ? body.input
        : {};

    const debug = body.debug === true;
    const workerId = typeof body.workerId === 'string' && body.workerId.trim()
        ? body.workerId.trim()
        : null;
    const overrideScript = typeof body.overrideScript === 'string' && body.overrideScript.trim()
        ? body.overrideScript
        : null;

    return { input, debug, workerId, overrideScript };
}

export function createAdapterRouter(context) {
    const { queueManager } = context;

    return async function handleAdapterRequest(req, res, pathname) {
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
        }

        const adapterId = decodeURIComponent(pathname.replace(/^\//, ''));
        await registry.loadAll();
        const adapter = registry.getAdapter(adapterId);
        if (!adapter) {
            sendApiError(res, {
                code: ERROR_CODES.NOT_FOUND,
                message: `适配器不存在: ${adapterId}`,
                status: 404
            });
            return;
        }

        if (!queueManager.canAcceptNonStreaming()) {
            const status = queueManager.getStatus();
            sendApiError(res, {
                code: ERROR_CODES.SERVER_BUSY,
                message: `服务器繁忙（队列: ${status.total}/${queueManager.maxQueueSize}）。请稍后重试。`
            });
            return;
        }

        const requestId = buildRequestId();

        try {
            const contentType = String(req.headers['content-type'] || '').toLowerCase();
            if (contentType && !contentType.startsWith('application/json')) {
                sendApiError(res, {
                    code: ERROR_CODES.INVALID_REQUEST_BODY,
                    message: '仅支持 application/json 请求体',
                    status: 400
                });
                return;
            }

            const rawBody = await readJsonBody(req);
            const { input, debug, workerId, overrideScript } = normalizeRequestBody(rawBody);
            // 入队：把新协议字段透传给 queue
            queueManager.addTask({
                res,
                id: requestId,
                adapterId,
                adapter,
                input,
                debug,
                workerId,
                overrideScript,
                endpointPath: `/api/${adapterId}`,
                requestSummary: summarizeRequestBody(input),
                requestBody: { input, debug, workerId, overrideScript: overrideScript ? '<override>' : null },
                isStreaming: false
            });
        } catch (err) {
            logger.error('服务器', '适配器请求解析失败', { id: requestId, error: err.message });
            sendApiError(res, {
                code: ERROR_CODES.INVALID_REQUEST_BODY,
                message: err.message,
                status: 400
            });
        }
    };
}

export { summarizeRequestBody, summarizeResponseBody, normalizeRequestBody };
