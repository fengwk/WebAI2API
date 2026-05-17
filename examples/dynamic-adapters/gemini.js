const TARGET_URL = 'https://gemini.google.com/app?hl=en';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForInput(page, timeout = 30000) {
  const textbox = page.getByRole('textbox').first();
  await textbox.waitFor({ timeout });
  return textbox;
}

async function uploadFiles(page, images) {
  if (!images?.length) return;
  const imagePaths = images.map(image => image.path).filter(Boolean);
  if (imagePaths.length === 0) return;

  const menuBtn = page.getByRole('button', { name: 'Open upload file menu' });
  await menuBtn.click({ timeout: 10000 });
  const uploadFilesBtn = page.getByRole('menuitem', { name: /Upload files/i });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    uploadFilesBtn.click({ timeout: 10000 })
  ]);
  await chooser.setFiles(imagePaths);
}

function parseLenFramedResponse(buf) {
  let i = 0;
  if (buf.length >= 4 && buf[0] === 0x29 && buf[1] === 0x5d && buf[2] === 0x7d) {
    const firstNl = buf.indexOf(0x0a);
    if (firstNl !== -1) i = firstNl + 1;
  }

  const frames = [];
  const readLineBuf = () => {
    if (i >= buf.length) return null;
    const nl = buf.indexOf(0x0a, i);
    let line;
    if (nl === -1) {
      line = buf.slice(i);
      i = buf.length;
    } else {
      line = buf.slice(i, nl);
      i = nl + 1;
    }
    if (line.length && line[line.length - 1] === 0x0d) line = line.slice(0, -1);
    return line;
  };

  let pendingLen = null;
  while (true) {
    const lineBuf = readLineBuf();
    if (lineBuf === null) break;
    const lineStr = lineBuf.toString('utf8').trim();
    if (!lineStr) continue;

    if (pendingLen === null) {
      if (/^\d+$/.test(lineStr)) pendingLen = Number(lineStr);
      continue;
    }

    let chunkStr = lineBuf.toString('utf8').trim();
    while (true) {
      try {
        frames.push(JSON.parse(chunkStr));
        break;
      } catch (e) {
        const truncated = /Unexpected end of JSON input|Unterminated string/.test(String(e?.message || ''));
        if (!truncated || i >= buf.length) break;
        const nextBuf = readLineBuf();
        if (!nextBuf) break;
        chunkStr += `\n${nextBuf.toString('utf8').trim()}`;
      }
    }
    pendingLen = null;
  }
  return frames;
}

function extractPayloads(frames) {
  const payloads = [];
  for (const frame of frames) {
    if (!Array.isArray(frame)) continue;
    for (const item of frame) {
      if (!Array.isArray(item)) continue;
      const payloadStr = item[2];
      if (typeof payloadStr !== 'string') continue;
      try {
        payloads.push(JSON.parse(payloadStr));
      } catch {
        // ignore malformed payloads
      }
    }
  }
  return payloads;
}

function walk(obj, visit) {
  if (obj == null) return;
  if (Array.isArray(obj)) {
    for (const item of obj) walk(item, visit);
    return;
  }
  if (typeof obj === 'object') {
    visit(obj);
    for (const value of Object.values(obj)) walk(value, visit);
  }
}

function extractImageUrlsFromResponse(buf) {
  const payloads = extractPayloads(parseLenFramedResponse(buf));
  const urls = [];
  const seen = new Set();
  const pushUrl = (u) => {
    if (typeof u !== 'string') return;
    if (!/^https?:\/\//.test(u)) return;
    if (!/googleusercontent\.com\/gg-dl|googleusercontent\.com\/rd-gg-dl|gstatic\.com|googleapis\.com/i.test(u)) return;
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };
  for (const payload of payloads) {
    walk(payload, (node) => {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'string') {
          if (/image|thumbnail|uri|url/i.test(key)) pushUrl(value);
          const matches = value.match(/https?:\/\/[^\s"']+/g) || [];
          for (const match of matches) pushUrl(match);
        }
      }
    });
  }
  return urls;
}

function extractAiTextFromResponse(buf) {
  const payloads = extractPayloads(parseLenFramedResponse(buf));
  let best = '';
  for (const payload of payloads) {
    walk(payload, (node) => {
      for (const value of Object.values(node)) {
        if (typeof value === 'string' && value.length > best.length) {
          best = value;
        }
      }
    });
  }
  return best;
}

function buildPrompt(input) {
  const prompt = String(input.prompt || '').trim();
  const size = String(input.size || '').trim();
  if (!size) return prompt;
  return `${prompt}\n\n将宽高比设置为${size}`;
}

function normalizeOutputImage(file) {
  return {
    mimeType: file.mimeType,
    base64: file.base64
  };
}

async function executeGemini(ctx, input) {
  const { page, api, config, helpers } = ctx;
  const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;
  const prompt = buildPrompt(input);
  const images = await helpers.files.resolveMany(Array.isArray(input.images) ? input.images : [], { prefix: 'gemini-input' });

  api.log('info', '打开 Gemini 页面', {
    promptLength: prompt.length,
    imageCount: images.length
  });

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const useTempChat = config?.backend?.adapter?.gemini?.temporaryChat || false;
  if (useTempChat) {
    try {
      await page.getByRole('button', { name: 'Temporary chat' }).click({ timeout: 3000 });
    } catch {
      // ignore
    }
  }

  const inputLocator = await waitForInput(page);
  await sleep(500);

  if (images.length > 0) {
    await uploadFiles(page, images);
    await sleep(3000);
  }

  await page.getByRole('button', { name: 'Tools' }).click({ timeout: 10000 });
  await page.getByRole('menuitemcheckbox', { name: 'Create image' }).click({ timeout: 10000 });
  await inputLocator.click({ timeout: 10000 });
  await page.keyboard.insertText(prompt);

  const responsePromise = page.waitForResponse((response) => {
    return response.url().includes('assistant.lamda.BardFrontendService/StreamGenerate') && response.request().method() === 'POST';
  }, { timeout: waitTimeout });

  await page.getByRole('button', { name: 'Send message' }).click({ timeout: 10000 });
  const streamResponse = await responsePromise;
  if (!streamResponse.ok()) {
    throw helpers.apiError({ message: `API 返回错误: HTTP ${streamResponse.status()}`, status: 502, retryable: true });
  }

  const bodyBuffer = await streamResponse.body();
  const imageUrls = extractImageUrlsFromResponse(bodyBuffer);
  if (imageUrls.length === 0) {
    const text = extractAiTextFromResponse(bodyBuffer);
    throw helpers.apiError({ message: text ? text.slice(0, 400) : '响应中未找到图片结果', status: 400, retryable: false });
  }

  const imageUrl = imageUrls[0].includes('=') ? imageUrls[0] : `${imageUrls[0]}=d-I`;
  const image = await helpers.files.fromUrl(imageUrl, {
    mode: 'object',
    fileName: 'gemini-result.png',
    mimeType: 'image/png'
  });
  return { image: normalizeOutputImage(image) };
}

export const manifest = {
  id: 'gemini',
  name: 'Gemini',
  inputJsonSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: {
        type: 'string',
        title: 'Prompt',
        description: '输入提示词',
        'x-ui': 'textarea'
      },
      size: {
        type: 'string',
        title: 'Size',
        default: '1024x1024'
      },
      images: {
        type: 'array',
        title: '参考图片',
        description: '留空则文生图，上传图片则按编辑图处理',
        'x-ui': 'files',
        'x-accept': 'image/*',
        items: {
          type: 'object',
          required: ['mimeType', 'base64'],
          properties: {
            fileName: { type: 'string' },
            mimeType: { type: 'string' },
            base64: { type: 'string' }
          }
        }
      }
    }
  },
  outputJsonSchema: {
    type: 'object',
    required: ['image'],
    properties: {
      image: {
        type: 'object',
        required: ['mimeType', 'base64'],
        properties: {
          fileName: { type: 'string' },
          mimeType: { type: 'string' },
          base64: { type: 'string' }
        }
      }
    }
  },
  async execute(ctx, input) {
    return await executeGemini(ctx, input);
  }
};
