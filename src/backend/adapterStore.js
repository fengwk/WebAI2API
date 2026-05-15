/**
 * @fileoverview 动态适配器文件存储
 * @description 管理 data/adapters 目录中的动态适配器脚本文件。
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

export const ADAPTERS_DIR = path.join(process.cwd(), 'data', 'adapters');

const ADAPTER_ID_RE = /^[A-Za-z0-9._-]+$/;

export function ensureAdaptersDirSync() {
    if (!fs.existsSync(ADAPTERS_DIR)) {
        fs.mkdirSync(ADAPTERS_DIR, { recursive: true });
    }
}

export async function ensureAdaptersDir() {
    await fsp.mkdir(ADAPTERS_DIR, { recursive: true });
}

export function normalizeAdapterId(adapterId) {
    const normalized = String(adapterId || '').trim();
    if (!normalized) {
        throw new Error('适配器 ID 不能为空');
    }
    if (normalized === 'merge') {
        throw new Error('适配器 ID 不能使用保留字 merge');
    }
    if (!ADAPTER_ID_RE.test(normalized)) {
        throw new Error('适配器 ID 仅支持字母、数字、点、下划线和中划线');
    }
    return normalized;
}

export function getAdapterFilePath(adapterId) {
    return path.join(ADAPTERS_DIR, `${normalizeAdapterId(adapterId)}.js`);
}

export async function listAdapterFiles() {
    await ensureAdaptersDir();
    const entries = await fsp.readdir(ADAPTERS_DIR, { withFileTypes: true });
    return entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => ({
            id: entry.name.slice(0, -3),
            fileName: entry.name,
            filePath: path.join(ADAPTERS_DIR, entry.name)
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

export async function readAdapterSource(adapterId) {
    await ensureAdaptersDir();
    return await fsp.readFile(getAdapterFilePath(adapterId), 'utf8');
}

export async function writeAdapterSource(adapterId, source) {
    await ensureAdaptersDir();
    await fsp.writeFile(getAdapterFilePath(adapterId), source, 'utf8');
}

export async function deleteAdapterSource(adapterId) {
    await ensureAdaptersDir();
    await fsp.unlink(getAdapterFilePath(adapterId));
}

export async function adapterSourceExists(adapterId) {
    try {
        await fsp.access(getAdapterFilePath(adapterId), fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

export async function importAdapterModule(filePath) {
    const stat = await fsp.stat(filePath);
    return await import(`${pathToFileURL(filePath).href}?t=${stat.mtimeMs}`);
}
