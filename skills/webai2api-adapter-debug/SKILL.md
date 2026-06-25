---
name: webai2api-adapter-debug
description: 当用户要求调试 WebAI2API 中依赖远程浏览器的适配器脚本、对话脚本或页面自动化脚本时加载。
---
# webai2api-adapter-debug

## 目标

用一套稳定、可复用的流程调试运行在远程 resident page 上的自动化脚本。

目标顺序：

1. 先让脚本稳定执行
2. 再收敛结束信号
3. 再收敛内容提取路径
4. 最后再回写正式 adapter

## 何时使用

以下情况加载本技能：

- 用户明确要求“调试” WebAI2API 中依赖远程浏览器的脚本或适配器
- 需要通过 `overrideScript` 快速试验逻辑
- 需要处理 `workerId`、`sessionId`、页面 ready、弹窗、内容抓取、异常快退、回归验证

## 基本 API 用法

最小请求：

```http
POST /api/{adapterId}
Content-Type: application/json
```

请求体：

```json
{
  "input": {
    "prompt": "...",
    "sessionId": "..."
  },
  "debug": true,
  "workerId": "...",
  "overrideScript": "..."
}
```

最小 `curl` 示例：

```bash
curl -X POST "https://<host>/api/chatgpt" \
  -H 'Content-Type: application/json' \
  -d '{
    "input": {"prompt": "用一句话回答：什么是 Docker？"},
    "debug": true,
    "workerId": "chatgpt-worker-1",
    "overrideScript": "return { url: page.url() };"
  }'
```

调试时默认建议：

- 传 `debug: true`
- 传 `workerId`
- 有多轮上下文时在 `input` 里传 `sessionId`
- 初步定位阶段优先传 `overrideScript`

## WebAI2API 是怎么工作的

先把系统模型想清楚：

```text
客户端请求
  -> POST /api/{adapterId}
    -> 选择/校验 worker
      -> 在该 worker 的 resident page 上执行脚本
        -> 返回统一 envelope
```

关键点：

- 一个 `adapterId` 对应一种网页能力
- 一个 worker 绑定一个 `type`，通常等于一个 `adapterId`
- 一个 worker 维护一个持久 resident page
- 同一 worker 默认串行执行
- 调试与正式执行共用同一个入口：`POST /api/{adapterId}`

这意味着：

- 调试不是在本地浏览器里跑
- 调试不是直接改后端逻辑才生效
- 你调的是“远程 resident page 上的脚本执行行为”

## Adapter / Manifest 协议

一个 adapter 文件本质上导出一个 `manifest`：

```js
export const manifest = {
  id: 'chatgpt',
  name: 'ChatGPT',
  description: '...',
  homePageUrl: 'https://chatgpt.com',
  inputJsonSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', title: '提示词' },
      sessionId: { type: 'string', title: '会话 ID（可选）' }
    }
  },
  script: `
    // 这里不是函数声明，而是 async function 的函数体
    return { ok: true };
  `
};
```

### 字段含义

- `id`
  - adapter 唯一标识
  - 对应路由 `/api/{adapterId}`
- `name`
  - 展示名称
- `description`
  - 说明文本
- `homePageUrl`
  - worker 初始化 / 重建时优先进入的默认站点
- `inputJsonSchema`
  - 输入描述，主要用于 UI/说明
- `script`
  - 真正执行的脚本
  - 是**字符串形式的脚本函数体**，不是 `function` 定义

## 脚本执行协议

WebAI2API 会把 `manifest.script` 或 `overrideScript` 编译成一个 async runner。

可以把它理解成：

```js
async function runner(page, input, api, helpers, runtime) {
  // 你的 script 内容就在这里执行
}
```

因此脚本里：

- 可以直接使用 `page`
- 可以直接使用 `input`
- 可以直接使用 `api`
- 可以直接使用 `helpers`
- 可以直接使用 `runtime`

不需要额外 import，也不需要包一层函数。

### 文件里的脚本 vs 直接调试脚本

要区分两种场景：

1. **adapter 文件里的 `manifest.script`**
  - 它是一个 JavaScript 字符串字面量
  - 正则、换行、反斜杠等内容往往需要多一层转义

2. **请求体里的 `overrideScript`**
  - 它是脚本本体
  - 不应再带 adapter 文件字符串层面的额外转义

如果把文件中的脚本直接复制到网页脚本编辑器或 `overrideScript` 中，容易出现：

- `Invalid regular expression flags`
- `Unexpected token`

因此：

- 从 adapter 文件复制到 `overrideScript` 时，要去掉一层字符串转义
- 从 `overrideScript` 回写到 adapter 文件时，要补上一层字符串转义

## 注入对象

### `page`

当前 worker 的 resident Playwright `Page`。

它是主要的浏览器自动化入口，例如：

- `page.goto()`
- `page.locator()`
- `page.getByRole()`
- `page.evaluate()`
- `page.waitForTimeout()`
- `page.on('websocket', ...)`

### `input`

请求体中的业务输入。

例如：

```json
{
  "input": {
    "prompt": "...",
    "sessionId": "..."
  }
}
```

脚本中直接读取：

```js
const prompt = input.prompt;
const sessionId = input.sessionId;
```

### `api`

平台提供的调试/产物辅助能力。

当前可稳定依赖的最小集合：

- `api.log(level, message, extra?)`
- `api.sleep(ms)`
- `api.step(name, extra?)`
- `api.capture(name, options?)`
- `api.saveFile({ relativePath, content, mimeType })`

调试阶段优先使用这些能力做观测。

### `helpers`

平台辅助函数集合。

常见能力：

- `helpers.apiError(options)`
- `helpers.files.resolve(value, options)`
- `helpers.files.resolveMany(values, options)`
- `helpers.files.fromPath(filePath, options)`
- `helpers.files.fromBuffer(buffer, options)`
- `helpers.files.fromDataUrl(dataUrl, options)`
- `helpers.files.fromUrl(url, options)`

适合在需要处理文件、URL、data URL、输入附件时使用。

### `runtime`

只读运行时信息。

常见字段：

- `runtime.config`
- `runtime.proxyConfig`
- `runtime.userDataDir`
- `runtime.workerName`
- `runtime.instanceName`
- `runtime.worker`
- `runtime.meta`

调试时常用来打印上下文，但不要轻易依赖内部结构做核心逻辑。

关键字段：

- `input`
  - 业务输入
  - 调试前先确认目标 adapter 的 `inputJsonSchema`
- `debug: true`
  - 调试阶段默认必开
- `workerId`
  - 调试阶段默认必传
  - 若指定，则目标 worker 必须支持当前 `adapterId`
  - 用于 sticky 调试
- `overrideScript`
  - 调试阶段优先使用

补充语义：

- `sessionId`
  - 是脚本自己的业务输入
  - 平台不理解它的站点含义
  - 是否进入某个会话、如何进入，由脚本自己决定
- `inputJsonSchema`
  - 主要用于说明与 UI 展示
  - 不应假设平台一定替你做强校验

### `homePageUrl` 的语义

- 它定义的是 worker resident page 的默认常驻站点
- worker 初始化、页面重建或浏览器恢复时，平台会最佳努力打开它
- 但脚本每次执行时是否跳转、跳到哪里，仍然由脚本自己决定

## 最小调试模板

### 模板 A：只观察，不发送

用于先确认页面状态是否正常。

```js
const url = page.url();
const sessionId = (url.match(/\/c\/([0-9a-f-]{8,})/i) || [])[1] || null;
const composerVisible = await page.locator('.ProseMirror').first().isVisible().catch(() => false);
const userCount = await page.locator('[data-message-author-role="user"]').count();
const asstCount = await page.locator('[data-message-author-role="assistant"]').count();

await api.capture('inspect', { screenshot: true, fullPage: false });

return {
  url,
  sessionId,
  composerVisible,
  userCount,
  asstCount
};
```

### 模板 B：最小发送模板

用于先确认“能不能发出去、能不能拿到新回复”。

```js
const composer = page.locator('.ProseMirror').first();
await composer.waitFor({ timeout: 15000 });

const before = (await composer.innerText()).trim();
if (before) {
  await page.keyboard.press('ControlOrMeta+a').catch(() => null);
  await page.keyboard.press('Delete').catch(() => null);
}

const baselineCount = await page.locator('[data-message-author-role="assistant"]').count();

await composer.pressSequentially(String(input.prompt || ''), { delay: 3, timeout: 30000 });

const sendBtn = page.locator('button[data-testid="send-button"]');
try {
  await sendBtn.click({ timeout: 8000 });
} catch {
  await composer.press('Enter', { timeout: 5000 });
}

let text = '';
let lastChange = Date.now();
const start = Date.now();
while (Date.now() - start < 120000) {
  const count = await page.locator('[data-message-author-role="assistant"]').count();
  if (count > baselineCount) {
    const next = await page.evaluate((base) => {
      const out = [];
      document.querySelectorAll('[data-message-author-role="assistant"]').forEach((n, i) => {
        if (i >= base) {
          const t = (n.innerText || '').trim();
          if (t) out.push(t);
        }
      });
      return out.join('\\n\\n');
    }, baselineCount);
    if (next !== text) {
      text = next;
      lastChange = Date.now();
    }
    if (text && Date.now() - lastChange >= 5000) {
      break;
    }
  }
  await page.waitForTimeout(500).catch(() => null);
}

return { reply: text };
```

### 模板 C：最小异常快退

用于避免无限等待。

```js
const start = Date.now();
let firstProgressAt = null;

while (Date.now() - start < maxMs) {
  const state = await sampleState();

  if (state.dialogs?.length) {
    await dismissAnyDialog();
  }

  if (state.progress && !firstProgressAt) {
    firstProgressAt = Date.now();
  }

  if (Date.now() - start > 15000 && !firstProgressAt) {
    throw new Error('NO_PROGRESS');
  }

  if (state.done) {
    break;
  }

  await page.waitForTimeout(1000).catch(() => null);
}
```

## 起步顺序

对 0 上下文 agent，推荐永远按这个顺序开始：

1. 用“只观察模板”确认页面状态
2. 确认 `workerId` / `sessionId` 是否正确
3. 确认页面 ready / 是否有弹窗
4. 再用“最小发送模板”验证能否拿到回复
5. 成功后再增加结束信号、内容提取、结构保真等逻辑

## 调试时如何做观测与记录

调试脚本至少应会用这三类能力：

### 1. `api.log()`

用于记录关键时间点和状态。

推荐记录：

- 当前 URL / sessionId
- 页面是否 ready
- 是否发现 dialog
- 发送动作是否成功
- 最近一次进展时间
- 完成信号是否出现
- 快速失败原因

示例：

```js
api.log('info', 'page ready', { url: page.url() });
api.log('info', 'send clicked');
api.log('info', 'no progress', { elapsedMs: 15000 });
```

### 2. `api.capture()`

用于截图做诊断，不用于正式内容提取。

推荐截图时机：

- 页面 ready 后
- 发送前
- 长时间无进展时
- 最终完成时
- 异常退出时

示例：

```js
const shot = await api.capture('ready', { screenshot: true, fullPage: false });
```

### 3. `api.saveFile()`

用于保存中间诊断数据，适合：

- 协议事件样本
- 状态采样序列
- 失败现场摘要

示例：

```js
await api.saveFile({
  relativePath: 'notes/debug-state.json',
  content: JSON.stringify(state, null, 2),
  mimeType: 'application/json'
});
```

## 返回值协议

脚本 `return` 的对象，会进入成功响应的 `data` 字段。

成功响应形态：

```json
{
  "ok": true,
  "data": { ... },
  "meta": { ... }
}
```

文件产物规则：

- `api.capture()` / `api.saveFile()` 对外应返回 URL
- 不要依赖本地绝对路径作为正式输出

## 调试时推荐返回什么

最小建议返回：

- `url`
- `sessionId`（若脚本能识别）
- `reply` 或当前阶段文本
- `meta`（耗时、结束信号、消息数量等）

示例：

```js
return {
  url: page.url(),
  sessionId,
  reply,
  meta: {
    totalMs,
    turnCompleteSeen,
    messageCount
  }
};
```

失败响应形态：

```json
{
  "ok": false,
  "message": "错误信息",
  "meta": { ... }
}
```

`debug: true` 时还会多一个：

```json
{
  "trace": {
    "steps": [],
    "captures": [],
    "logs": []
  }
}
```

因此调试脚本的推荐返回是：

- 最终内容
- 当前 URL / sessionId
- 结束信号摘要
- 耗时
- 必要的诊断字段

## 记录什么

优先记录最小必要信息：

- 页面状态：URL、session、dialog、输入区、消息数量
- 协议状态：是否有流进展、是否有完成信号
- 时间点：发送时间、首次进展时间、完成时间、超时时间
- 失败上下文：最后一次状态采样、截图、错误原因

不要默认记录无边界的大体积原始数据；只有在问题无法定位时，才扩大采样范围。

## 核心规则

### 1. 始终固定路由

- 单轮调试：固定 `workerId`
- 多轮调试：固定 `workerId` + `sessionId`

未固定前，不要根据现象下结论。

### 2. 默认以“调试模式”工作

调试阶段默认：

- 开 `debug: true`
- 多日志
- 多截图
- 多状态采样

先看清问题，再优化脚本。

### 3. 先观察，再发送

第一次进入一个 worker / session 时，先采样：

- 当前 URL / sessionId
- composer 是否可见
- 是否存在 dialog / modal
- 当前 user / assistant message 数
- 是否存在页面级“进行中”信号

不要一上来就发送 prompt。

### 4. 不要长时间无脑等待

统一使用“短等待 + 检测循环”：

- 每次等待 1~3 秒
- 重新采样状态
- 有异常就立即处理或失败返回

## 推荐工作流

### 阶段 A：直接调接口

目标：快速定位问题。

做法：

- 写最小 `overrideScript`
- 先确认页面状态
- 再确认能否发送
- 再确认结束信号和内容提取

### 阶段 B：切到临时脚本文件

当脚本开始变长时：

- 在临时目录维护 `script.js`、`prompt.txt`、runner
- 不再把大段 JS 塞进命令行

目标：

- 减少转义错误
- 加快迭代
- 方便保留多个版本对比

### 阶段 C：回写正式 adapter

只有在以下内容都稳定后，才回写正式 adapter：

- 页面 ready 策略
- 弹窗处理策略
- 结束信号
- 内容提取路径
- 快速失败条件
- session 复用策略

## 页面 ready 策略

页面 ready 的最低要求：

- 输入区域可见
- 没有阻塞性弹窗

推荐流程：

1. 进入目标页或目标 session
2. 每 1 秒采样一次 UI 状态
3. 若有弹窗，优先尝试关闭
4. 若短时间仍未 ready，允许 reload 一次
5. 若总超时仍未 ready，快速失败并带状态返回

## 旧会话策略

对已有 `sessionId`：

- 不要立刻抓 baseline
- 先等历史消息数量稳定

否则容易把历史消息误判成“本轮新增消息”。

## 发送前基线

发送前至少记录以下之一：

- assistant message ids
- assistant message 数量

这是后续识别“本轮新增回复”的基线。

## 内容获取策略

优先级：

1. **优先从接口、协议或流里取数据**
2. 当接口协议隐晦、解析成本过高，或数据本身就是前端组装后的结果时，再考虑从 DOM 获取

原因：

- 接口/协议通常更稳定
- 不容易因为 UI 样式调整而失效
- 更容易拿到结构化内容

原则：

- 主路径尽量只保留一条
- DOM 优先作为兜底，而不是默认主路径
- 不要同时维护多个无必要的主路径

## 结束信号

不要只靠“文本静止”判断结束。

优先寻找目标站点自己的强信号，例如：

- 站点原生流结束事件
- 明确的“回答完成”事件
- 页面级“进行中”标记消失
- 最终操作按钮出现

如果站点没有可靠强信号，再退回到：

- 页面不再处于进行中状态
- 文本稳定一段时间

## 异常处理

### 页面未 ready

表现：

- 输入区域不可见
- 页面只有框架壳

处理：

- 轮询 + 必要时 reload 一次
- 超时直接失败

### 阻塞性弹窗

表现：

- 页面没有消息变化
- 操作无反应
- dialog / modal 可见

处理优先级：

1. `Escape`
2. 尝试通用按钮：
  - `Not now`
  - `Maybe later`
  - `Skip`
  - `Close`
  - `Got it`
  - `Continue`

不要把逻辑写死成只处理某一种文案。

### 发送成功但没有任何进展

表现：

- 一段时间内没有任何协议级或 DOM 级变化

处理：

- 快速失败
- 返回当前 URL、dialogs、页面状态摘要

### 页面假死

表现：

- 页面看起来已加载
- 输入区存在
- 没有明显报错
- 但长时间没有任何协议级、DOM 级或页面级进展

处理：

- 先做短等待 + 检测循环，不要直接长睡眠
- 记录最近一次进展时间
- 若超过阈值仍无新进展，归类为假死并快速失败
- 必要时在下一轮尝试 reload 或重新进入目标 session

### 回复已生成但脚本没抓到

表现：

- 回到同一 session 后能看到完整回复
- 当次脚本却返回空或截断

优先排查：

- 结束信号是否错了
- baseline 是否抓早了
- hydrate 是否没等完
- 内容提取路径是否有缺陷

### 模型答错

表现：

- 页面稳定结束
- 回复完整，但内容不符合问题

处理：

- 归类为模型问题
- 不要误判成脚本未完成

## 关键最佳实践

1. 固定 `workerId`，多轮时同时固定 `sessionId`
2. 进入老 session 后先等 hydrate 完成，再抓 baseline
3. 优先使用站点原生结束信号，DOM 只做兜底
4. 把“文本稳定”与“页面状态”组合判断
5. 调试监听必须可回收，避免污染 resident page
6. 代码块、表格、引用等结构化内容优先用更干净的数据源获取

## 调试完成标准

认为“调通”至少要满足：

- 短问短答稳定成功
- 结构化内容（如代码块）稳定成功
- 搜索/工具辅助类问题稳定成功
- 长回复 / 复杂分析稳定成功
- 同一 `workerId + sessionId` 多轮不串台
- 出现弹窗、页面阻塞、无进展时能快速失败并给出可诊断信息

## 参考资料

如果需要补充浏览器自动化或平台背景，优先查这些资料：

- WebAI2API 仓库
  - `https://github.com/fengwk/WebAI2API`
- Playwright 官方文档
  - 总览：`https://playwright.dev/docs/intro`
  - `Page`：`https://playwright.dev/docs/api/class-page`
  - `Locator`：`https://playwright.dev/docs/api/class-locator`
  - `WebSocket`：`https://playwright.dev/docs/api/class-websocket`
- Camoufox 项目页
  - `https://github.com/daijro/camoufox`

优先顺序：

1. 先看本 skill
2. 再看 WebAI2API 仓库文档
3. 遇到浏览器自动化细节问题，再看 Playwright 官方文档
4. 遇到浏览器伪装/运行时差异问题，再看 Camoufox 项目页
