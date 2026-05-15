/**
 * @fileoverview 动态适配器注册表
 * @description 统一管理 data/adapters 下的动态脚本、provider 元数据与模型查询。
 */

import { logger } from '../utils/logger.js';
import { ensureAdaptersDirSync, listAdapterFiles, importAdapterModule, ADAPTERS_DIR } from './adapterStore.js';
import { getProvider, hasProvider } from './providers/registry.js';

ensureAdaptersDirSync();

function createModelDescriptor(modelId) {
    return {
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'webai-2api'
    };
}

class AdapterRegistry {
    constructor() {
        this.adapters = new Map();
        this.adapterConfig = {};
        this.loaded = false;
    }

    setAdapterConfig(config) {
        this.adapterConfig = config || {};
    }

    isModelEnabled(adapterId, modelId) {
        const adapterCfg = this.adapterConfig[adapterId];
        if (!adapterCfg?.modelFilter) return true;

        const { mode, list } = adapterCfg.modelFilter;
        if (!Array.isArray(list) || list.length === 0) return true;
        const inList = list.includes(modelId);
        return mode === 'whitelist' ? inList : !inList;
    }

    async loadAll() {
        if (this.loaded) return;

        logger.info('注册表', `正在扫描适配器目录: ${ADAPTERS_DIR}`);
        this.adapters.clear();
        const files = await listAdapterFiles();

        for (const file of files) {
            try {
                const module = await importAdapterModule(file.filePath);
                const manifest = module.manifest;
                if (!manifest) {
                    logger.warn('注册表', `跳过 ${file.fileName}: 未导出 manifest`);
                    continue;
                }

                if (manifest.id !== file.id) {
                    logger.error('注册表', `${file.fileName} manifest 校验失败: manifest.id 必须与文件名一致 (${file.id})`);
                    continue;
                }

                if (!this.validateManifest(manifest, file.fileName)) {
                    continue;
                }

                this.adapters.set(manifest.id, manifest);
                logger.debug('注册表', `已加载适配器: ${manifest.id} (${manifest.name || file.fileName})`);
            } catch (err) {
                logger.error('注册表', `加载 ${file.fileName} 失败: ${err.message}`);
            }
        }

        this.loaded = true;
        logger.info('注册表', `适配器加载完成，共 ${this.adapters.size} 个可用`);
    }

    async reload() {
        this.loaded = false;
        this.adapters.clear();
        await this.loadAll();
    }

    getManifestErrors(manifest) {
        const errors = [];

        if (!manifest.id || typeof manifest.id !== 'string') {
            errors.push('缺少 id 或类型不正确');
        }

        if (manifest.name !== undefined && typeof manifest.name !== 'string') {
            errors.push('name 必须是字符串');
        }

        if (!manifest.provider || typeof manifest.provider !== 'object') {
            errors.push('缺少 provider 配置');
        } else {
            if (!manifest.provider.type || typeof manifest.provider.type !== 'string') {
                errors.push('provider.type 缺失或类型不正确');
            } else if (!hasProvider(manifest.provider.type)) {
                errors.push(`未知 provider.type: ${manifest.provider.type}`);
            }

            if (manifest.provider.models !== undefined) {
                if (!Array.isArray(manifest.provider.models)) {
                    errors.push('provider.models 必须是数组');
                } else {
                    for (let i = 0; i < manifest.provider.models.length; i++) {
                        if (!manifest.provider.models[i] || typeof manifest.provider.models[i] !== 'string') {
                            errors.push(`provider.models[${i}] 必须是非空字符串`);
                        }
                    }
                }
            }
        }

        if (!manifest.execute || typeof manifest.execute !== 'function') {
            errors.push('缺少 execute 函数');
        }

        if (manifest.navigationHandlers !== undefined && !Array.isArray(manifest.navigationHandlers)) {
            errors.push('navigationHandlers 必须是数组');
        }

        if (manifest.getTargetUrl !== undefined && typeof manifest.getTargetUrl !== 'function') {
            errors.push('getTargetUrl 必须是函数');
        }

        return errors;
    }

    validateManifest(manifest, fileName) {
        const errors = this.getManifestErrors(manifest);
        if (errors.length > 0) {
            logger.error('注册表', `${fileName} manifest 校验失败: ${errors.join('; ')}`);
            return false;
        }
        return true;
    }

    getAdapter(id) {
        return this.adapters.get(id) || null;
    }

    getAdapterIds() {
        return Array.from(this.adapters.keys());
    }

    hasAdapter(id) {
        return this.adapters.has(id);
    }

    getProviderByAdapterId(id) {
        const adapter = this.getAdapter(id);
        if (!adapter) return null;
        return getProvider(adapter.provider.type);
    }

    getProviderTypeByAdapterId(id) {
        return this.getAdapter(id)?.provider?.type || null;
    }

    getTargetUrl(id, config, workerConfig) {
        const adapter = this.getAdapter(id);
        if (!adapter) return 'about:blank';
        if (typeof adapter.getTargetUrl === 'function') {
            return adapter.getTargetUrl(config, workerConfig) || 'about:blank';
        }
        return adapter.targetUrl || 'about:blank';
    }

    getNavigationHandlers(id) {
        const adapter = this.getAdapter(id);
        return adapter?.navigationHandlers || [];
    }

    getAdapterModels(id) {
        const adapter = this.getAdapter(id);
        if (!adapter) return [];
        const models = adapter.provider?.models || [];
        return models.filter(modelId => this.isModelEnabled(id, modelId));
    }

    supportsTask(adapterId, providerType, modelId) {
        const adapter = this.getAdapter(adapterId);
        if (!adapter || adapter.provider?.type !== providerType) {
            return false;
        }

        const models = adapter.provider?.models || [];
        if (!modelId) {
            return models.length > 0;
        }

        return models.includes(modelId) && this.isModelEnabled(adapterId, modelId);
    }

    getDefaultModel(providerType) {
        for (const [adapterId, adapter] of this.adapters) {
            if (adapter.provider?.type !== providerType) continue;
            const models = this.getAdapterModels(adapterId);
            if (models.length > 0) {
                return models[0];
            }
        }
        return null;
    }

    hasModel(providerType, modelId) {
        for (const [adapterId, adapter] of this.adapters) {
            if (adapter.provider?.type !== providerType) continue;
            if (this.getAdapterModels(adapterId).includes(modelId)) {
                return true;
            }
        }
        return false;
    }

    getModelsForAdapter(id) {
        return {
            object: 'list',
            data: this.getAdapterModels(id).map(createModelDescriptor)
        };
    }

    getAllModels() {
        const seen = new Set();
        const data = [];
        for (const adapterId of this.adapters.keys()) {
            for (const modelId of this.getAdapterModels(adapterId)) {
                if (seen.has(modelId)) continue;
                seen.add(modelId);
                data.push(createModelDescriptor(modelId));
            }
        }
        return { object: 'list', data };
    }
}

const registry = new AdapterRegistry();

export { AdapterRegistry, registry };
