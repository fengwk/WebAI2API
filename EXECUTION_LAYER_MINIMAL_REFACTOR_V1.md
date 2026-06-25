# WebAI2API 第一轮最小但彻底清理的执行层重构方案

## 1. 文档目标

本文档用于指导 **0 上下文 Agent** 直接接手编码，实现 WebAI2API 的第一轮执行层重构。

本轮目标不是重写浏览器/runtime 底座，而是在**保留现有 instance / worker / resident page / 指纹 / profile / VNC / 队列基础设施**的前提下，彻底清理执行层历史包袱，统一脚本结构与执行协议。

---

## 2. 本轮重构的最终结论

### 2.1 保留的核心概念

- `instance`
  - 浏览器身份边界
  - 对应：`userDataDir`、指纹、代理、登录态、共享浏览器上下文

- `worker`
  - instance 下的一个常驻 resident page
  - 当前第一轮仍保留：**1 worker = 1 adapterId/type**
  - 不做多脚本绑定改造

- `adapterId`
  - 继续作为公共 API 路由键使用
  - 暂不新造 `scriptId`

### 2.2 删除/清理的历史包袱

以下内容在本轮应彻底清理掉：

- `providers[]`
- `execute(ctx, input)` 旧脚本 DSL
- `outputJsonSchema`
- `/admin/debug/run`
- `PoolManager.runDebugScript`
- `Worker.runDebugScript`
- debug 专用执行旁路
- 旧 adapter 文件（不迁移，直接删除）
- 前端自维护的 `SchemaField.vue`

### 2.3 统一后的核心执行模型

- 只有一条正式执行入口：

```http
POST /api/{adapterId}
```

- 调试不是单独 API，而是执行模式：
  - `debug`
  - `workerId`
  - `overrideScript`

### 2.4 第一轮不做的事

- 不引入 `session / claim / dynamic worker`
- 不重构 `instance + worker` 结构
- 不把一个 worker 改成支持多个脚本
- 不引入请求级 `timeout`
- 不做自动 Schema 表单渲染
- 不兼容旧脚本结构

---

## 3. 当前架构中的关键问题（必须清理）

### 3.1 双执行链路

当前存在两条执行路径：

1. 正式执行：`POST /api/{adapterId}`
2. 调试执行：`POST /admin/debug/run`

问题：

- 语义重复
- 返回结构不统一
- 逻辑维护分叉
- debug 能力已经不只是临时工具

**结论：删除 `/admin/debug/run`，统一只保留 `/api/{adapterId}`。**

---

### 3.2 脚本结构不一致

当前仓库同时存在：

#### A. registry 期望结构
文件：`src/backend/registry.js`

期望字段：

- `id`
- `name`
- `inputJsonSchema`
- `outputJsonSchema`
- `execute`

#### B. 现有脚本实际结构
文件：`data/adapters/chatgpt.js`、`data/adapters/gemini.js`

实际使用：

- `id`
- `name`
- `providers[]`

这说明脚本存储模型本身已经历史失配。

**结论：本轮只保留一种新结构，不做兼容。**

---

### 3.3 同一个 worker 的 resident page 存在并发争抢风险

本轮要求支持：

- 指定 `workerId`
- sticky 调试
- override 脚本

如果不补 worker 本地串行队列，同一 worker 会出现多个请求同时抢 resident page 的问题。

**结论：必须新增 worker 本地 FIFO 串行队列。**

---

### 3.4 前端请求页过重且协议不统一

当前请求页：

- 使用自维护 `SchemaField.vue`
- 直接把请求体当业务输入
- curl 示例未对接未来协议
- 最近请求缺少 sticky/override 视角

**结论：第一轮直接改成 JSON 编辑器，不做 Schema 自动表单。**

---

## 4. 新的 adapter 脚本结构（唯一允许的 manifest）

### 4.1 目标结构

每个 adapter 文件必须导出：

```js
export const manifest = {
  id: 'chatgpt_image',
  name: 'ChatGPT 图片生成',
  description: '在 ChatGPT 页面生成图片',
  homePageUrl: 'https://chatgpt.com',
  inputJsonSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        title: '提示词'
      }
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

### 4.2 字段定义

#### `id`
- string
- 必填
- 必须与文件名一致
- 作为 `/api/{adapterId}` 路由参数
- 创建后不可编辑

#### `name`
- string
- 必填
- 仅用于展示

#### `description`
- string
- 可选
- 用于 UI 和 Agent 理解脚本用途

#### `homePageUrl`
- string
- 可选
- 表示该脚本所属 worker resident page 的默认目标站点
- 本轮仅作为元信息，不引入复杂自动跳站策略

#### `inputJsonSchema`
- object
- 可选
- **不做强校验**
- 只用于：
  - UI 展示
  - JSON 编辑器辅助说明
  - curl 示例默认结构提示

#### `script`
- string
- 必填
- 纯 JavaScript 脚本内容
- 由统一脚本执行器编译并执行

### 4.3 明确删除的字段

新结构中禁止出现：

- `providers`
- `models`
- `outputJsonSchema`
- `execute`
- `timeoutMs`

如果出现，registry 应直接报错，不做兼容。

---

## 5. 超时规则

### 5.1 不支持请求级 timeout

本轮**不引入请求级 `timeout`** 字段。

请求体中不允许出现：

- `timeout`

### 5.2 保留全局默认等待超时

继续保留当前配置：

```yaml
backend:
  pool:
    waitTimeout: 120000
```

说明：

- 配置文件单位：毫秒
- 当前 WebUI 展示单位：秒

### 5.3 脚本内部局部 timeout

脚本内部可自行使用 Playwright 局部 timeout：

```js
await page.goto(url, { timeout: 30000 });
await page.getByRole('button').click({ timeout: 5000 });
```

说明：

- 这是**局部步骤超时**
- 不是整个请求的硬超时

### 5.4 文案建议

当前前端“生成等待超时”文案不再准确，建议改成：

> 默认执行超时

说明文案：

> 单次脚本执行的默认等待时间，单位：秒。脚本内部仍可为具体步骤单独设置局部超时。

---

## 6. `/api/{adapterId}` 新请求协议

### 6.1 请求体结构

```json
{
  "input": {},
  "debug": false,
  "workerId": "optional",
  "overrideScript": "optional"
}
```

### 6.2 字段定义

#### `input`
- object
- 业务输入
- 透传给脚本中的 `input`

#### `debug`
- boolean
- 可选
- `true` 时返回 `trace`

#### `workerId`
- string
- 可选
- 如果指定：
  - 本次请求必须落到该 worker
  - 如果该 worker busy，则进入其本地 FIFO 队列

#### `overrideScript`
- string
- 可选
- 本次执行时覆盖 manifest 中的默认 `script`
- 仅覆盖执行内容，不覆盖元信息

---

## 7. `/api/{adapterId}` 新返回协议

### 7.1 成功返回（非 debug）

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

### 7.2 成功返回（debug）

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
  },
  "trace": {
    "steps": [],
    "captures": [],
    "logs": []
  }
}
```

### 7.3 失败返回（非 debug）

```json
{
  "ok": false,
  "message": "未找到发送按钮",
  "meta": {
    "requestId": "req_xxx",
    "adapterId": "chatgpt_image",
    "workerId": "chatgpt-page",
    "instanceId": "glatzsheryn",
    "queuedMs": 120,
    "durationMs": 1540,
    "page": {
      "url": "https://chatgpt.com",
      "title": "ChatGPT"
    }
  }
}
```

### 7.4 失败返回（debug）

```json
{
  "ok": false,
  "message": "未找到发送按钮",
  "meta": {
    "requestId": "req_xxx",
    "adapterId": "chatgpt_image",
    "workerId": "chatgpt-page",
    "instanceId": "glatzsheryn",
    "queuedMs": 120,
    "durationMs": 1540,
    "page": {
      "url": "https://chatgpt.com",
      "title": "ChatGPT"
    }
  },
  "trace": {
    "steps": [],
    "captures": [],
    "logs": []
  }
}
```

### 7.5 Artifact 输出规则

所有文件产物只返回 URL，不返回路径。

示例：

```json
{
  "name": "after-send",
  "ts": 1711111113,
  "artifacts": {
    "screenshot": {
      "url": "https://host/files/executions/req_xxx/after-send.png",
      "mimeType": "image/png",
      "name": "after-send.png"
    }
  }
}
```

内部可保留 `localPath`，但对外 API 响应中禁止出现。

---

## 8. Worker 绑定模型（本轮保持不变）

### 8.1 继续保持：1 worker = 1 adapterId

当前 worker 绑定方式不重构，继续保留：

- `worker.type === adapterId`

这意味着：

- 一个 worker 只支持一个 adapterId
- sticky 调试时，`workerId` 必须和 `{adapterId}` 匹配

### 8.2 选择 worker 的规则

#### 不传 `workerId`
- 系统从支持当前 `adapterId` 的 worker 中选择一个

#### 传 `workerId`
必须校验：

1. worker 存在
2. worker 的 `type === adapterId`
3. worker 不处于 maintenance / error / offline

否则直接返回错误。

---

## 9. 队列与调度策略

### 9.1 queue 配置（统一放在同一个配置块）

```yaml
queue:
  # 全局入口缓冲区大小（非流式请求的额外排队数）
  # 设为 0 则不限制全局入口排队数量
  # 全局入口上限 = Workers数量 + queueBuffer
  queueBuffer: 2

  # 单个 worker 的本地等待队列上限
  # 当请求已经绑定到某个 worker（显式指定 workerId 或调度选中）后，
  # 若该 worker 当前正在执行，则请求会进入该 worker 的本地 FIFO 队列。
  # 超过该值时直接返回 busy。
  workerMaxPending: 10

  # 单个请求在目标 worker 本地队列中的最长等待时间（毫秒）
  # 超时后返回 timeout。
  workerWaitTimeout: 300000
```

### 9.2 两层队列模型

系统队列分为两层：

#### 全局入口层
- 由 `queueBuffer` 控制
- 用于限制系统整体可接受的请求数量
- 当前入口上限：

```text
Workers数量 + queueBuffer
```

#### worker 本地层
- 由 `workerMaxPending` 和 `workerWaitTimeout` 控制
- 请求一旦绑定到某个 worker，就进入该 worker 的本地 FIFO 队列

### 9.3 worker 本地队列规则

- 同一 worker 默认并发数 = 1
- 队列顺序：FIFO
- 超过 `workerMaxPending`：直接返回 busy
- 等待超过 `workerWaitTimeout`：返回 timeout

### 9.4 调度策略重定义

当前支持的三种策略：

- `least_busy`
- `round_robin`
- `random`

其中 `least_busy` 当前只按 `busyCount` 判断，这在引入 worker 本地队列后不够准确。

#### 新定义

worker 负载值定义为：

```text
load = activeCount + pendingCount
```

其中：
- `activeCount`：当前正在执行的任务数（本轮通常为 0 或 1）
- `pendingCount`：worker 本地等待队列长度

#### 策略行为

##### `least_busy`
按 `load` 升序选择 worker。

##### `round_robin`
在可用 worker 中轮询；跳过：
- maintenance
- offline
- error
- 本地队列已满

##### `random`
在可用 worker 中随机选择；同样跳过不可用或队列已满的 worker。

---

## 10. `run debug` 历史包袱清理

### 10.1 结论

`/admin/debug/run` 属于历史包袱，本轮应彻底清理。

以后只保留一条正式执行链路：

```http
POST /api/{adapterId}
```

调试能力通过：

- `debug`
- `workerId`
- `overrideScript`

实现。

### 10.2 必删内容

- `/admin/debug/run`
- `PoolManager.runDebugScript`
- `Worker.runDebugScript`
- debug 专用 artifacts 概念

### 10.3 可保留并吸收的能力

原 debug 链路中的以下能力应并入主执行链路：

- 动态脚本编译
- `api.capture()`
- `api.saveFile()`
- `api.log()`
- `api.step()`
- trace 组装

删的是独立 API，不是删调试能力。

---

## 11. 前端改造方案

### 11.1 脚本编辑页（原“适配器脚本”tab）

文件：
- `webui/src/components/settings/adapters.vue`

#### 改造目标

当前 UI 是直接编辑整段旧 sourceCode。改造后：

##### 左侧字段
- `id`
- `name`
- `description`
- `inputJsonSchema`
- `homePageUrl`
- `script`

##### 规则
- `id` 创建时可填，创建后不可修改
- `name/description/inputJsonSchema/homePageUrl/script` 可编辑

#### 保存策略

前端提交结构化数据，后端统一序列化为新的 manifest JS 文件。

### 11.2 请求 API 页面

文件：
- `webui/src/components/tools/request.vue`

#### 第一版策略
**只使用 JSON 编辑器，不接 Schema 自动表单渲染。**

#### 页面结构

##### 左侧
- adapter 列表
- name
- description
- homePageUrl

##### 中间
- `input` JSON 编辑器
- 高级参数：
  - `debug`
  - `workerId`
  - `overrideScript`

##### 右侧
- curl 实时预览
- 复制按钮

##### 下方
- 最近请求列表
- 点击可查看响应、meta、trace

#### 说明
第一版不使用 `@lljj/vue3-form-ant`，也不使用现有 `SchemaField.vue`。

### 11.3 删除 `SchemaField.vue`

文件：
- `webui/src/components/tools/SchemaField.vue`

该组件属于自维护 Schema 渲染逻辑，本轮删除，不再使用。

---

## 12. 后端逐文件改造清单

### 12.1 `src/backend/registry.js`

#### 要做
- 只认新 manifest 结构
- 校验字段：
  - `id`
  - `name`
  - `description?`
  - `homePageUrl?`
  - `inputJsonSchema?`
  - `script`

#### 必须失败的情况
- `id` 缺失
- `id !== 文件名`
- `script` 缺失或不是字符串
- 出现 `providers`
- 出现 `execute`
- 出现 `outputJsonSchema`

---

### 12.2 `src/server/api/adapter/routes.js`

#### 要做
- 解析新的请求体结构：
  - `input`
  - `debug`
  - `workerId`
  - `overrideScript`
- 不再把整个 body 当业务输入
- 不再强依赖 `inputJsonSchema` 做拦截校验

#### 返回
- 统一使用新的 envelope 结构

---

### 12.3 `src/server/queue.js`

#### 要做
- 任务结构增加：
  - `workerId`
  - `debug`
  - `overrideScript`
- 历史记录可额外记录：
  - `worker_id`
  - `instance_id`
  - `debug`
  - `used_override_script`

> 第一轮如果不改历史表结构，至少要保证执行链路跑通。

---

### 12.4 `src/backend/pool/PoolManager.js`

#### 要做
- 如果请求指定 `workerId`：
  - 精确定位 worker
  - 校验 `worker.type === adapterId`
- 如果未指定：
  - 保持当前调度逻辑
- 删除：
  - `runDebugScript`

---

### 12.5 `src/backend/pool/Worker.js`

#### 要做（核心）
1. 删除 `runDebugScript` 独立主逻辑
2. 抽出统一脚本编译器：
   - `compileScriptRunner(script)`
3. 抽出统一执行器：
   - 在 resident page 上执行默认脚本或覆盖脚本
4. `executeTask()` 改造：
   - 无 `overrideScript` → 执行 manifest.script
   - 有 `overrideScript` → 执行覆盖脚本
5. 增加 worker 本地 FIFO 串行队列
6. 统一 trace 收集：
   - `steps`
   - `captures`
   - `logs`
7. 所有产物输出 URL，不输出 path

---

### 12.6 `src/server/api/admin/routes.js`

#### 要做
- 删除 `/admin/debug/run`
- 删除 debug 专属产物读取逻辑（如仍需要，统一为 execution files）

---

### 12.7 `src/config/index.js` / `src/config/validator.js` / `src/config/manager.js`

#### 要做
新增并支持：

- `queue.workerMaxPending`
- `queue.workerWaitTimeout`

并更新：
- pool 配置读取/保存
- workers 设置页对应字段

---

### 12.8 `config.example.yaml`

#### 要做
- 删除旧脚本 DSL 相关描述
- 更新 `queue` 配置
- 更新 `waitTimeout` 文案

---

## 13. 需要删除的旧代码与旧脚本

### 13.1 删除接口/旁路
- `/admin/debug/run`
- `PoolManager.runDebugScript`
- `Worker.runDebugScript`

### 13.2 删除旧脚本结构
- 所有 `providers[]` 结构脚本
- 所有 `execute(ctx, input)` 结构脚本
- 所有 `outputJsonSchema`

### 13.3 删除前端旧渲染器
- `webui/src/components/tools/SchemaField.vue`

### 13.4 删除历史脚本
- `data/adapters/*.js` 中所有不符合新 manifest 的文件
- 不做迁移，不做兼容

> 只保留/重写真正还需要的能力脚本。

---

## 14. 测试方案（必须完成）

项目当前使用：

- `node --test`
- 入口：`package.json` 中的 `test` / `test:unit`

文件：
- `tests/unit/*.test.js`
- `tests/mock/*.test.js`

本轮必须补测试，不接受只靠手测。

### 14.1 Registry 测试
建议文件：
- `tests/unit/registry-new-manifest.test.js`

覆盖：
- 合法新 manifest 可加载
- 缺 `script` 报错
- 存在 `providers` 报错
- 存在 `execute` 报错
- 存在 `outputJsonSchema` 报错
- `id !== 文件名` 报错

### 14.2 Adapter API 请求协议测试
建议文件：
- `tests/mock/adapter-router-new-protocol.test.js`

覆盖：
- 新请求结构解析正确
- `input` 透传
- `workerId` 解析
- `overrideScript` 解析
- `debug` 开关控制 trace 返回
- 成功返回 envelope
- 失败返回 envelope

### 14.3 脚本执行器测试
建议文件：
- `tests/unit/script-runner.test.js`

覆盖：
- 默认脚本执行成功
- `overrideScript` 覆盖成功
- 注入对象可用：
  - `page`
  - `input`
  - `api`
  - `helpers`
  - `runtime`

### 14.4 Worker 本地队列测试
建议文件：
- `tests/unit/worker-queue.test.js`

覆盖：
- 同一 worker 串行执行
- FIFO 顺序正确
- 超过 `workerMaxPending` 拒绝
- 超过 `workerWaitTimeout` 超时
- 指定 `workerId` 时不会落到其他 worker

### 14.5 Artifact URL 测试
建议文件：
- `tests/unit/artifact-url.test.js`

覆盖：
- `saveFile()` 返回 URL
- `capture()` 返回 URL
- 对外响应不泄露本地路径

### 14.6 Legacy Removal 测试
建议文件：
- `tests/unit/legacy-removal.test.js`

覆盖：
- `/admin/debug/run` 不可用
- 旧脚本结构不能加载

---

## 15. 前端第一轮验收要求

### 15.1 脚本编辑页
- 可以创建新脚本
- `id` 创建后不可修改
- 可以编辑：
  - `name`
  - `description`
  - `inputJsonSchema`
  - `homePageUrl`
  - `script`

### 15.2 请求 API 页面
- 选择 adapter 后可编辑 `input` JSON
- 可以填写：
  - `debug`
  - `workerId`
  - `overrideScript`
- curl 示例实时更新
- 能正确显示最近请求与响应

---

## 16. 验收标准

以下全部满足才算本轮完成：

1. `/api/{adapterId}` 支持：
   - `input`
   - `debug`
   - `workerId`
   - `overrideScript`

2. 返回统一为：
   - `ok`
   - `data/message`
   - `meta`
   - `trace`（仅 debug）

3. `/admin/debug/run` 已删除

4. 所有旧 `providers[]` / `execute()` / `outputJsonSchema` 脚本已删除

5. 只允许新 manifest 结构加载

6. worker 支持本地 FIFO 串行队列

7. 文件产物对外只返回 URL

8. 请求页第一版使用 JSON 编辑器，不再依赖 `SchemaField.vue`

9. 单元测试补齐并通过

---

## 17. 实施顺序建议

### Step 1
重写 manifest 结构与 registry 校验

### Step 2
删除所有旧脚本，加入最小新结构示例脚本

### Step 3
改 `/api/{adapterId}` 请求/响应协议

### Step 4
统一 Worker 执行器：默认脚本 / overrideScript 共用

### Step 5
增加 worker 本地 FIFO 队列

### Step 6
删除 `/admin/debug/run` 及其执行旁路

### Step 7
重构前端脚本页和请求页

### Step 8
补测试并清理死代码

---

## 18. 给接手 Agent 的最后说明

本轮不是做“兼容过渡”，而是做一次**执行层的脚本模型切换**。

编码时请严格遵守以下原则：

1. 不做旧脚本兼容
2. 不保留 `run debug` 执行旁路
3. 不再让脚本以 `execute(ctx, input)` 形式存在
4. 所有脚本统一为 `manifest + script string`
5. 所有正式执行统一走 `/api/{adapterId}`
6. 所有 worker 执行必须串行
7. 所有外部文件产物只返回 URL
8. 必须补测试，不接受“改完能跑就行”

如果在实现过程中发现浏览器/runtime 层存在明显 bug，可修复，但**不要扩大重构边界到第二轮目标**（例如 worker 多脚本绑定、session/claim、多路脚本调度等）。
