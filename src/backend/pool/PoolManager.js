/**
 * @fileoverview PoolManager 类
 * @description
 *   - 管理 Worker 池
 *   - 支持指定 workerId 精确路由
 *   - 调度策略以 worker 负载（activeCount + pendingCount）作为衡量
 *   - 删除原 runDebugScript 旁路
 */

import { logger } from '../../utils/logger.js';
import { registry } from '../registry.js';
import { createStrategySelector } from '../strategies/index.js';
import { Worker } from './Worker.js';

export class PoolManager {
    constructor(config) {
        this.config = config;
        this.workers = [];
        this.strategy = config.backend.pool.strategy || 'least_busy';
        this.strategySelector = createStrategySelector(this.strategy);
        this.initialized = false;
    }

    async initAll() {
        if (this.initialized) return;

        await registry.loadAll();

        const loginArg = process.argv.find(arg => arg.startsWith('-login'));
        const isLoginMode = !!loginArg;
        const loginWorkerName = loginArg?.includes('=')
            ? loginArg.split('=')[1]
            : (isLoginMode ? this.config.backend.pool.workers[0]?.name || null : null);

        const workerConfigs = this.config.backend.pool.workers;
        const validWorkers = [];

        for (const workerConfig of workerConfigs) {
            if (isLoginMode && workerConfig.name !== loginWorkerName) {
                continue;
            }

            if (!registry.hasAdapter(workerConfig.type)) {
                logger.error('工作池', `Worker [${workerConfig.name}] 的类型 "${workerConfig.type}" 无对应适配器，跳过`);
                continue;
            }

            validWorkers.push(new Worker(this.config, workerConfig));
        }

        if (isLoginMode && validWorkers.length === 0) {
            const availableNames = workerConfigs.map(w => w.name).join(', ');
            throw new Error(`登录模式未找到 Worker "${loginWorkerName}"。可用的 Worker: ${availableNames}`);
        }

        const browserMap = new Map();

        for (const worker of validWorkers) {
            try {
                const existing = browserMap.get(worker.userDataDir);
                if (existing) {
                    const workerProxy = JSON.stringify(worker.proxyConfig || null);
                    const existingProxy = JSON.stringify(existing.proxyConfig || null);
                    if (workerProxy !== existingProxy) {
                        logger.warn('工作池', `[${worker.name}] 代理配置与 [${existing.firstWorkerName}] 不一致，将使用后者的配置`);
                    }
                    await worker.init(existing.browser);
                    worker._browserOwner = existing.ownerWorker;
                    existing.ownerWorker._sharedWorkers.push(worker);
                } else {
                    await worker.init();
                    browserMap.set(worker.userDataDir, {
                        browser: worker.browser,
                        proxyConfig: worker.proxyConfig,
                        firstWorkerName: worker.name,
                        ownerWorker: worker
                    });
                }
                this.workers.push(worker);
            } catch (e) {
                logger.error('工作池', `[${worker.name}] 初始化失败，跳过该 Worker`, { error: e.message });
            }
        }

        if (this.workers.length === 0) {
            throw new Error('所有 Worker 初始化都失败了，无法启动服务');
        }

        this.initialized = true;
        logger.info('工作池', `工作池初始化完成，共 ${this.workers.length} 个 Worker 就绪 (${browserMap.size} 个浏览器实例)`);
    }

    /**
     * 选取候选 worker。
     *  - supports adapterId
     *  - healthy（initialized && 无 error && page 存在）
     *  - 本地队列未满
     */
    _pickCandidates(adapterId) {
        return this.workers.filter(worker =>
            worker.supports(adapterId)
            && worker.isHealthy()
            && !worker.isLocalQueueFull()
        );
    }

    _classifyNoCandidate(adapterId) {
        const supported = this.workers.filter(worker => worker.supports(adapterId));
        if (supported.length === 0) {
            return {
                code: null,
                message: `没有可用的 Worker 支持适配器: ${adapterId}`,
                retryable: true
            };
        }

        const healthy = supported.filter(worker => worker.isHealthy());
        if (healthy.length === 0) {
            return {
                code: 'WORKER_UNAVAILABLE',
                message: `支持适配器 ${adapterId} 的 Worker 当前不可用`,
                retryable: true
            };
        }

        const fullWorkers = healthy.filter(worker => worker.isLocalQueueFull());
        if (fullWorkers.length === healthy.length) {
            return {
                code: 'WORKER_BUSY',
                message: `支持适配器 ${adapterId} 的 Worker 本地队列已满`,
                retryable: true
            };
        }

        return {
            code: null,
            message: `没有可用的 Worker 支持适配器: ${adapterId}`,
            retryable: true
        };
    }

    /**
     * 调度入口。
     * task 字段：
     *   adapterId, input, fileOutput, debug, workerId?, overrideScript?
     */
    async executeTask(ctx, task, meta = {}) {
        if (!task || !task.adapterId) {
            return {
                success: false,
                error: { message: 'executeTask: 缺少 adapterId', retryable: false }
            };
        }

        // 1) 指定 workerId：精确定位（不参与调度）
        if (task.workerId) {
            return await this._executeOnSpecificWorker(task, meta);
        }

        // 2) 调度选择
        const candidates = this._pickCandidates(task.adapterId);
        if (candidates.length === 0) {
            return {
                success: false,
                error: this._classifyNoCandidate(task.adapterId)
            };
        }

        const sortedCandidates = this.strategySelector.sort(candidates);
        const failoverConfig = this.config.backend?.pool?.failover || {};
        const failoverEnabled = failoverConfig.enabled !== false;
        const maxRetries = failoverConfig.maxRetries ?? 2;
        const maxAttempts = failoverEnabled
            ? (maxRetries === 0 ? sortedCandidates.length : Math.min(maxRetries + 1, sortedCandidates.length))
            : 1;

        let lastError = null;
        for (let i = 0; i < maxAttempts; i++) {
            const worker = sortedCandidates[i];
            logger.debug('工作池', `任务分发至: ${worker.name} (load: ${worker.load})`);
            try {
                const result = await worker.executeTask(ctx, task, meta);
                if (result.success) return result;
                lastError = result.error;
                if (result.error?.retryable === false) return result;
                if (i < maxAttempts - 1) {
                    logger.warn('工作池', `[${worker.name}] 失败，尝试下一个 Worker...`, {
                        error: result.error?.message,
                        ...meta
                    });
                }
            } catch (err) {
                lastError = { message: err.message || '执行异常', retryable: true };
                logger.error('工作池', `[${worker.name}] 执行异常`, { error: err.message, ...meta });
            }
        }
        return {
            success: false,
            error: lastError || { message: '所有 Worker 都执行失败', retryable: true }
        };
    }

    /**
     * 指定 workerId 的精确执行：不做调度、不做 failover。
     */
    async _executeOnSpecificWorker(task, meta) {
        const worker = this.workers.find(w => w.name === task.workerId);
        if (!worker) {
            return {
                success: false,
                error: { code: 'WORKER_NOT_FOUND', message: `指定 Worker 不存在: ${task.workerId}`, retryable: false }
            };
        }
        if (!worker.supports(task.adapterId)) {
            return {
                success: false,
                error: {
                    code: 'WORKER_TYPE_MISMATCH',
                    message: `Worker [${worker.name}] 的 type (${worker.type}) 与 adapterId (${task.adapterId}) 不匹配`,
                    retryable: false
                }
            };
        }
        if (!worker.isHealthy()) {
            return {
                success: false,
                error: { code: 'WORKER_UNAVAILABLE', message: `Worker [${worker.name}] 不可用 (未初始化 / 离线 / 错误)`, retryable: true }
            };
        }
        if (worker.isLocalQueueFull()) {
            return {
                success: false,
                error: { code: 'WORKER_BUSY', message: `Worker [${worker.name}] 本地队列已满`, retryable: true }
            };
        }

        logger.debug('工作池', `任务精确路由至: ${worker.name} (load: ${worker.load})`);
        try {
            return await worker.executeTask({}, task, meta);
        } catch (err) {
            return {
                success: false,
                error: { message: err.message || '执行异常', retryable: true }
            };
        }
    }

    async getCookies(instanceName, domain) {
        let worker;
        if (instanceName) {
            worker = this.workers.find(w => w.instanceName === instanceName);
            if (!worker) throw new Error(`浏览器实例不存在: ${instanceName}`);
        } else {
            worker = this.workers[0];
            if (!worker) throw new Error('工作池中没有可用的 Worker');
        }
        const cookies = await worker.getCookies(domain);
        return { instance: worker.instanceName, cookies };
    }

    getFirstPage() {
        return this.workers[0]?.page || null;
    }

    getWorkerByName(workerName) {
        if (!workerName) return this.workers[0] || null;
        return this.workers.find(worker => worker.name === workerName) || null;
    }
}
