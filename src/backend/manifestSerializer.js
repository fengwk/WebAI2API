/**
 * @fileoverview 结构化 manifest 与 JS 源文件之间的序列化器
 *
 * 结构化 manifest（前端提交）：
 *   {
 *     id, name, description?, homePageUrl?, inputJsonSchema?, script
 *   }
 *
 * JS 源文件（registry 加载）：
 *   export const manifest = { ... };
 *
 * 序列化策略：
 *   - 顶层对象字段直接 JSON.stringify
 *   - script 字段是字符串，使用 JSON.stringify 后再用模板字符串包裹
 *   - 其它字段直接 JSON.stringify
 */

const SUPPORTED_FIELDS = ['id', 'name', 'description', 'homePageUrl', 'inputJsonSchema', 'script'];
const FORBIDDEN_FIELDS = ['providers', 'execute', 'outputJsonSchema', 'models', 'timeoutMs'];

function jsonStringify(value) {
    // JSON.stringify 末尾不带多余空格，与现有 example 风格一致
    return JSON.stringify(value, null, 2);
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeStructuredManifest(input, fallbackId) {
    if (!isPlainObject(input)) {
        throw new Error('manifest 必须是对象');
    }
    const out = {};
    if (input.id) out.id = String(input.id);
    else if (fallbackId) out.id = String(fallbackId);
    if (input.name) out.name = String(input.name);
    if (input.description !== undefined && input.description !== null) {
        out.description = String(input.description);
    }
    if (input.homePageUrl !== undefined && input.homePageUrl !== null) {
        out.homePageUrl = String(input.homePageUrl);
    }
    if (input.inputJsonSchema !== undefined && input.inputJsonSchema !== null) {
        if (!isPlainObject(input.inputJsonSchema)) {
            throw new Error('inputJsonSchema 必须是对象');
        }
        out.inputJsonSchema = input.inputJsonSchema;
    }
    if (typeof input.script !== 'string') {
        throw new Error('script 必须是字符串');
    }
    out.script = input.script;

    if (!out.id) throw new Error('缺少 id');
    if (!out.name) throw new Error('缺少 name');

    // 显式禁止已废弃字段
    for (const field of FORBIDDEN_FIELDS) {
        if (input[field] !== undefined) {
            throw new Error(`禁止使用已废弃字段: ${field}`);
        }
    }
    return out;
}

/**
 * 把结构化 manifest 序列化为 JS 源文件内容。
 * 生成的代码形如：
 *   export const manifest = {
 *     "id": "...",
 *     "name": "...",
 *     ...
 *     "script": "..."
 *   };
 */
export function serializeManifestToSource(manifest) {
    const ordered = {};
    for (const field of SUPPORTED_FIELDS) {
        if (manifest[field] === undefined) continue;
        ordered[field] = manifest[field];
    }
    return `export const manifest = ${jsonStringify(ordered)};\n`;
}

/**
 * 从结构化输入生成可直接写入磁盘的源文件内容。
 * 自动从 input.id 提取 adapterId。
 */
export function buildSourceFromStructured(input) {
    const structured = normalizeStructuredManifest(input, input?.id);
    return {
        adapterId: structured.id,
        source: serializeManifestToSource(structured)
    };
}

/**
 * 从源文件解析出结构化 manifest。
 * 通过 import() 解析后取 module.manifest。
 */
export async function parseSourceToStructured(filePath) {
    const module = await importAdapterModule(filePath);
    const m = module?.manifest;
    if (!m || typeof m !== 'object') {
        throw new Error('源文件未导出 manifest 对象');
    }
    // 复用 normalize 校验并规范化字段
    return normalizeStructuredManifest(m, m.id);
}

import { importAdapterModule } from './adapterStore.js';

export { SUPPORTED_FIELDS, FORBIDDEN_FIELDS, normalizeStructuredManifest };
