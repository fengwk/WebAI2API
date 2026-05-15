const TARGET_URL = 'https://gemini.google.com/app?hl=en';

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
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

async function downloadImage(api, page, url, timeout = 120000) {
  const resp = await page.request.get(url, { timeout });
  if (!resp.ok()) {
    throw new Error(`图片下载失败: HTTP ${resp.status()}`);
  }
  const buffer = await resp.body();
  const contentType = resp.headers()['content-type'] || 'image/png';
  const mimeType = contentType.split(';')[0].trim();
  return await api.saveFile({
    relativePath: 'gemini/result.png',
    content: buffer,
    mimeType
  });
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
        const msg = String(e?.message || '');
        const truncated = /Unexpected end of JSON input|Unterminated string/.test(msg);
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
  const frames = parseLenFramedResponse(buf);
  const urls = [];
  const seen = new Set();
  const pushUrl = (u) => {
    if (typeof u !== 'string') return;
    if (!/^https?:\/\//.test(u)) return;
    if (!/googleusercontent\.com|gstatic\.com|googleapis\.com/i.test(u)) return;
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };

  for (const frame of frames) {
    walk(frame, (node) => {
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
  try {
    const text = buf.toString('utf8');
    const matches = text.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g) || [];
    const candidates = matches
      .map(item => item.slice(1, -1))
      .map(item => item.replace(/\\n/g, ' ').replace(/\\"/g, '"'))
      .filter(item => /sorry|unable|can'?t|cannot|policy|violat|rate limit/i.test(item));
    return candidates[0] || '';
  } catch {
    return '';
  }
}

function buildPrompt(input) {
  const prompt = String(input.prompt || '').trim();
  const size = String(input.size || '').trim();
  if (!size) return prompt;
  return `${prompt}\n\n将宽高比设置为 ${size}`;
}

async function executeGeminiImage(ctx, input) {
  const { page, api, config } = ctx;
  const waitTimeout = config?.backend?.pool?.waitTimeout ?? 300000;
  const prompt = buildPrompt(input);
  const images = input.images || [];

  api.log('info', '打开 Gemini 页面', {
    providerType: input.providerType,
    model: input.model,
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
    api.log('info', '开始上传参考图片', { count: images.length });
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
    return {
      success: false,
      error: {
        message: `API 返回错误: HTTP ${streamResponse.status()}`,
        retryable: true
      }
    };
  }

  const bodyBuffer = await streamResponse.body();
  const imageUrls = extractImageUrlsFromResponse(bodyBuffer);
  if (imageUrls.length === 0) {
    const text = extractAiTextFromResponse(bodyBuffer);
    return {
      success: false,
      error: {
        message: text ? text.substring(0, 200) : '响应中未找到图片结果',
        retryable: false
      }
    };
  }

  const file = await downloadImage(api, page, `${imageUrls[0]}=d-I`);
  return {
    success: true,
    data: {
      created: Math.floor(Date.now() / 1000),
      images: [
        {
          file
        }
      ]
    }
  };
}

export const manifest = {
  id: 'gemini',
  name: 'Gemini',
  providers: [
    {
      type: 'openai-images-generations',
      models: ['gemini-3-pro-image-preview'],
      async execute(ctx, input) {
        return await executeGeminiImage(ctx, {
          ...input,
          providerType: 'openai-images-generations'
        });
      }
    },
    {
      type: 'openai-images-edits',
      models: ['gemini-3-pro-image-preview'],
      async execute(ctx, input) {
        return await executeGeminiImage(ctx, {
          ...input,
          providerType: 'openai-images-edits'
        });
      }
    }
  ]
};
