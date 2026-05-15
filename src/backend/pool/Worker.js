/**
 * @fileoverview Worker 类
 * @description 封装单个浏览器实例，提供模型匹配和任务执行能力
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { initBrowserBase, createCursor } from '../engine/launcher.js';
import { registry } from '../registry.js';
import { tryGotoWithCheck } from '../utils/page.js';
import { saveRuntimeFile } from '../runtimeFiles.js';

function createAdapterApi(workerName, instanceName, meta = {}, fileOutput = null, page = null) {
    return {
        log(level, message, extra = {}) {
            const normalizedLevel = String(level || 'info').toLowerCase();
            const method = ['debug', 'warn', 'error'].includes(normalizedLevel) ? normalizedLevel : 'info';
            logger[method]('动态适配器', `[${workerName}${instanceName ? `@${instanceName}` : ''}] ${message}`, {
                ...meta,
                ...extra
            });
        },
        async sleep(ms) {
            await new Promise(resolve => setTimeout(resolve, ms));
        },
        async saveFile(options = {}) {
            if (!fileOutput?.rootDir || !fileOutput?.urlBasePath) {
                throw new Error('当前上下文未启用文件输出');
            }
            return await saveRuntimeFile({
                rootDir: fileOutput.rootDir,
                urlBasePath: fileOutput.urlBasePath,
                relativePath: options.relativePath,
                content: options.content,
                mimeType: options.mimeType
            });
        },
        async capture(name, options = {}) {
            if (!page) {
                throw new Error('当前上下文不支持 capture');
            }

            const captureName = name || `capture-${Date.now()}`;
            const capture = {
                name: captureName,
                url: page.url(),
                title: await page.title().catch(() => '')
            };

            if (options.html) {
                const saved = await saveRuntimeFile({
                    rootDir: fileOutput.rootDir,
                    urlBasePath: fileOutput.urlBasePath,
                    relativePath: `captures/${captureName}.html`,
                    content: await page.content(),
                    mimeType: 'text/html; charset=utf-8'
                });
                capture.htmlUrl = saved.url;
            }

            if (options.text) {
                capture.text = await page.locator('body').innerText({ timeout: 5000 });
            }

            if (options.screenshot !== false) {
                const saved = await saveRuntimeFile({
                    rootDir: fileOutput.rootDir,
                    urlBasePath: fileOutput.urlBasePath,
                    relativePath: `captures/${captureName}.png`,
                    content: await page.screenshot({
                        fullPage: !!options.fullPage,
                        type: 'png'
                    }),
                    mimeType: 'image/png'
                });
                capture.screenshotUrl = saved.url;
            }

            return capture;
        }
    };
}

function previewText(text, maxLen = 500) {
    if (typeof text !== 'string') return '';
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

async function writeDebugArtifact(artifactDir, fileName, content, encoding = null) {
    await fs.promises.mkdir(artifactDir, { recursive: true });
    const filePath = path.join(artifactDir, fileName);
    if (encoding) {
        await fs.promises.writeFile(filePath, content, { encoding });
    } else {
        await fs.promises.writeFile(filePath, content);
    }
    return filePath;
}

async function persistDataUrlArtifact(artifactDir, artifactBasePath, fileBaseName, dataUrl) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
    if (!match) return null;
    const mimeType = match[1];
    const base64 = match[2];
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
    const fileName = `${fileBaseName}.${ext}`;
    await writeDebugArtifact(artifactDir, fileName, Buffer.from(base64, 'base64'));
    return `${artifactBasePath}/${encodeURIComponent(fileName)}`;
}

function createDebugApi(workerName, instanceName, page, meta, logs, captures, artifactDir, artifactBasePath) {
    const baseApi = createAdapterApi(workerName, instanceName, meta, {
        rootDir: artifactDir,
        urlBasePath: artifactBasePath
    }, page);

    return {
        ...baseApi,
        log(level, message, extra = {}) {
            const entry = {
                ts: Date.now(),
                level: String(level || 'info').toLowerCase(),
                message,
                extra
            };
            logs.push(entry);
            baseApi.log(level, message, extra);
        },
        async capture(name, options = {}) {
            const capture = {
                name: name || `capture-${captures.length + 1}`,
                ts: Date.now(),
                url: page.url()
            };

            try {
                capture.title = await page.title();
            } catch {
                capture.title = '';
            }

            if (options.html) {
                try {
                    const html = await page.content();
                    const fileName = `${capture.name}.html`;
                    await writeDebugArtifact(artifactDir, fileName, html, 'utf8');
                    capture.htmlUrl = `${artifactBasePath}/${encodeURIComponent(fileName)}`;
                    capture.htmlPreview = previewText(html, 300);
                } catch (e) {
                    capture.htmlError = e.message;
                }
            }

            if (options.text) {
                try {
                    const text = await page.locator('body').innerText({ timeout: 5000 });
                    capture.text = text;
                    capture.textPreview = previewText(text, 300);
                } catch (e) {
                    capture.textError = e.message;
                }
            }

            if (options.screenshot !== false) {
                try {
                    const buffer = await page.screenshot({
                        fullPage: !!options.fullPage,
                        type: 'png'
                    });
                    const fileName = `${capture.name}.png`;
                    await writeDebugArtifact(artifactDir, fileName, buffer);
                    capture.screenshotUrl = `${artifactBasePath}/${encodeURIComponent(fileName)}`;
                } catch (e) {
                    capture.screenshotError = e.message;
                }
            }

            captures.push(capture);
            logs.push({
                ts: Date.now(),
                level: 'debug',
                message: `capture:${capture.name}`,
                extra: {
                    url: capture.url,
                    hasHtml: !!capture.htmlUrl,
                    hasText: !!capture.text,
                    hasScreenshot: !!capture.screenshotUrl
                }
            });
            return capture;
        }
    };
}

function compileDebugRunner(script) {
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    return new AsyncFunction(
        'ctx',
        'api',
        'input',
        'meta',
        `const { page, context, config, proxyConfig, userDataDir, workerName, instanceName } = ctx;\n${script}`
    );
}

function normalizeExecutionError(error) {
    if (!error) {
        return { message: '执行失败', retryable: true };
    }

    if (typeof error === 'string') {
        return { message: error, retryable: true };
    }

    if (typeof error === 'object') {
        return {
            message: String(error.message || '执行失败'),
            code: error.code || null,
            retryable: error.retryable !== false,
            details: error.details || null
        };
    }

    return { message: String(error), retryable: true };
}

function normalizeExecutionResult(result) {
    if (!result || typeof result !== 'object' || typeof result.success !== 'boolean') {
        throw new Error('适配器必须返回 { success, data, error }');
    }

    if (result.success) {
        return {
            success: true,
            data: result.data ?? null,
            error: null
        };
    }

    return {
        success: false,
        data: null,
        error: normalizeExecutionError(result.error)
    };
}

/**
 * Worker 类 - 封装单个浏览器实例
 */
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

        // Merge 模式专属
        this.mergeTypes = workerConfig.mergeTypes || [];
        this.mergeMonitor = workerConfig.mergeMonitor || null;

        // 运行时状态
        this.browser = null;
        this.page = null;
        this.busyCount = 0;
        this.initialized = false;

        // 浏览器所有权（用于共享浏览器场景的协调重启）
        this._isBrowserOwner = false;  // 是否是浏览器的所有者（负责重启）
        this._browserOwner = null;     // 如果是共享者，指向所有者 Worker
        this._sharedWorkers = [];      // 如果是所有者，保存共享该浏览器的 Worker 列表
    }

    /**
     * 初始化浏览器实例
     * @param {object} [sharedBrowser] - 可选，共享的浏览器实例
     */
    async init(sharedBrowser = null) {
        if (this.initialized) return;

        // 确保用户数据目录存在
        if (!fs.existsSync(this.userDataDir)) {
            fs.mkdirSync(this.userDataDir, { recursive: true });
        }

        // 获取目标 URL
        let targetUrl = 'about:blank';
        if (this.type === 'merge') {
            const firstType = this.mergeTypes[0];
            targetUrl = registry.getTargetUrl(firstType, this.globalConfig, this.workerConfig) || 'about:blank';
        } else {
            targetUrl = registry.getTargetUrl(this.type, this.globalConfig, this.workerConfig) || 'about:blank';
        }

        // 登录模式下不注册导航处理器，避免自动登录干预用户操作
        const isLoginMode = process.argv.some(arg => arg.startsWith('-login'));
        let navigationHandler = null;

        if (!isLoginMode) {
            // 收集导航处理器
            const handlers = [];
            const typesToHandle = this.type === 'merge' ? this.mergeTypes : [this.type];
            for (const type of typesToHandle) {
                const typeHandlers = registry.getNavigationHandlers(type);
                handlers.push(...typeHandlers);
            }

            navigationHandler = handlers.length > 0
                ? async (page) => {
                    for (const handler of handlers) {
                        try {
                            await handler(page);
                        } catch (e) {
                            logger.debug('工作池', `导航处理器执行失败: ${e.message}`);
                        }
                    }
                }
                : null;
        }

        logger.info('工作池', `[${this.name}] 正在初始化浏览器...`);
        if (this.proxyConfig) {
            logger.info('工作池', `[${this.name}] 使用代理: ${this.proxyConfig.type}://${this.proxyConfig.host}:${this.proxyConfig.port}`);
        } else {
            logger.info('工作池', `[${this.name}] 直连模式（无代理）`);
        }

        if (sharedBrowser) {
            await this._initWithSharedBrowser(sharedBrowser, targetUrl, navigationHandler);
            this._isBrowserOwner = false;
        } else {
            await this._initNewBrowser(targetUrl, navigationHandler);
            this._isBrowserOwner = true;
        }

        this.initialized = true;
    }

    /**
     * 使用共享浏览器初始化
     * @private
     */
    async _initWithSharedBrowser(sharedBrowser, targetUrl, navigationHandler) {
        logger.info('工作池', `[${this.name}] 复用已有浏览器，创建新标签页...`);
        this.browser = sharedBrowser;
        this.page = await sharedBrowser.newPage();
        this.page.authState = { isHandlingAuth: false };
        this.page._browserMutex = this._browserMutex;
        const humanizeCursorMode = this.globalConfig?.browser?.humanizeCursor;
        this.page._humanizeCursorMode = humanizeCursorMode;
        // true 表示使用项目维护的 ghost-cursor
        if (humanizeCursorMode === true) {
            this.page.cursor = createCursor(this.page);
        }

        // 保存参数用于重新初始化
        this._targetUrl = targetUrl;
        this._navigationHandler = navigationHandler;

        await this._navigateToTarget(targetUrl);

        if (navigationHandler) {
            this.page.on('framenavigated', async () => {
                try { await navigationHandler(this.page); } catch (e) { /* ignore */ }
            });
        }

        // 监听标签页关闭事件，自动重新创建（仅针对共享者）
        this._registerPageCloseHandler();

        logger.info('工作池', `[${this.name}] 初始化完成`);
    }

    /**
     * 注册标签页关闭事件处理器
     * @private
     */
    _registerPageCloseHandler() {
        if (!this.page) return;

        this.page.on('close', async () => {
            // 如果浏览器还在运行，说明只是标签页被关闭
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

    /**
     * 重新创建标签页（标签页关闭恢复）
     * @private
     */
    async _recreatePage() {
        this.page = await this.browser.newPage();
        this.page.authState = { isHandlingAuth: false };
        const humanizeCursorMode = this.globalConfig?.browser?.humanizeCursor;
        this.page._humanizeCursorMode = humanizeCursorMode;
        if (humanizeCursorMode === true) {
            this.page.cursor = createCursor(this.page);
        }
        await this._navigateToTarget(this._targetUrl || 'about:blank');

        if (this._navigationHandler) {
            this.page.on('framenavigated', async () => {
                try { await this._navigationHandler(this.page); } catch (e) { /* ignore */ }
            });
        }

        // 重新注册标签页关闭处理器
        this._registerPageCloseHandler();

        this.initialized = true;
        logger.info('工作池', `[${this.name}] 标签页已成功重新创建`);
    }

    /**
     * 启动新浏览器初始化
     * @private
     */
    async _initNewBrowser(targetUrl, navigationHandler) {
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

        if (navigationHandler) {
            this.page.on('framenavigated', async () => {
                try { await navigationHandler(this.page); } catch (e) { /* ignore */ }
            });
        }

        // 保存 navigationHandler 用于重新初始化
        this._navigationHandler = navigationHandler;
        this._targetUrl = targetUrl;

        logger.info('工作池', `[${this.name}] 正在连接目标页面...`);
        await this._navigateToTarget(targetUrl);

        // 登录模式：注册浏览器关闭事件（不阻塞，关闭后退出进程）
        const isLoginMode = process.argv.some(arg => arg.startsWith('-login'));
        if (isLoginMode) {
            logger.info('工作池', `[${this.name}] 登录模式已就绪，请在浏览器中完成登录`);
            this.browser.on('close', () => {
                logger.info('工作池', `[${this.name}] 浏览器已关闭，登录模式结束`);
                process.exit(0);
            });
        } else {
            // 非登录模式：注册断开事件，所有者负责重启并同步到共享者
            this.browser.on('close', async () => {
                logger.warn('工作池', `[${this.name}] 浏览器已断开连接，正在自动重新初始化...`);

                // 标记自己和所有共享者为未初始化
                this.initialized = false;
                this.browser = null;
                this.page = null;
                for (const sharedWorker of this._sharedWorkers) {
                    sharedWorker.initialized = false;
                    sharedWorker.browser = null;
                    sharedWorker.page = null;
                }

                try {
                    // 重新初始化浏览器
                    await this._reinit();

                    // 为所有共享者创建新的标签页
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
                            await sharedWorker._navigateToTarget(sharedWorker._targetUrl || 'about:blank');
                            sharedWorker._registerPageCloseHandler();  // 重新注册标签页关闭处理器
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

            // 所有者也需要监听标签页关闭事件
            this._registerPageCloseHandler();
        }

        logger.info('工作池', `[${this.name}] 初始化完成`);
    }

    /**
     * 导航到目标 URL
     * @private
     */
    async _navigateToTarget(targetUrl) {
        if (this.type === 'merge') {
            let gotoSuccess = false;
            for (const type of this.mergeTypes) {
                const url = registry.getTargetUrl(type, this.globalConfig, this.workerConfig);
                if (!url) continue;
                const gotoResult = await tryGotoWithCheck(this.page, url, { timeout: 30000 });
                if (!gotoResult.error) {
                    gotoSuccess = true;
                    logger.debug('工作池', `[${this.name}] 使用 ${type} 适配器初始化成功`);
                    break;
                }
                logger.warn('工作池', `[${this.name}] ${type} 网站不可用，尝试下一个...`, { error: gotoResult.error });
            }
            if (!gotoSuccess) {
                logger.warn('工作池', `[${this.name}] 所有适配器网站当前不可用，但 Worker 仍将初始化（请求时可能会失败）`);
            }
        } else {
            const gotoResult = await tryGotoWithCheck(this.page, targetUrl, { timeout: 60000 });
            if (gotoResult.error) {
                logger.warn('工作池', `[${this.name}] 目标网站当前不可用: ${gotoResult.error}，但 Worker 仍将初始化`);
            }
        }
    }

    /**
     * 检查是否支持指定 provider + model
     */
    supports(providerType, modelId) {
        if (this.type === 'merge') {
            return this.mergeTypes.some(type => registry.supportsTask(type, providerType, modelId));
        }
        return registry.supportsTask(this.type, providerType, modelId);
    }

    /**
     * 获取支持当前任务的候选适配器类型
     * @private
     */
    _getCandidateTypes(providerType, modelId) {
        const types = this.type === 'merge' ? this.mergeTypes : [this.type];
        return types.filter(type => registry.supportsTask(type, providerType, modelId));
    }

    async executeTask(ctx, task, meta = {}) {
        const failoverConfig = this.globalConfig.backend?.pool?.failover || {};
        const candidateTypes = this._getCandidateTypes(task.providerType, task.modelId);
        if (candidateTypes.length === 0) {
            return {
                success: false,
                data: null,
                error: {
                    message: `Worker [${this.name}] 不支持 provider=${task.providerType}, model=${task.modelId || 'default'}`,
                    retryable: false
                }
            };
        }

        if (this.type !== 'merge' || failoverConfig.enabled === false || candidateTypes.length === 1) {
            return await this._executeAdapter(ctx, candidateTypes[0], task, meta);
        }

        const maxRetries = failoverConfig.maxRetries ?? 2;
        const maxAttempts = maxRetries === 0
            ? candidateTypes.length
            : Math.min(maxRetries + 1, candidateTypes.length);

        let lastError = null;
        for (let i = 0; i < maxAttempts; i++) {
            const type = candidateTypes[i];
            const result = await this._executeAdapter(ctx, type, task, meta);
            if (result.success) {
                return result;
            }

            lastError = result.error;
            if (result.error?.retryable === false) {
                return result;
            }

            if (i < maxAttempts - 1) {
                logger.warn('工作池', `[${this.name}] ${type} 失败，尝试下一个适配器...`, {
                    error: result.error?.message,
                    ...meta
                });
            }
        }

        return {
            success: false,
            data: null,
            error: lastError || { message: '所有候选适配器都执行失败', retryable: true }
        };
    }

    /**
     * 执行单个适配器
     * @private
     */
    async _executeAdapter(ctx, type, task, meta) {
        if (!this.initialized || !this.page || this.page.isClosed()) {
            logger.info('工作池', `[${this.name}] 浏览器已断开，正在自动重新初始化...`, meta);
            try {
                await this._reinit();
            } catch (e) {
                logger.error('工作池', `[${this.name}] 重新初始化失败`, { error: e.message, ...meta });
                return {
                    success: false,
                    data: null,
                    error: {
                        message: `Worker 重新初始化失败: ${e.message}`,
                        retryable: true
                    }
                };
            }
        }

        const adapter = registry.getAdapter(type);
        if (!adapter) {
            return {
                success: false,
                data: null,
                error: {
                    message: `适配器不存在: ${type}`,
                    retryable: false
                }
            };
        }

        logger.info('工作池', `[${this.name}] 执行任务 -> ${type} (${task.providerType}/${task.modelId || 'default'})`, meta);

        const subContext = {
            ...ctx,
            page: this.page,
            context: this.browser,
            config: this.globalConfig,
            proxyConfig: this.proxyConfig,
            userDataDir: this.userDataDir,
            workerName: this.name,
            instanceName: this.instanceName,
            worker: {
                name: this.name,
                type: this.type,
                instance: this.instanceName
            },
            api: createAdapterApi(this.name, this.instanceName, meta, task.fileOutput, this.page)
        };

        this.busyCount++;
        try {
            const result = await adapter.execute(subContext, task.input);
            return normalizeExecutionResult(result);
        } catch (err) {
            logger.error('工作池', `[${this.name}] 适配器执行异常`, { error: err.message, ...meta });
            return {
                success: false,
                data: null,
                error: normalizeExecutionError(err)
            };
        } finally {
            this.busyCount--;
        }
    }

    async runAdapterTest(adapterId, task, meta = {}) {
        if (!this.initialized || !this.browser) {
            await this._reinit();
        }

        const adapter = registry.getAdapter(adapterId);
        if (!adapter) {
            return {
                success: false,
                data: null,
                error: {
                    message: `适配器不存在: ${adapterId}`,
                    retryable: false
                }
            };
        }

        const page = await this.browser.newPage();
        page.authState = { isHandlingAuth: false };
        const humanizeCursorMode = this.globalConfig?.browser?.humanizeCursor;
        page._humanizeCursorMode = humanizeCursorMode;
        if (humanizeCursorMode === true) {
            page.cursor = createCursor(page);
        }

        if (this._navigationHandler) {
            page.on('framenavigated', async () => {
                try { await this._navigationHandler(page); } catch { }
            });
        }

        const subContext = {
            page,
            context: this.browser,
            config: this.globalConfig,
            proxyConfig: this.proxyConfig,
            userDataDir: this.userDataDir,
            workerName: this.name,
            instanceName: this.instanceName,
            worker: {
                name: this.name,
                type: this.type,
                instance: this.instanceName
            },
            api: createAdapterApi(this.name, this.instanceName, meta, task.fileOutput, page)
        };

        this.busyCount++;
        try {
            const result = await adapter.execute(subContext, task.input);
            return normalizeExecutionResult(result);
        } catch (err) {
            logger.error('工作池', `[${this.name}] 适配器测试异常`, { error: err.message, ...meta });
            return {
                success: false,
                data: null,
                error: normalizeExecutionError(err)
            };
        } finally {
            this.busyCount--;
            try {
                if (!page.isClosed()) {
                    await page.close();
                }
            } catch { }
        }
    }

    /**
     * 重新初始化浏览器（崩溃恢复）
     * @private
     */
    async _reinit() {
        this.initialized = false;
        this.browser = null;
        this.page = null;

        await this._initNewBrowser(this._targetUrl || 'about:blank', this._navigationHandler || null);
        this.initialized = true;
        logger.info('工作池', `[${this.name}] 浏览器已成功重新初始化`);
    }

    /**
     * 获取支持的模型列表
     */
    getModels() {
        const types = this.type === 'merge' ? this.mergeTypes : [this.type];
        const seenIds = new Set();
        const models = [];
        for (const type of types) {
            const result = registry.getModelsForAdapter(type);
            for (const model of result.data || []) {
                if (seenIds.has(model.id)) continue;
                seenIds.add(model.id);
                models.push(model);
            }
        }
        return models;
    }

    async runDebugScript(script, input, meta = {}, options = {}) {
        if (!this.initialized || !this.browser) {
            await this._reinit();
        }

        const page = await this.browser.newPage();
        page.authState = { isHandlingAuth: false };
        const humanizeCursorMode = this.globalConfig?.browser?.humanizeCursor;
        page._humanizeCursorMode = humanizeCursorMode;
        if (humanizeCursorMode === true) {
            page.cursor = createCursor(page);
        }

        if (this._navigationHandler) {
            page.on('framenavigated', async () => {
                try { await this._navigationHandler(page); } catch { }
            });
        }

        if (options.timeout && Number(options.timeout) > 0) {
            const timeout = Number(options.timeout);
            page.setDefaultTimeout(timeout);
            page.setDefaultNavigationTimeout(timeout);
        }

        const logs = [];
        const captures = [];
        const artifactDir = options.artifactDir;
        const artifactBasePath = options.artifactBasePath;
        const api = createDebugApi(this.name, this.instanceName, page, meta, logs, captures, artifactDir, artifactBasePath);
        const ctx = {
            page,
            context: this.browser,
            config: this.globalConfig,
            proxyConfig: this.proxyConfig,
            userDataDir: this.userDataDir,
            workerName: this.name,
            instanceName: this.instanceName,
            worker: {
                name: this.name,
                type: this.type,
                instance: this.instanceName
            },
            api
        };

        this.busyCount++;
        try {
            const runner = compileDebugRunner(script);
            const result = await runner(ctx, api, input, meta);
            if (result?.image && typeof result.image === 'string' && result.image.startsWith('data:')) {
                const imageUrl = await persistDataUrlArtifact(artifactDir, artifactBasePath, 'result-image', result.image);
                if (imageUrl) {
                    result.imageUrl = result.imageUrl || imageUrl;
                    delete result.image;
                }
            }
            return {
                success: true,
                result,
                logs,
                captures,
                page: {
                    url: page.url(),
                    title: await page.title().catch(() => '')
                },
                keepPageOpen: !!options.keepPageOpen
            };
        } catch (err) {
            try {
                await api.capture('error-final', { screenshot: true, html: true, text: true, fullPage: true });
            } catch { }
            return {
                success: false,
                result: {
                    error: err.message,
                    stack: err.stack,
                    url: page.url()
                },
                logs,
                captures,
                page: {
                    url: page.url(),
                    title: await page.title().catch(() => '')
                },
                keepPageOpen: !!options.keepPageOpen
            };
        } finally {
            this.busyCount--;
            if (!options.keepPageOpen) {
                try {
                    if (!page.isClosed()) {
                        await page.close();
                    }
                } catch { }
            }
        }
    }

    /**
     * 导航到监控页面（空闲时）
     */
    async navigateToMonitor() {
        if (this.type !== 'merge' || !this.mergeMonitor) return;
        if (!this.page || this.page.isClosed()) return;

        const targetUrl = registry.getTargetUrl(this.mergeMonitor, this.globalConfig, this.workerConfig);
        if (!targetUrl) return;

        const currentUrl = this.page.url();
        try {
            if (currentUrl.includes(new URL(targetUrl).hostname)) return;
        } catch (e) { return; }

        logger.info('工作池', `[${this.name}] 空闲，跳转监控: ${this.mergeMonitor}`);
        try {
            await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
            logger.warn('工作池', `[${this.name}] 监控跳转失败: ${e.message}`);
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
