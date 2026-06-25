/**
 * ChatGPT 适配器（新 manifest）
 *
 * 脚本通过 manifest.script 字符串形式提供给执行器，
 * 由统一执行器在 worker resident page 上执行。
 *
 * 注入对象：
 *   - page      当前 worker 的 Playwright Page
 *   - input     业务输入（{ prompt, size? }）
 *   - api       日志/文件/capture 等辅助能力
 *   - helpers   文件/上传/错误构造工具
 *   - runtime   调度、config、超时等元信息
 */

export const manifest = {
  id: 'chatgpt',
  name: 'ChatGPT',
  description: '在 ChatGPT 页面执行提示词并抓取页面元数据。',
  homePageUrl: 'https://chatgpt.com',
  inputJsonSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', title: '提示词' },
      size: { type: 'string', title: '宽高比（可选）' }
    }
  },
  script: `
// 跳转到 ChatGPT 主页（resident page 会自动沿用已登录会话）
await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });

api.log('info', '已打开 ChatGPT', { promptLength: String(input.prompt || '').length });

// 等待 ProseMirror 输入框出现
const composer = page.locator('.ProseMirror').first();
await composer.waitFor({ timeout: 15000 });

// 拼装 prompt
const size = String(input.size || '').trim();
const finalPrompt = size ? (input.prompt + '\\n\\n将宽高比设置为 ' + size) : input.prompt;

// 写入输入框
await composer.click();
await composer.fill(finalPrompt);

// 截图留证（产物只返回 URL）
const capture = await api.capture('after-fill', { screenshot: true, fullPage: true });

// 把 capture 信息写入文件
const note = await api.saveFile({
  relativePath: 'notes/chatgpt.json',
  content: JSON.stringify({ prompt: finalPrompt, capture: capture.name, ts: Date.now() }, null, 2),
  mimeType: 'application/json'
});

return {
  url: page.url(),
  title: await page.title(),
  prompt: finalPrompt,
  capture: capture.name,
  noteUrl: note.url
};
`
};
