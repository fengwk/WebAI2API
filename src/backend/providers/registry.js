import { openaiChatCompletionsProvider } from './openaiChatCompletions.js';
import { openaiImagesGenerationsProvider } from './openaiImagesGenerations.js';
import { openaiImagesEditsProvider } from './openaiImagesEdits.js';

const PROVIDERS = new Map([
    [openaiChatCompletionsProvider.type, openaiChatCompletionsProvider],
    [openaiImagesGenerationsProvider.type, openaiImagesGenerationsProvider],
    [openaiImagesEditsProvider.type, openaiImagesEditsProvider]
]);

export function getProvider(type) {
    return PROVIDERS.get(type) || null;
}

export function listProviders() {
    return Array.from(PROVIDERS.values()).map(provider => ({ type: provider.type }));
}

export function hasProvider(type) {
    return PROVIDERS.has(type);
}
