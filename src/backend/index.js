/**
 * @fileoverview 后端适配器入口
 * @description 基于 Pool 架构统一管理多浏览器实例，提供动态适配器执行接口。
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config/index.js';
import { PoolManager } from './pool/index.js';

const TEMP_DIR = path.join(process.cwd(), 'data', 'temp');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let poolManager = null;

export function getBackend() {
    const config = loadConfig();
    config.paths = {
        tempDir: TEMP_DIR
    };

    return {
        name: 'pool',
        config,
        TEMP_DIR,
        initBrowser: async (cfg) => {
            if (poolManager && poolManager.initialized) {
                return { poolManager, config: cfg };
            }

            poolManager = new PoolManager(cfg);
            await poolManager.initAll();
            return { poolManager, config: cfg };
        },
        executeTask: async (ctx, task, meta) => {
            if (!poolManager) {
                return {
                    success: false,
                    data: null,
                    error: {
                        message: 'Pool 未初始化',
                        retryable: true
                    }
                };
            }
            return await poolManager.executeTask(ctx, task, meta);
        },
        getCookies: async (workerName, domain) => {
            if (!poolManager) {
                throw new Error('Pool 未初始化');
            }
            return await poolManager.getCookies(workerName, domain);
        },
        getPoolManager: () => poolManager
    };
}
