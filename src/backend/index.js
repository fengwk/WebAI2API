/**
 * @fileoverview 后端适配器入口
 * @description 基于 Pool 架构统一管理多浏览器实例，提供统一的对外接口。
 *
 * 对外统一能力：
 * - `initBrowser(cfg)` → 初始化 Pool
 * - `executeTask(ctx, task, meta)`
 * - `getModels()` / `getDefaultModel(providerType)`
 * - `getCookies(workerName, domain)` - 获取指定 Worker 的 Cookies
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config/index.js';
import { PoolManager } from './pool/index.js';
import { logger } from '../utils/logger.js';

// --- 集中管理的路径常量 ---
const TEMP_DIR = path.join(process.cwd(), 'data', 'temp');

// 确保临时目录存在
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 全局 PoolManager 实例
let poolManager = null;

/**
 * 获取后端接口
 * @returns {object} 后端统一接口
 */
export function getBackend() {
    const config = loadConfig();

    // 将临时目录路径注入 config 对象
    config.paths = {
        tempDir: TEMP_DIR
    };

    return {
        name: 'pool',
        config,
        TEMP_DIR,

        /**
         * 初始化 Pool
         * @param {object} cfg - 配置对象
         * @returns {Promise<{poolManager: PoolManager, config: object}>}
         */
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

        /**
         * 获取模型列表
         * @returns {object}
         */
        getModels: () => {
            if (!poolManager) {
                return { object: 'list', data: [] };
            }
            return poolManager.getModels();
        },

        getDefaultModel: (providerType) => {
            if (!poolManager) {
                return null;
            }
            return poolManager.getDefaultModel(providerType);
        },

        hasModel: (providerType, modelId) => {
            if (!poolManager) {
                return false;
            }
            return poolManager.hasModel(providerType, modelId);
        },

        /**
         * 获取 Cookies
         * @param {string} [workerName] - Worker 名称
         * @param {string} [domain] - 域名
         * @returns {Promise<{worker: string, cookies: object[]}>}
         */
        getCookies: async (workerName, domain) => {
            if (!poolManager) {
                throw new Error('Pool 未初始化');
            }
            return await poolManager.getCookies(workerName, domain);
        },

        /**
         * 获取 PoolManager 实例
         * @returns {PoolManager|null}
         */
        getPoolManager: () => poolManager
    };
}
