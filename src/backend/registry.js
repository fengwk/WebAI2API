/**
 * @fileoverview 动态适配器注册表
 * @description 统一管理 data/adapters 下的动态脚本、provider 元数据与模型查询。
 */

import { logger } from '../utils/logger.js';
import { ensureAdaptersDirSync, listAdapterFiles, importAdapterModule, ADAPTERS_DIR } from './adapterStore.js';
import { hasProvider } from './providers/registry.js';

ensureAdaptersDirSync();

function createModelDescriptor(modelId) {
    return {
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'webai-2api'
    };
}

function getProviderModels(providerEntry) {
    return Array.isArray(providerEntry?.models) ? providerEntry.models : [];
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

        if (!Array.isArray(manifest.providers) || manifest.providers.length === 0) {
            errors.push('providers 必须是非空数组');
        } else {
            const seenProviderKeys = new Set();
            for (let i = 0; i < manifest.providers.length; i++) {
                const providerEntry = manifest.providers[i];
                const prefix = `providers[${i}]`;

                if (!providerEntry || typeof providerEntry !== 'object') {
                    errors.push(`${prefix} 必须是对象`);
                    continue;
                }

                if (!providerEntry.type || typeof providerEntry.type !== 'string') {
                    errors.push(`${prefix}.type 缺失或类型不正确`);
                } else if (!hasProvider(providerEntry.type)) {
                    errors.push(`未知 ${prefix}.type: ${providerEntry.type}`);
                }

                if (!Array.isArray(providerEntry.models) || providerEntry.models.length === 0) {
                    errors.push(`${prefix}.models 必须是非空数组`);
                } else {
                    for (let j = 0; j < providerEntry.models.length; j++) {
                        const modelId = providerEntry.models[j];
                        if (!modelId || typeof modelId !== 'string') {
                            errors.push(`${prefix}.models[${j}] 必须是非空字符串`);
                            continue;
                        }

                        const providerModelKey = `${providerEntry.type}:${modelId}`;
                        if (seenProviderKeys.has(providerModelKey)) {
                            errors.push(`${prefix}.models[${j}] 与其他 provider 项重复: ${providerEntry.type}/${modelId}`);
                        } else {
                            seenProviderKeys.add(providerModelKey);
                        }
                    }
                }

                if (typeof providerEntry.execute !== 'function') {
                    errors.push(`${prefix}.execute 必须是函数`);
                }
            }
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

    getAdapterProviders(id) {
        return this.getAdapter(id)?.providers || [];
    }

    getProviderEntries(adapterId, providerType = null) {
        const providers = this.getAdapterProviders(adapterId);
        if (!providerType) {
            return providers;
        }
        return providers.filter(providerEntry => providerEntry.type === providerType);
    }

    resolveProviderEntry(adapterId, providerType, modelId = null) {
        const candidates = this.getProviderEntries(adapterId, providerType);
        if (candidates.length === 0) {
            return null;
        }

        if (modelId) {
            return candidates.find(providerEntry => getProviderModels(providerEntry)
                .some(candidateModelId => candidateModelId === modelId && this.isModelEnabled(adapterId, candidateModelId))) || null;
        }

        return candidates.find(providerEntry => getProviderModels(providerEntry)
            .some(candidateModelId => this.isModelEnabled(adapterId, candidateModelId))) || null;
    }

    getAdapterModels(id) {
        const seen = new Set();
        const models = [];
        for (const providerEntry of this.getAdapterProviders(id)) {
            for (const modelId of getProviderModels(providerEntry)) {
                if (!this.isModelEnabled(id, modelId) || seen.has(modelId)) continue;
                seen.add(modelId);
                models.push(modelId);
            }
        }
        return models;
    }

    supportsTask(adapterId, providerType, modelId) {
        return !!this.resolveProviderEntry(adapterId, providerType, modelId);
    }

    getDefaultModel(providerType) {
        for (const adapterId of this.adapters.keys()) {
            for (const providerEntry of this.getProviderEntries(adapterId, providerType)) {
                const modelId = getProviderModels(providerEntry)
                    .find(candidateModelId => this.isModelEnabled(adapterId, candidateModelId));
                if (modelId) {
                    return modelId;
                }
            }
        }
        return null;
    }

    hasModel(providerType, modelId) {
        for (const adapterId of this.adapters.keys()) {
            if (this.resolveProviderEntry(adapterId, providerType, modelId)) {
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
