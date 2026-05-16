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

async function getComposer(page, timeout = 30000) {
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

async function enableImageMode(page) {
  const enabled = await clickFirstAvailable([
    page.getByText('生成图片', { exact: false }),
    page.getByText('Create image', { exact: false }),
    page.locator("[data-testid='use-case-prompt-chips'] button").first()
  ], { timeout: 5000 });

  return enabled;
}

async function uploadFiles(page, images) {
  if (!images?.length) return;

  const imagePaths = images.map(image => image.path).filter(Boolean);
  if (imagePaths.length === 0) return;

  const buttonCandidates = [
    page.getByRole('button', { name: /Add files and more/i }),
    page.getByRole('button', { name: /Add photos and files/i }),
    page.getByRole('button', { name: /Add files/i }),
    page.getByRole('button', { name: /添加文件/i }),
    page.getByRole('button', { name: /添加图片/i })
  ];

  for (const button of buttonCandidates) {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        button.click({ timeout: 5000 })
      ]);
      await chooser.setFiles(imagePaths);
      return;
    } catch {
      // try next button
    }
  }

  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(imagePaths);
    return;
  }

  throw new Error('未找到可用的图片上传入口');
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
  return `${prompt}\n\n将宽高比设置为 ${size}`;
}

async function waitForGeneratedImage(page, timeout) {
  const candidates = [
    page.getByRole('img', { name: /已生成图片/i }),
    page.getByRole('img', { name: /Generated image/i }),
    page.locator('img[alt*="已生成图片"]'),
    page.locator('img[alt*="Generated image"]')
  ];

  for (const locator of candidates) {
    try {
      await locator.last().waitFor({ timeout, state: 'visible' });
      return locator.last();
    } catch {
      // try next locator
    }
  }

  throw new Error('等待生成图片超时');
}

async function extractImageData(api, page, imageLocator) {
  const source = await imageLocator.evaluate((img) => {
    return img.currentSrc || img.src || img.getAttribute('src') || '';
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

  const resp = await page.request.get(source, { timeout: 120000 });
  if (!resp.ok()) {
    throw new Error(`图片下载失败: HTTP ${resp.status()}`);
  }

  const buffer = await resp.body();
  const contentType = resp.headers()['content-type'] || 'image/png';
  const mimeType = contentType.split(';')[0].trim();
  return await api.saveFile({
    relativePath: 'chatgpt/result.png',
    content: buffer,
    mimeType
  });
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
  const composer = await getComposer(page, 30000);

  if (images.length > 0) {
    api.log('info', '开始上传参考图片', { count: images.length });
    await uploadFiles(page, images);
    await sleep(2000);
  }

  await composer.click({ timeout: 10000 });
  await composer.fill('');
  await page.keyboard.insertText(prompt);

  const imageModeEnabled = await enableImageMode(page);
  api.log('info', '切换生成图片模式', { enabled: imageModeEnabled });

  const conversationPromise = page.waitForResponse((response) => {
    return response.url().includes('backend-api/f/conversation') && response.request().method() === 'POST';
  }, { timeout: waitTimeout });
  const imagePromise = waitForGeneratedImage(page, Math.max(waitTimeout, 180000));

  api.log('info', '发送提示词', { providerType: input.providerType });
  const clicked = await clickFirstAvailable([
    page.getByRole('button', { name: /^发送提示$/i }),
    page.getByRole('button', { name: /^Send prompt$/i }),
    page.getByRole('button', { name: /^Send message$/i }),
    page.locator("[data-testid='send-button']")
  ], { timeout: 5000 });
  if (!clicked) {
    await page.keyboard.press('Enter');
  }

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
  } catch {
    // keep waiting image if conversation parsing failed
  }

  try {
    const imageLocator = await imagePromise;
    api.log('info', '检测到已生成图片，开始提取源地址');
    const file = await extractImageData(api, page, imageLocator);
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
