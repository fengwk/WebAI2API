/**
 * @fileoverview 任务队列管理模块
 * @description 负责请求队列、并发控制和心跳机制，适配 Pool 模式架构
 */

import { logger } from '../utils/logger.js';
import path from 'path';
import {
    sendJson,
    sendSse,
    sendSseDone,
    sendHeartbeat,
    sendApiError,
    buildChatCompletionChunk
} from './respond.js';
import { ERROR_CODES } from './errors.js';
import { incrementSuccess, incrementFailed } from '../utils/stats.js';
import { createRecord, updateRecord, processResponseMedia } from '../utils/history.js';

/**
 * @typedef {object} TaskContext
 * @property {import('http').IncomingMessage} req - HTTP 请求对象
 * @property {import('http').ServerResponse} res - HTTP 响应对象
 * @property {string} providerType - Provider 类型
 * @property {object} provider - Provider 定义
 * @property {object} input - 归一化输入
 * @property {string|null} modelId - 模型 ID
 * @property {string|null} modelName - 模型名称
 * @property {string} id - 请求唯一标识
 * @property {boolean} isStreaming - 是否流式请求
 */

/**
 * @typedef {object} QueueConfig
 * @property {number} maxConcurrent - 最大并发数
 * @property {number} maxQueueSize - 最大队列大小
 * @property {string} keepaliveMode - 心跳模式 ('comment' | 'content')
 */

/**
 * @typedef {object} PoolContext
 * @property {import('../backend/pool.js').PoolManager} poolManager - Pool 管理器
 * @property {object} config - 配置对象
 */

/**
 * 创建任务队列管理器
 * @param {QueueConfig} queueConfig - 队列配置
 * @param {object} callbacks - 回调函数
 * @param {Function} callbacks.initBrowser - 初始化 Pool 函数
 * @param {Function} callbacks.generate - 生成图片函数
 * @param {object} callbacks.config - 配置对象
 * @param {Function} [callbacks.navigateToMonitor] - 监控导航函数
 * @param {Function} [callbacks.getCookies] - 获取 Cookies 函数
 * @returns {object} 队列管理器
 */
export function createQueueManager(queueConfig, callbacks) {
    const { maxConcurrent, queueBuffer, keepaliveMode } = queueConfig;
    const { initBrowser, executeTask, config, navigateToMonitor, getCookies } = callbacks;

    // 计算有效队列大小：0 表示不限制，否则为 maxConcurrent + buffer
    const effectiveQueueSize = queueBuffer === 0 ? Infinity : (maxConcurrent + queueBuffer);

    /** @type {TaskContext[]} */
    const queue = [];

    /** @type {TaskContext[]} */
    const processingTasks = [];  // 跟踪正在处理的任务

    /** @type {number} */
    let processingCount = 0;

    /** @type {PoolContext|null} */
    let poolContext = null;

    /**
     * 清理任务临时文件
     * @param {TaskContext} task - 任务上下文
     */
    async function cleanupTask(task) {
        if (task?.cleanupPaths?.length) {
            const fs = await import('fs/promises');
            for (const p of task.cleanupPaths) {
                try {
                    await fs.unlink(p);
                } catch (e) {
                    logger.debug('服务器', `临时文件清理失败: ${p}`);
                }
            }
        }
    }

    /**
     * 处理单个任务
     * @param {TaskContext} task - 任务上下文
     */
    async function processTask(task) {
        const { res, provider, providerType, input, modelId, modelName, id, isStreaming, promptText, inputFiles } = task;
        const startTime = Date.now();

        logger.info('服务器', '[队列] 开始处理任务', { id, remaining: queue.length });

        // 创建历史记录
        try {
            createRecord({
                id,
                providerType,
                modelId,
                modelName,
                prompt: promptText,
                inputImages: inputFiles,
                isStreaming,
                status: 'pending'
            });
        } catch (e) {
            logger.debug('服务器', `创建历史记录失败: ${e.message}`);
        }

        // 启动心跳（流式请求）
        let heartbeatInterval = null;
        if (isStreaming) {
            heartbeatInterval = setInterval(() => {
                if (res.writableEnded) {
                    clearInterval(heartbeatInterval);
                    return;
                }
                sendHeartbeat(res, keepaliveMode, modelName);
            }, 3000);
        }

        try {
            // 确保 Pool 已初始化
            if (!poolContext) {
                poolContext = await initBrowser(config);
            }

            const fileOutput = {
                rootDir: path.join(process.cwd(), 'data', 'files', 'responses', id),
                urlBasePath: `/files/responses/${encodeURIComponent(id)}`
            };

            const result = await executeTask(poolContext, {
                providerType,
                modelId,
                input,
                fileOutput
            }, { id });

            // 清除心跳
            if (heartbeatInterval) clearInterval(heartbeatInterval);

            // 处理结果
            if (!result.success) {
                // 生成失败：记录统计和历史
                await incrementFailed();
                try {
                    updateRecord(id, {
                        status: 'failed',
                        errorMessage: result.error?.message || '执行失败',
                        durationMs: Date.now() - startTime
                    });
                } catch (e) {
                    logger.debug('服务器', `更新历史记录失败: ${e.message}`);
                }
                sendApiError(res, {
                    code: ERROR_CODES.GENERATION_FAILED,
                    message: result.error?.message || '执行失败',
                    status: result.error?.retryable ? 503 : 502,
                    isStreaming
                });
                return;
            }

            const responseDescriptor = await provider.buildSuccessResponse({
                modelName,
                input,
                result: result.data,
                stream: isStreaming
            });

            const history = await provider.buildHistory({
                modelName,
                input,
                result: result.data
            });

            logger.info('服务器', '结果已准备就绪', { id });
            await incrementSuccess();

            // 更新历史记录（异步处理媒体，不阻塞响应）
            processResponseMedia(history.responseMediaSource, id).then(responseMedia => {
                try {
                    updateRecord(id, {
                        status: 'success',
                        responseText: history.responseText,
                        reasoningContent: history.reasoningContent,
                        responseMedia,
                        durationMs: Date.now() - startTime
                    });
                } catch (e) {
                    logger.debug('服务器', `更新历史记录失败: ${e.message}`);
                }
            }).catch(e => {
                logger.debug('服务器', `处理响应媒体失败: ${e.message}`);
            });

            // 发送成功响应
            if (responseDescriptor.responseType === 'chat') {
                logger.info('服务器', '准备发送聊天响应...', {
                    id,
                    isStreaming,
                    contentLength: responseDescriptor.content.length,
                    hasReasoning: !!responseDescriptor.reasoningContent
                });
                if (isStreaming) {
                    const chunk = buildChatCompletionChunk(
                        responseDescriptor.content,
                        modelName,
                        'stop',
                        responseDescriptor.reasoningContent
                    );
                    sendSse(res, chunk);
                    sendSseDone(res);
                } else {
                    sendJson(res, 200, responseDescriptor.body);
                }
            } else {
                logger.info('服务器', '准备发送 JSON 响应...', { id, providerType });
                sendJson(res, responseDescriptor.status || 200, responseDescriptor.body);
            }

        } catch (err) {
            // 清除心跳
            if (heartbeatInterval) clearInterval(heartbeatInterval);

            // 记录失败统计和历史
            await incrementFailed();
            try {
                updateRecord(id, {
                    status: 'failed',
                    errorMessage: err.message,
                    durationMs: Date.now() - startTime
                });
            } catch (e) {
                logger.debug('服务器', `更新历史记录失败: ${e.message}`);
            }
            logger.error('服务器', '任务处理失败', { id, error: err.message });
            sendApiError(res, {
                code: ERROR_CODES.INTERNAL_ERROR,
                message: err.message,
                isStreaming
            });
        }
    }

    /**
     * 处理队列中的任务
     */
    async function processQueue() {
        // 如果正在处理的任务已满，或队列为空，则停止
        if (processingCount >= maxConcurrent || queue.length === 0) {
            // 队列空闲时，触发监控跳转
            if (processingCount === 0 && queue.length === 0 && navigateToMonitor) {
                navigateToMonitor().catch(() => { });
            }
            return;
        }

        // 取出下一个任务
        const task = queue.shift();
        processingCount++;
        processingTasks.push(task);  // 添加到处理中列表

        try {
            await processTask(task);
        } finally {
            // 从处理中列表移除
            const idx = processingTasks.indexOf(task);
            if (idx !== -1) processingTasks.splice(idx, 1);
            // 清理临时文件
            cleanupTask(task);
            processingCount--;
            // 递归处理下一个任务
            processQueue();
        }
    }

    /**
     * 添加任务到队列
     * @param {TaskContext} task - 任务上下文
     */
    function addTask(task) {
        queue.push(task);
        processQueue();
    }

    /**
     * 获取当前队列状态
     * @returns {{queueLength: number, processing: number, total: number}}
     */
    function getStatus() {
        return {
            queueLength: queue.length,
            processing: processingCount,
            total: processingCount + queue.length
        };
    }

    /**
     * 获取详细队列状态（包含任务列表）
     * @returns {{processing: object[], waiting: object[]}}
     */
    function getDetailedStatus() {
        return {
            processing: processingTasks.map(t => ({
                id: t.id,
                model: t.modelName || t.modelId,
                isStreaming: t.isStreaming
            })),
            waiting: queue.map(t => ({
                id: t.id,
                model: t.modelName || t.modelId,
                isStreaming: t.isStreaming
            }))
        };
    }

    /**
     * 检查是否可以接受新请求（非流式）
     * @returns {boolean}
     */
    function canAcceptNonStreaming() {
        return processingCount + queue.length < effectiveQueueSize;
    }

    /**
     * 初始化 Pool
     * @returns {Promise<PoolContext>}
     */
    async function initializePool() {
        poolContext = await initBrowser(config);
        // 初始化完成后，触发首次监控跳转
        if (navigateToMonitor) {
            navigateToMonitor().catch(() => { });
        }
        return poolContext;
    }

    /**
     * 获取 Pool 上下文
     * @returns {PoolContext|null}
     */
    function getPoolContext() {
        return poolContext;
    }

    /**
     * 获取指定 Worker 的 Cookies (代理到后端)
     * @param {string} [workerName] - Worker 名称
     * @param {string} [domain] - 域名
     * @returns {Promise<{worker: string, cookies: object[]}>}
     */
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
