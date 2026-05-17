const TARGET_URL = 'https://chatgpt.com/';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clickFirstAvailable(locators, options = {}) {
  for (const locator of locators) {
    try {
      await locator.click(options);
      return true;
    } catch {
      // try next locator
    }
  }
  return false;
}

async function waitForComposer(page, timeout = 30000) {
  const locators = [
    page.locator('#prompt-textarea'),
    page.locator('.ProseMirror'),
    page.getByRole('textbox')
  ];

  for (const locator of locators) {
    try {
      await locator.first().waitFor({ timeout, state: 'visible' });
      return locator.first();
    } catch {
      // try next locator
    }
  }

  throw new Error('未找到 ChatGPT 输入框');
}

async function startNewChatIfPossible(page) {
  await clickFirstAvailable([
    page.getByRole('button', { name: /新聊天/i }),
    page.getByRole('button', { name: /New chat/i }),
    page.locator("[data-testid='create-new-chat-button']")
  ], { timeout: 5000 });
}

async function openComposerMenu(page) {
  const opened = await clickFirstAvailable([
    page.getByRole('button', { name: /添加文件等/i }),
    page.getByRole('button', { name: /Add files and more/i }),
    page.locator('#composer-plus-btn'),
    page.locator("[data-testid='composer-plus-btn']")
  ], { timeout: 5000 });

  if (!opened) {
    throw new Error('未找到 ChatGPT 加号菜单按钮');
  }
}

async function enableImageMode(page, api) {
  await openComposerMenu(page);
  const enabled = await clickFirstAvailable([
    page.getByRole('menuitem', { name: /创建图片/i }),
    page.getByRole('menuitem', { name: /Create image/i }),
    page.getByText('创建图片', { exact: false }),
    page.getByText('Create image', { exact: false })
  ], { timeout: 5000 });
  api.log('info', '切换创建图片模式', { enabled });
  return enabled;
}

function getGeneratedImageSelector() {
  return 'img[alt*="已生成图片"], img[alt*="Generated image"]';
}

function getAssistantMessageSelector() {
  return '[data-message-author-role="assistant"]';
}

function isAssistantErrorText(text) {
  return /guardrails|nudity|sexuality|erotic|violat|policy|rate limit|we[’']?re so sorry|retry or edit|usage policies|our policies|内容可能违反|使用政策|给此回复点个[“"]?踩|抱歉|违规|限制|重试/i.test(text);
}

function isAssistantProgressText(text) {
  return /analyzing images|正在思考|正在生成更细致的图片|generating a more detailed image|please wait/i.test(text);
}

async function getAssistantMessageData(locator) {
  return await locator.evaluate((root) => {
    const texts = [];
    const pushText = (value) => {
      const normalized = String(value || '').replace(/\s+/g, ' ').trim();
      if (normalized && !texts.includes(normalized)) {
        texts.push(normalized);
      }
    };

    const selectors = [
      '.text-token-text-error',
      '.markdown',
      '[data-testid="image-gen-loading-state-frame"]',
      '[data-testid="image-gen-loading-state"]'
    ];

    for (const selector of selectors) {
      root.querySelectorAll(selector).forEach((node) => pushText(node.innerText || node.textContent || ''));
    }

    if (texts.length === 0) {
      pushText(root.innerText || root.textContent || '');
    }

    const messageId = root.getAttribute('data-message-id') || root.closest('[data-turn-id]')?.getAttribute('data-turn-id') || '';
    return {
      key: messageId || texts.join('|').slice(0, 200),
      text: texts.join('\n')
    };
  });
}

async function collectExistingAssistantTextKeys(page) {
  const locator = page.locator(getAssistantMessageSelector());
  const count = await locator.count().catch(() => 0);
  const keys = new Set();
  for (let i = 0; i < count; i++) {
    const data = await getAssistantMessageData(locator.nth(i)).catch(() => null);
    if (data?.text) keys.add(data.key);
  }
  return keys;
}

async function collectExistingGeneratedImageKeys(page) {
  const locator = page.locator(getGeneratedImageSelector());
  const count = await locator.count().catch(() => 0);
  const keys = new Set();
  for (let i = 0; i < count; i++) {
    try {
      const key = await locator.nth(i).evaluate((img) => `${img.id || ''}|${img.getAttribute('alt') || ''}|${img.currentSrc || img.getAttribute('src') || ''}`);
      keys.add(key);
    } catch {
      // ignore
    }
  }
  return keys;
}

async function findNewGeneratedImage(page, existingKeys = new Set()) {
  const locator = page.locator(getGeneratedImageSelector());
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    try {
      if (!(await item.isVisible())) continue;
      const key = await item.evaluate((img) => `${img.id || ''}|${img.getAttribute('alt') || ''}|${img.currentSrc || img.getAttribute('src') || ''}`);
      if (!existingKeys.has(key)) return item;
    } catch {
      // ignore
    }
  }
  return null;
}

async function hasImageGenerationInProgress(page) {
  const locators = [
    page.locator('[data-testid="image-gen-loading-state"]'),
    page.locator('[data-testid="image-gen-loading-state-frame"]'),
    page.locator('[data-testid="image-gen-loading-state-entry-surface"]'),
    page.locator('[data-testid="stop-button"]'),
    page.getByRole('button', { name: /停止回答/i }),
    page.getByRole('button', { name: /Stop/i })
  ];
  for (const locator of locators) {
    try {
      if (await locator.first().isVisible()) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

async function findNewAssistantText(page, existingKeys = new Set()) {
  const locator = page.locator(getAssistantMessageSelector());
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const data = await getAssistantMessageData(locator.nth(i)).catch(() => null);
    if (data?.text && !existingKeys.has(data.key)) {
      return data.text;
    }
  }
  return '';
}

async function waitForAssistantOutcome(page, timeout, existingAssistantTextKeys, existingImageKeys, api) {
  const start = Date.now();
  let candidateText = '';
  let candidateSince = 0;

  while (Date.now() - start < timeout) {
    const imageLocator = await findNewGeneratedImage(page, existingImageKeys);
    if (imageLocator) {
      return { type: 'image', imageLocator };
    }

    const assistantText = await findNewAssistantText(page, existingAssistantTextKeys);
    if (assistantText) {
      if (isAssistantErrorText(assistantText)) {
        return { type: 'error', text: assistantText };
      }

      const inProgress = await hasImageGenerationInProgress(page);
      if (inProgress || isAssistantProgressText(assistantText)) {
        api.log('info', '检测到图片处理中状态，继续等待', { textPreview: assistantText.slice(0, 120) });
        candidateText = '';
        candidateSince = 0;
        await sleep(500);
        continue;
      }

      if (assistantText !== candidateText) {
        candidateText = assistantText;
        candidateSince = Date.now();
        api.log('info', '检测到新的 assistant 文本回复，开始观察是否会继续出图', { textPreview: assistantText.slice(0, 200) });
      }

      if (Date.now() - candidateSince >= 15000) {
        return { type: 'text', text: candidateText };
      }
    }

    await sleep(500);
  }

  throw new Error('等待生成结果超时');
}

async function getUploadTileCount(page) {
  const locator = page.locator('button[aria-label*="用户上传的图片"], button[aria-label*="uploaded image"], button[aria-label*="Uploaded image"]');
  return await locator.count().catch(() => 0);
}

async function waitForUploadTilesSettled(page, expectedCount, timeout = 60000, api = null) {
  const start = Date.now();
  const pending = page.locator('div[role="group"][aria-label] .cursor-wait, div[role="group"][aria-label] svg circle[stroke-dasharray]');
  let lastState = null;

  while (Date.now() - start < timeout) {
    const tileCount = await getUploadTileCount(page);
    const pendingCount = await pending.count().catch(() => 0);
    const state = `${tileCount}/${expectedCount}:${pendingCount}`;
    if (api && state !== lastState) {
      lastState = state;
      api.log('debug', '等待上传图片处理完成', { expectedCount, tileCount, pendingCount });
    }
    if (tileCount >= expectedCount && pendingCount === 0) {
      await sleep(500);
      return;
    }
    await sleep(500);
  }

  throw new Error('等待上传图片处理完成超时');
}

async function uploadFiles(page, images, api) {
  if (!images?.length) return [];
  let uploadedCount = 0;
  for (const image of images) {
    api.log('info', '上传参考图片', { fileName: image.fileName || image.path });
    await openComposerMenu(page);
    const uploadInput = page.locator('#upload-files').first();
    await uploadInput.waitFor({ timeout: 5000, state: 'attached' });
    await uploadInput.setInputFiles(image.path);
    uploadedCount += 1;
    await waitForUploadTilesSettled(page, uploadedCount, 60000, api);
  }
  return images;
}

function buildPrompt(input) {
  const prompt = String(input.prompt || '').trim();
  const size = String(input.size || '').trim();
  if (!size) return prompt;
  return `${prompt}\n\n将宽高比设置为${size}`;
}

async function setComposerPrompt(page, composer, prompt) {
  await composer.click({ timeout: 10000 });
  await composer.fill('');
  const lines = String(prompt || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      await page.keyboard.insertText(lines[i]);
    }
    if (i < lines.length - 1) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
    }
  }
}

async function waitForSendReady(page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const button = await page.locator('#composer-submit-button, [data-testid="send-button"]').first();
    try {
      if (await button.isVisible()) {
        const disabled = await button.evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true');
        if (!disabled) return button;
      }
    } catch {
      // ignore transient state
    }
    await sleep(300);
  }
  throw new Error('等待发送按钮可点击超时');
}

async function submitPrompt(page, api) {
  api.log('info', '发送提示词');
  await waitForUploadTilesSettled(page, 0, 30000).catch(() => {});
  const maxAttempts = 3;
  const submitTimeout = 8000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForSendReady(page, 30000);
    const submissionPromise = page.waitForResponse((response) => {
      return response.url().includes('backend-api/f/conversation') && response.request().method() === 'POST';
    }, { timeout: submitTimeout });

    const composer = await waitForComposer(page, 5000);
    await composer.click({ timeout: 5000 });
    await page.keyboard.press('Enter');

    try {
      await submissionPromise;
      api.log('info', '已确认提交请求已发出', { attempt });
      return;
    } catch (error) {
      api.log('warn', '发送后未检测到提交请求，准备重试', { attempt, error: error.message });
      if (attempt === maxAttempts) {
        throw new Error('发送提示词后未检测到提交请求');
      }
      await sleep(1000);
    }
  }
}

async function extractImageFile(ctx, imageLocator) {
  const { page, api, helpers } = ctx;
  const source = await imageLocator.evaluate((img) => img.currentSrc || img.src || img.getAttribute('src') || '');
  const alt = await imageLocator.evaluate((img) => img.getAttribute('alt') || '');
  api.log('info', '提取生成图源地址', { sourcePreview: source.slice(0, 160), altPreview: alt.slice(0, 120) });

  if (!source) {
    throw new Error('未获取到图片地址');
  }

  if (source.startsWith('data:')) {
    return await helpers.files.fromDataUrl(source, { mode: 'object', fileName: 'result.png' });
  }

  if (source.startsWith('blob:')) {
    const dataUrl = await page.evaluate(async (blobUrl) => {
      const response = await fetch(blobUrl);
      const blob = await response.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }, source);
    return await helpers.files.fromDataUrl(dataUrl, { mode: 'object', fileName: 'result.png' });
  }

  return await helpers.files.fromUrl(source, { mode: 'object', fileName: 'result.png' });
}

async function executeChatgpt(ctx, input) {
  const { page, api, config, helpers } = ctx;
  const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;
  const prompt = buildPrompt(input);
  const inputImages = Array.isArray(input.images) ? input.images : [];

  const resolvedImages = await helpers.files.resolveMany(inputImages, { prefix: 'chatgpt-input' });

  api.log('info', '打开 ChatGPT 页面', {
    promptLength: prompt.length,
    imageCount: inputImages.length
  });

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1000);
  await startNewChatIfPossible(page);
  const composer = await waitForComposer(page, 30000);

  await enableImageMode(page, api);

  if (resolvedImages.length > 0) {
    await uploadFiles(page, resolvedImages, api);
    await waitForUploadTilesSettled(page, resolvedImages.length, 60000, api);
  }

  await setComposerPrompt(page, composer, prompt);

  const existingImageKeys = await collectExistingGeneratedImageKeys(page);
  const existingAssistantTextKeys = await collectExistingAssistantTextKeys(page);

  const conversationPromise = page.waitForResponse((response) => {
    return response.url().includes('backend-api/f/conversation') && response.request().method() === 'POST';
  }, { timeout: waitTimeout });

  const outcomePromise = waitForAssistantOutcome(page, Math.max(waitTimeout, 180000), existingAssistantTextKeys, existingImageKeys, api);
  await submitPrompt(page, api);

  let conversationText = '';
  try {
    const conversationResponse = await conversationPromise;
    if (conversationResponse.status() !== 200) {
      throw helpers.apiError({ message: `API 返回错误: HTTP ${conversationResponse.status()}`, status: 502, retryable: true });
    }
    conversationText = extractConversationText(await conversationResponse.text());
  } catch (error) {
    if (error.message.startsWith('API 返回错误')) {
      throw error;
    }
  }

  const outcome = await outcomePromise;
  if (outcome.type === 'error') {
    throw helpers.apiError({ message: outcome.text, status: 400, retryable: false });
  }
  if (outcome.type === 'text') {
    throw helpers.apiError({ message: outcome.text, status: 400, retryable: false });
  }

  const image = await extractImageFile(ctx, outcome.imageLocator);
  return { image, conversationText };
}

export const manifest = {
  id: 'chatgpt',
  name: 'ChatGPT',
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
          required: ['fileName', 'mimeType', 'base64'],
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
        required: ['fileName', 'mimeType', 'base64'],
        properties: {
          fileName: { type: 'string' },
          mimeType: { type: 'string' },
          base64: { type: 'string' }
        }
      },
      conversationText: {
        type: 'string'
      }
    }
  },
  async execute(ctx, input) {
    return await executeChatgpt(ctx, input);
  }
};
