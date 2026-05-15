import { manifest as generateManifest } from './chatgpt_image_generate.js';

export const manifest = {
  ...generateManifest,
  id: 'chatgpt_image_edit',
  name: 'ChatGPT Image Edit',
  provider: {
    type: 'openai-images-edits',
    models: ['gpt-image-2']
  }
};
