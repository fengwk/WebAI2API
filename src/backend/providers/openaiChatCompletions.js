import { buildChatResponseDescriptor, buildModelField, coerceInputPayload, normalizeStringField, pickDefaultModel, summarizeMessages } from './common.js';
import { saveInputValueToTempFile, toUploadDescriptor } from '../../utils/inputFiles.js';

async function normalizeMessageContent(content, context) {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return '';
    }

    const normalized = [];
    const cleanupPaths = [];

    for (const part of content) {
        if (!part || typeof part !== 'object') continue;

        if (part.type === 'text') {
            normalized.push({ type: 'text', text: String(part.text || '') });
            continue;
        }

        if (part.type === 'image_url' && part.image_url?.url) {
            const saved = await saveInputValueToTempFile(part.image_url.url, {
                tempDir: context.tempDir,
                prefix: 'chat-image',
                fileName: 'image'
            });
            cleanupPaths.push(saved.path);
            normalized.push({ type: 'image_file', file: toUploadDescriptor(saved) });
        }
    }

    return { content: normalized, cleanupPaths };
}

async function normalizeMessages(messages, context) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('messages 是必填字段且必须是数组');
    }

    const normalizedMessages = [];
    const cleanupPaths = [];

    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;

        const role = String(message.role || 'user');
        const normalizedContent = await normalizeMessageContent(message.content, context);

        if (typeof normalizedContent === 'string') {
            normalizedMessages.push({ role, content: normalizedContent });
            continue;
        }

        cleanupPaths.push(...normalizedContent.cleanupPaths);
        normalizedMessages.push({ role, content: normalizedContent.content });
    }

    if (normalizedMessages.length === 0) {
        throw new Error('messages 不能为空');
    }

    return { messages: normalizedMessages, cleanupPaths };
}

function parseMessagesField(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim()) {
        return JSON.parse(value);
    }
    return value;
}

export const openaiChatCompletionsProvider = {
    type: 'openai-chat-completions',
    buildInputSchema(manifest) {
        return {
            fields: [
                buildModelField(manifest),
                {
                    key: 'messages',
                    label: 'Messages(JSON)',
                    type: 'json',
                    required: true,
                    defaultValue: JSON.stringify([
                        { role: 'user', content: 'Hello' }
                    ], null, 2)
                },
                {
                    key: 'reasoning',
                    label: 'Reasoning',
                    type: 'switch',
                    defaultValue: false
                },
                {
                    key: 'stream',
                    label: 'Stream',
                    type: 'switch',
                    defaultValue: false
                }
            ]
        };
    },
    async normalizeApiRequest(body, context, manifest) {
        const { messages, cleanupPaths } = await normalizeMessages(body.messages, context);
        const modelId = pickDefaultModel(manifest, body.model);
        return {
            modelId,
            input: {
                model: modelId,
                messages,
                reasoning: body.reasoning === true,
                stream: body.stream === true,
                options: {
                    temperature: body.temperature,
                    max_tokens: body.max_tokens,
                    response_format: body.response_format
                }
            },
            cleanupPaths,
            promptText: summarizeMessages(messages),
            inputFiles: messages.flatMap(message => Array.isArray(message.content)
                ? message.content.filter(part => part.type === 'image_file').map(part => part.file.path)
                : [])
        };
    },
    async normalizeAdminInput(body, context, manifest) {
        const input = coerceInputPayload(body);
        const messages = input.messages
            ? parseMessagesField(input.messages)
            : [{ role: 'user', content: normalizeStringField(input.prompt || '', { fieldName: 'prompt', required: true }) }];
        return await this.normalizeApiRequest({ ...input, messages }, context, manifest);
    },
    async buildSuccessResponse(options) {
        const { modelName, input, result } = options;
        return buildChatResponseDescriptor(modelName || input.model || 'unknown-model', result, input.stream === true);
    },
    async buildHistory(options) {
        const { input, result } = options;
        return {
            responseText: String(result?.content || ''),
            reasoningContent: result?.reasoningContent || null,
            responseMediaSource: { success: true, data: result },
            promptText: summarizeMessages(input.messages || []),
            inputFiles: (input.messages || []).flatMap(message => Array.isArray(message.content)
                ? message.content.filter(part => part.type === 'image_file').map(part => part.file.path)
                : [])
        };
    }
};
