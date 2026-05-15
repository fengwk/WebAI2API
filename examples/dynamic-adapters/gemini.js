const TARGET_URL = 'https://gemini.google.com/app?hl=en';

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForInput(page, timeout = 30000) {
  const textbox = page.getByRole('textbox').first();
  await textbox.waitFor({ timeout });
  return textbox;
}

async function uploadFiles(page, imagePaths) {
  if (!imagePaths?.length) return;

  const menuBtn = page.getByRole('button', { name: 'Open upload file menu' });
  await menuBtn.click({ timeout: 10000 });

  const uploadFilesBtn = page.getByRole('menuitem', { name: /Upload files/i });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    uploadFilesBtn.click({ timeout: 10000 })
  ]);
  await chooser.setFiles(imagePaths);
}

async function downloadAsDataUrl(page, url, timeout = 120000) {
  const resp = await page.request.get(url, { timeout });
  if (!resp.ok()) {
    throw new Error(`图片下载失败: HTTP ${resp.status()}`);
  }
  const buffer = await resp.body();
  const contentType = resp.headers()['content-type'] || 'image/png';
  const mimeType = contentType.split(';')[0].trim();
  return {
    image: `data:${mimeType};base64,${buffer.toString('base64')}`,
    imageUrl: url
  };
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

export const manifest = {
  id: 'gemini',
  displayName: 'Gemini Image',
  description: 'Gemini 图片生成动态适配器，默认目标模型为 gemini-3-pro-image-preview。',
  models: [
    { id: 'gemini-3-pro-image-preview', imagePolicy: 'optional', type: 'image' }
  ],
  navigationHandlers: [],
  getTargetUrl() {
    return TARGET_URL;
  },

  async generate(ctx, prompt, imagePaths, modelId, meta) {
    const { page, api, config } = ctx;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 300000;

    api.log('info', '打开 Gemini 页面', { modelId, promptLength: prompt.length, imageCount: imagePaths.length, ...meta });
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

    if (imagePaths.length > 0) {
      api.log('info', '开始上传参考图片', { count: imagePaths.length, ...meta });
      await uploadFiles(page, imagePaths);
      await sleep(3000);
    }

    await page.getByRole('button', { name: 'Tools' }).click({ timeout: 10000 });
    await page.getByRole('menuitemcheckbox', { name: 'Create image' }).click({ timeout: 10000 });

    await inputLocator.click({ timeout: 10000 });
    await page.keyboard.insertText(prompt);

    const responsePromise = page.waitForResponse((response) => {
      return response.url().includes('assistant.lamda.BardFrontendService/StreamGenerate') && response.request().method() === 'POST';
    }, { timeout: waitTimeout });

    api.log('info', '发送提示词', meta);
    await page.getByRole('button', { name: 'Send message' }).click({ timeout: 10000 });

    const streamResponse = await responsePromise;
    if (!streamResponse.ok()) {
      return { error: `API 返回错误: HTTP ${streamResponse.status()}` };
    }

    const bodyBuffer = await streamResponse.body();
    const imageUrls = extractImageUrlsFromResponse(bodyBuffer);
    if (imageUrls.length === 0) {
      const text = extractAiTextFromResponse(bodyBuffer);
      return { error: text ? text.substring(0, 200) : '响应中未找到图片结果' };
    }

    const imageUrl = `${imageUrls[0]}=d-I`;
    api.log('info', '开始下载 Gemini 图片', { imageUrl, ...meta });
    return await downloadAsDataUrl(page, imageUrl);
  }
};
