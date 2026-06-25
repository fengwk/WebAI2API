# WebAI2API 适配器脚本指南（V1）

当前运行时只加载：

```text
data/adapters/*.js
```

一个文件代表一个 **adapter 能力脚本**，一个 worker 只绑定一个 `adapterId/type`。

---

## 1. 唯一支持的脚本结构

```js
export const manifest = {
  id: 'chatgpt_image',
  name: 'ChatGPT 图片生成',
  description: '在 ChatGPT 页面生成图片',
  homePageUrl: 'https://chatgpt.com',
  inputJsonSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', title: '提示词' }
    },
    required: ['prompt']
  },
  script: `
    await api.goto('https://chatgpt.com');
    const inputBox = page.getByRole('textbox').first();
    await inputBox.fill(input.prompt);
    return {
      url: page.url(),
      title: await page.title()
    };
  `
};
```

---

## 2. 字段说明

- `manifest.id`
  - adapter 唯一 ID
  - 必须与文件名一致
  - 也是 `/api/{adapterId}` 的路由键
  - 也是 worker 配置中的 `type`

- `manifest.name`
  - 展示名称

- `manifest.description`
  - 可选说明文本

- `manifest.homePageUrl`
  - resident page 默认常驻打开的 URL
  - worker 初始化 / resident page 重建时会优先打开它

- `manifest.inputJsonSchema`
  - 可选输入描述
  - 不做强校验
  - 仅用于 UI 展示与输入说明

- `manifest.script`
  - 唯一执行逻辑
  - 必须是字符串
  - 系统会统一编译并在 worker resident page 上执行

---

## 3. 不再支持的历史字段

以下字段已被废弃，出现即视为无效脚本：

- `providers`
- `models`
- `execute`
- `outputJsonSchema`
- `timeoutMs`

---

## 4. 运行时注入对象

脚本执行时注入：

```js
page
input
api
helpers
runtime
```

### `page`
- 当前 worker 的 resident Playwright `Page`

### `input`
- 请求体中的业务输入

### `api`
平台辅助能力：

- `api.log(level, message, extra?)`
- `api.step(name, extra?)`
- `api.sleep(ms)`
- `api.goto(url, options?)`
- `api.capture(name, options?)`
- `api.saveFile({ relativePath, content, mimeType })`

### `helpers`
- `helpers.apiError(options)`
- `helpers.files.resolve(value, options)`
- `helpers.files.resolveMany(values, options)`
- `helpers.files.fromPath(filePath, options)`
- `helpers.files.fromBuffer(buffer, options)`
- `helpers.files.fromDataUrl(dataUrl, options)`
- `helpers.files.fromUrl(url, options)`

### `runtime`
只读运行时信息：

```js
{
  config,
  proxyConfig,
  userDataDir,
  workerName,
  instanceName,
  worker,
  meta
}
```

---

## 5. 请求协议

统一只走：

```http
POST /api/{adapterId}
```

请求体结构：

```json
{
  "input": {},
  "debug": false,
  "workerId": "optional",
  "overrideScript": "optional"
}
```

### 说明

- `input`
  - 业务输入，传给脚本中的 `input`

- `debug`
  - 为 `true` 时返回 `trace.steps / trace.captures / trace.logs`

- `workerId`
  - 可选 sticky worker
  - 若指定，则该 worker 的 `type` 必须等于当前 `adapterId`

- `overrideScript`
  - 可选
  - 本次执行时覆盖 manifest.script
  - 只覆盖执行内容，不覆盖元信息

---

## 6. 返回值约定

### 成功

脚本 `return` 什么，接口就把它放到：

```json
{
  "ok": true,
  "data": { ... },
  "meta": { ... }
}
```

### 失败

```json
{
  "ok": false,
  "message": "错误信息",
  "meta": { ... }
}
```

### debug 模式

额外返回：

```json
"trace": {
  "steps": [],
  "captures": [],
  "logs": []
}
```

---

## 7. 文件输出规则

所有文件产物只对外返回 **URL**，不返回本地路径。

例如：

```js
const file = await api.saveFile({
  relativePath: 'notes/result.json',
  content: JSON.stringify({ ok: true }),
  mimeType: 'application/json'
});

return { fileUrl: file.url };
```

---

## 8. 执行与调试原则

- 不再使用 `/admin/debug/run`
- 调试能力已并入 `/api/{adapterId}`
- sticky 调试通过 `workerId` 实现
- 同一 worker 默认串行执行，busy 时进入本地 FIFO 队列

---

## 9. 建议

- 脚本里优先使用 `api.goto()`、`api.capture()`、`api.step()`
- 长步骤自己在 Playwright 调用中设置局部 timeout
- 返回值只返回可 JSON 序列化的数据
- 不要在脚本中直接依赖本地路径
