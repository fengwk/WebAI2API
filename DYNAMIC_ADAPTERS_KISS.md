# WebAI2API 动态适配器 KISS 设计（V1）

## 核心原则

- 一个文件对应一个 adapter 能力脚本
- 一个 worker 只绑定一个 `adapterId/type`
- resident page 常驻，worker 默认串行执行
- 正式执行与调试执行统一走：

```http
POST /api/{adapterId}
```

- 不再保留 `/admin/debug/run` 旁路

---

## 1. 统一脚本结构

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
    return { title: await page.title() };
  `
};
```

---

## 2. 不再支持的旧结构

以下结构已废弃：

- `providers[]`
- `models`
- `execute(ctx, input)`
- `outputJsonSchema`
- `timeoutMs`

脚本只有一套结构，不再做双结构兼容。

---

## 3. 执行协议

请求体：

```json
{
  "input": {},
  "debug": false,
  "workerId": "optional",
  "overrideScript": "optional"
}
```

### 行为

- 无 `overrideScript`
  - 执行 manifest.script

- 有 `overrideScript`
  - 本次执行时覆盖 manifest.script

- 有 `workerId`
  - 强制落到指定 worker
  - 若 busy，则进入该 worker 本地 FIFO 队列

- `debug = true`
  - 返回 `trace.steps / trace.captures / trace.logs`

---

## 4. Worker 语义

### 第一轮保持不变

- 一个 worker 只支持一个 `adapterId`
- 即：`worker.type === adapterId`

这意味着：

- sticky 调试通过 `workerId` 实现
- 指定的 worker 必须和当前 adapterId 匹配

---

## 5. resident page 语义

- worker 初始化时，会在 resident page 上最佳努力打开 `homePageUrl`
- resident page 被关闭后，重建时也会再次尝试打开 `homePageUrl`
- worker 所属浏览器上下文重建后，共享 worker 恢复时同样会重新打开 `homePageUrl`

`homePageUrl` 的作用不是每次执行都强制跳转，而是：

> 定义这个 worker 的 resident page 默认常驻站点。

脚本本身仍然可以在执行过程中自行导航到其他页面。

---

## 6. 返回结构

### 成功

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "requestId": "req_xxx",
    "adapterId": "chatgpt_image",
    "workerId": "chatgpt-page",
    "instanceId": "glatzsheryn",
    "queuedMs": 120,
    "durationMs": 3120,
    "page": {
      "url": "https://chatgpt.com",
      "title": "ChatGPT"
    }
  }
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

额外附带：

```json
"trace": {
  "steps": [],
  "captures": [],
  "logs": []
}
```

---

## 7. 队列模型

队列分为两层：

### 全局入口层
- 使用 `queue.queueBuffer`
- 全局入口上限 = `Workers数量 + queueBuffer`

### worker 本地层
- 使用 `queue.workerMaxPending`
- 单 worker 本地 FIFO 队列上限
- 使用 `queue.workerWaitTimeout`
- 单请求在 worker 本地队列中的最长等待时间

### 调度策略

`least_busy` 的负载定义为：

```text
load = activeCount + pendingCount
```

---

## 8. 文件产物原则

- 所有 capture/saveFile 只对外返回 URL
- 不返回本地路径
- 内部可保留 `localPath`，但禁止出现在 API 响应中

---

## 9. KISS 结论

第一轮 KISS 的核心就是：

- **保留 instance / worker / resident page / 浏览器底座**
- **统一脚本结构**
- **统一执行入口**
- **用 `workerId + overrideScript + debug` 覆盖调试需求**
- **删除历史双结构与 debug 执行旁路**
