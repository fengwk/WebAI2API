import { manifest as generateManifest } from './gemini_image_generate.js';

export const manifest = {
  ...generateManifest,
  id: 'gemini_image_edit',
  name: 'Gemini Image Edit',
  provider: {
    type: 'openai-images-edits',
    models: ['gemini-3-pro-image-preview']
  }
};
