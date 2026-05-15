import fs from 'fs/promises';
import path from 'path';

function encodeRelativePath(relativePath) {
    return String(relativePath)
        .split('/')
        .filter(Boolean)
        .map(part => encodeURIComponent(part))
        .join('/');
}

export function normalizeRelativePath(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
    if (!normalized) {
        throw new Error('relativePath 不能为空');
    }
    if (normalized.includes('..')) {
        throw new Error('relativePath 不允许包含 ..');
    }
    return normalized;
}

function detectMimeType(relativePath, fallback) {
    const ext = path.extname(relativePath).toLowerCase();
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.webp': return 'image/webp';
        case '.gif': return 'image/gif';
        case '.html': return 'text/html; charset=utf-8';
        case '.txt': return 'text/plain; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        case '.pdf': return 'application/pdf';
        default: return fallback || 'application/octet-stream';
    }
}

function normalizeContent(content) {
    if (Buffer.isBuffer(content)) {
        return { data: content, encoding: null };
    }
    if (typeof content === 'string') {
        if (content.startsWith('data:')) {
            const match = /^data:([^;]+);base64,(.+)$/s.exec(content);
            if (!match) {
                throw new Error('无效的 data URL');
            }
            return {
                data: Buffer.from(match[2], 'base64'),
                encoding: null,
                mimeType: match[1].trim().toLowerCase()
            };
        }
        return { data: content, encoding: 'utf8' };
    }
    throw new Error('不支持的文件内容类型');
}

export async function saveRuntimeFile(options = {}) {
    const { rootDir, urlBasePath, relativePath, content, mimeType } = options;
    if (!rootDir || !urlBasePath) {
        throw new Error('文件输出上下文未配置');
    }

    const normalizedRelativePath = normalizeRelativePath(relativePath);
    const targetPath = path.join(rootDir, normalizedRelativePath);
    if (!targetPath.startsWith(rootDir)) {
        throw new Error('relativePath 非法');
    }

    const normalized = normalizeContent(content);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, normalized.data, normalized.encoding ? { encoding: normalized.encoding } : undefined);

    return {
        relativePath: normalizedRelativePath,
        absolutePath: targetPath,
        url: `${urlBasePath.replace(/\/$/, '')}/${encodeRelativePath(normalizedRelativePath)}`,
        mimeType: detectMimeType(normalizedRelativePath, mimeType || normalized.mimeType)
    };
}
