import { buildImagesResponseDescriptor, buildModelField, coerceInputPayload, imageEntriesToOpenAIData, normalizeIntegerField, normalizeResponseFormat, normalizeStringField, pickDefaultModel } from './common.js';
import { saveInputValueToTempFile, toUploadDescriptor } from '../../utils/inputFiles.js';

async function normalizeInputImages(items, context) {
    const values = Array.isArray(items) ? items : (items ? [items] : []);
    const uploads = [];
    const cleanupPaths = [];
    for (const item of values) {
        const saved = await saveInputValueToTempFile(item, {
            tempDir: context.tempDir,
            prefix: 'image-edit',
            fileName: item?.fileName || 'image'
        });
        uploads.push(toUploadDescriptor(saved));
        cleanupPaths.push(saved.path);
    }
    return { uploads, cleanupPaths };
}

async function normalizeMask(mask, context) {
    if (!mask) return { upload: null, cleanupPaths: [] };
    const saved = await saveInputValueToTempFile(mask, {
        tempDir: context.tempDir,
        prefix: 'image-mask',
        fileName: mask?.fileName || 'mask'
    });
    return { upload: toUploadDescriptor(saved), cleanupPaths: [saved.path] };
}

function buildSchema(manifest) {
    return {
        fields: [
            buildModelField(manifest),
            {
                key: 'prompt',
                label: 'Prompt',
                type: 'textarea',
                required: true,
                defaultValue: ''
            },
            {
                key: 'images',
                label: 'Images',
                type: 'file',
                required: true,
                multiple: true,
                accept: 'image/*'
            },
            {
                key: 'mask',
                label: 'Mask',
                type: 'file',
                required: false,
                multiple: false,
                accept: 'image/*'
            },
            {
                key: 'size',
                label: 'Size',
                type: 'input',
                defaultValue: '1024x1024'
            },
            {
                key: 'n',
                label: 'N',
                type: 'number',
                min: 1,
                max: 10,
                defaultValue: 1
            },
            {
                key: 'response_format',
                label: 'Response Format',
                type: 'select',
                defaultValue: 'b64_json',
                options: [
                    { label: 'url', value: 'url' },
                    { label: 'b64_json', value: 'b64_json' }
                ]
            }
        ]
    };
}

function resolveResponseFormat(body) {
    const legacyValue = body.response_format || body.responseFormat;
    if (legacyValue !== undefined && legacyValue !== null && legacyValue !== '') {
        return normalizeResponseFormat(legacyValue);
    }

    if (body.output_format === 'url' || body.output_format === 'b64_json') {
        return normalizeResponseFormat(body.output_format);
    }

    return 'b64_json';
}

async function normalizeEditInput(body, context, manifest) {
    const prompt = normalizeStringField(body.prompt, { fieldName: 'prompt', required: true });
    const { uploads, cleanupPaths } = await normalizeInputImages(body.images || body.image, context);
    if (uploads.length === 0) {
        throw new Error('image 是必填字段');
    }
    const mask = await normalizeMask(body.mask, context);
    const modelId = pickDefaultModel(manifest, body.model);
    const size = body.size ? String(body.size) : '1024x1024';
    return {
        modelId,
        input: {
            model: modelId,
            prompt,
            images: uploads,
            mask: mask.upload,
            size,
            n: normalizeIntegerField(body.n, { fieldName: 'n', defaultValue: 1, min: 1, max: 10 }),
            responseFormat: resolveResponseFormat(body),
            quality: body.quality ? String(body.quality) : '',
            background: body.background ? String(body.background) : '',
            moderation: body.moderation ? String(body.moderation) : '',
            outputFormat: body.output_format && !['url', 'b64_json'].includes(String(body.output_format))
                ? String(body.output_format)
                : '',
            outputCompression: body.output_compression ?? null,
            user: body.user ? String(body.user) : ''
        },
        cleanupPaths: [...cleanupPaths, ...mask.cleanupPaths],
        promptText: prompt,
        inputFiles: uploads.map(item => item.path)
    };
}

export const openaiImagesEditsProvider = {
    type: 'openai-images-edits',
    buildInputSchema: buildSchema,
    async normalizeApiRequest(body, context, manifest) {
        return await normalizeEditInput(body, context, manifest);
    },
    async normalizeAdminInput(body, context, manifest) {
        return await normalizeEditInput(coerceInputPayload(body), context, manifest);
    },
    async buildSuccessResponse(options) {
        const { input, result, modelName } = options;
        const data = await imageEntriesToOpenAIData(result?.images || [], input.responseFormat);
        return buildImagesResponseDescriptor(modelName || input.model || 'unknown-model', result, {
            created: result?.created || Math.floor(Date.now() / 1000),
            data
        });
    },
    async buildHistory(options) {
        const { input, result } = options;
        const urls = (result?.images || []).map(item => item.file?.url || item.url).filter(Boolean);
        return {
            responseText: urls.join('\n'),
            reasoningContent: null,
            responseMediaSource: { success: true, data: result },
            promptText: input.prompt,
            inputFiles: input.images.map(item => item.path)
        };
    }
};
