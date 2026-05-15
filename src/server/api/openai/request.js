import { getProvider } from '../../../backend/providers/registry.js';
import { parseMultipartForm } from './multipart.js';

function buildManifestLike(defaultModel) {
    return {
        models: defaultModel ? [defaultModel] : []
    };
}

async function readRequestBuffer(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function parseContentType(contentTypeHeader) {
    const [type, ...params] = String(contentTypeHeader || '').split(';').map(item => item.trim());
    const paramMap = {};
    for (const param of params) {
        const index = param.indexOf('=');
        if (index === -1) continue;
        paramMap[param.slice(0, index)] = param.slice(index + 1).replace(/^"|"$/g, '');
    }
    return { type: type.toLowerCase(), params: paramMap };
}

function firstFieldValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

function fieldEntriesToPayload(fields, files) {
    const payload = { ...fields };

    const images = files
        .filter(file => file.name === 'image' || file.name === 'image[]')
        .map(file => ({
            buffer: file.buffer,
            fileName: file.fileName,
            mimeType: file.mimeType
        }));

    if (images.length > 0) {
        payload.images = images;
    }

    const mask = files.find(file => file.name === 'mask' || file.name === 'mask[]');
    if (mask) {
        payload.mask = {
            buffer: mask.buffer,
            fileName: mask.fileName,
            mimeType: mask.mimeType
        };
    }

    for (const key of Object.keys(payload)) {
        payload[key] = firstFieldValue(payload[key]);
    }

    return payload;
}

export async function parseProviderRequest(req, options) {
    const {
        providerType,
        tempDir,
        requestId,
        resolveDefaultModel
    } = options;

    const provider = getProvider(providerType);
    if (!provider) {
        throw new Error(`未知 provider: ${providerType}`);
    }

    const defaultModel = resolveDefaultModel ? resolveDefaultModel(providerType) : null;
    const manifestLike = buildManifestLike(defaultModel);
    const contentType = parseContentType(req.headers['content-type']);

    let payload;
    if (contentType.type === 'application/json' || !contentType.type) {
        const buffer = await readRequestBuffer(req);
        payload = buffer.length > 0 ? JSON.parse(buffer.toString('utf8')) : {};
    } else if (contentType.type === 'multipart/form-data') {
        const boundary = contentType.params.boundary;
        if (!boundary) {
            throw new Error('multipart/form-data 缺少 boundary');
        }
        const buffer = await readRequestBuffer(req);
        const { fields, files } = parseMultipartForm(buffer, boundary);
        payload = fieldEntriesToPayload(fields, files);
    } else {
        throw new Error(`不支持的 Content-Type: ${contentType.type}`);
    }

    const normalized = await provider.normalizeApiRequest(payload, {
        tempDir,
        requestId
    }, manifestLike);

    if (!normalized.modelId && defaultModel) {
        normalized.modelId = defaultModel;
        normalized.input.model = defaultModel;
    }

    if (!normalized.modelId) {
        throw new Error(`provider ${providerType} 当前没有可用模型`);
    }

    return {
        provider,
        providerType,
        payload,
        ...normalized
    };
}
