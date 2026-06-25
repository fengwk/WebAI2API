# WebAI2API 架构与扩展指南

本文面向开发者，说明 WebAI2API 的整体架构、核心运行链路，以及如何基于现有框架扩展新的网页 AI 站点。

## 1. 项目定位

WebAI2API 的本质不是直接调用官方 API，而是：

1. 使用真实浏览器 / 虚拟浏览器访问目标网站
2. 通过 Playwright + Camoufox 模拟人工操作
3. 从网页交互或站点接口响应中提取结果
4. 对外暴露统一的 `/api/{adapterId}` 执行接口

适用场景：

- 目标站点没有稳定开放 API
- 目标能力主要通过网页提供
- 需要多账号、多浏览器实例、代理隔离、统一调度

---

## 2. 总体架构

可以把系统理解成 6 层：

```text
外部客户端
  -> HTTP Server (/api, /admin, WebUI)
    -> Queue / PoolManager
      -> Worker
        -> Adapter
          -> Browser / Page (Playwright + Camoufox)
            -> 目标网站 (ChatGPT / Gemini / ...)
```

### 2.1 接口层

- `/api/*`：统一执行接口
- `/admin/*`：管理接口
- `/`：WebUI 静态页面
- `/admin/vnc`：VNC 的 WebSocket 代理

关键文件：

- `src/server/api/index.js`
- `src/server/api/admin/routes.js`
- `src/server/api/admin/vncProxy.js`

### 2.2 调度层

调度层负责：

- 请求入队
- 多 Worker 负载均衡
- 故障转移
- 登录模式 / 普通模式切换

关键文件：

- `src/server/queue.js`
- `src/backend/pool/PoolManager.js`

### 2.3 Worker 层

Worker 是“可调度的执行单元”，负责：

- 绑定一个 `type`（即 adapterId）
- 初始化浏览器或复用浏览器
- 维护 resident page
- 执行具体脚本任务

关键文件：

- `src/backend/pool/Worker.js`

### 2.4 Adapter 层

Adapter 是整个项目最关键的扩展点。

你可以把 Adapter 理解成：

> 针对某个网站 / 某种能力封装的一段脚本化网页自动化能力。

Adapter 当前负责：

- 声明唯一 `id`
- 提供 `name / description / homePageUrl / inputJsonSchema`
- 提供 `script` 字符串
- 在 worker resident page 上执行页面自动化操作
- 返回可 JSON 序列化的结果

关键目录：

- `data/adapters/*.js`

### 2.5 浏览器运行时

浏览器运行时由 Playwright + Camoufox 驱动，负责：

- 启动浏览器 / 上下文
- 配置代理
- 管理用户数据目录
- 执行页面跳转、点击、上传、输入

关键文件：

- `src/backend/engine/launcher.js`
- `src/backend/engine/utils.js`
- `src/backend/utils/`

### 2.6 配置与状态

配置和运行数据主要分两类：

1. `data/config.yaml`
  - 运行配置
  - WebUI 保存时会直接回写 YAML

2. `data/history/history.db`
  - 请求历史记录数据库（SQLite）
  - 不是运行配置数据库

关键文件：

- `src/config/index.js`
- `src/config/manager.js`
- `src/config/validator.js`
- `src/utils/history.js`

---

## 3. 核心概念

## 3.1 Instance

Instance 代表一套浏览器环境，通常对应：

- 一个浏览器进程 / Context
- 一个用户数据目录
- 一套登录态 / Cookie / 本地缓存
- 可选的一套独立代理

同一 Instance 下的多个 Worker 默认共享登录态。

## 3.2 Worker

Worker 是一个可调度单元，代表：

- 某个适配器类型的一条执行入口
- 例如 `chatgpt`、`chatgpt_text`、`gemini`

多个 Worker 可以共享同一个 Instance，也可以分散在不同 Instance。

## 3.3 Adapter

Adapter 是“站点能力脚本”。

例如：

- `chatgpt`：ChatGPT 页面能力
- `gemini`：Gemini 页面能力

---

## 4. 请求执行链路

以一次 `POST /api/{adapterId}` 为例：

1. 客户端调用 `/api/{adapterId}`
2. 服务端解析请求体（`input / debug / workerId / overrideScript`）
3. 请求进入全局入口队列
4. Queue / PoolManager 选择或校验目标 Worker
5. Worker 在 resident page 上执行 manifest.script 或 overrideScript
6. 脚本通过 `api.capture / api.saveFile / api.step / api.log` 收集 trace 与产物
7. Queue 将结果包装为统一 envelope（`ok / data|message / meta / trace?`）返回

---

## 5. 登录态与多账号机制

## 5.1 单账号

如果只有一套 Gemini / ChatGPT 登录态，可以把多个 worker 放进同一个 instance，例如：

- `gemini`
- `chatgpt`

## 5.2 多账号

如果你有多个账号，关键不是多加 Worker，而是：

> 为不同账号创建不同的 Instance，并设置不同的 `userDataMark`。

否则多个 Worker 可能共享同一个用户数据目录，最终还是只会看到一个浏览器实例。

---

## 6. VNC / WebUI 是怎么工作的

Docker / Linux 模式下常用：

- `-xvfb`：启动虚拟显示器
- `-vnc`：启动 x11vnc

WebUI 中的“虚拟显示器”并不是浏览器直连 `5900`，而是：

1. WebUI 加载 noVNC
2. 通过 `/admin/vnc?token=...` 建立 WebSocket
3. 服务端将 WebSocket 流量代理到容器内的 VNC TCP 端口

因此：

- WebUI 与 API 共享主服务端口（默认 `3000`）
- `5900` 主要是内部 VNC 服务端口

---

## 7. 如何扩展新的网页站点

## 7.1 最小扩展单元：新增一个 Adapter

扩展一个新网站，通常不需要改框架核心，只需要新增一个 Adapter 文件。

放置位置：

- `data/adapters/my_site.js`

注册表会自动扫描该目录，因此一般不需要手动登记。

## 7.2 Adapter 至少要提供什么

`registry.js` 会校验以下核心字段：

- `id`
- `name`
- `description`（可选）
- `homePageUrl`（可选）
- `inputJsonSchema`（可选）
- `script`

推荐最小模板：

```js
export const manifest = {
  id: 'my_site_image',
  name: 'My Site 图片生成',
  description: '在 My Site 页面执行脚本',
  homePageUrl: 'https://example.com/app',
  inputJsonSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', title: '提示词' }
    },
    required: ['prompt']
  },
  script: `
    await api.goto('https://example.com/app');
    api.log('info', '开始执行', { prompt: input.prompt });
    return {
      url: page.url(),
      title: await page.title()
    };
  `
};
```

## 7.3 一个 Adapter 里通常要做哪些事

常见步骤：

1. 打开目标页面
2. 处理首屏条款 / onboarding / 弹窗
3. 等输入框 ready
4. 上传参考图片（如果支持）
5. 输入 prompt
6. 点击发送
7. 等待站点请求返回 / 下载链接出现 / DOM 结果出现
8. 提取文本、图片、视频并返回可 JSON 序列化的数据

## 7.4 推荐复用的公共能力

优先复用已有工具函数，不要每个适配器都从零写：

- `gotoWithCheck`
- `waitForInput`
- `waitApiResponse`
- `safeClick`
- `humanType`
- `uploadFilesViaChooser`
- `normalizePageError`
- `useContextDownload`

这些工具能减少站点差异带来的重复代码。

## 7.5 页面导航与状态收敛

当前协议不再提供 `getTargetUrl` / `navigationHandlers` / `providers[]` / `execute()`。

原因：

- 页面导航属于脚本实现细节
- 当前一条 adapter 只对应一个能力脚本
- 由 `script` 自己完成 `goto + 弹窗处理 + 页面收敛` 更直接

## 7.6 什么时候需要 `configSchema`

如果适配器有自己的专属配置，建议通过 `configSchema` 暴露给 WebUI。

例如 `gemini` 适配器已经用它提供了：

- `temporaryChat`

这样用户可以直接在 WebUI 中配置，而不是手改 YAML。

---

## 8. 扩展新站点时的开发建议

## 8.1 先做单 Worker 可用，再做多账号

建议顺序：

1. 先让单 Worker 单账号跑通
2. 再确认登录态是否稳定
3. 再加多 Instance / 多代理
4. 最后再做模型黑白名单、故障转移等优化

## 8.2 先抓“稳定信号”，别先抓 DOM 细节

对于网页 AI 站点，结果提取优先级建议是：

1. 监听网络响应 / 下载链接
2. 监听站点自己的 API 请求
3. 最后才是从 DOM 文本硬解析

原因：

- DOM 最容易被页面改版打断
- 请求与下载事件通常更稳定

## 8.3 登录模式优先用于初始化账号

项目已经支持登录模式：

- `-login`
- `-login=workerName`

在 WebUI 中也可以选择“指定 Worker 登录”。

这对多账号初始化非常重要。

## 8.4 一个账号一个 `userDataMark`

如果你希望账号真正隔离，请显式设置不同的 `userDataMark`，避免多个 Worker 意外共享浏览器数据目录。

---

## 9. 哪些扩展更适合这套框架

适合：

- 有稳定网页入口的 AI 工具
- 登录后可长期复用状态的网站
- 结果可通过页面请求 / 下载 / DOM 提取的网站

不太适合：

- 强依赖手机验证码的站点
- 页面频繁改版、强风控的站点
- 结果只通过复杂加密 WebSocket 返回的站点
- 必须使用原生 App 才能完成核心能力的网站

---

## 10. 读代码建议

如果你要快速理解并扩展这个项目，推荐阅读顺序：

1. `README.md`
2. `config.example.yaml`
3. `src/server/api/index.js`
4. `src/backend/pool/PoolManager.js`
5. `src/backend/pool/Worker.js`
6. `src/backend/registry.js`
7. `src/backend/adapter/chatgpt.js`
8. `src/backend/adapter/gemini.js`

这个顺序能最快建立：

- 请求是怎么进来的
- Worker 是怎么调度的
- Adapter 是怎么执行的
- 一个新站点该从哪下手

---

## 11. 一句话总结

WebAI2API 可以理解为：

> 一个“面向网页 AI 服务的脚本化执行框架 + 多浏览器实例调度系统”。

扩展新页面时，核心工作通常就是：

> 新增一个 Adapter，并把该网站的页面交互、结果提取和错误处理封装进去。
