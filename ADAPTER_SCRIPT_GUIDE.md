# WebAI2API 动态适配器脚本指南

当前运行时只加载：

```text
/app/data/adapters/*.js
```

一个文件代表一个站点级 adapter，一个 worker 只绑定一个 adapter ID。

## 最小协议

```js
export const manifest = {
  id: 'chatgpt',
  name: 'ChatGPT',
  providers: [
    {
      type: 'openai-images-generations',
      models: ['gpt-image-2'],
      async execute(ctx, input) {
        const { page, api } = ctx;
        await page.goto('https://chatgpt.com/images/', { waitUntil: 'domcontentloaded' });
        api.log('info', '开始执行', { model: input.model });
        return {
          success: false,
          error: {
            message: '请实现具体逻辑',
            retryable: false
          }
        };
      }
    }
  ]
};
```

## 字段说明

- `manifest.id`
  - adapter 唯一 ID
  - 必须与文件名一致
  - worker 配置中的 `type` 就是它
- `manifest.name`
  - WebUI 展示名称
- `manifest.providers`
  - 站点支持的 provider 能力列表
- `provider.type`
  - 标准 provider 类型，例如：
    - `openai-chat-completions`
    - `openai-images-generations`
    - `openai-images-edits`
- `provider.models`
  - 该 provider entry 支持的模型列表
- `provider.execute(ctx, input)`
  - 核心执行函数

## 运行时职责边界

运行时只负责：

- 加载脚本
- 根据 worker.type 找到 adapter
- 根据 `provider.type + model` 找到 provider entry
- 提供统一的 `ctx` / `api`

脚本自己负责：

- `page.goto(...)`
- 页面状态收敛
- 上传文件
- 点击发送
- 等待结果
- 识别错误
- 保存输出文件

因此协议里**没有**这些字段：

- `getTargetUrl`
- `navigationHandlers`
- `homeUrl`

## `ctx` 结构

```js
ctx = {
  page,
  context,
  config,
  proxyConfig,
  userDataDir,
  workerName,
  instanceName,
  worker,
  api
}
```

其中：

- `ctx.page`
- `ctx.context`
- `ctx.config`
- `ctx.proxyConfig`
- `ctx.userDataDir`
- `ctx.worker = { name, type, instance }`

## `api` 能力

- `api.log(level, message, extra?)`
- `api.sleep(ms)`
- `api.capture(name, options?)`
- `api.saveFile({ relativePath, content, mimeType })`

## 输入约定

`input` 由标准 provider 归一化后传入。

例如图片 provider 常见字段：

- `input.model`
- `input.prompt`
- `input.size`
- `input.n`
- `input.responseFormat`
- `input.images`（每项包含 `path/fileName/mimeType`）
- `input.mask`

## 返回值约定

成功：

```js
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
```

失败：

```js
return {
  success: false,
  error: {
    message: '错误信息',
    retryable: false
  }
};
```

## 调试与验收

- 保存脚本时只做静态校验
- 页面级排障使用 `/admin/debug/run`
- 真实功能联调直接走正式 `/v1/*` 接口
