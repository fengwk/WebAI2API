import fs from 'fs/promises';

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

async function getGeneratedImageKey(imageLocator) {
  return await imageLocator.evaluate((img) => {
    const src = img.currentSrc || img.getAttribute('src') || '';
    const alt = img.getAttribute('alt') || '';
    const id = img.id || '';
    return `${id}|${alt}|${src}`;
  });
}

async function collectExistingGeneratedImageKeys(page) {
  const locator = page.locator(getGeneratedImageSelector());
  const count = await locator.count();
  const keys = new Set();

  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    try {
      keys.add(await getGeneratedImageKey(item));
    } catch {
      // ignore detached nodes
    }
  }

  return keys;
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
      root.querySelectorAll(selector).forEach((node) => {
        pushText(node.innerText || node.textContent || '');
      });
    }

    if (texts.length === 0) {
      pushText(root.innerText || root.textContent || '');
    }

    const messageId = root.getAttribute('data-message-id') ||
      root.closest('[data-turn-id]')?.getAttribute('data-turn-id') ||
      '';

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
    const item = locator.nth(i);
    try {
      const data = await getAssistantMessageData(item);
      if (data.text) {
        keys.add(data.key);
      }
    } catch {
      // ignore detached nodes
    }
  }

  return keys;
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
    page.getByText('Create image', { exact: false }),
    page.getByText('生成图片', { exact: false })
  ], { timeout: 5000 });

  api.log('info', '切换创建图片模式', { enabled });
  return enabled;
}

async function uploadFiles(page, images, api) {
  if (!images?.length) return;

  let uploadedCount = 0;
  for (const image of images) {
    if (!image?.path) continue;

    api.log('info', '上传参考图片', { fileName: image.fileName || image.path });
    await openComposerMenu(page);

    const uploadInput = page.locator('#upload-files').first();
    await uploadInput.waitFor({ timeout: 5000, state: 'attached' });
    await uploadInput.setInputFiles(image.path);
    uploadedCount += 1;
    await waitForUploadTilesSettled(page, uploadedCount, 60000, api);
  }
}

function getUploadTileLocator(page) {
  return page.locator([
    'button[aria-label*="用户上传的图片"]',
    'button[aria-label*="uploaded image"]',
    'button[aria-label*="Uploaded image"]'
  ].join(', '));
}

function getUploadPendingLocator(page) {
  return page.locator([
    'div[role="group"][aria-label] .cursor-wait',
    'div[role="group"][aria-label] svg circle[stroke-dasharray]'
  ].join(', '));
}

async function waitForUploadTilesSettled(page, expectedCount, timeout = 60000, api = null) {
  const start = Date.now();
  const tiles = getUploadTileLocator(page);
  const pending = getUploadPendingLocator(page);
  let lastState = null;

  while (Date.now() - start < timeout) {
    const tileCount = await tiles.count().catch(() => 0);
    const pendingCount = await pending.count().catch(() => 0);

    const state = `${tileCount}/${expectedCount}:${pendingCount}`;
    if (api && state !== lastState) {
      lastState = state;
      api.log('debug', '等待上传图片处理完成', {
        expectedCount,
        tileCount,
        pendingCount
      });
    }

    if (tileCount >= expectedCount && pendingCount === 0) {
      await sleep(500);
      return;
    }

    await sleep(500);
  }

  throw new Error('等待上传图片处理完成超时');
}

async function findSendButton(page) {
  const candidates = [
    page.locator('#composer-submit-button'),
    page.getByRole('button', { name: /^发送提示$/i }),
    page.getByRole('button', { name: /^Send prompt$/i }),
    page.getByRole('button', { name: /^Send message$/i }),
    page.locator("[data-testid='send-button']")
  ];

  for (const candidate of candidates) {
    const button = candidate.first();
    try {
      if (await button.isVisible()) {
        return button;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function waitForSendReady(page, timeout = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const button = await findSendButton(page);
    if (button) {
      try {
        const disabled = await button.evaluate((el) => {
          return el.disabled || el.getAttribute('aria-disabled') === 'true';
        });
        if (!disabled) {
          return button;
        }
      } catch {
        // ignore detached or transient node state
      }
    }

    await sleep(300);
  }

  throw new Error('等待发送按钮可点击超时');
}

function extractConversationText(conversationBody) {
  let text = '';
  const lines = conversationBody.split('\n');

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const dataStr = line.slice(6).trim();
    if (!dataStr || dataStr === '[DONE]') continue;

    try {
      const data = JSON.parse(dataStr);
      if (
        data.v?.message?.channel === 'final' &&
        data.v?.message?.author?.role === 'assistant' &&
        data.v?.message?.content?.parts?.length > 0
      ) {
        const part = data.v.message.content.parts[0];
        if (typeof part === 'string') {
          text = part;
        }
      }

      if (Array.isArray(data.v)) {
        for (const patch of data.v) {
          if (patch.o === 'append' && patch.p === '/message/content/parts/0' && patch.v) {
            text += patch.v;
          }
        }
      }
    } catch {
      // ignore parse failures
    }
  }

  return text;
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

async function waitForGeneratedImage(page, timeout, existingKeys = new Set()) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const item = await findNewGeneratedImage(page, existingKeys);
    if (item) {
      return item;
    }

    await sleep(500);
  }

  throw new Error('等待生成图片超时');
}

async function findNewGeneratedImage(page, existingKeys = new Set()) {
  const locator = page.locator(getGeneratedImageSelector());
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    try {
      if (!(await item.isVisible())) {
        continue;
      }

      const key = await getGeneratedImageKey(item);
      if (!existingKeys.has(key)) {
        return item;
      }
    } catch {
      // ignore detached or transient nodes
    }
  }

  return null;
}

async function waitForAssistantError(page, timeout, existingKeys = new Set(), api = null) {
  const locator = page.locator(getAssistantMessageSelector());
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);
      try {
        const data = await getAssistantMessageData(item);
        const text = data.text;
        if (!text) {
          continue;
        }

        if (existingKeys.has(data.key)) {
          continue;
        }

        if (isAssistantErrorText(text)) {
          api?.log('warn', '检测到 ChatGPT 错误回复', {
            textPreview: text.slice(0, 200)
          });
          return text;
        }
      } catch {
        // ignore detached nodes
      }
    }

    await sleep(500);
  }

  throw new Error('等待错误回复超时');
}

async function waitForAssistantReply(page, timeout, existingKeys = new Set(), api = null) {
  const locator = page.locator(getAssistantMessageSelector());
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);
      try {
        const data = await getAssistantMessageData(item);
        const text = data.text;
        if (!text) {
          continue;
        }

        if (existingKeys.has(data.key)) {
          continue;
        }

        api?.log('info', '检测到新的 assistant 文本回复', {
          textPreview: text.slice(0, 200)
        });
        return text;
      } catch {
        // ignore detached nodes
      }
    }

    await sleep(500);
  }

  throw new Error('等待 assistant 文本回复超时');
}

async function hasImageGenerationInProgress(page) {
  const loadingLocators = [
    page.locator('[data-testid="image-gen-loading-state"]'),
    page.locator('[data-testid="image-gen-loading-state-frame"]'),
    page.locator('[data-testid="image-gen-loading-state-entry-surface"]'),
    page.locator('[data-testid="stop-button"]'),
    page.getByRole('button', { name: /停止回答/i }),
    page.getByRole('button', { name: /Stop/i })
  ];

  for (const locator of loadingLocators) {
    try {
      if (await locator.first().isVisible()) {
        return true;
      }
    } catch {
      // ignore transient locators
    }
  }

  return false;
}

async function waitForAssistantOutcome(page, timeout, existingAssistantTextKeys, existingImageKeys, api = null) {
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
        api?.log('warn', '检测到 ChatGPT 错误回复', { textPreview: assistantText.slice(0, 200) });
        return { type: 'error', text: assistantText };
      }

      const inProgress = await hasImageGenerationInProgress(page);
      if (inProgress || isAssistantProgressText(assistantText)) {
        api?.log('info', '检测到图片处理中状态，继续等待', {
          textPreview: assistantText.slice(0, 120)
        });
        candidateText = '';
        candidateSince = 0;
        await sleep(500);
        continue;
      }

      if (assistantText !== candidateText) {
        candidateText = assistantText;
        candidateSince = Date.now();
        api?.log('info', '检测到新的 assistant 文本回复，开始观察是否会继续出图', {
          textPreview: assistantText.slice(0, 200)
        });
      }

      if (Date.now() - candidateSince >= 15000) {
        return { type: 'text', text: candidateText };
      }
    }

    await sleep(500);
  }

  throw new Error('等待生成结果超时');
}

async function findNewAssistantText(page, existingKeys = new Set()) {
  const locator = page.locator(getAssistantMessageSelector());
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    try {
      const data = await getAssistantMessageData(item);
      const text = data.text;
      if (!text) {
        continue;
      }

      if (existingKeys.has(data.key)) {
        continue;
      }

      return text;
    } catch {
      // ignore detached nodes
    }
  }

  return '';
}

async function extractImageFile(api, page, imageLocator) {
  const source = await imageLocator.evaluate((img) => {
    return img.currentSrc || img.src || img.getAttribute('src') || '';
  });
  const alt = await imageLocator.evaluate((img) => img.getAttribute('alt') || '');

  api.log('info', '提取生成图源地址', {
    sourcePreview: source ? source.slice(0, 160) : '',
    altPreview: alt ? alt.slice(0, 120) : ''
  });

  if (!source) {
    throw new Error('未获取到图片地址');
  }

  if (source.startsWith('data:')) {
    return await api.saveFile({
      relativePath: 'chatgpt/result.png',
      content: source
    });
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

    return await api.saveFile({
      relativePath: 'chatgpt/result.png',
      content: dataUrl
    });
  }

  const response = await page.request.get(source, { timeout: 120000 });
  if (!response.ok()) {
    throw new Error(`图片下载失败: HTTP ${response.status()}`);
  }

  const buffer = await response.body();
  const contentType = response.headers()['content-type'] || 'image/png';
  const mimeType = contentType.split(';')[0].trim();
  return await api.saveFile({
    relativePath: 'chatgpt/result.png',
    content: buffer,
    mimeType
  });
}

async function clickSaveButton(page) {
  return await clickFirstAvailable([
    page.getByRole('button', { name: /^保存$/i }),
    page.getByRole('button', { name: /^Save$/i }),
    page.locator("[data-testid='fullscreen-shell-header-content'] button").nth(3),
    page.locator('#radix-_r_hh_ button').nth(3)
  ], { timeout: 5000 });
}

async function downloadImageViaViewer(api, page, imageLocator) {
  await imageLocator.click({ timeout: 10000 });
  await sleep(800);

  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  const clicked = await clickSaveButton(page);
  if (!clicked) {
    throw new Error('未找到保存按钮');
  }

  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('下载文件路径为空');
  }

  const buffer = await fs.readFile(downloadPath);
  const fileName = download.suggestedFilename() || 'result.png';
  const mimeType = fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';

  return await api.saveFile({
    relativePath: `chatgpt/${fileName}`,
    content: buffer,
    mimeType
  });
}

async function submitPrompt(page, api) {
  api.log('info', '发送提示词');
  await waitForUploadTilesSettled(page, 0, 30000).catch(() => {});

  const maxAttempts = 3;
  const submitTimeout = 8000;

  async function trySubmitByEnter(actionName) {
    const submissionPromise = page.waitForResponse((response) => {
      return response.url().includes('backend-api/f/conversation') && response.request().method() === 'POST';
    }, { timeout: submitTimeout });

    const composer = await waitForComposer(page, 5000);
    await composer.click({ timeout: 5000 });
    await page.keyboard.press('Enter');

    try {
      await submissionPromise;
      api.log('info', '已确认提交请求已发出', { actionName });
      return true;
    } catch (error) {
      api.log('warn', '提交动作未触发请求', {
        actionName,
        error: error.message
      });
      return false;
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForSendReady(page, 30000);
    let submitted = false;

    submitted = await trySubmitByEnter('keyboard.enter');

    if (submitted) {
      api.log('info', '已确认提交请求已发出', { attempt });
      return;
    }

    api.log('warn', '发送后未检测到提交请求，准备重试', { attempt });

    if (attempt === maxAttempts) {
      throw new Error('发送提示词后未检测到提交请求');
    }

    await sleep(1000);
  }
}

async function executeChatgptImage(ctx, input) {
  const { page, api, config } = ctx;
  const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;
  const prompt = buildPrompt(input);
  const images = input.images || [];

  api.log('info', '打开 ChatGPT 页面', {
    providerType: input.providerType,
    model: input.model,
    promptLength: prompt.length,
    imageCount: images.length
  });

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1000);
  await startNewChatIfPossible(page);
  const composer = await waitForComposer(page, 30000);

  await enableImageMode(page, api);

  if (images.length > 0) {
    await uploadFiles(page, images, api);
    await waitForUploadTilesSettled(page, images.filter(image => image?.path).length, 60000, api);
  }

  await setComposerPrompt(page, composer, prompt);

  const existingImageKeys = await collectExistingGeneratedImageKeys(page);
  const existingAssistantTextKeys = await collectExistingAssistantTextKeys(page);

  const conversationPromise = page.waitForResponse((response) => {
    return response.url().includes('backend-api/f/conversation') && response.request().method() === 'POST';
  }, { timeout: waitTimeout });

  const assistantOutcomePromise = waitForAssistantOutcome(
    page,
    Math.max(waitTimeout, 180000),
    existingAssistantTextKeys,
    existingImageKeys,
    api
  );

  await submitPrompt(page, api);

  let conversationText = '';
  try {
    const conversationResponse = await conversationPromise;
    if (conversationResponse.status() !== 200) {
      return {
        success: false,
        error: {
          message: `API 返回错误: HTTP ${conversationResponse.status()}`,
          retryable: true
        }
      };
    }

    const body = await conversationResponse.text();
    conversationText = extractConversationText(body);

    const isRateLimit = body.includes('RateLimitException') || body.includes('rate limit') || /limit.*reset/i.test(conversationText);
    if (isRateLimit) {
      return {
        success: false,
        error: {
          message: `触发速率限制: ${conversationText.substring(0, 200)}`,
          retryable: false
        }
      };
    }

    const isContentRejection = /cannot|can't|unable|sorry|policy|violat/i.test(conversationText);
    if (conversationText && isContentRejection && !body.includes('file_') && !body.includes('dalle')) {
      return {
        success: false,
        error: {
          message: `内容被拒绝: ${conversationText.substring(0, 200)}`,
          retryable: false
        }
      };
    }
  } catch {
    // keep waiting for generated image if conversation parsing failed
  }

  try {
    const result = await assistantOutcomePromise;

    if (result.type === 'error') {
      return {
        success: false,
        error: {
          message: result.text.substring(0, 200),
          retryable: false
        }
      };
    }

    if (result.type === 'text') {
      return {
        success: false,
        error: {
          message: result.text.substring(0, 200),
          retryable: false
        }
      };
    }

    const imageLocator = result.imageLocator;
    api.log('info', '检测到已生成图片，优先直接下载图片源');

    let file;
    try {
      file = await extractImageFile(api, page, imageLocator);
    } catch (directError) {
      api.log('warn', '直接下载图片源失败，回退为查看器保存', { error: directError.message });
      file = await downloadImageViaViewer(api, page, imageLocator);
    }

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
  } catch {
    if (conversationText) {
      return {
        success: false,
        error: {
          message: `模型返回文本而非图片: ${conversationText.substring(0, 200)}`,
          retryable: false
        }
      };
    }

    return {
      success: false,
      error: {
        message: '等待图片生成超时',
        retryable: true
      }
    };
  }
}

export const manifest = {
  id: 'chatgpt',
  name: 'ChatGPT',
  providers: [
    {
      type: 'openai-images-generations',
      models: ['gpt-image-2'],
      async execute(ctx, input) {
        return await executeChatgptImage(ctx, {
          ...input,
          providerType: 'openai-images-generations'
        });
      }
    },
    {
      type: 'openai-images-edits',
      models: ['gpt-image-2'],
      async execute(ctx, input) {
        return await executeChatgptImage(ctx, {
          ...input,
          providerType: 'openai-images-edits'
        });
      }
    }
  ]
};
