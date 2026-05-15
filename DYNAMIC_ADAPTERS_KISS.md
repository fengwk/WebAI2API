# WebAI2API 动态适配器 KISS 设计

## 核心原则

- 一个文件对应一个站点级 adapter
- 一个 worker 只代表一套浏览器/登录态/代理配置
- 一个 adapter 内部可以声明多个 provider entry
- `execute()` 自己负责 `goto` 与页面收敛
- 正式联调只走 `/v1/*`
- `/admin/debug/run` 只保留为低层浏览器调试工具

## 当前协议

```js
export const manifest = {
  id: 'chatgpt',
  name: 'ChatGPT',
  providers: [
    {
      type: 'openai-images-generations',
      models: ['gpt-image-2'],
      async execute(ctx, input) {}
    },
    {
      type: 'openai-images-edits',
      models: ['gpt-image-2'],
      async execute(ctx, input) {}
    }
  ]
};
```

## 为什么这样设计

### 1. 同站点能力不再拆成多个 worker

例如 ChatGPT 文生图与图生图共享同一站点、登录态与页面逻辑。

如果拆成多个 adapter：

- worker 配置会膨胀
- 同站点逻辑会重复
- merge 会被滥用为“同站点多能力拼装器”

改成一个 adapter 多 provider entry 后：

- worker 只需 `type: chatgpt`
- 共享上传/下载/错误解析逻辑
- merge 仅保留给跨站点聚合与故障转移

### 2. 页面职责归脚本自己

协议里不再保留：

- `getTargetUrl`
- `navigationHandlers`
- `homeUrl`

这些都是站点行为，不是标准协议。

## 运行时职责

- 加载 `/app/data/adapters/*.js`
- 校验 `manifest.id/name/providers[]`
- 根据 worker.type 找 adapter
- 根据 `provider.type + model` 找 provider entry
- 调用该 entry 的 `execute(ctx, input)`

## Admin 行为

- `/admin/adapters`：显示脚本静态元数据
- 保存脚本：只做静态校验
- 不再保留 `/admin/adapters/:id/test`
- `/admin/debug/run`：继续保留 raw script 浏览器调试

## 正式接口

- `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `POST /v1/images/edits`

正式调用时由标准 provider 层完成：

- 请求归一化
- 模型路由
- 响应格式转换
- 历史记录标准化
