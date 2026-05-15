import { buildImagesResponseDescriptor, buildModelField, coerceInputPayload, imageEntriesToOpenAIData, normalizeIntegerField, normalizeResponseFormat, normalizeStringField, pickDefaultModel } from './common.js';

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
                defaultValue: 'url',
                options: [
                    { label: 'url', value: 'url' },
                    { label: 'b64_json', value: 'b64_json' }
                ]
            }
        ]
    };
}

function normalizeImageInput(body, manifest) {
    const prompt = normalizeStringField(body.prompt, { fieldName: 'prompt', required: true });
    const modelId = pickDefaultModel(manifest, body.model);
    return {
        modelId,
        input: {
            model: modelId,
            prompt,
            size: body.size ? String(body.size) : '',
            n: normalizeIntegerField(body.n, { fieldName: 'n', defaultValue: 1, min: 1, max: 10 }),
            responseFormat: normalizeResponseFormat(body.response_format || body.responseFormat),
            quality: body.quality ? String(body.quality) : '',
            background: body.background ? String(body.background) : '',
            moderation: body.moderation ? String(body.moderation) : '',
            outputFormat: body.output_format ? String(body.output_format) : '',
            outputCompression: body.output_compression ?? null
        },
        cleanupPaths: [],
        promptText: prompt,
        inputFiles: []
    };
}

export const openaiImagesGenerationsProvider = {
    type: 'openai-images-generations',
    buildInputSchema: buildSchema,
    async normalizeApiRequest(body, _context, manifest) {
        return normalizeImageInput(body, manifest);
    },
    async normalizeAdminInput(body, _context, manifest) {
        return normalizeImageInput(coerceInputPayload(body), manifest);
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
            inputFiles: []
        };
    }
};
