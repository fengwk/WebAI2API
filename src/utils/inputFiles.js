import fs from 'fs/promises';
import path from 'path';
import { resolveUploadedFile } from '../backend/uploadStore.js';

const MIME_EXTENSION_MAP = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf'
};

function sanitizeFileName(fileName) {
    return String(fileName || 'upload')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/^_+|_+$/g, '') || 'upload';
}

function mimeTypeToExtension(mimeType, fallback = 'bin') {
    const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (!normalized) return fallback;
    return MIME_EXTENSION_MAP[normalized] || normalized.split('/')[1] || fallback;
}

function extToMimeType(fileName, fallback = 'application/octet-stream') {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.webp': return 'image/webp';
        case '.gif': return 'image/gif';
        case '.pdf': return 'application/pdf';
        default: return fallback;
    }
}

function buildTempFileName(prefix, fileName, mimeType) {
    const baseName = sanitizeFileName(fileName || prefix);
    if (path.extname(baseName)) {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${baseName}`;
    }
    const ext = mimeTypeToExtension(mimeType);
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${baseName}.${ext}`;
}

export function parseDataUrl(dataUrl) {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!match) {
        throw new Error('无效的 data URL');
    }

    return {
        mimeType: match[1].trim().toLowerCase(),
        buffer: Buffer.from(match[2], 'base64')
    };
}

export async function saveBufferToTempFile(buffer, options = {}) {
    const { tempDir, prefix = 'upload', fileName = 'upload', mimeType = 'application/octet-stream' } = options;
    if (!tempDir) {
        throw new Error('缺少 tempDir');
    }

    await fs.mkdir(tempDir, { recursive: true });
    const finalFileName = buildTempFileName(prefix, fileName, mimeType);
    const filePath = path.join(tempDir, finalFileName);
    await fs.writeFile(filePath, buffer);
    return {
        path: filePath,
        fileName: finalFileName,
        mimeType: mimeType || extToMimeType(finalFileName)
    };
}

export async function saveDataUrlToTempFile(dataUrl, options = {}) {
    const parsed = parseDataUrl(dataUrl);
    return await saveBufferToTempFile(parsed.buffer, {
        ...options,
        mimeType: parsed.mimeType,
        fileName: options.fileName || `upload.${mimeTypeToExtension(parsed.mimeType)}`
    });
}

export async function saveRemoteUrlToTempFile(url, options = {}) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`远程文件下载失败: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || options.mimeType || 'application/octet-stream';
    const fileName = options.fileName || `remote.${mimeTypeToExtension(contentType)}`;
    const buffer = Buffer.from(await response.arrayBuffer());
    const saved = await saveBufferToTempFile(buffer, {
        ...options,
        fileName,
        mimeType: contentType
    });

    return {
        ...saved,
        sourceUrl: url
    };
}

export async function saveInputValueToTempFile(value, options = {}) {
    if (typeof value === 'string') {
        if (value.startsWith('data:')) {
            return await saveDataUrlToTempFile(value, options);
        }
        if (/^https?:\/\//i.test(value)) {
            return await saveRemoteUrlToTempFile(value, options);
        }
    }

    if (value && typeof value === 'object') {
        if (typeof value.uploadId === 'string' && value.uploadId.trim()) {
            return await resolveUploadedFile(value.uploadId.trim(), {
                tempDir: options.tempDir,
                fileName: value.fileName,
                mimeType: value.mimeType
            });
        }
        if (Buffer.isBuffer(value.buffer)) {
            return await saveBufferToTempFile(value.buffer, {
                ...options,
                fileName: value.fileName || options.fileName,
                mimeType: value.mimeType || options.mimeType
            });
        }
        if (typeof value.dataUrl === 'string') {
            return await saveDataUrlToTempFile(value.dataUrl, {
                ...options,
                fileName: value.fileName || options.fileName,
                mimeType: value.mimeType || options.mimeType
            });
        }
        if (typeof value.url === 'string') {
            return await saveRemoteUrlToTempFile(value.url, {
                ...options,
                fileName: value.fileName || options.fileName,
                mimeType: value.mimeType || options.mimeType
            });
        }
        if (typeof value.base64 === 'string') {
            const mimeType = value.mimeType || extToMimeType(value.fileName || 'upload.bin');
            return await saveBufferToTempFile(Buffer.from(value.base64, 'base64'), {
                ...options,
                fileName: value.fileName || options.fileName,
                mimeType
            });
        }
    }

    throw new Error('不支持的文件输入');
}

export function toUploadDescriptor(savedFile) {
    return {
        path: savedFile.path,
        fileName: savedFile.fileName,
        mimeType: savedFile.mimeType,
        sourceUrl: savedFile.sourceUrl || null
    };
}
