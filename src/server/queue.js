/**
 * @fileoverview 任务队列管理模块
 * @description 负责请求队列、并发控制、调度到 Pool，并将执行结果按新协议 envelope 写出。
 *
 * 入队任务结构（来自 /api/{adapterId} 路由）：
 *   {
 *     res, id, adapterId, adapter,
 *     input, debug, workerId, overrideScript,
 *     endpointPath, requestSummary, requestBody
 *   }
 *
 * 出队 envelope：
 *   - 成功: { ok: true,  data,    meta, trace? }
 *   - 失败: { ok: false, message, meta, trace? }
 */

import path from 'path';
import { logger } from '../utils/logger.js';
import { sendApiError, sendJson } from './respond.js';
import { ERROR_CODES } from './errors.js';
import { incrementSuccess, incrementFailed } from '../utils/stats.js';
import { createRecord, updateRecord } from '../utils/history.js';
import { summarizeResponseBody } from './api/adapter/routes.js';

export function createQueueManager(queueConfig, callbacks) {
    const {
        maxConcurrent,
        queueBuffer,
        workerMaxPending = 10,
        workerWaitTimeout = 300000
    } = queueConfig;
    const { initBrowser, executeTask, resetPool, config } = callbacks;
    const effectiveQueueSize = queueBuffer === 0 ? Infinity : (maxConcurrent + queueBuffer);
    const taskExecutionTimeout = config.queue?.taskExecutionTimeout ?? 420000;

    const queue = [];
    const processingTasks = [];
    let processingCount = 0;
    let poolContext = null;

    function buildPublicBaseUrl() {
        const configured = String(config.server?.publicFileBaseUrl || '').trim();
        return configured ? configured.replace(/\/$/, '') : '';
    }

    function buildEnvelope({ ok, data, message, meta, trace }) {
        const payload = { ok, meta };
        if (ok) {
            payload.data = data ?? null;
        } else {
            payload.message = message || '执行失败';
        }
        if (trace !== undefined && trace !== null) {
            payload.trace = trace;
        }
        return payload;
    }

    function buildMeta(task, { workerId, instanceId, queuedMs, durationMs, page }) {
        return {
            requestId: task.id,
            adapterId: task.adapterId,
            workerId: workerId || null,
            instanceId: instanceId || null,
            queuedMs: Math.max(0, queuedMs || 0),
            durationMs: Math.max(0, durationMs || 0),
            page: page || { url: '', title: '' }
        };
    }

    function buildGenericPage() {
        return { url: '', title: '' };
    }

    function abortTask(task, reasonMessage, status = 'failed') {
        if (!task || task._aborted) return;
        task._aborted = true;
        const durationMs = task.enqueuedAt ? (Date.now() - task.enqueuedAt) : 0;
        try {
            updateRecord(task.id, {
                status,
                errorMessage: reasonMessage,
                durationMs
            });
        } catch (e) {
            logger.debug('服务器', `更新历史记录失败: ${e.message}`);
        }

        if (!task.res.writableEnded) {
            const meta = buildMeta(task, {
                workerId: task.workerId || null,
                instanceId: null,
                queuedMs: durationMs,
                durationMs,
                page: buildGenericPage()
            });
            if (task.res.writeHead) task.res.writeHead(502, { 'Content-Type': 'application/json' });
            task.res.end(JSON.stringify(buildEnvelope({
                ok: false,
                message: reasonMessage,
                meta,
                trace: null
            })));
        }
    }

    async function processTask(task) {
        const { res, id: requestId, debug, workerId, overrideScript } = task;
        const startTime = Date.now();
        const queuedMs = startTime - (task.enqueuedAt || startTime);

        logger.info('服务器', '[队列] 开始处理任务', {
            id: requestId,
            adapterId: task.adapterId,
            workerId: workerId || null,
            debug: !!debug,
            override: !!overrideScript,
            remaining: queue.length
        });

        try {
            createRecord({
                id: requestId,
                adapterId: task.adapterId,
                endpointPath: task.endpointPath,
                requestSummary: task.requestSummary,
                requestBody: task.requestBody,
                status: 'pending'
            });
        } catch (e) {
            logger.debug('服务器', `创建历史记录失败: ${e.message}`);
        }

        const publicBaseUrl = buildPublicBaseUrl();
        const publicResponsePath = `/files/responses/${encodeURIComponent(requestId)}`;
        const fileOutput = {
            rootDir: path.join(process.cwd(), 'data', 'files', 'responses', requestId),
            urlBasePath: publicBaseUrl ? `${publicBaseUrl}${publicResponsePath}` : publicResponsePath
        };

        let result;
        try {
            if (!poolContext) {
                poolContext = await initBrowser(config);
            }
            let timeoutHandle = null;
            try {
                result = await Promise.race([
                    executeTask(poolContext, {
                        adapterId: task.adapterId,
                        input: task.input,
                        fileOutput,
                        debug: !!debug,
                        workerId: workerId || null,
                        overrideScript: overrideScript || null,
                        requestId
                    }, { id: requestId }),
                    new Promise((_, reject) => {
                        timeoutHandle = setTimeout(() => {
                            const err = new Error(`任务执行超时 (${taskExecutionTimeout}ms)`);
                            err.code = 'TASK_EXECUTION_TIMEOUT';
                            reject(err);
                        }, taskExecutionTimeout);
                    })
                ]);
            } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle);
            }
        } catch (err) {
            if (err.code === 'TASK_EXECUTION_TIMEOUT') {
                logger.warn('服务器', '[队列] 任务执行超时，准备重置工作池', { id: requestId, adapterId: task.adapterId });
                if (resetPool) {
                    try {
                        await resetPool(`task-timeout:${requestId}`);
                    } catch (resetErr) {
                        logger.error('服务器', '重置工作池失败', { error: resetErr.message, id: requestId });
                    }
                    poolContext = null;
                }
            }
            result = {
                success: false,
                error: { message: err.message || '执行异常', retryable: true }
            };
        }

        if (task._aborted) {
            return;
        }

        const durationMs = Date.now() - startTime;
        const meta = buildMeta(task, {
            workerId: result.workerId,
            instanceId: result.instanceId,
            queuedMs,
            durationMs,
            page: result.page
        });

        // debug 时附带 trace；否则丢弃避免响应体过大
        const trace = debug ? (result.trace || null) : null;

        if (!result.success) {
            await incrementFailed();
            try {
                updateRecord(requestId, {
                    status: 'failed',
                    errorMessage: result.error?.message || '执行失败',
                    durationMs
                });
            } catch (e) {
                logger.debug('服务器', `更新历史记录失败: ${e.message}`);
            }

            if (res.writableEnded) return;

            // 失败也按新协议 envelope 返回：{ ok:false, message, meta, trace? }
            const errCode = result.error?.code;
            const errMessage = result.error?.message || '执行失败';
            let httpStatus = 502;
            if (errCode === 'WORKER_BUSY') httpStatus = 429;
            else if (errCode === 'WORKER_TIMEOUT') httpStatus = 504;
            else if (result.error?.retryable === false) httpStatus = 400;

            if (res.writeHead) res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(buildEnvelope({
                ok: false,
                message: errMessage,
                meta,
                trace
            })));
            return;
        }

        // 成功：直接写出新 envelope
        await incrementSuccess();
        try {
            updateRecord(requestId, {
                status: 'success',
                responseSummary: summarizeResponseBody(result.data),
                responseBody: result.data,
                durationMs
            });
        } catch (e) {
            logger.debug('服务器', `更新历史记录失败: ${e.message}`);
        }

        logger.info('服务器', '结果已准备就绪', { id: requestId, adapterId: task.adapterId, durationMs });
        if (res.writableEnded) return;

        const envelope = buildEnvelope({
            ok: true,
            data: result.data ?? null,
            meta,
            trace
        });
        sendJson(res, 200, envelope);
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
        }

        if (queue.length > 0 && processingCount < maxConcurrent) {
            setImmediate(processQueue);
        }
    }

    function addTask(task) {
        if (!task || typeof task !== 'object') {
            throw new Error('addTask: 无效的 task');
        }
        if (!task.res) {
            throw new Error('addTask: 缺少 res');
        }
        task.enqueuedAt = Date.now();
        queue.push(task);
        processQueue();
    }

    function getStatus() {
        return {
            processing: processingCount,
            queueLength: queue.length,
            total: processingCount + queue.length
        };
    }

    function getDetailedStatus() {
        return {
            processing: processingTasks.map(task => ({
                id: task.id,
                adapterId: task.adapterId,
                endpointPath: task.endpointPath,
                workerId: task.workerId || null,
                debug: !!task.debug,
                override: !!task.overrideScript
            })),
            waiting: queue.map(task => ({
                id: task.id,
                adapterId: task.adapterId,
                endpointPath: task.endpointPath,
                workerId: task.workerId || null
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

    async function resetPoolContext(reason = 'manual-reset') {
        if (resetPool) {
            await resetPool(reason);
        }
        poolContext = null;
    }

    async function recoverFromFatalRuntime(reasonMessage) {
        const processingSnapshot = processingTasks.slice();
        const queuedSnapshot = queue.splice(0, queue.length);

        for (const task of queuedSnapshot) {
            abortTask(task, reasonMessage);
        }
        for (const task of processingSnapshot) {
            abortTask(task, reasonMessage);
        }

        await resetPoolContext(reasonMessage);
    }

    return {
        addTask,
        getStatus,
        getDetailedStatus,
        canAcceptNonStreaming,
        initializePool,
        getPoolContext,
        resetPoolContext,
        recoverFromFatalRuntime,
        maxQueueSize: effectiveQueueSize,
        workerMaxPending,
        workerWaitTimeout,
        taskExecutionTimeout
    };
}
