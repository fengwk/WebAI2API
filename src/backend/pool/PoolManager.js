/**
 * @fileoverview PoolManager 类
 * @description 管理 Worker 池，负责初始化与适配器任务分发。
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

    async executeTask(ctx, task, meta = {}) {
        const candidates = this.workers.filter(worker => worker.supports(task.adapterId));
        if (candidates.length === 0) {
            return {
                success: false,
                data: null,
                error: {
                    message: `没有 Worker 支持适配器: ${task.adapterId}`,
                    retryable: false
                }
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
            logger.debug('工作池', `任务分发至: ${worker.name} (busy: ${worker.busyCount})`);
            try {
                const result = await worker.executeTask(ctx, task, meta);
                if (result.success) {
                    return result;
                }

                lastError = result.error;
                if (result.error?.retryable === false) {
                    return result;
                }

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
            data: null,
            error: lastError || { message: '所有 Worker 都执行失败', retryable: true }
        };
    }

    async getCookies(instanceName, domain) {
        let worker;
        if (instanceName) {
            worker = this.workers.find(w => w.instanceName === instanceName);
            if (!worker) {
                throw new Error(`浏览器实例不存在: ${instanceName}`);
            }
        } else {
            worker = this.workers[0];
            if (!worker) {
                throw new Error('工作池中没有可用的 Worker');
            }
        }

        const cookies = await worker.getCookies(domain);
        return { instance: worker.instanceName, cookies };
    }

    getFirstPage() {
        return this.workers[0]?.page || null;
    }

    getWorkerByName(workerName) {
        if (!workerName) {
            return this.workers[0] || null;
        }
        return this.workers.find(worker => worker.name === workerName) || null;
    }

    async runDebugScript(workerName, script, input, meta = {}, options = {}) {
        const worker = this.getWorkerByName(workerName);
        if (!worker) {
            throw new Error(`Worker 不存在: ${workerName}`);
        }
        return await worker.runDebugScript(script, input, meta, options);
    }
}
