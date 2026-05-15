import fs from 'fs/promises';
import { buildChatCompletion } from '../../server/respond.js';

export function coerceInputPayload(body) {
    if (body && typeof body.input === 'object' && body.input !== null) {
        return body.input;
    }
    return body || {};
}

export function getConfiguredModels(definition) {
    if (Array.isArray(definition?.models)) {
        return definition.models;
    }
    if (Array.isArray(definition?.provider?.models)) {
        return definition.provider.models;
    }
    return [];
}

export function pickDefaultModel(definition, requestedModel = null) {
    const models = getConfiguredModels(definition);
    if (requestedModel) {
        return String(requestedModel);
    }
    return models[0] || null;
}

export function normalizeIntegerField(value, options = {}) {
    const { fieldName = 'value', defaultValue = 1, min = 1, max = 10 } = options;
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
        throw new Error(`${fieldName} 必须是 ${min}-${max} 之间的整数`);
    }
    return normalized;
}

export function normalizeStringField(value, options = {}) {
    const { fieldName = 'value', required = false, allowEmpty = false } = options;
    if (value === undefined || value === null) {
        if (required) {
            throw new Error(`${fieldName} 是必填字段`);
        }
        return '';
    }
    const normalized = String(value);
    if (!allowEmpty && required && !normalized.trim()) {
        throw new Error(`${fieldName} 不能为空`);
    }
    return normalized;
}

export function normalizeResponseFormat(value) {
    if (value === undefined || value === null || value === '') {
        return 'url';
    }
    const normalized = String(value).trim();
    if (!['url', 'b64_json'].includes(normalized)) {
        throw new Error('response_format 仅支持 url 或 b64_json');
    }
    return normalized;
}

export function buildModelField(definition) {
    const models = getConfiguredModels(definition);
    return {
        key: 'model',
        label: '模型',
        type: 'select',
        required: models.length > 0,
        options: models.map(model => ({ label: model, value: model })),
        disabled: models.length <= 1,
        defaultValue: models[0] || ''
    };
}

export async function imageEntriesToOpenAIData(images, responseFormat) {
    const data = [];
    for (const image of images || []) {
        const item = {};

        if (responseFormat === 'b64_json') {
            if (image?.b64_json) {
                item.b64_json = image.b64_json;
            } else if (image?.file?.absolutePath) {
                const buffer = await fs.readFile(image.file.absolutePath);
                item.b64_json = buffer.toString('base64');
            } else {
                throw new Error('图片结果缺少可编码内容');
            }
        } else {
            if (!image?.file?.url && !image?.url) {
                throw new Error('图片结果缺少 URL');
            }
            item.url = image.file?.url || image.url;
        }

        if (image?.revisedPrompt) {
            item.revised_prompt = image.revisedPrompt;
        }

        data.push(item);
    }
    return data;
}

export function summarizeMessages(messages = []) {
    return messages.map(message => {
        if (typeof message?.content === 'string') {
            return `${message.role}: ${message.content}`;
        }
        if (Array.isArray(message?.content)) {
            const text = message.content
                .filter(part => part?.type === 'text')
                .map(part => part.text)
                .join(' ');
            return `${message.role}: ${text}`;
        }
        return `${message?.role || 'user'}:`;
    }).join('\n');
}

export function buildChatResponseDescriptor(modelName, result, stream) {
    const content = String(result?.content || '');
    return {
        responseType: 'chat',
        stream: !!stream,
        content,
        reasoningContent: result?.reasoningContent || null,
        body: buildChatCompletion(content, modelName, result?.reasoningContent || null)
    };
}

export function buildImagesResponseDescriptor(modelName, result, body) {
    return {
        responseType: 'json',
        modelName,
        status: 200,
        body
    };
}
