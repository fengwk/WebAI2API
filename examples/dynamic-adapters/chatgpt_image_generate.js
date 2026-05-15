const TARGET_URL = 'https://chatgpt.com/images/';
const INPUT_SELECTOR = '.ProseMirror';

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForComposer(page, timeout = 30000) {
  await page.waitForSelector(INPUT_SELECTOR, { timeout });
}

async function uploadFiles(page, images) {
  if (!images?.length) return;

  const imagePaths = images.map(image => image.path).filter(Boolean);
  if (imagePaths.length === 0) return;

  const buttonCandidates = [
    page.getByRole('button', { name: /Add files and more/i }),
    page.getByRole('button', { name: /Add photos and files/i }),
    page.getByRole('button', { name: /Add files/i })
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

async function downloadImage(api, page, url) {
  const resp = await page.request.get(url, { timeout: 120000 });
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
      // ignore line parse failures
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

export const manifest = {
  id: 'chatgpt_image_generate',
  name: 'ChatGPT Image Generate',
  provider: {
    type: 'openai-images-generations',
    models: ['gpt-image-2']
  },
  navigationHandlers: [],
  getTargetUrl() {
    return TARGET_URL;
  },
  async execute(ctx, input) {
    const { page, api, config } = ctx;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 300000;
    const prompt = buildPrompt(input);
    const images = input.images || [];

    api.log('info', '打开 ChatGPT 图片页面', {
      model: input.model,
      promptLength: prompt.length,
      imageCount: images.length
    });

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForComposer(page);

    if (images.length > 0) {
      api.log('info', '开始上传参考图片', { count: images.length });
      await uploadFiles(page, images);
      await sleep(3000);
    }

    const composer = page.locator(INPUT_SELECTOR).first();
    await composer.click({ timeout: 10000 });
    await page.keyboard.insertText(prompt);
    await page.keyboard.press('Enter');

    const conversationResponse = await page.waitForResponse((response) => {
      return response.url().includes('backend-api/f/conversation') && response.request().method() === 'POST';
    }, { timeout: waitTimeout });

    if (conversationResponse.status() !== 200) {
      return {
        success: false,
        error: {
          message: `API 返回错误: HTTP ${conversationResponse.status()}`,
          retryable: true
        }
      };
    }

    const conversationBody = await conversationResponse.text();
    const conversationText = extractConversationText(conversationBody);
    const isImageGenerationStarted = conversationBody.includes('dalle') || conversationBody.includes('file_');

    if (conversationText) {
      const isRateLimit = conversationBody.includes('RateLimitException') ||
        conversationBody.includes('rate limit') ||
        /limit.*reset/i.test(conversationText);
      if (isRateLimit) {
        return {
          success: false,
          error: {
            message: `触发速率限制: ${conversationText.substring(0, 200)}`,
            retryable: false
          }
        };
      }

      if (!isImageGenerationStarted) {
        const isContentRejection = /cannot|can't|unable|sorry|policy|violat/i.test(conversationText);
        if (isContentRejection) {
          return {
            success: false,
            error: {
              message: `内容被拒绝: ${conversationText.substring(0, 200)}`,
              retryable: false
            }
          };
        }
      }
    }

    const imageTimeout = isImageGenerationStarted ? 120000 : 30000;
    let downloadUrl = null;
    try {
      await page.waitForResponse(async (response) => {
        const url = response.url();
        if (!url.includes('backend-api/files/download/file_') || response.status() !== 200) {
          return false;
        }
        try {
          const json = await response.json();
          if (json?.file_name?.startsWith('user-') && !json.file_name.includes('.part') && json.download_url) {
            downloadUrl = json.download_url;
            return true;
          }
        } catch {
          // ignore
        }
        return false;
      }, { timeout: imageTimeout });
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

    if (!downloadUrl) {
      return {
        success: false,
        error: {
          message: '未获取到图片下载链接',
          retryable: true
        }
      };
    }

    const file = await downloadImage(api, page, downloadUrl);
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
};
