/**
 * @fileoverview OpenAI 兼容 API 路由
 * @description 处理 /v1 路径下的模型、Cookies、Chat Completions 与 Images 协议。
 */

import crypto from 'crypto';
import { logger } from '../../../utils/logger.js';
import { ERROR_CODES } from '../../errors.js';
import { sendJson, sendApiError } from '../../respond.js';
import { parseProviderRequest } from './request.js';

function buildRequestId() {
    return crypto.randomUUID().slice(0, 8);
}

export function createOpenAIRouter(context) {
    const {
        getModels,
        getDefaultModel,
        hasModel,
        tempDir,
        queueManager
    } = context;

    function handleModels(res) {
        sendJson(res, 200, getModels());
    }

    async function handleCookies(res, requestId, workerName, domain) {
        const poolContext = queueManager.getPoolContext();
        if (!poolContext?.poolManager) {
            sendApiError(res, { code: ERROR_CODES.BROWSER_NOT_INITIALIZED });
            return;
        }

        try {
            const result = await queueManager.getWorkerCookies(workerName, domain);
            sendJson(res, 200, {
                worker: result.worker,
                cookies: result.cookies
            });
        } catch (err) {
            logger.error('服务器', '获取 Cookies 失败', { id: requestId, error: err.message });
            sendApiError(res, {
                code: ERROR_CODES.INTERNAL_ERROR,
                message: err.message
            });
        }
    }

    async function handleTaskRequest(req, res, requestId, providerType) {
        try {
            const parseResult = await parseProviderRequest(req, {
                providerType,
                tempDir,
                requestId,
                resolveDefaultModel: getDefaultModel
            });

            if (parseResult.payload?.model && !hasModel(providerType, parseResult.modelId)) {
                sendApiError(res, {
                    code: ERROR_CODES.INVALID_MODEL,
                    message: `模型无效或当前无可用适配器: ${parseResult.modelId}`
                });
                return;
            }

            if (providerType !== 'openai-chat-completions' && parseResult.payload?.stream === true) {
                sendApiError(res, {
                    code: ERROR_CODES.INVALID_REQUEST_BODY,
                    message: `${providerType} 不支持 stream=true`
                });
                return;
            }

            const isStreaming = providerType === 'openai-chat-completions' && parseResult.payload?.stream === true;
            if (!isStreaming && !queueManager.canAcceptNonStreaming()) {
                const status = queueManager.getStatus();
                sendApiError(res, {
                    code: ERROR_CODES.SERVER_BUSY,
                    message: `服务器繁忙（队列: ${status.total}/${queueManager.maxQueueSize}）。请稍后重试。`
                });
                return;
            }

            if (isStreaming) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
            }

            queueManager.addTask({
                req,
                res,
                id: requestId,
                providerType,
                provider: parseResult.provider,
                payload: parseResult.payload,
                input: parseResult.input,
                modelId: parseResult.modelId,
                modelName: parseResult.modelId,
                promptText: parseResult.promptText,
                inputFiles: parseResult.inputFiles,
                cleanupPaths: parseResult.cleanupPaths,
                isStreaming
            });
        } catch (err) {
            logger.error('服务器', '请求解析失败', { id: requestId, error: err.message });
            sendApiError(res, {
                code: ERROR_CODES.INVALID_REQUEST_BODY,
                message: err.message
            });
        }
    }

    return async function handleOpenAIRequest(req, res, pathname, parsedUrl) {
        const requestId = buildRequestId();

        if (req.method === 'GET' && pathname === '/models') {
            handleModels(res);
            return;
        }

        if (req.method === 'GET' && pathname === '/cookies') {
            const workerName = parsedUrl.searchParams.get('name');
            const domain = parsedUrl.searchParams.get('domain');
            await handleCookies(res, requestId, workerName, domain);
            return;
        }

        if (req.method === 'POST' && pathname === '/chat/completions') {
            await handleTaskRequest(req, res, requestId, 'openai-chat-completions');
            return;
        }

        if (req.method === 'POST' && pathname === '/images/generations') {
            await handleTaskRequest(req, res, requestId, 'openai-images-generations');
            return;
        }

        if (req.method === 'POST' && pathname === '/images/edits') {
            await handleTaskRequest(req, res, requestId, 'openai-images-edits');
            return;
        }

        res.writeHead(404);
        res.end();
    };
}
