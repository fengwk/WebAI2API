import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const uploads = new Map();

function isPathInsideDir(filePath, dirPath) {
    const resolvedFile = path.resolve(String(filePath || ''));
    const resolvedDir = path.resolve(String(dirPath || ''));
    return resolvedFile === resolvedDir || resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
}

export function registerUploadedFile(savedFile, options = {}) {
    const uploadId = crypto.randomUUID();
    uploads.set(uploadId, {
        path: savedFile.path,
        fileName: options.fileName || savedFile.fileName,
        mimeType: options.mimeType || savedFile.mimeType,
        fieldName: options.fieldName || null,
        size: options.size ?? null,
        createdAt: Date.now()
    });
    return {
        uploadId,
        fileName: options.fileName || savedFile.fileName,
        mimeType: options.mimeType || savedFile.mimeType,
        fieldName: options.fieldName || null,
        size: options.size ?? null
    };
}

export async function resolveUploadedFile(uploadId, options = {}) {
    const { tempDir, fileName, mimeType } = options;
    if (!tempDir) {
        throw new Error('缺少 tempDir');
    }
    const record = uploads.get(String(uploadId || ''));
    if (!record) {
        throw new Error(`上传文件不存在: ${uploadId}`);
    }
    if (!isPathInsideDir(record.path, tempDir)) {
        throw new Error('上传文件路径不在 tempDir 内');
    }
    const stat = await fs.stat(record.path).catch(() => null);
    if (!stat || !stat.isFile()) {
        throw new Error(`上传文件不存在: ${uploadId}`);
    }
    return {
        path: path.resolve(record.path),
        fileName: fileName || record.fileName,
        mimeType: mimeType || record.mimeType,
        sourceUrl: null
    };
}
