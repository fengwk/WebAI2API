/**
 * @fileoverview 动态适配器注册表
 * @description 统一管理 data/adapters 下的动态脚本。唯一支持的脚本结构为：
 *              export const manifest = {
 *                  id, name, description?, homePageUrl?, inputJsonSchema?, script
 *              };
 *              不再兼容 providers[] / execute() / outputJsonSchema 等历史结构。
 */

import { logger } from '../utils/logger.js';
import { validateSchemaDefinition } from '../utils/jsonSchema.js';
import { ensureAdaptersDirSync, listAdapterFiles, importAdapterModule, ADAPTERS_DIR } from './adapterStore.js';

ensureAdaptersDirSync();

const FORBIDDEN_FIELDS = ['providers', 'execute', 'outputJsonSchema', 'models', 'timeoutMs'];

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

    /**
     * 校验 manifest 是否符合新结构。
     * - id/name 必填
     * - script 必填且为字符串
     * - description/homePageUrl 可选字符串
     * - inputJsonSchema 可选 JSON Schema 对象
     * - 禁止出现 providers/execute/outputJsonSchema/models/timeoutMs
     */
    getManifestErrors(manifest) {
        const errors = [];

        if (!manifest || typeof manifest !== 'object') {
            return ['manifest 必须是对象'];
        }

        if (!manifest.id || typeof manifest.id !== 'string') {
            errors.push('缺少 id 或类型不正确');
        }

        if (!manifest.name || typeof manifest.name !== 'string') {
            errors.push('缺少 name 或类型不正确');
        }

        if (manifest.description !== undefined && typeof manifest.description !== 'string') {
            errors.push('description 必须是字符串');
        }

        if (manifest.homePageUrl !== undefined && typeof manifest.homePageUrl !== 'string') {
            errors.push('homePageUrl 必须是字符串');
        }

        if (manifest.script === undefined || manifest.script === null) {
            errors.push('缺少 script 字段');
        } else if (typeof manifest.script !== 'string') {
            errors.push('script 必须是字符串');
        } else if (manifest.script.trim().length === 0) {
            errors.push('script 不能为空字符串');
        }

        if (manifest.inputJsonSchema !== undefined && manifest.inputJsonSchema !== null) {
            if (typeof manifest.inputJsonSchema !== 'object') {
                errors.push('inputJsonSchema 必须是对象');
            } else {
                errors.push(...validateSchemaDefinition(manifest.inputJsonSchema, 'inputJsonSchema'));
            }
        }

        for (const field of FORBIDDEN_FIELDS) {
            if (manifest[field] !== undefined) {
                errors.push(`禁止使用已废弃字段: ${field}`);
            }
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

export { AdapterRegistry, registry, FORBIDDEN_FIELDS };
