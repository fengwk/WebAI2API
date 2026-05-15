# WebAI2API 动态适配器脚本编写指南

本文面向后续维护者与 Agent，说明如何为当前的动态适配器系统编写可运行脚本。

本文只描述当前 **KISS 版动态适配器** 约定：

- 运行时只加载 `/app/data/adapters/*.js`
- 每个脚本文件只包含一个适配器
- 脚本直接操作 Playwright `page/context`
- 只提供一个极简 helper：`api.log()`

---

## 1. 文件位置

运行时适配器目录：

```text
/app/data/adapters/
```

每个适配器一个文件，例如：

```text
/app/data/adapters/chatgpt.js
/app/data/adapters/gemini.js
```

文件名（不含 `.js`）必须与 `manifest.id` 一致。

例如：

- 文件：`chatgpt.js`
- `manifest.id`：`chatgpt`

否则注册表会判定该脚本无效。

---

## 2. 最小脚本结构

动态适配器脚本必须导出：

```js
export const manifest = { ... }
```

最小示例：

```js
export const manifest = {
  id: 'chatgpt',
  displayName: 'ChatGPT Image',
  description: '动态适配器示例',
  models: [
    { id: 'gpt-image-2', imagePolicy: 'optional', type: 'image' }
  ],
  navigationHandlers: [],

  async generate(ctx, prompt, imagePaths, modelId, meta) {
    const { page, context, api } = ctx;
    api.log('info', '开始执行适配器', { modelId, promptLength: prompt.length, imageCount: imagePaths.length });

    await page.goto('https://example.com');
    return { error: '请编辑脚本后再测试' };
  }
};
```

---

## 3. `manifest` 字段说明

## 3.1 必填字段

### `id`

适配器唯一 ID，同时也是 Worker 配置里 `type` 的值。

例如：

```yaml
workers:
  - name: chatgpt_a
    type: chatgpt
```

### `models`

声明该适配器支持的模型列表。最小字段：

```js
models: [
  { id: 'gpt-image-2', imagePolicy: 'optional', type: 'image' }
]
```

字段说明：

- `id`: 模型名，对外出现在 `/v1/models` 中
- `imagePolicy`: `optional | required | forbidden`
- `type`: `image | text`

### `generate(ctx, prompt, imagePaths, modelId, meta)`

核心执行函数。所有实际网页自动化逻辑都写在这里。

---

## 3.2 可选字段

### `displayName`

WebUI 中的显示名称。

### `description`

脚本用途说明。

### `navigationHandlers`

当前动态适配器支持该字段，但第一版一般可直接写空数组：

```js
navigationHandlers: []
```

### `getTargetUrl(config, workerConfig)`

如果你希望 Worker 初始化时自动打开某个页面，可以提供该函数。

如果不写，则默认回退到 `about:blank`。

---

## 4. `generate()` 的参数说明

函数签名：

```js
async generate(ctx, prompt, imagePaths, modelId, meta)
```

## 4.1 `ctx`

当前动态适配器可直接使用：

- `ctx.page`: 当前 Playwright Page
- `ctx.context`: 当前 Playwright BrowserContext
- `ctx.config`: 全局配置对象
- `ctx.proxyConfig`: 当前 worker/instance 的代理配置
- `ctx.userDataDir`: 当前浏览器数据目录
- `ctx.workerName`: 当前 worker 名称
- `ctx.instanceName`: 当前 instance 名称
- `ctx.api`: 极简 helper，目前只有 `log()`

## 4.2 `prompt`

已经由上层解析好的最终提示词。

## 4.3 `imagePaths`

已经落地到本地磁盘的图片路径数组。

适配器需要自己决定是否上传这些图片。

## 4.4 `modelId`

当前请求指定的模型 ID。

如果一个适配器声明了多个模型，可以在脚本中：

```js
if (modelId === 'gemini-3-pro-image-preview') {
  // 图片流程
} else if (modelId === 'gemini-text') {
  // 文本流程
}
```

## 4.5 `meta`

日志上下文。通常不用直接修改。

---

## 5. `api.log()` 的使用方式

当前唯一内建 helper：

```js
api.log(level, message, extra?)
```

示例：

```js
api.log('info', '开始上传图片', { count: imagePaths.length });
api.log('warn', '未找到预期按钮，尝试降级逻辑');
api.log('error', '下载失败', { url });
```

推荐在以下位置打日志：

1. 开始执行时
2. 页面导航后
3. 上传图片前后
4. 点击发送前后
5. 等待站点接口前后
6. 提取结果失败时

---

## 6. 返回值约定

当前脚本保持与原框架兼容，直接返回对象。

## 6.1 成功返回

### 图片/视频结果

```js
return {
  image: 'data:image/png;base64,...'
}
```

或：

```js
return {
  image: 'data:video/mp4;base64,...'
}
```

### 文本结果

```js
return {
  text: 'hello world'
}
```

### 可选补充字段

```js
return {
  image: 'data:image/png;base64,...',
  imageUrl: 'https://...',
  reasoning: '过程说明'
}
```

## 6.2 失败返回

```js
return { error: '错误信息' }
```

如果你知道这个错误不该自动重试，可以返回：

```js
return {
  error: '内容被拒绝',
  retryable: false
}
```

---

## 7. 推荐编写方式

## 7.1 优先直接使用 Playwright 原生 API

当前 KISS 版设计下，优先直接写：

- `page.goto()`
- `page.waitForSelector()`
- `page.locator()`
- `page.getByRole()`
- `page.waitForResponse()`
- `page.request.get()`
- `page.screenshot()`
- `context.newPage()`

不要依赖运行时内部源码中的 helper 路径。

换句话说，**动态脚本尽量自包含**。

## 7.2 脚本内部允许定义本地 helper

如果一个适配器需要多个辅助函数，建议直接在脚本文件内部定义。

例如：

```js
async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForComposer(page) {
  await page.waitForSelector('.ProseMirror', { timeout: 30000 });
}
```

这比依赖框架内部 import 更稳定。

---

## 8. 常见能力怎么写

## 8.1 页面导航

```js
await page.goto('https://chatgpt.com/images/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
```

## 8.2 等待输入框

```js
await page.waitForSelector('.ProseMirror', { timeout: 30000 });
```

## 8.3 输入提示词

```js
await page.locator('.ProseMirror').click();
await page.keyboard.insertText(prompt);
```

## 8.4 上传图片

```js
const [fileChooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.getByRole('button', { name: /Add files/i }).click()
]);
await fileChooser.setFiles(imagePaths);
```

## 8.5 等待网页接口响应

```js
const response = await page.waitForResponse((resp) => {
  return resp.url().includes('backend-api/f/conversation') && resp.request().method() === 'POST';
}, { timeout: 300000 });
```

## 8.6 用当前上下文下载资源

```js
const resp = await page.request.get(downloadUrl, { timeout: 120000 });
const buffer = await resp.body();
const contentType = resp.headers()['content-type'] || 'image/png';
const mimeType = contentType.split(';')[0].trim();
return {
  image: `data:${mimeType};base64,${buffer.toString('base64')}`
};
```

这里用的是当前页面上下文绑定的 request client，通常能继承当前登录态 Cookie。

---

## 9. 调试建议

## 9.1 先保存，再测试

当前测试执行跑的是**当前已保存脚本**。

建议流程：

1. 编辑脚本
2. 点击保存
3. 点击测试执行
4. 在 VNC 中观察页面行为
5. 在日志查看器中看 `api.log()` 输出

## 9.2 测试优先用独立 worker

建议给调试脚本准备一个独立 worker，例如：

```yaml
workers:
  - name: chatgpt_debug
    type: chatgpt
```

这样更容易在 VNC 中观察，不会干扰正式实例。

## 9.3 常见调试日志建议

建议至少打印：

- `modelId`
- `prompt.length`
- `imagePaths.length`
- 当前 URL
- 当前步骤名称

---

## 10. 常见错误与排查

## 10.1 脚本保存后显示“无效”

常见原因：

- 没有导出 `manifest`
- `manifest.id` 与文件名不一致
- `models` 不是数组
- `generate` 不是函数

## 10.2 Worker 下拉里看不到该适配器

原因通常是：

- 脚本无效，未通过注册表校验
- `/admin/adapters` 中该适配器 `valid=false`

## 10.3 保存后测试仍然失败

排查顺序：

1. 看测试结果返回中的 `error`
2. 看日志查看器中的 `动态适配器` 日志
3. 在 VNC 中观察页面是否真的执行到目标步骤
4. 检查当前 worker 对应站点是否已登录

---

## 11. 最佳实践

1. **一开始先只做一个最小可运行版本**
2. **先让页面能打开、能输入、能点击，再做复杂解析**
3. **优先依赖网络响应，而不是脆弱 DOM**
4. **脚本尽量自包含，不依赖框架内部 import**
5. **先打足日志，再去优化结构**

---

## 12. 示例脚本

仓库中已提供两个参考脚本：

- `examples/dynamic-adapters/chatgpt.js`
- `examples/dynamic-adapters/gemini.js`

可直接复制到 WebUI 中保存，或复制到运行目录：

```text
/app/data/adapters/
```

---

## 13. 远程临时调试接口

除了“保存后测试”的正式动态适配器路径，系统还提供了一个**临时调试脚本接口**，用于 Agent 或人工远程直接提交脚本运行。

接口：

```http
POST /admin/debug/run
```

请求体示例：

```json
{
  "workerName": "chatgpt_debug",
  "modelId": "gpt-image-2",
  "prompt": "一只橘猫，赛博朋克风格",
  "images": [],
  "keepPageOpen": false,
  "timeout": 300000,
  "script": "api.log('info', 'start', { modelId });\nawait page.goto('https://chatgpt.com/images/', { waitUntil: 'domcontentloaded' });\nawait api.capture('after-goto', { screenshot: true, html: true, text: true });\nreturn { ok: true, url: page.url() };"
}
```

### 运行特性

- 使用指定 Worker 的**当前登录态**
- 在该 Worker 的 `context` 下新开一个临时 `page`
- 默认执行完自动关闭页面
- 如果 `keepPageOpen=true`，则保留该页面，方便在 VNC 中继续观察

### 返回内容

返回 JSON 中包含：

- `success`
- `result`
- `logs`
- `captures`
- `page`

其中：

- `logs` 来自 `api.log()`
- `captures` 来自 `api.capture()`
- 如果脚本返回了 `result.image = data:image/...;base64,...`，调试接口会自动把图片落盘为调试产物，并返回 `result.imageUrl`

### 调试产物存放位置

调试产物不会长期存放在运行数据目录，而是写入服务的临时目录下：

```text
<tempDir>/debug-artifacts/<runId>/
```

当前策略：

- 图片截图 / 结果图片：保存为文件并返回 URL
- HTML 快照：保存为文件并返回 URL
- 文本快照：直接内联返回在 JSON 中
- 调试产物会在后续调试请求时按 TTL 做轻量清理（当前默认约 30 分钟）

### 临时调试脚本上下文

接口执行的脚本不是完整 `manifest` 模块，而是一段**函数体脚本**。脚本内部可直接使用：

- `page`
- `context`
- `config`
- `proxyConfig`
- `userDataDir`
- `workerName`
- `instanceName`
- `prompt`
- `imagePaths`
- `modelId`
- `meta`
- `api`

### 调试专用 helper

临时调试脚本可使用：

- `api.log(level, message, extra?)`
- `api.sleep(ms)`
- `api.capture(name, options?)`

其中 `api.capture()` 支持：

```js
await api.capture('step-name', {
  screenshot: true,
  html: true,
  text: true,
  fullPage: true
})
```

执行后不会把截图 / HTML / 文本直接内联到超大 JSON 中，而是保存为调试产物文件，并返回：

- `screenshotUrl`
- `htmlUrl`

其中：

- 图片、HTML 等文件型产物返回 URL
- 文本内容直接内联返回在 `capture.text`

你可以直接用这些 URL 查看对应产物，避免 base64 截图和 HTML 快照把调试响应撑得过大。

这是远程调试页面结构、截图、卡点位置最重要的手段。

---

## 14. 一句话总结

> 动态适配器脚本就是一份导出 `manifest` 的 JS 模块；直接用 Playwright `page/context` 写网页自动化逻辑，用 `api.log()` 打调试日志，然后通过 WebUI 的保存 + 测试 + VNC 观察来快速迭代。
