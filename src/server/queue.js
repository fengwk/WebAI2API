/**
 * @fileoverview 任务队列管理模块
 * @description 负责请求队列、并发控制和动态适配器任务执行。
 */

import path from 'path';
import { logger } from '../utils/logger.js';
import { sendJson, sendApiError } from './respond.js';
import { ERROR_CODES } from './errors.js';
import { incrementSuccess, incrementFailed } from '../utils/stats.js';
import { createRecord, updateRecord } from '../utils/history.js';
import { validateJsonSchema } from '../utils/jsonSchema.js';
import { summarizeResponseBody } from './api/adapter/routes.js';

export function createQueueManager(queueConfig, callbacks) {
    const { maxConcurrent, queueBuffer } = queueConfig;
    const { initBrowser, executeTask, config, getCookies } = callbacks;
    const effectiveQueueSize = queueBuffer === 0 ? Infinity : (maxConcurrent + queueBuffer);

    const queue = [];
    const processingTasks = [];
    let processingCount = 0;
    let poolContext = null;

    function buildPublicBaseUrl() {
        const configured = String(config.server?.publicFileBaseUrl || '').trim();
        return configured ? configured.replace(/\/$/, '') : '';
    }

    async function processTask(task) {
        const { res, adapterId, adapter, input, id, endpointPath, requestSummary, requestBody } = task;
        const startTime = Date.now();

        logger.info('服务器', '[队列] 开始处理任务', { id, remaining: queue.length });

        try {
            createRecord({
                id,
                adapterId,
                endpointPath,
                requestSummary,
                requestBody,
                status: 'pending'
            });
        } catch (e) {
            logger.debug('服务器', `创建历史记录失败: ${e.message}`);
        }

        try {
            if (!poolContext) {
                poolContext = await initBrowser(config);
            }

            const publicBaseUrl = buildPublicBaseUrl();
            const publicResponsePath = `/files/responses/${encodeURIComponent(id)}`;
            const fileOutput = {
                rootDir: path.join(process.cwd(), 'data', 'files', 'responses', id),
                urlBasePath: publicBaseUrl ? `${publicBaseUrl}${publicResponsePath}` : publicResponsePath
            };

            const result = await executeTask(poolContext, {
                adapterId,
                input,
                fileOutput
            }, { id });

            if (!result.success) {
                await incrementFailed();
                updateRecord(id, {
                    status: 'failed',
                    errorMessage: result.error?.message || '执行失败',
                    durationMs: Date.now() - startTime
                });
                sendApiError(res, {
                    code: ERROR_CODES.GENERATION_FAILED,
                    message: result.error?.message || '执行失败',
                    status: result.error?.retryable ? 503 : 400
                });
                return;
            }

            const outputErrors = validateJsonSchema(adapter.outputJsonSchema, result.data, '$');
            if (outputErrors.length > 0) {
                await incrementFailed();
                updateRecord(id, {
                    status: 'failed',
                    errorMessage: `输出校验失败: ${outputErrors.join('; ')}`,
                    durationMs: Date.now() - startTime
                });
                sendApiError(res, {
                    code: ERROR_CODES.INTERNAL_ERROR,
                    message: `输出校验失败: ${outputErrors.join('; ')}`,
                    status: 500
                });
                return;
            }

            await incrementSuccess();
            updateRecord(id, {
                status: 'success',
                responseSummary: summarizeResponseBody(result.data),
                responseBody: result.data,
                durationMs: Date.now() - startTime
            });

            logger.info('服务器', '结果已准备就绪', { id, adapterId });
            sendJson(res, 200, result.data);
        } catch (err) {
            await incrementFailed();
            updateRecord(id, {
                status: 'failed',
                errorMessage: err.message,
                durationMs: Date.now() - startTime
            });
            logger.error('服务器', '任务处理失败', { id, error: err.message });
            sendApiError(res, {
                code: ERROR_CODES.INTERNAL_ERROR,
                message: err.message
            });
        }
    }

    async function processQueue() {
        if (processingCount >= maxConcurrent || queue.length === 0) {
            return;
        }

        const task = queue.shift();
        processingCount++;
        processingTasks.push(task);

        try {
            await processTask(task);
        } finally {
            const idx = processingTasks.indexOf(task);
            if (idx !== -1) processingTasks.splice(idx, 1);
            processingCount--;
            processQueue();
        }
    }

    function addTask(task) {
        queue.push(task);
        processQueue();
    }

    function getStatus() {
        return {
            queueLength: queue.length,
            processing: processingCount,
            total: processingCount + queue.length
        };
    }

    function getDetailedStatus() {
        return {
            processing: processingTasks.map(task => ({
                id: task.id,
                adapterId: task.adapterId,
                endpointPath: task.endpointPath
            })),
            waiting: queue.map(task => ({
                id: task.id,
                adapterId: task.adapterId,
                endpointPath: task.endpointPath
            }))
        };
    }

    function canAcceptNonStreaming() {
        return processingCount + queue.length < effectiveQueueSize;
    }

    async function initializePool() {
        poolContext = await initBrowser(config);
        return poolContext;
    }

    function getPoolContext() {
        return poolContext;
    }

    async function getWorkerCookies(workerName, domain) {
        if (!getCookies) {
            throw new Error('getCookies 回调未注册');
        }
        return await getCookies(workerName, domain);
    }

    return {
        addTask,
        getStatus,
        getDetailedStatus,
        canAcceptNonStreaming,
        initializePool,
        getPoolContext,
        getWorkerCookies,
        maxQueueSize: effectiveQueueSize
    };
}
