# WebAI2API 动态适配器设计（KISS 版）

本文定义 WebAI2API 的一套**最小可行动态适配器方案**。

目标是：

- 不再通过修改源码 + 重打镜像来调适配器
- 适配器直接由 WebUI 编辑、保存、删除、测试
- 保持实现足够简单，不引入版本、草稿、发布、权限、沙箱等额外复杂度

---

## 1. 设计原则

本方案严格遵循 KISS：

1. **运行时只认一份适配器源码**
2. **不做版本管理**
3. **不做草稿 / 发布流程**
4. **不做初始化模板复制**
5. **脚本直接操作 Playwright `page/context`**
6. **只提供极少量项目级 helper**

一句话概括：

> 适配器就是保存在 `data/adapters` 目录中的一段 JS 模块代码，保存后立即生效，测试和正式请求都使用这份当前脚本。

---

## 2. 运行时适配器来源

## 2.1 只加载动态适配器

运行时只加载：

```text
/app/data/adapters/*.js
```

不再加载：

- `src/backend/adapter/*.js`（源码内置适配器）

源码内置适配器可以继续保留在仓库中，作为参考实现，但**不参与运行时注册**。

## 2.2 启动时允许为空

`/app/data/adapters` 初始为空是允许的。

此时系统表现为：

- `/v1/models` 返回空列表
- WebUI 显示“暂无适配器”
- 正式请求报“当前没有可用适配器 / 模型”

用户在 WebUI 保存第一个脚本后，系统进入可用状态。

---

## 3. 动态适配器文件格式

## 3.1 一文件一适配器

每个适配器对应一个 JS 文件，例如：

```text
/app/data/adapters/chatgpt.js
/app/data/adapters/gemini.js
/app/data/adapters/my-site.js
```

## 3.2 文件内容

文件内容与当前内置适配器保持同协议：

```js
export const manifest = {
  id: 'chatgpt',
  displayName: 'ChatGPT Dynamic',
  description: '动态适配器示例',
  models: [
    { id: 'gpt-image-2', imagePolicy: 'optional', type: 'image' }
  ],
  navigationHandlers: [],

  async generate(ctx, prompt, imagePaths, modelId, meta) {
    const { page, context, api } = ctx;

    api.log('info', '开始执行适配器', { modelId });

    await page.goto('https://chatgpt.com/images/');
    await page.waitForSelector('.ProseMirror');
    await page.locator('.ProseMirror').fill(prompt);
    await page.keyboard.press('Enter');

    return { error: 'not implemented' };
  }
};
```

## 3.3 保持当前 manifest 协议

第一版不重构 manifest 协议，继续复用当前注册表的校验逻辑。

最小必需字段：

- `id`
- `models`
- `generate`

这样可以最大限度减少底层改动。

## 3.4 Worker 的 `type` 语义

为了最小改动适配原框架，Worker 配置结构保持不变。

也就是说：

```yaml
workers:
  - name: chatgpt_a
    type: chatgpt
```

这里的 `type` 不再表示“源码内置适配器类型”，而是表示：

> 运行时去 `/app/data/adapters` 中查找 `manifest.id === "chatgpt"` 的脚本。

这样可以直接复用现有：

- Worker 配置结构
- PoolManager 对 `worker.type` 的处理方式
- OpenAI 模型路由逻辑

当前框架中的 `merge` 仍然作为保留特殊值存在，用于兼容原有聚合模式。

---

## 4. 脚本执行上下文

## 4.1 直接暴露 Playwright 原始对象

动态脚本直接拿到：

- `page`
- `context`

原因：

- Playwright 原始能力已经足够强
- 可以覆盖绝大多数网页自动化需求
- 不需要一开始就设计复杂 DSL

## 4.2 `ctx` 最小结构

传给动态适配器 `generate()` 的 `ctx` 最小建议如下：

```js
{
  page,
  context,
  config,
  proxyConfig,
  userDataDir,
  workerName,
  instanceName,
  api
}
```

说明：

- `page`：当前执行页面
- `context`：当前 Playwright BrowserContext
- `config`：全局运行配置
- `proxyConfig`：当前 worker / instance 代理配置
- `userDataDir`：当前浏览器数据目录
- `workerName`：当前 worker 名称
- `instanceName`：当前实例名称
- `api`：极简辅助对象

---

## 5. `api` 设计（极简版）

## 5.1 第一版只提供 `log`

第一版 helper 只保留：

```js
api.log(level, message, extra?)
```

用途：

- 统一把动态脚本日志打进现有日志系统
- 让 WebUI 日志查看器直接看到调试输出

## 5.2 为什么不先做更多 helper

因为当前脚本已经可以直接用：

- `page.goto()`
- `page.locator()`
- `page.waitForSelector()`
- `page.request.get()`
- `page.screenshot()`
- `context.newPage()`

所以：

- `screenshot` 不必先封装
- `download` 不必先封装
- `click/type/upload` 不必先封装

后续如有重复代码，再按需加 helper。

## 5.3 可后续追加但第一版不做的 helper

可选候选：

- `api.sleep(ms)`
- `api.screenshot(name?)`
- `api.download(url, options?)`

但第一版为了 KISS，不先做。

---

## 6. 测试执行设计

## 6.1 测试基于“当前脚本”执行

测试执行不引入草稿版概念。

规则：

1. 在 WebUI 编辑脚本
2. 先保存
3. 点击测试
4. 测试运行的就是当前保存后的脚本

这样实现最简单，避免“编辑器内容直接测试”和“文件内容测试”两条执行路径并存。

## 6.2 测试执行不污染正式页

测试时不要直接复用正式请求使用的 `worker.page`。

建议流程：

1. 通过 `workerName` 找到目标 Worker
2. 复用该 Worker 的 `context`（共享登录态）
3. 调用 `context.newPage()` 新开一个临时页面
4. 在临时页面上执行当前脚本
5. 执行结束后关闭该页面

这样有几个好处：

- 共享目标账号的登录状态
- 可在 VNC 中直接看到页面动作
- 不污染正式 Worker 的常驻页面

## 6.3 最小测试接口

新增一个最小接口：

```text
POST /admin/adapters/:id/test
```

请求体最小字段：

```json
{
  "workerName": "chatgpt_debug",
  "modelId": "gpt-image-2",
  "prompt": "test",
  "images": []
}
```

行为：

- 在指定 worker 的 context 中开临时页
- 执行当前已保存脚本
- 返回结果 / 错误
- 所有调试过程进入系统日志

---

## 7. 正式请求行为

正式请求与现在一致：

```text
/v1/*
  -> Queue / PoolManager
    -> Worker
      -> Registry 获取当前 Adapter
        -> manifest.generate(...)
```

区别仅在于：

- Registry 不再从源码目录加载适配器
- 而是从 `/app/data/adapters` 加载

## 7.1 “当前脚本”语义

系统没有版本概念，只有“当前脚本”。

规则：

- 保存后，后续新请求使用最新脚本
- 正在执行中的请求，继续用它启动时已经拿到的函数引用

这不属于版本管理，只是最基本的执行一致性。

---

## 8. Registry 最小改动方案

## 8.1 加载目录修改

当前 `registry.js` 负责扫描适配器目录。

第一版建议改成：

- 把适配器目录从 `src/backend/adapter` 改为 `/app/data/adapters`

或更稳妥一点：

- 提取 `ADAPTER_DIR` 为可配置目录
- 默认指向 `process.cwd()/data/adapters`

## 8.2 Reload 机制

不做文件监听。

最小方案：

- WebUI 保存脚本后，后端显式调用 `registry.reload()`
- 删除脚本后，也显式调用 `registry.reload()`

这样已经足够。

## 8.3 模块缓存问题

动态加载 `.js` 文件时，要避免 Node ESM import 缓存。

最简单做法：

- 按文件内容或 mtime 追加 query string 进行 import

例如：

```js
await import(`file://${filePath}?t=${mtimeMs}`)
```

这就足够满足“保存后重新加载”的需求。

---

## 9. WebUI 最小功能

第一版只做一个简单的“适配器脚本工作台”。

功能包括：

1. **适配器列表**
2. **新建脚本**
3. **编辑脚本**
4. **保存脚本**
5. **删除脚本**
6. **测试脚本**

## 9.1 不做 manifest 表单化编辑

第一版直接编辑完整 JS 文件。

原因：

- 最少前端工作量
- 不需要设计额外 schema 编辑器
- 用户可以自由调整 `manifest` 和 `generate()`

## 9.2 与 VNC 的协作方式

测试执行时，因为是在目标 worker 的 `context` 中新开页面：

- 页面动作天然会出现在当前 VNC 虚拟显示器里
- 用户可以一边看 VNC 一边看日志

这正是本方案的核心优势之一。

---

## 10. 生命周期与用户体验

## 10.1 启动时

如果 `data/adapters` 为空：

- 系统正常启动
- 无可用模型
- WebUI 提示“请先创建第一个适配器脚本”

## 10.2 编辑时

- 打开适配器脚本文本
- 修改代码
- 点击保存
- 后端写入文件并 reload registry

## 10.3 测试时

- 选择 worker
- 输入 prompt / modelId
- 点击测试
- 在 VNC 中观察页面
- 在日志中查看输出

## 10.4 正式使用时

- `/v1/models` 由当前动态适配器 manifest 生成
- 正式请求执行当前脚本

---

## 11. 明确不做的事情

为了保持方案简单，第一版明确不做：

- 内置适配器与动态适配器双轨并存
- 模板初始化复制
- 脚本版本管理
- 草稿与发布机制
- 保存前测试
- 文件系统监听热更新
- 任意安全隔离或沙箱
- 复杂 helper / DSL / StepRunner

---

## 12. MVP 实现顺序

建议按以下顺序做：

1. **Registry 改为只加载 `/app/data/adapters`**
2. **新增 admin 接口：列表 / 读取 / 保存 / 删除**
3. **给动态脚本注入 `page/context/api.log`**
4. **新增测试执行接口（基于临时 page）**
5. **新增 WebUI 脚本编辑页**

---

## 13. 一句话总结

本方案的核心是：

> 运行时只加载 `/app/data/adapters/*.js`；适配器就是一份当前 JS 脚本；脚本直接操作 Playwright `page/context`；WebUI 只负责保存、编辑、删除、测试；没有模板、没有版本、没有发布流，完全按“热配置代码”模式工作。
