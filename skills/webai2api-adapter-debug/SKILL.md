---
name: webai2api-adapter-debug
description: 当用户要求调试 WebAI2API 中运行在远程 resident page 上的 adapter 脚本、对话脚本或页面自动化脚本时加载。适用于需要定位 worker/session、页面 ready、发送稳定性、协议取数、图片工具结果提取、回写正式 adapter 的场景。
---
# webai2api-adapter-debug

## 目标

用稳定、可复用的方法调试运行在远程 resident page 上的 adapter 脚本，并在确认脚本稳定后回写正式 adapter。

优先级顺序：

1. 先让脚本稳定执行
2. 再确认结束信号
3. 再确认内容提取主路径
4. 最后回写正式 adapter

## 执行入口

- 远程请求、认证和原始响应输出统一使用 `scripts/webai2api-cli.py`
- 调试时直接编写最终 adapter JS 文件，再用 CLI 读取该文件的 `manifest.script` 执行远程验证
- 推荐工作文件：`examples/dynamic-adapters/<adapterId>.js`
  - 若任务明确要求同步运行时副本，再在最后同步到 `data/adapters/<adapterId>.js`
  - 调试过程中只维护一份工作文件
- 实际调用参数、示例和约束不写在本 skill 中，直接查看：
  - `python3 skills/webai2api-adapter-debug/scripts/webai2api-cli.py --help`
  - `skills/webai2api-adapter-debug/scripts/README.md`
- 除非在调试 CLI 本身，否则不要手写 `curl`
- 不要把独立临时 `script` 文件当成常规调试输入

## 调试工作流

按下面顺序推进，不要跳步骤：

1. 选定唯一主文件
  - 优先使用 `examples/dynamic-adapters/<adapterId>.js`
  - 如果文件不存在，就按本 skill 的 DSL 新建它

2. 先把 `manifest` 壳写对
  - `id` 与目标 `adapterId` 一致
  - `name`、`description`、`homePageUrl`、`inputJsonSchema` 先补最小必要集
  - `script` 必须是字符串形式的函数体

3. 先写“只观察”版本的 `script`
  - 不发消息
  - 只返回 `url`、`title`、页面关键状态
  - 先验证页面能否进入、worker 是否正确、基本 DOM 是否可见

4. 用 CLI 调试这个最终 adapter 文件
  - CLI 会自动 import 文件、读取 `manifest.id` 和 `manifest.script`
  - CLI 会先做本地编译校验，再发远程请求

5. 如果 CLI 报“本地编译失败”
  - 直接回到 adapter 文件，修 `manifest.script` 的转义或内层语法
  - 修完后重新运行同一个 CLI 命令

6. “只观察”成功后，再升级到“最小发送”
  - 先验证能不能发出去
  - 再验证能不能拿到本轮新增结果

7. “最小发送”成功后，再补结束信号和主提取路径
  - 协议 / 流优先
  - DOM 只做兜底

8. 全部稳定后，如有需要，再同步到运行时副本
  - 只有在主文件已稳定后，才同步到 `data/adapters/<adapterId>.js`

## WebAI2API 工作模型

先把系统模型想清楚：

```text
客户端请求
  -> POST /api/{adapterId}
    -> 选择/校验 worker
      -> 在该 worker 的 resident page 上执行脚本
        -> 返回统一 envelope
```

关键事实：

- 一个 `adapterId` 对应一种网页能力
- 一个 worker 绑定一个 `type`，通常等于一个 `adapterId`
- 一个 worker 维护一个持久 resident page
- 同一 worker 默认串行执行
- 调试与正式执行共用同一个入口：`POST /api/{adapterId}`

这意味着：

- 调试不是在本地浏览器里跑
- 调试不是改后端逻辑就自动生效
- 你调的是“远程 resident page 上的脚本执行行为”

## Adapter DSL

### 唯一支持的结构

```js
export const manifest = {
  id: '<adapterId>',
  name: '<Adapter Name>',
  description: '<What this adapter does>',
  homePageUrl: 'https://<target-site>',
  inputJsonSchema: {
    type: 'object',
    properties: {
      '<fieldName>': { type: 'string', title: '<Field Title>' }
    }
  },
  script: `
    // 这里不是函数声明，而是 async function 的函数体
    return { ok: true };
  `
};
```

### 起步模板

第一次调试某个 adapter 时，先从一个“只观察、不发送”的最小模板开始。字段、输入结构和选择器都按目标站点或接口调整：

```js
export const manifest = {
  id: '<adapterId>',
  name: '<Adapter Name>',
  description: '<Adapter description>',
  homePageUrl: 'https://<target-site>',
  inputJsonSchema: {
    type: 'object',
    properties: {
      '<fieldName>': { type: 'string', title: '<Field Title>' }
    }
  },
  script: `
const pageReady = await page.locator('<replace-with-target-ready-selector>').first().isVisible().catch(() => false);
return {
  url: page.url(),
  title: await page.title().catch(() => ''),
  pageReady,
  inputKeys: Object.keys(input || {}),
  inputSample: JSON.stringify(input || {}).slice(0, 200)
};
`
};
```

这个模板只做“观察”，不发送消息，适合先验证：

- adapter 文件能否被 import
- `manifest.script` 能否通过本地编译
- worker 是否正确
- resident page 是否进入目标站点
- 目标页面或目标接口对应的关键元素是否可见

### 字段语义

- `id`
  - adapter 唯一标识
  - 对应路由 `/api/{adapterId}`
  - 通常也对应 worker 的 `type`
- `name`
  - 展示名称
- `description`
  - 说明文本
- `homePageUrl`
  - resident page 的默认常驻站点
  - worker 初始化、页面重建或浏览器恢复时会最佳努力打开它
- `inputJsonSchema`
  - 输入说明，主要用于 UI 与自说明
  - 不应假设平台会替你做强校验
- `script`
  - 真正执行的脚本
  - 必须是字符串形式的 async function 函数体

### 脚本执行模型

运行时最终会把脚本字符串编译成类似下面的 async runner：

```js
async function runner(page, input, api, helpers, runtime) {
  // 你的 script 内容在这里执行
}
```

因此脚本里：

- 可以直接使用 `page`
- 可以直接使用 `input`
- 可以直接使用 `api`
- 可以直接使用 `helpers`
- 可以直接使用 `runtime`
- 不需要 `import`
- 不需要再包一层函数

### adapter `script` authoring 规则

1. 直接编辑最终 adapter JS 文件
2. `manifest.script` 是**外层 adapter 文件中的字符串字面量**
3. 该字符串的运行时值，才是远端最终要编译的函数体
4. CLI 只做：`import adapter -> 读取 manifest.script -> 本地编译 -> 远端执行`

这意味着：

- 你写在 adapter 文件里的 `script`，不是“原始 JS 源码”，而是“**承载 JS 源码的字符串**”
- 正则、换行、反斜杠等内容，要按**外层字符串**再转义一层
- 不要把 JSON 字符串化后的文本直接粘进 adapter 文件

#### 写法示例

如果**内层最终函数体**想要的是：

```js
const resourceId = (String(url || '').match(/\/item\/([0-9a-f-]{8,})/i) || [])[1] || null;
const blocks = chunk.split(/\n\n+/);
const lines = part.split(/\r?\n/);
const text = String(node.innerText || '').replace(/\s+/g, ' ').trim();
const joined = parts.join('\n\n');
```

那么**adapter 文件里的 `manifest.script` 字符串源码**应写成：

```js
const resourceId = (String(url || '').match(/\\/item\\/([0-9a-f-]{8,})/i) || [])[1] || null;
const blocks = chunk.split(/\\n\\n+/);
const lines = part.split(/\\r?\\n/);
const text = String(node.innerText || '').replace(/\\s+/g, ' ').trim();
const joined = parts.join('\\n\\n');
```

一句话判断：

- 如果你正在编辑的是 `.js` adapter 文件里的 `manifest.script`，通常要比“最终函数体源码”**多一层反斜杠**
- 如果 CLI 成功 import adapter，但本地编译失败，优先怀疑这层转义写错了

典型错误症状：

- `Invalid regular expression flags`
- `Unexpected token`
- `Numeric separators are not allowed at the end of numeric literals`

#### 编译失败时优先检查什么

如果 CLI 能 import adapter 文件，但本地编译 `manifest.script` 失败，优先按下面顺序检查：

1. 正则里的斜杠是否少转义或多转义
2. `\n` / `\r` / `\s` 这类转义是否写在正确层级
3. 字符串引号是否互相打断
4. CSS 选择器字符串里是否有未转义的引号
5. 从 JSON、网页编辑器或别的工具复制过来的文本，是否直接粘进了 adapter 文件

判断原则：

- 你正在编辑的是 adapter 文件里的字符串字面量
- 先让外层字符串合法
- 再让它的运行时值成为合法的函数体源码

### 注入对象

#### `page`

当前 worker 的 resident Playwright `Page`。

常用能力：

- `page.goto()`
- `page.locator()`
- `page.getByRole()`
- `page.evaluate()`
- `page.waitForTimeout()`
- `page.on('websocket', ...)`

#### `input`

请求体中的业务输入。

例如：

```json
{
  "input": {
    "<fieldName>": "<value>",
    "<optionalField>": "<optionalValue>"
  }
}
```

#### `api`

平台提供的调试/产物辅助能力。

最小稳定集合：

- `api.log(level, message, extra?)`
- `api.step(name, extra?)`
- `api.sleep(ms)`
- `api.goto(url, options?)`
- `api.capture(name, options?)`
- `api.saveFile({ relativePath, content, mimeType })`

#### `helpers`

平台辅助函数集合。

常见能力：

- `helpers.apiError(options)`
- `helpers.files.resolve(value, options)`
- `helpers.files.resolveMany(values, options)`
- `helpers.files.fromPath(filePath, options)`
- `helpers.files.fromBuffer(buffer, options)`
- `helpers.files.fromDataUrl(dataUrl, options)`
- `helpers.files.fromUrl(url, options)`

#### `runtime`

只读运行时信息。

常见字段：

- `runtime.config`
- `runtime.proxyConfig`
- `runtime.userDataDir`
- `runtime.workerName`
- `runtime.instanceName`
- `runtime.worker`
- `runtime.meta`

不要轻易依赖内部结构做核心业务逻辑，只把它当成调试辅助上下文。

### 返回值协议

脚本 `return` 的对象会进入成功响应的 `data` 字段。

成功响应形态：

```json
{
  "ok": true,
  "data": { ... },
  "meta": { ... }
}
```

失败响应形态：

```json
{
  "ok": false,
  "message": "错误信息",
  "meta": { ... }
}
```

`debug: true` 时还会附带：

```json
{
  "trace": {
    "steps": [],
    "captures": [],
    "logs": []
  }
}
```

文件产物规则：

- `api.capture()` / `api.saveFile()` 对外返回 URL
- 正式输出不要依赖本地绝对路径

## 实践方法论

### 1. 默认固定路由

- 单轮调试：固定 `workerId`
- 多轮或状态相关调试：固定 `workerId`；如果目标站点本身提供可复用状态标识，再一并固定该标识

未固定前，不要根据现象下结论。

### 2. 先观察，再发送

第一次进入目标 worker 或目标页面状态时，先采样：

- 当前 URL / 可复用状态标识（若目标站点提供）
- 关键交互元素是否可见（如输入框、提交按钮、上传入口）
- 是否存在 dialog / modal
- 与本轮结果判定相关的基线数量或标识（如消息数、卡片数、记录数）
- 是否存在页面级“进行中”信号

不要一上来就触发真实业务动作（如发送 prompt、点击提交、上传文件）。

可执行拆分建议：

- 第一次修改文件，先写“观察版 script”
- 观察版跑通后，再加发送逻辑

### 3. 页面 ready 只看最低必要条件

页面 ready 的最低要求：

- 关键交互元素可见
- 没有阻塞性弹窗

推荐流程：

1. 进入目标页或目标业务状态
2. 短等待 + 检测循环采样 UI 状态
3. 若有弹窗，优先尝试关闭
4. 若短时间仍未 ready，允许 reload 一次
5. 若总超时仍未 ready，快速失败并带状态返回

### 4. 只在真实弹窗存在时处理弹窗

- 不要无条件发送 `Escape`
- 先确认 dialog / modal 真实可见，再尝试：
  1. `Escape`
  2. 通用按钮：`Not now` / `Maybe later` / `Skip` / `Close` / `Got it` / `Continue`

无条件 `Escape` 可能打断输入、发送或生成。

### 5. 发送前先抓基线

发送前至少记录以下之一：

- 结果项的唯一标识（如 message id、card id、record id）
- 结果项数量
- 旧状态的历史稳定点

否则容易把历史结果误判为本轮新增结果。

### 6. 不要长时间无脑等待

统一使用“短等待 + 检测循环”：

- 每次等待 1~3 秒
- 重新采样状态
- 有异常就立即处理或快速失败

### 7. 协议优先，DOM 兜底

内容获取优先级：

1. 优先从接口、协议或流里取数据
2. 只有协议隐晦、解析成本过高，或结果本身由前端组装时，再考虑 DOM

原则：

- 内容获取应明确一个主提取来源
- DOM 优先作为兜底，而不是默认提取来源
- 代码块、表格、引用等结构化内容优先使用更干净的数据源

### 8. 结束信号优先使用站点强信号

不要只靠“文本静止”判断结束。

优先寻找目标站点自己的强信号，例如：

- 站点原生流结束事件
- 明确的“回答完成”事件
- 页面级“进行中”标记消失
- 最终操作按钮出现

只有没有可靠强信号时，才退回到“页面不再进行中 + 文本稳定一段时间”。

### 9. 快速失败要可诊断

常见失败类型：

- 页面未 ready
- 阻塞性弹窗
- 业务动作触发后没有任何进展
- 页面假死
- 结果已生成但脚本没抓到

失败时优先返回：

- 当前 URL / 可复用状态标识（若目标站点提供）
- dialog 状态
- 关键交互元素是否可见
- 最近一次状态采样
- 必要截图或 trace

### 10. 调试监听必须可回收

- WebSocket / frame / page 事件监听在退出前必须解绑
- 不要污染 resident page 的后续轮次

## 图片 / 工具结果调试补充

当任务涉及图片生成、图片编辑或工具输出时，额外遵守：

- 不要把普通 assistant 文本当成图片结果
- 只有 `role=tool` 且 `metadata.async_task_type == "image_gen"` 的消息，才应视为图片工具输出
- `file_upload` 通常是上传过程占位，不应作为输出图片
- 输入附件和输出图片必须区分
- 如果流里没有直接拿到图片结果，但拿到了 `conversation_id`，应继续查询 conversation 明细
- conversation 明细里仍然只读取 `role=tool && async_task_type=image_gen` 的消息

相关参考：

- `/home/fengwk/proj/chatgpt2api/docs/upstream-sse-conversation.md`
- `/home/fengwk/proj/chatgpt2api/services/protocol/conversation.py`
- `/home/fengwk/proj/chatgpt2api/services/openai_backend_api.py`

## 推荐工作流

1. 先读当前 adapter、协议文档和相关参考实现
2. 在最终 adapter 文件里先写最小 `script`，做“只观察”验证
3. 再做最小发送验证
4. 成功后再补结束信号与主提取路径
5. 结果稳定后回写正式 adapter
6. 回写后补做回归验证

## 调试完成标准

认为“调通”至少要满足：

- 最小业务动作稳定成功
- 结构化结果稳定成功（若该 adapter 需要）
- 搜索 / 工具 / 上传 / 生成等扩展场景稳定成功（若该 adapter 需要）
- 长耗时或复杂场景稳定成功（若该 adapter 需要）
- 需要复用同一页面状态的连续操作保持一致且不串台
- 出现弹窗、页面阻塞、无进展时能快速失败并给出可诊断信息

## 优先阅读的文件

开始调试前，优先阅读：

- 当前目标 adapter 文件
- `/home/fengwk/proj/WebAI2API/ADAPTER_SCRIPT_GUIDE.md`
- `/home/fengwk/proj/WebAI2API/DYNAMIC_ADAPTERS_KISS.md`
- `/home/fengwk/proj/WebAI2API/ARCHITECTURE.md`

需要浏览器自动化细节时，再看：

- `https://playwright.dev/docs/intro`
- `https://playwright.dev/docs/api/class-page`
- `https://playwright.dev/docs/api/class-locator`
- `https://playwright.dev/docs/api/class-websocket`
- `https://github.com/daijro/camoufox`
