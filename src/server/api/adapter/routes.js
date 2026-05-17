/**
 * @fileoverview 动态适配器 API 路由
 * @description 固定暴露 POST /api/{adapter_id}，按适配器 schema 校验输入输出。
 */

import crypto from 'crypto';
import { registry } from '../../../backend/registry.js';
import { validateJsonSchema } from '../../../utils/jsonSchema.js';
import { logger } from '../../../utils/logger.js';
import { ERROR_CODES } from '../../errors.js';
import { sendApiError } from '../../respond.js';

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

function summarizeRequestBody(body) {
    if (!body || typeof body !== 'object') return '';
    if (typeof body.prompt === 'string' && body.prompt.trim()) {
        return body.prompt.trim();
    }
    return JSON.stringify(body, (key, value) => {
        if (typeof value === 'string' && value.length > 160) {
            return `${value.slice(0, 160)}...`;
        }
        return value;
    });
}

function summarizeResponseBody(body) {
    if (body === null || body === undefined) return '';
    if (typeof body === 'string') return body;
    return JSON.stringify(body, (key, value) => {
        if (typeof value === 'string' && value.length > 200) {
            return `${value.slice(0, 200)}...`;
        }
        return value;
    });
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

            const body = await readJsonBody(req);
            const validationErrors = validateJsonSchema(adapter.inputJsonSchema, body, '$');
            if (validationErrors.length > 0) {
                sendApiError(res, {
                    code: ERROR_CODES.INVALID_REQUEST_BODY,
                    message: `输入校验失败: ${validationErrors.join('; ')}`,
                    status: 400
                });
                return;
            }

            queueManager.addTask({
                req,
                res,
                id: requestId,
                adapterId,
                adapter,
                input: body,
                endpointPath: `/api/${adapterId}`,
                requestSummary: summarizeRequestBody(body),
                requestBody: body,
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

export { summarizeRequestBody, summarizeResponseBody };
