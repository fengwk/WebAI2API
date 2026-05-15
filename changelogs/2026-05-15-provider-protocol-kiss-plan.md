# WebAI2API Provider 协议重构方案（KISS 版）

日期：2026-05-15  
状态：设计定稿（可执行）

---

## 1. 背景

当前动态适配器能力已经具备：

- `/app/data/adapters/*.js` 动态脚本加载
- WebUI 脚本编辑、保存、删除、测试
- `/admin/debug/run` 远程临时脚本执行
- VNC 可视化调试

但当前协议仍然带有明显“图片生成时代”的历史包袱：

- 适配器/脚本接口偏向 `prompt + imagePaths + modelId`
- 外层 `/v1/chat/completions` 承担了图片请求
- 图像协议、聊天协议、通用浏览器任务协议没有清晰分层
- 调试台输入结构还没有完全围绕 provider 建立

目标是把系统重构为：

> **Adapter 只负责浏览器执行，Provider 负责对外协议。**

同时坚持：

- 最小改动
- 最少概念
- 不保留脏的历史兼容逻辑

---

## 2. 总体原则

### 2.1 适配器只做执行

Adapter 只关心：

- 它是谁
- 它服务哪个 provider
- 它怎么执行浏览器任务

Adapter 不负责：

- 对外 OpenAI 协议解析
- 历史记录展示结构定义
- UI 表单 schema 设计

### 2.2 Provider 才是协议定义者

Provider 负责：

- 对外协议类型定义
- 输入归一化
- 输出适配回标准协议
- 模型路由
- 调试台表单 schema
- 历史记录标准化

### 2.3 先只支持三种 Provider

第一阶段只定义：

1. `openai-chat-completions`
2. `openai-images-generations`
3. `openai-images-edits`

其它 provider（如搜索抓取、PDF 上传解析）暂不进入首轮实现。

### 2.4 不做复杂兼容层

本方案不保留旧的：

- `generate(ctx, prompt, imagePaths, modelId, meta)` 协议
- 图片专用输入协议
- 旧式 OpenAI 图片逻辑打补丁

新脚本统一使用：

```js
async execute(ctx, input)
```

---

## 3. Adapter 协议

## 3.1 文件位置

运行时脚本目录：

```text
/app/data/adapters/*.js
```

一个文件对应一个 Adapter。

## 3.2 Manifest 最终结构

```js
export const manifest = {
  id: 'chatgpt_image_generate',
  name: 'ChatGPT Image Generate',
  provider: {
    type: 'openai-images-generations',
    models: ['gpt-image-2']
  },
  execute
}
```

### 字段说明

- `id`
  - 适配器唯一 ID
  - 必须与文件名一致
- `name`
  - WebUI 展示名称
- `provider.type`
  - 当前脚本服务的 provider 类型
- `provider.models`
  - 该 provider 下支持的模型列表
  - 对于不需要模型路由的 provider，可省略
- `execute`
  - 唯一执行入口

### 非目标字段

第一版不引入：

- `version`
- `capabilities`
- `task`
- `description`
- `inputSchema`
- `outputSchema`

这些信息都不属于 Adapter 运行核心。

## 3.3 执行函数

统一为：

```js
async function execute(ctx, input) {
  ...
}
```

---

## 4. `ctx` 协议

```js
ctx = {
  page,
  context,
  worker,
  api
}
```

### `ctx.page`

当前 Playwright `Page`。

### `ctx.context`

当前 Playwright `BrowserContext`。

### `ctx.worker`

当前 Worker 元信息：

```js
{
  name: 'glatzsheryn@gmail.com-gemini_image',
  type: 'gemini_image_generate',
  instance: 'glatzsheryn@gmail.com'
}
```

### `ctx.api`

统一保留以下能力：

- `api.log(level, message, extra?)`
- `api.capture(name, options?)`
- `api.sleep(ms)`
- `api.saveFile(...)`（新增）

说明：

- `log/capture/sleep` 现有已经可用，正式脚本与 debug 脚本统一保留
- `saveFile` 作为通用文件输出能力新增

---

## 5. 文件输出协议

## 5.1 原则

脚本不暴露绝对路径，只指定相对路径。

脚本不关心：

- 真实磁盘存储根目录
- URL 具体生成方式
- 清理策略

这些由运行时统一处理。

## 5.2 `api.saveFile()`

```js
await api.saveFile({
  relativePath: 'chatgpt/result.png',
  content: buffer,
  mimeType: 'image/png',
  ttlMs: 30 * 60 * 1000
})
```

返回：

```js
{
  relativePath: 'chatgpt/result.png',
  url: '/files/chatgpt/result.png',
  mimeType: 'image/png'
}
```

### 参数说明

- `relativePath`
  - 脚本声明的逻辑相对路径
- `content`
  - `string | Buffer | dataUrl | Playwright Download`
- `mimeType`
  - 可选 MIME 类型
- `ttlMs`
  - 可选生命周期，`null/省略` 表示长期文件

### 存储策略

- `ttlMs` 存在：临时文件，可清理
- `ttlMs` 不存在：长期文件

### 路由策略

- 调试临时文件仍可通过 `/admin/debug/artifacts/...` 暴露
- 正式文件建议新增统一 `/files/...` 路由

---

## 6. Output 协议

所有脚本统一返回：

```js
{
  success: true | false,
  data: any,
  error: null | {
    message: string,
    code?: string,
    retryable?: boolean,
    details?: any
  }
}
```

说明：

- `success`
  - 当前任务是否成功
- `data`
  - 完全 provider 相关
- `error`
  - 给系统统一渲染错误

### 示例：图片生成

```js
return {
  success: true,
  data: {
    created: 1710000000,
    data: [
      { url: 'https://...' }
    ]
  }
}
```

### 示例：文本生成

```js
return {
  success: true,
  data: {
    text: '你好'
  }
}
```

### 示例：抓取结果

```js
return {
  success: true,
  data: {
    items: [ ... ]
  }
}
```

### 示例：失败

```js
return {
  success: false,
  error: {
    message: '未找到输入框',
    code: 'INPUT_NOT_FOUND',
    retryable: false
  }
}
```

---

## 7. Provider 协议

Provider Registry 统一定义为：

```js
{
  type,
  inputSchema,
  normalizeRequest,
  renderResponse,
  buildRecord
}
```

### `type`

provider 类型名，例如：

- `openai-chat-completions`
- `openai-images-generations`
- `openai-images-edits`

### `inputSchema`

给前端调试台渲染表单。

### `normalizeRequest`

将外部协议请求归一化为传给脚本的 `input`。

### `renderResponse`

将脚本输出重新渲染成外部协议响应。

### `buildRecord`

把当前请求和脚本输出归一化成“历史记录表格标准格式”。

---

## 8. 三个标准 Provider 定义

## 8.1 `openai-chat-completions`

### 对外路由

```http
POST /v1/chat/completions
```

### `provider.models`

示例：

```js
provider: {
  type: 'openai-chat-completions',
  models: ['chatgpt-4o-text', 'gemini-2.5-pro']
}
```

### `inputSchema`

```js
{
  type: 'object',
  required: ['messages'],
  properties: {
    model: { type: 'string', title: 'Model' },
    messages: { type: 'json', title: 'Messages' },
    stream: { type: 'boolean', title: 'Stream', default: false },
    reasoning: { type: 'boolean', title: 'Reasoning', default: false }
  }
}
```

### `normalizeRequest`

输入：OpenAI chat 请求体  
输出：

```js
{
  model,
  messages,
  stream,
  reasoning,
  prompt
}
```

其中 `prompt` 为 provider 归一化后的最终文本上下文。

### `renderResponse`

将脚本返回：

```js
{ success, data: { text, reasoning? }, error }
```

渲染成：

- 非流式 OpenAI Chat Completion
- 流式 SSE Chat Completion Chunk

### `buildRecord`

写入统一记录：

```js
{
  modelId,
  modelName,
  prompt,
  inputFiles: [],
  responseText,
  reasoningContent,
  responseMedia: [],
  status,
  errorMessage,
  durationMs,
  isStreaming
}
```

---

## 8.2 `openai-images-generations`

### 对外路由

```http
POST /v1/images/generations
```

### `provider.models`

示例：

```js
provider: {
  type: 'openai-images-generations',
  models: ['gpt-image-2']
}
```

### `inputSchema`

```js
{
  type: 'object',
  required: ['prompt'],
  properties: {
    model: { type: 'string', title: 'Model' },
    prompt: { type: 'string', title: 'Prompt', widget: 'textarea' },
    size: { type: 'string', title: 'Size' },
    n: { type: 'integer', title: 'N', default: 1, minimum: 1, maximum: 4 },
    response_format: {
      type: 'string',
      title: 'Response Format',
      enum: ['url', 'b64_json'],
      default: 'url'
    },
    user: { type: 'string', title: 'User' }
  }
}
```

### `normalizeRequest`

输出：

```js
{
  prompt,
  model,
  size,
  n,
  response_format,
  user
}
```

不额外发明通用字段，尽量保留 OpenAI 图片协议原名。

### 特别说明：`size`

对于 ChatGPT Image 2，验证结果表明：

```text
<prompt>

将宽高比设置为 <size>
```

这种官方注入方式可行，因此 `size` 原样透传给脚本，由脚本决定如何注入页面交互提示。

### `renderResponse`

脚本返回：

```js
{
  success: true,
  data: {
    created,
    data: [
      { url?, b64_json?, revised_prompt? }
    ],
    message?
  }
}
```

直接渲染成标准 OpenAI Image Generation 响应。

### `buildRecord`

```js
{
  modelId,
  modelName,
  prompt,
  inputFiles: [],
  responseText: message || '',
  responseMedia,
  reasoningContent: null,
  status,
  errorMessage,
  durationMs,
  isStreaming: false
}
```

---

## 8.3 `openai-images-edits`

### 对外路由

```http
POST /v1/images/edits
```

### `provider.models`

示例：

```js
provider: {
  type: 'openai-images-edits',
  models: ['gpt-image-2']
}
```

### `inputSchema`

```js
{
  type: 'object',
  required: ['prompt', 'images'],
  properties: {
    model: { type: 'string', title: 'Model' },
    prompt: { type: 'string', title: 'Prompt', widget: 'textarea' },
    images: {
      type: 'file',
      title: 'Images',
      multiple: true,
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    },
    mask: {
      type: 'file',
      title: 'Mask',
      multiple: false,
      accept: ['image/png', 'image/jpeg', 'image/webp']
    },
    size: { type: 'string', title: 'Size' },
    n: { type: 'integer', title: 'N', default: 1, minimum: 1, maximum: 4 },
    response_format: {
      type: 'string',
      title: 'Response Format',
      enum: ['url', 'b64_json'],
      default: 'url'
    },
    user: { type: 'string', title: 'User' }
  }
}
```

### `normalizeRequest`

输出：

```js
{
  prompt,
  model,
  images: [ { path, name, mimeType, size } ],
  mask: { path, name, mimeType, size } | null,
  n,
  size,
  response_format,
  user
}
```

### `renderResponse`

脚本返回格式与 `openai-images-generations` 保持一致，provider 渲染成 OpenAI Image Edit 响应。

### `buildRecord`

```js
{
  modelId,
  modelName,
  prompt,
  inputFiles: images,
  responseText: message || '',
  responseMedia,
  reasoningContent: null,
  status,
  errorMessage,
  durationMs,
  isStreaming: false
}
```

---

## 9. 历史记录标准格式

为了少改现有表格与数据库，统一 provider 的 `buildRecord()` 输出为：

```js
{
  modelId: string | null,
  modelName: string | null,
  prompt: string | null,
  inputFiles: array,
  responseText: string | null,
  responseMedia: array,
  reasoningContent: string | null,
  status: 'pending' | 'success' | 'failed',
  errorMessage: string | null,
  durationMs: number | null,
  isStreaming: boolean
}
```

### 落地策略

第一阶段尽量沿用现有存储字段：

- `prompt`
- `responseText`
- `reasoningContent`
- `responseMedia`
- `status`
- `errorMessage`
- `durationMs`
- `isStreaming`

`inputFiles` 在持久化时可先映射到当前 `input_images` 兼容字段，后续再统一重构 DB 结构。

---

## 10. WebUI 调试台改造方案

## 10.1 适配器选择后，读取 provider

当前流程改成：

1. 选择 Adapter
2. 读取 `manifest.provider.type`
3. 从 Provider Registry 获取 `inputSchema`
4. 渲染调试表单

## 10.2 调试接口

统一调试接口：

```http
POST /admin/debug/run
```

请求体改成：

```json
{
  "workerName": "chatgpt_debug",
  "source": "<完整适配器脚本源码>",
  "input": {
    "prompt": "一只橘猫",
    "model": "gpt-image-2",
    "size": "1024x1024",
    "n": 1,
    "response_format": "url"
  },
  "keepPageOpen": false,
  "timeout": 300000
}
```

### 说明

- `source`
  - 当前编辑器里的完整适配器脚本源码
- `input`
  - 直接由 provider inputSchema 表单生成的输入对象

这样：
- 调试接口
- 正式 provider 输入
- 脚本执行输入

三者保持一致。

---

## 11. Worker 绑定规则

继续保持最小改动：

```yaml
workers:
  - name: chatgpt_a
    type: chatgpt_image_generate
```

说明：

- `worker.type = adapter.id`
- `merge` 继续保留并有效

---

## 12. 首批迁移范围

第一阶段只做三类 provider + 对应适配器：

1. `openai-chat-completions`
2. `openai-images-generations`
3. `openai-images-edits`

建议首批脚本：

- `chatgpt_image_generate`
- `chatgpt_image_edit`
- `gemini_image_generate`
- `gemini_image_edit`（如果网页能力允许）
- `chatgpt_text_completion`
- `gemini_text_completion`

---

## 13. 代码落地步骤（可执行）

### Phase 1：协议骨架

1. 新建 Provider Registry
2. 定义三类 provider
3. Adapter manifest 改成：
   - `id`
   - `name`
   - `provider`
   - `execute`
4. Debug 接口入参改成：
   - `source`
   - `input`

### Phase 2：路由层改造

1. `/v1/chat/completions` 改用 `openai-chat-completions`
2. 新增 `/v1/images/generations`
3. 新增 `/v1/images/edits`
4. 请求先走 provider.normalizeRequest()
5. 脚本结果再走 provider.renderResponse()

### Phase 3：历史记录改造

1. provider.buildRecord() 统一输出记录对象
2. 最小改动映射到当前 DB 字段
3. 保持现有历史表可用

### Phase 4：前端调试台改造

1. 适配器页选择 adapter 后读取 provider
2. 用 provider.inputSchema 渲染表单
3. 以 `{ source, input }` 方式调用 `/admin/debug/run`

### Phase 5：迁移首批脚本

1. 重写 `chatgpt image generate`
2. 重写 `gemini image generate`
3. 重写 `chatgpt text`
4. 重写 `gemini text`

---

## 14. 验收标准

### Provider 层

- 能正确注册三种 provider
- 能按 provider + model 路由找到可用 adapter/worker

### OpenAI 接口层

- `/v1/chat/completions` 可用
- `/v1/images/generations` 可用
- `/v1/images/edits` 可用

### Debug 层

- `/admin/debug/run` 接收 `{ source, input }`
- 调试表单由 provider.inputSchema 渲染
- 调试截图/HTML/文件 URL 可访问

### 历史记录层

- 表格可继续展示
- 文本、媒体、错误、耗时可正确落库

---

## 15. 一句话总结

本方案最终把系统收敛成：

> **Adapter 只负责 `execute(ctx, input)`；Provider 负责标准协议定义、请求归一化、响应适配与历史记录标准化；第一阶段只定义 `openai-chat-completions`、`openai-images-generations`、`openai-images-edits` 三种 provider。**
