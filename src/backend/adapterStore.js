/**
 * @fileoverview 动态适配器文件存储
 * @description 管理 data/adapters 目录中的动态适配器脚本文件。
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';

export const ADAPTERS_DIR = path.join(process.cwd(), 'data', 'adapters');
export const ADAPTER_EXAMPLES_DIR = path.join(process.cwd(), 'examples', 'dynamic-adapters');

const BUNDLED_ADAPTER_HASHES = {
    'chatgpt.js': new Set([
        '3f13d0e76dfe652e821b9c0669b178f568013e08ac424b5e5c71e2771aa6b222'
    ]),
    'gemini.js': new Set([
        '6cc35d1b9c3697ec62bc24011df6a9e567fab1777cbe9184dc816251e5984d2a'
    ])
};

const ADAPTER_ID_RE = /^[A-Za-z0-9._-]+$/;

export function ensureAdaptersDirSync() {
    if (!fs.existsSync(ADAPTERS_DIR)) {
        fs.mkdirSync(ADAPTERS_DIR, { recursive: true });
    }
    seedDefaultAdaptersIfEmptySync();
    refreshBundledAdaptersIfNeededSync();
}

export async function ensureAdaptersDir() {
    await fsp.mkdir(ADAPTERS_DIR, { recursive: true });
    await seedDefaultAdaptersIfEmpty();
    await refreshBundledAdaptersIfNeeded();
}

function sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

export function seedDefaultAdaptersIfEmptySync() {
    if (!fs.existsSync(ADAPTER_EXAMPLES_DIR)) {
        return;
    }

    const currentFiles = fs.readdirSync(ADAPTERS_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'));
    if (currentFiles.length > 0) {
        return;
    }

    const exampleFiles = fs.readdirSync(ADAPTER_EXAMPLES_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'));
    for (const entry of exampleFiles) {
        fs.copyFileSync(path.join(ADAPTER_EXAMPLES_DIR, entry.name), path.join(ADAPTERS_DIR, entry.name));
    }
}

export async function seedDefaultAdaptersIfEmpty() {
    try {
        const currentFiles = (await fsp.readdir(ADAPTERS_DIR, { withFileTypes: true }))
            .filter(entry => entry.isFile() && entry.name.endsWith('.js'));
        if (currentFiles.length > 0) {
            return;
        }

        const exampleEntries = (await fsp.readdir(ADAPTER_EXAMPLES_DIR, { withFileTypes: true }))
            .filter(entry => entry.isFile() && entry.name.endsWith('.js'));
        await Promise.all(exampleEntries.map(async (entry) => {
            await fsp.copyFile(path.join(ADAPTER_EXAMPLES_DIR, entry.name), path.join(ADAPTERS_DIR, entry.name));
        }));
    } catch {
        // ignore seeding failures, registry will continue loading existing files only
    }
}

export function refreshBundledAdaptersIfNeededSync() {
    if (!fs.existsSync(ADAPTER_EXAMPLES_DIR)) {
        return;
    }

    for (const [fileName, knownHashes] of Object.entries(BUNDLED_ADAPTER_HASHES)) {
        const runtimePath = path.join(ADAPTERS_DIR, fileName);
        const examplePath = path.join(ADAPTER_EXAMPLES_DIR, fileName);
        if (!fs.existsSync(runtimePath) || !fs.existsSync(examplePath)) {
            continue;
        }

        const currentContent = fs.readFileSync(runtimePath, 'utf8');
        if (knownHashes.has(sha256(currentContent))) {
            fs.copyFileSync(examplePath, runtimePath);
        }
    }
}

export async function refreshBundledAdaptersIfNeeded() {
    try {
        for (const [fileName, knownHashes] of Object.entries(BUNDLED_ADAPTER_HASHES)) {
            const runtimePath = path.join(ADAPTERS_DIR, fileName);
            const examplePath = path.join(ADAPTER_EXAMPLES_DIR, fileName);
            try {
                const currentContent = await fsp.readFile(runtimePath, 'utf8');
                if (knownHashes.has(sha256(currentContent))) {
                    await fsp.copyFile(examplePath, runtimePath);
                }
            } catch {
                // ignore missing files or IO failures
            }
        }
    } catch {
        // ignore refresh failures
    }
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
