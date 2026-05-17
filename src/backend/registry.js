/**
 * @fileoverview 动态适配器注册表
 * @description 统一管理 data/adapters 下的动态脚本与单 endpoint 元数据。
 */

import { logger } from '../utils/logger.js';
import { validateSchemaDefinition } from '../utils/jsonSchema.js';
import { ensureAdaptersDirSync, listAdapterFiles, importAdapterModule, ADAPTERS_DIR } from './adapterStore.js';

ensureAdaptersDirSync();

class AdapterRegistry {
    constructor() {
        this.adapters = new Map();
        this.loaded = false;
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

                const errors = this.getManifestErrors(manifest);
                if (errors.length > 0) {
                    logger.error('注册表', `${file.fileName} manifest 校验失败: ${errors.join('; ')}`);
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

        if (!manifest.inputJsonSchema || typeof manifest.inputJsonSchema !== 'object') {
            errors.push('缺少 inputJsonSchema');
        } else {
            errors.push(...validateSchemaDefinition(manifest.inputJsonSchema, 'inputJsonSchema'));
        }

        if (!manifest.outputJsonSchema || typeof manifest.outputJsonSchema !== 'object') {
            errors.push('缺少 outputJsonSchema');
        } else {
            errors.push(...validateSchemaDefinition(manifest.outputJsonSchema, 'outputJsonSchema'));
        }

        if (typeof manifest.execute !== 'function') {
            errors.push('execute 必须是函数');
        }

        return errors;
    }

    getAdapter(id) {
        return this.adapters.get(id) || null;
    }

    hasAdapter(id) {
        return this.adapters.has(id);
    }

    getAdapterIds() {
        return Array.from(this.adapters.keys());
    }

    listAdapters() {
        return Array.from(this.adapters.values());
    }
}

const registry = new AdapterRegistry();

export { AdapterRegistry, registry };
