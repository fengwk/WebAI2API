/**
 * @fileoverview Worker 类
 * @description
 *   - 封装单个浏览器实例（一个 worker 一个 resident page，对应一个 adapterId）
 *   - 在 resident page 上执行 manifest.script 或请求级 overrideScript
 *   - 内置本地 FIFO 串行队列：同一 worker 默认并发 = 1
 *   - 统一注入：page, input, api, helpers, runtime
 *   - 收集 trace：steps, captures, logs
 *   - 所有文件产物只对外返回 URL，不返回本地路径
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { initBrowserBase, createCursor } from '../engine/launcher.js';
import { registry } from '../registry.js';
import { saveRuntimeFile } from '../runtimeFiles.js';
import { saveInputValueToTempFile } from '../../utils/inputFiles.js';

// ============================================================
// 工具：脚本编译 / 错误规范化 / MIME 推断 / 文件读取助手
// ============================================================

/**
 * 将 manifest.script 字符串编译为一个 async function runner。
 * 注入到脚本中的顶层变量：page, input, api, helpers, runtime。
 *   - page     当前 worker 的 Playwright Page
 *   - input    业务输入
 *   - api      日志/文件/capture/step 等辅助
 *   - helpers  files.resolve / apiError 等
 *   - runtime  config / proxyConfig / workerName / instanceName / meta / etc.
 */
function compileScriptRunner(script, sourceLabel = 'manifest') {
    if (typeof script !== 'string' || !script.trim()) {
        const err = new Error(`脚本内容为空: ${sourceLabel}`);
        err.code = 'SCRIPT_EMPTY';
        throw err;
    }
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    let runner;
    try {
        runner = new AsyncFunction(
            'page',
            'input',
            'api',
            'helpers',
            'runtime',
            `${script}`
        );
    } catch (e) {
        const err = new Error(`脚本编译失败 (${sourceLabel}): ${e.message}`);
        err.code = 'SCRIPT_COMPILE_ERROR';
        throw err;
    }
    return runner;
}

function normalizeExecutionError(error) {
    if (!error) {
        return { message: '执行失败', retryable: true };
    }
    if (typeof error === 'string') {
        return { message: error, retryable: true };
    }
    return {
        message: String(error.message || '执行失败'),
        code: error.code || null,
        retryable: error.retryable !== false,
        details: error.details || null
    };
}

function detectMimeTypeFromPath(filePath, fallback = 'application/octet-stream') {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.webp': return 'image/webp';
        case '.gif': return 'image/gif';
        case '.pdf': return 'application/pdf';
        case '.txt': return 'text/plain';
        case '.json': return 'application/json';
        default: return fallback;
    }
}

async function fileValueFromBuffer(buffer, options = {}, fileOutput = null) {
    const mode = options.mode || 'object';
    const fileName = options.fileName || 'file.bin';
    const mimeType = options.mimeType || detectMimeTypeFromPath(fileName);

    if (mode === 'base64') return buffer.toString('base64');
    if (mode === 'dataUrl') return `data:${mimeType};base64,${buffer.toString('base64')}`;
    if (mode === 'url') {
        if (!fileOutput?.rootDir || !fileOutput?.urlBasePath) {
            throw new Error('当前上下文未启用文件 URL 输出');
        }
        const relativePath = options.relativePath
            || path.posix.join('outputs', `${Date.now()}-${fileName}`);
        const saved = await saveRuntimeFile({
            rootDir: fileOutput.rootDir,
            urlBasePath: fileOutput.urlBasePath,
            relativePath,
            content: buffer,
            mimeType
        });
        return saved.url;
    }
    return { fileName, mimeType, base64: buffer.toString('base64') };
}

function createExecutionHelpers(context = {}) {
    const { tempDir, fileOutput } = context;
    return {
        apiError(options = {}) {
            const error = new Error(options.message || '执行失败');
            error.status = options.status || 500;
            error.retryable = options.retryable !== false;
            error.code = options.code || null;
            error.details = options.details || null;
            return error;
        },
        files: {
            async resolve(value, options = {}) {
                const saved = await saveInputValueToTempFile(value, {
                    tempDir,
                    prefix: options.prefix || 'input',
                    fileName: options.fileName,
                    mimeType: options.mimeType
                });
                return {
                    path: saved.path,
                    fileName: saved.fileName,
                    mimeType: saved.mimeType,
                    sourceUrl: saved.sourceUrl || null
                };
            },
            async resolveMany(values, options = {}) {
                const items = Array.isArray(values) ? values : (values ? [values] : []);
                const out = [];
                for (const item of items) out.push(await this.resolve(item, options));
                return out;
            },
            async fromPath(filePath, options = {}) {
                const buffer = await fs.promises.readFile(filePath);
                return await fileValueFromBuffer(buffer, options, fileOutput);
            },
            async fromBuffer(buffer, options = {}) {
                return await fileValueFromBuffer(
                    Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
                    options,
                    fileOutput
                );
            },
            async fromDataUrl(dataUrl, options = {}) {
                const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ''));
                if (!match) throw new Error('无效的 data URL');
                return await fileValueFromBuffer(
                    Buffer.from(match[2], 'base64'),
                    { ...options, mimeType: options.mimeType || match[1].trim().toLowerCase() },
                    fileOutput
                );
            },
            async fromUrl(url, options = {}) {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`文件下载失败: HTTP ${response.status}`);
                const buffer = Buffer.from(await response.arrayBuffer());
                const mimeType = options.mimeType
                    || response.headers.get('content-type')?.split(';')[0].trim()
                    || 'application/octet-stream';
                return await fileValueFromBuffer(buffer, {
                    ...options,
                    mimeType,
                    fileName: options.fileName || path.basename(new URL(url).pathname) || 'remote.bin'
                }, fileOutput);
            }
        }
    };
}

/**
 * 创建脚本内可见的 `api` 注入对象。
 * - 始终只对外返回 URL（fileOutput.rootDir/urlBasePath 启用时）
 * - debug 模式下额外把 step/capture/log 收集到 trace 容器
 */
function createAdapterApi(workerName, instanceName, fileOutput, page, trace = null) {
    const recordLog = (level, message, extra) => {
        const entry = {
            ts: Date.now(),
            level: String(level || 'info').toLowerCase(),
            message: typeof message === 'string' ? message : String(message || ''),
            extra: extra && typeof extra === 'object' ? extra : {}
        };
        if (trace) trace.logs.push(entry);
        const method = ['debug', 'warn', 'error'].includes(entry.level) ? entry.level : 'info';
        logger[method]('动态适配器', `[${workerName}${instanceName ? `@${instanceName}` : ''}] ${entry.message}`, entry.extra);
    };

    return {
        log: recordLog,
        async sleep(ms) {
            await new Promise(resolve => setTimeout(resolve, ms));
        },
        async step(name, extra = {}) {
            if (!trace) return;
            trace.steps.push({
                name: typeof name === 'string' ? name : `step-${trace.steps.length + 1}`,
                ts: Date.now(),
                extra: extra && typeof extra === 'object' ? extra : {}
            });
        },
        async saveFile(options = {}) {
            if (!fileOutput?.rootDir || !fileOutput?.urlBasePath) {
                const err = new Error('当前上下文未启用文件输出');
                err.code = 'FILE_OUTPUT_DISABLED';
                throw err;
            }
            const saved = await saveRuntimeFile({
                rootDir: fileOutput.rootDir,
                urlBasePath: fileOutput.urlBasePath,
                relativePath: options.relativePath,
                content: options.content,
                mimeType: options.mimeType
            });
            // 对外只返回 URL，不返回绝对路径
            return { url: saved.url, mimeType: saved.mimeType, name: path.basename(saved.relativePath) };
        },
        async capture(name, options = {}) {
            if (!page) throw new Error('当前上下文不支持 capture');

            const captureName = name || `capture-${Date.now()}`;
            const entry = {
                name: captureName,
                ts: Date.now(),
                url: page.url(),
                title: await page.title().catch(() => ''),
                artifacts: {}
            };

            if (options.html) {
                const saved = await saveRuntimeFile({
                    rootDir: fileOutput.rootDir,
                    urlBasePath: fileOutput.urlBasePath,
                    relativePath: `captures/${captureName}.html`,
                    content: await page.content(),
                    mimeType: 'text/html; charset=utf-8'
                });
                entry.artifacts.html = { url: saved.url, mimeType: 'text/html; charset=utf-8', name: `${captureName}.html` };
            }

            if (options.text) {
                try {
                    entry.text = await page.locator('body').innerText({ timeout: 5000 });
                } catch (e) {
                    entry.textError = e.message;
                }
            }

            if (options.screenshot !== false) {
                try {
                    const saved = await saveRuntimeFile({
                        rootDir: fileOutput.rootDir,
                        urlBasePath: fileOutput.urlBasePath,
                        relativePath: `captures/${captureName}.png`,
                        content: await page.screenshot({ fullPage: !!options.fullPage, type: 'png' }),
                        mimeType: 'image/png'
                    });
                    entry.artifacts.screenshot = { url: saved.url, mimeType: 'image/png', name: `${captureName}.png` };
                } catch (e) {
                    entry.artifacts.screenshotError = e.message;
                }
            }

            if (trace) trace.captures.push(entry);
            return entry;
        }
    };
}

// ============================================================
// Worker 类
// ============================================================

// 暴露给测试的内部工具
export { compileScriptRunner, normalizeExecutionError, createAdapterApi, createExecutionHelpers };

export class Worker {
    /**
     * @param {object} globalConfig - 全局配置
     * @param {object} workerConfig - Worker 配置
     */
    constructor(globalConfig, workerConfig) {
        this.name = workerConfig.name;
        this.type = workerConfig.type;
        this.instanceName = workerConfig.instanceName || null;
        this.userDataDir = workerConfig.userDataDir;
        this.proxyConfig = workerConfig.resolvedProxy;
        this.globalConfig = globalConfig;
        this.workerConfig = workerConfig;

        // 运行时状态
        this.browser = null;
        this.page = null;
        this.busyCount = 0;
        this.initialized = false;
        this.error = null;

        // 本地 FIFO 队列
        this._pending = [];          // 等待中的任务
        this._activeCount = 0;       // 当前正在执行的任务数（本轮 = 0 或 1）

        // 浏览器所有权（用于共享浏览器场景的协调重启）
        this._isBrowserOwner = false;
        this._browserOwner = null;
        this._sharedWorkers = [];
    }

    /**
     * 获取当前 worker 的负载值：active + pending
     */
    get load() {
        return this._activeCount + this._pending.length;
    }

    /**
     * 读取当前 worker 绑定 adapter 的 homePageUrl。
     * 第一轮保持 1 worker = 1 adapterId，因此可直接从 registry 读取。
     */
    getHomePageUrl() {
        const manifest = registry.getAdapter(this.type);
        const url = manifest?.homePageUrl;
        return typeof url === 'string' && url.trim() ? url.trim() : null;
    }

    /**
     * resident page 初始化后，最佳努力打开 homePageUrl。
     * 失败仅记录日志，不阻塞 worker 初始化。
     */
    async _navigateResidentPageToHome(page = this.page) {
        const homePageUrl = this.getHomePageUrl();
        if (!homePageUrl || !page?.goto) return;
        try {
            await page.goto(homePageUrl, { waitUntil: 'domcontentloaded' });
            logger.info('工作池', `[${this.name}] resident page 已打开 homePageUrl: ${homePageUrl}`);
        } catch (e) {
            logger.warn('工作池', `[${this.name}] 打开 homePageUrl 失败，将保留空白页`, { homePageUrl, error: e.message });
        }
    }

    /**
     * Worker 本地队列已满？
     */
    isLocalQueueFull() {
        const max = this.globalConfig?.queue?.workerMaxPending ?? 10;
        return this._pending.length >= max;
    }

    /**
     * 初始化浏览器实例
     */
    async init(sharedBrowser = null) {
        if (this.initialized) return;

        if (!fs.existsSync(this.userDataDir)) {
            fs.mkdirSync(this.userDataDir, { recursive: true });
        }

        logger.info('工作池', `[${this.name}] 正在初始化浏览器...`);
        if (this.proxyConfig) {
            logger.info('工作池', `[${this.name}] 使用代理: ${this.proxyConfig.type}://${this.proxyConfig.host}:${this.proxyConfig.port}`);
        } else {
            logger.info('工作池', `[${this.name}] 直连模式（无代理）`);
        }

        if (sharedBrowser) {
            await this._initWithSharedBrowser(sharedBrowser);
            this._isBrowserOwner = false;
        } else {
            await this._initNewBrowser();
            this._isBrowserOwner = true;
        }

        this.initialized = true;
    }

    async _initWithSharedBrowser(sharedBrowser) {
        logger.info('工作池', `[${this.name}] 复用已有浏览器，创建新标签页...`);
        this.browser = sharedBrowser;
        this.page = await sharedBrowser.newPage();
        this.page.authState = { isHandlingAuth: false };
        this.page._browserMutex = this._browserMutex;
        const humanizeCursorMode = this.globalConfig?.browser?.humanizeCursor;
        this.page._humanizeCursorMode = humanizeCursorMode;
        if (humanizeCursorMode === true) {
            this.page.cursor = createCursor(this.page);
        }
        await this._navigateResidentPageToHome(this.page);
        this._registerPageCloseHandler();
        logger.info('工作池', `[${this.name}] 初始化完成`);
    }

    _registerPageCloseHandler() {
        if (!this.page) return;
        this.page.on('close', async () => {
            if (this.browser && !this.browser.isClosed?.()) {
                logger.warn('工作池', `[${this.name}] 标签页已关闭，正在重新创建...`);
                this.initialized = false;
                this.page = null;
                try {
                    await this._recreatePage();
                } catch (e) {
                    logger.error('工作池', `[${this.name}] 重新创建标签页失败: ${e.message}`);
                }
            }
        });
    }

    async _recreatePage() {
        this.page = await this.browser.newPage();
        this.page.authState = { isHandlingAuth: false };
        const humanizeCursorMode = this.globalConfig?.browser?.humanizeCursor;
        this.page._humanizeCursorMode = humanizeCursorMode;
        if (humanizeCursorMode === true) {
            this.page.cursor = createCursor(this.page);
        }
        await this._navigateResidentPageToHome(this.page);
        this._registerPageCloseHandler();
        this.initialized = true;
        logger.info('工作池', `[${this.name}] 标签页已成功重新创建`);
    }

    async _initNewBrowser() {
        const base = await initBrowserBase(this.globalConfig, {
            userDataDir: this.userDataDir,
            instanceName: this.instanceName,
            proxyConfig: this.proxyConfig
        });

        this.browser = base.context;
        this.page = base.page;
        this.page.authState = { isHandlingAuth: false };
        const humanizeCursorMode = this.globalConfig?.browser?.humanizeCursor;
        this.page._humanizeCursorMode = humanizeCursorMode;
        if (humanizeCursorMode === true) {
            this.page.cursor = createCursor(this.page);
        }

        const isLoginMode = process.argv.some(arg => arg.startsWith('-login'));
        if (isLoginMode) {
            logger.info('工作池', `[${this.name}] 登录模式已就绪，请在浏览器中手动访问目标站点并完成登录`);
            this.browser.on('close', () => {
                logger.info('工作池', `[${this.name}] 浏览器已关闭，登录模式结束`);
                process.exit(0);
            });
        } else {
            this.browser.on('close', async () => {
                logger.warn('工作池', `[${this.name}] 浏览器已断开连接，正在自动重新初始化...`);
                this.initialized = false;
                this.browser = null;
                this.page = null;
                for (const sharedWorker of this._sharedWorkers) {
                    sharedWorker.initialized = false;
                    sharedWorker.browser = null;
                    sharedWorker.page = null;
                }
                try {
                    await this._reinit();
                    for (const sharedWorker of this._sharedWorkers) {
                        try {
                            logger.info('工作池', `[${sharedWorker.name}] 正在恢复共享浏览器连接...`);
                            sharedWorker.browser = this.browser;
                            sharedWorker.page = await this.browser.newPage();
                            sharedWorker.page.authState = { isHandlingAuth: false };
                            const sharedCursorMode = this.globalConfig?.browser?.humanizeCursor;
                            sharedWorker.page._humanizeCursorMode = sharedCursorMode;
                            if (sharedCursorMode === true) {
                                sharedWorker.page.cursor = createCursor(sharedWorker.page);
                            }
                            await sharedWorker._navigateResidentPageToHome(sharedWorker.page);
                            sharedWorker._registerPageCloseHandler();
                            sharedWorker.initialized = true;
                            logger.info('工作池', `[${sharedWorker.name}] 共享浏览器连接已恢复`);
                        } catch (e) {
                            logger.error('工作池', `[${sharedWorker.name}] 恢复共享浏览器连接失败: ${e.message}`);
                        }
                    }
                } catch (e) {
                    logger.error('工作池', `[${this.name}] 自动重新初始化失败: ${e.message}`);
                }
            });
            this._registerPageCloseHandler();
        }

        logger.info('工作池', `[${this.name}] 初始化完成`);
    }

    /**
     * 重新初始化浏览器（崩溃恢复）
     */
    async _reinit() {
        this.initialized = false;
        this.browser = null;
        this.page = null;
        await this._initNewBrowser();
        this.initialized = true;
        logger.info('工作池', `[${this.name}] 浏览器已成功重新初始化`);
    }

    /**
     * 是否支持指定 adapterId。
     * 第一轮：1 worker = 1 adapterId。
     */
    supports(adapterId) {
        return this.type === adapterId;
    }

    /**
     * Worker 健康检查：当前是否可接收任务。
     * 不健康的状态：maintenance / offline / error / initialized=false
     */
    isHealthy() {
        if (!this.initialized) return false;
        if (this.error) return false;
        if (!this.page || this.page.isClosed?.()) return false;
        return true;
    }

    /**
     * 公开执行入口（被 PoolManager 调用）
     * - 校验 supports
     * - 校验本地队列容量
     * - 串行执行：当前任务完成后才执行下一个
     * @returns {Promise<{success, data, error?, workerId, instanceId, page, trace?}>}
     */
    async executeTask(ctx, task, meta = {}) {
        if (!this.supports(task.adapterId)) {
            return {
                success: false,
                error: { message: `Worker [${this.name}] 不支持适配器: ${task.adapterId}`, retryable: false },
                workerId: this.name,
                instanceId: this.instanceName
            };
        }

        const max = this.globalConfig?.queue?.workerMaxPending ?? 10;
        if (this._pending.length >= max) {
            return {
                success: false,
                error: { code: 'WORKER_BUSY', message: `Worker [${this.name}] 本地队列已满 (>= ${max})`, retryable: true },
                workerId: this.name,
                instanceId: this.instanceName
            };
        }

        return await new Promise((resolve) => {
            task._enqueuedAt = Date.now();
            const item = { ctx, task, meta, resolve };
            this._pending.push(item);
            this._schedulePendingTimeout(item);
            this._drainLocalQueue();
        });
    }

    /**
     * 串行执行 worker 本地队列中的任务。
     * 一次只跑一个（activeCount=0/1），完成后立即取下一个 FIFO。
     */
    _drainLocalQueue() {
        if (this._activeCount > 0) return;
        const item = this._pending.shift();
        if (!item) return;

        this._clearPendingTimeout(item);
        this._activeCount++;
        this.busyCount++;

        this._runTask(item).then((result) => {
            this._activeCount--;
            this.busyCount--;
            item.resolve(result);
            setImmediate(() => this._drainLocalQueue());
        }).catch((err) => {
            this._activeCount--;
            this.busyCount--;
            logger.error('工作池', `[${this.name}] executeTask 未捕获异常`, { error: err.message });
            item.resolve({
                success: false,
                error: normalizeExecutionError(err),
                workerId: this.name,
                instanceId: this.instanceName
            });
            setImmediate(() => this._drainLocalQueue());
        });
    }

    /**
     * 在 pending 阶段检测超时：item 还停留在 _pending 中时按 workerWaitTimeout 计时。
     * 进入 active 之后由 _runTask 自身的运行时负责（不再额外计时）。
     */
    _schedulePendingTimeout(item) {
        const waitTimeout = this.globalConfig?.queue?.workerWaitTimeout ?? 300000;
        if (!item || !item.task) return;
        const task = item.task;
        if (task._waitTimeoutHandle) return; // 已调度
        const enqueuedAt = task._enqueuedAt || Date.now();
        const waitedMs = Date.now() - enqueuedAt;
        const remaining = Math.max(0, waitTimeout - waitedMs);
        task._waitTimeoutHandle = setTimeout(() => {
            task._waitTimeoutHandle = null;
            const idx = this._pending.indexOf(item);
            if (idx === -1) return; // 已进入 active
            this._pending.splice(idx, 1);
            const elapsedMs = Date.now() - enqueuedAt;
            logger.warn('工作池', `[${this.name}] 本地队列等待超时 (${elapsedMs}ms)`);
            item.resolve({
                success: false,
                error: { code: 'WORKER_TIMEOUT', message: `Worker [${this.name}] 等待执行超时 (${elapsedMs}ms)`, retryable: true },
                workerId: this.name,
                instanceId: this.instanceName
            });
        }, remaining);
    }

    _clearPendingTimeout(item) {
        if (item?.task?._waitTimeoutHandle) {
            clearTimeout(item.task._waitTimeoutHandle);
            item.task._waitTimeoutHandle = null;
        }
    }

    async _runTask(item) {
        const { ctx, task, meta } = item;

        // 1) 重新初始化（如果浏览器挂了）
        if (!this.initialized || !this.page || this.page.isClosed?.()) {
            logger.info('工作池', `[${this.name}] 浏览器已断开，正在自动重新初始化...`, meta);
            try {
                await this._reinit();
            } catch (e) {
                logger.error('工作池', `[${this.name}] 重新初始化失败`, { error: e.message, ...meta });
                return {
                    success: false,
                    error: { message: `Worker 重新初始化失败: ${e.message}`, retryable: true },
                    workerId: this.name,
                    instanceId: this.instanceName
                };
            }
        }

        // 2) 取 manifest（来自 registry）
        const manifest = registry.getAdapter(task.adapterId);
        if (!manifest) {
            return {
                success: false,
                error: { message: `适配器不存在: ${task.adapterId}`, retryable: false },
                workerId: this.name,
                instanceId: this.instanceName
            };
        }

        // 3) 决定脚本：overrideScript > manifest.script
        const scriptSource = task.overrideScript && typeof task.overrideScript === 'string'
            ? task.overrideScript
            : manifest.script;
        const sourceLabel = task.overrideScript ? 'overrideScript' : 'manifest';

        let runner;
        try {
            runner = compileScriptRunner(scriptSource, sourceLabel);
        } catch (e) {
            return {
                success: false,
                error: { code: e.code || 'SCRIPT_COMPILE_ERROR', message: e.message, retryable: false },
                workerId: this.name,
                instanceId: this.instanceName
            };
        }

        // 4) 构造注入对象
        const trace = { steps: [], captures: [], logs: [] };
        const pageRef = this.page;
        const fileOutput = task.fileOutput || null;
        const api = createAdapterApi(this.name, this.instanceName, fileOutput, pageRef, trace);
        const helpers = createExecutionHelpers({
            tempDir: this.globalConfig?.paths?.tempDir,
            fileOutput
        });
        const runtime = {
            config: this.globalConfig,
            proxyConfig: this.proxyConfig,
            userDataDir: this.userDataDir,
            workerName: this.name,
            instanceName: this.instanceName,
            worker: { name: this.name, type: this.type, instance: this.instanceName },
            meta: { ...meta, debug: !!task.debug, requestId: meta?.id || null }
        };
        const scriptCtx = {
            page: pageRef,
            context: this.browser,
            config: this.globalConfig,
            proxyConfig: this.proxyConfig,
            userDataDir: this.userDataDir,
            workerName: this.name,
            instanceName: this.instanceName
        };

        logger.info('工作池', `[${this.name}] 执行任务 -> ${task.adapterId} (${sourceLabel})`, meta);

        // 5) 执行脚本（按新协议注入：page, input, api, helpers, runtime）
        try {
            const result = await runner(pageRef, task.input, api, helpers, runtime);
            return {
                success: true,
                data: result === undefined ? null : result,
                workerId: this.name,
                instanceId: this.instanceName,
                page: {
                    url: pageRef.url(),
                    title: await pageRef.title().catch(() => '')
                },
                trace
            };
        } catch (err) {
            // 失败时尝试 capture
            try {
                if (task.debug) {
                    await api.capture('error-final', { screenshot: true, html: false, text: false, fullPage: true });
                }
            } catch { /* ignore */ }
            return {
                success: false,
                error: normalizeExecutionError(err),
                workerId: this.name,
                instanceId: this.instanceName,
                page: {
                    url: pageRef.url(),
                    title: await pageRef.title().catch(() => '')
                },
                trace
            };
        }
    }

    /**
     * 获取 Cookies
     */
    async getCookies(domain) {
        if (!this.page) throw new Error(`Worker [${this.name}] 未初始化`);
        const context = this.page.context();
        if (domain) {
            return await context.cookies(domain.startsWith('http') ? domain : `https://${domain}`);
        }
        return await context.cookies();
    }
}
