/**
 * Gemini 适配器（新 manifest）
 *
 * 演示如何在 script 字符串内使用 api/helpers/runtime 注入，
 * 并通过 overrideScript 在请求级别覆盖默认脚本。
 */

export const manifest = {
  id: 'gemini',
  name: 'Gemini',
  description: '在 Gemini 页面执行提示词并抓取页面元数据。',
  homePageUrl: 'https://gemini.google.com/app',
  inputJsonSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', title: '提示词' }
    }
  },
  script: `
await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });

api.log('info', '已打开 Gemini', { prompt: input.prompt });

// 等待输入框
const textbox = page.getByRole('textbox').first();
await textbox.waitFor({ timeout: 15000 });

// 演示：使用 helpers.files.resolve 把一个 URL 下载到本地临时文件
const saved = await helpers.files.resolve(input.prompt, { prefix: 'prompt' });
api.log('info', 'prompt 缓存到本地', { fileName: saved.fileName });

// 简单抓取页面元数据作为返回值
const capture = await api.capture('gemini-snapshot', { screenshot: true, fullPage: false });

return {
  url: page.url(),
  title: await page.title(),
  prompt: input.prompt,
  promptFile: saved.fileName,
  capture: capture.name
};
`
};
