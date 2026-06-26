/**
 * @fileoverview LMArena Image Automator 服务器入口
 * @description HTTP API 服务器，提供动态适配器接口
 *
 * 支持的端点：
 * - POST /api/{adapter_id}        - 动态适配器接口
 *
 * 启动方式：
 * - 通过 supervisor.js 启动（推荐，支持自动重启和 Xvfb 管理）
 * - 直接运行 node server.js
 *
 * 命令行参数：
 * - -login 启动时打开登录页面
 */

import http from 'http';

// ==================== 启动前自检 ====================
import { runPreflight } from './preflight.js';
runPreflight();
// ==================== 加载其他依赖 ====================
const { getBackend } = await import('../backend/index.js');
const { logger } = await import('../utils/logger.js');
const { createQueueManager, createGlobalRouter } = await import('./index.js');
const { isUnderSupervisor } = await import('../utils/ipc.js');
const { loadTodayStats } = await import('../utils/stats.js');
const { initHistoryDb } = await import('../utils/history.js');

// ==================== 初始化配置 ====================

/**
 * 从统一后端获取配置和函数
 */
let backend;
try {
    backend = getBackend();
} catch (err) {
    logger.error('服务器', '配置加载失败', { error: err.message });
    logger.error('服务器', '请先初始化配置：复制 config.example.yaml 为 config.yaml');
    process.exit(78);  // 使用 78 退出码，supervisor 不会自动重启
}

const {
    config,
    name: backendName,
    initBrowser,
    executeTask,
    TEMP_DIR
} = backend;

/** @type {number} 服务器端口 */
const PORT = config.server?.port || 3000;

/** @type {number} 最大并发数 */
const MAX_CONCURRENT = config.queue?.maxConcurrent || 1;

/** @type {number} 队列缓冲区（0 表示不限制非流式） */
const QUEUE_BUFFER = config.queue?.queueBuffer ?? 2;

// ==================== 创建服务组件 ====================

/**
 * 队列管理器：负责任务队列、并发控制和心跳机制
 */
const WORKER_MAX_PENDING = config.queue?.workerMaxPending ?? 10;
const WORKER_WAIT_TIMEOUT = config.queue?.workerWaitTimeout ?? 300000;

const queueManager = createQueueManager(
    {
        maxConcurrent: MAX_CONCURRENT,
        queueBuffer: QUEUE_BUFFER,
        workerMaxPending: WORKER_MAX_PENDING,
        workerWaitTimeout: WORKER_WAIT_TIMEOUT
    },
    {
        initBrowser,
        executeTask,
        resetPool: backend.resetPool,
        config,
        getCookies: backend.getCookies
            ? (workerName, domain) => backend.getCookies(workerName, domain)
            : null
    }
);

const fatalRecoveryState = {
    inProgress: false,
    recentTimestamps: []
};

function trimFatalRecoveryWindow(now = Date.now()) {
    fatalRecoveryState.recentTimestamps = fatalRecoveryState.recentTimestamps.filter(ts => now - ts <= 60000);
}

function isBrowserRuntimeError(error) {
    const text = [error?.message || '', error?.stack || ''].join('\n');
    return /playwright-core|camoufox|ffnetworkmanager|browser has been closed|target page, context or browser has been closed|execution context was destroyed/i.test(text);
}

async function recoverFromFatalRuntime(source, error) {
    const now = Date.now();
    trimFatalRecoveryWindow(now);
    fatalRecoveryState.recentTimestamps.push(now);

    const browserRuntime = isBrowserRuntimeError(error);
    logger.error('服务器', `捕获到未处理异常 (${source})`, {
        error: error?.message || String(error || ''),
        browserRuntime,
        stack: error?.stack || ''
    });

    if (fatalRecoveryState.inProgress) {
        logger.warn('服务器', '故障恢复已在进行中，忽略重复恢复请求');
        return;
    }

    fatalRecoveryState.inProgress = true;
    try {
        await queueManager.recoverFromFatalRuntime(`服务运行时异常 (${source}): ${error?.message || 'unknown error'}`);
        logger.warn('服务器', '已完成工作池重置与任务中止，服务将继续接收新请求');
    } catch (recoverErr) {
        logger.error('服务器', '故障恢复失败，将依赖 supervisor 重启', { error: recoverErr.message, stack: recoverErr.stack || '' });
        process.exit(70);
        return;
    } finally {
        fatalRecoveryState.inProgress = false;
    }

    trimFatalRecoveryWindow();
    if (fatalRecoveryState.recentTimestamps.length >= 3) {
        logger.error('服务器', '一分钟内连续发生多次未处理异常，主动退出以触发 supervisor 全量重启');
        process.exit(70);
    }
}

process.on('uncaughtException', (error) => {
    void recoverFromFatalRuntime('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason || 'Unhandled rejection'));
    void recoverFromFatalRuntime('unhandledRejection', error);
});

// ==================== 创建路由 ====================

/**
 * 检测是否为登录模式
 */
const isLoginMode = process.argv.some(arg => arg.startsWith('-login'));

/**
 * 安全模式状态
 * 当 Pool 初始化失败时进入安全模式，此时：
 * - HTTP 服务器正常启动
 * - Admin API 和 WebUI 可用
 * - 动态适配器 API 返回 503
 */
let safeMode = false;
let safeModeReason = null;

const handleRequest = createGlobalRouter({
    backendName,
    tempDir: TEMP_DIR,
    queueManager,
    config,
    loginMode: isLoginMode,
    getSafeMode: () => ({ enabled: safeMode, reason: safeModeReason })
});

// ==================== 启动服务器 ====================

/**
 * 启动 HTTP 服务器
 * @returns {Promise<void>}
 */
async function startServer() {
    // 加载今日统计
    await loadTodayStats();

    // 初始化历史记录数据库
    try {
        await initHistoryDb();
    } catch (err) {
        logger.warn('服务器', '历史记录数据库初始化失败，功能可能不可用', { error: err.message });
    }

    // 登录模式提示
    if (isLoginMode) {
        logger.info('服务器', '登录模式已就绪，请在浏览器中完成登录操作');
        logger.info('服务器', '完成后可直接关闭浏览器窗口或按 Ctrl+C 退出');
    }

    // 预先启动工作池（失败时进入安全模式）
    try {
        await queueManager.initializePool();
    } catch (err) {
        logger.error('服务器', '工作池初始化失败', { error: err.message });
        logger.warn('服务器', '进入安全模式：WebUI 和 Admin API 可用，动态适配器 API 不可用');
        logger.warn('服务器', '请通过 配置文件或者 WebUI 修改正确的配置后重启服务');
        safeMode = true;
        safeModeReason = err.message;
    }

    // 创建并启动 HTTP 服务器
    const server = http.createServer(handleRequest);

    // 处理 WebSocket 升级请求（VNC 代理）
    server.on('upgrade', async (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // 只处理 /admin/vnc 路径
        if (url.pathname === '/admin/vnc') {
            const { handleVncUpgrade } = await import('./api/admin/vncProxy.js');
            await handleVncUpgrade(req, socket, head);
        } else {
            socket.destroy();
        }
    });

    server.listen(PORT, () => {
        const mode = isUnderSupervisor() ? 'Supervisor 托管' : '独立运行';
        const modeExtra = isLoginMode ? ' (登录模式)' : '';
        logger.info('服务器', `HTTP 服务器已启动，端口: ${PORT}${modeExtra}`);
        logger.info('服务器', `运行模式: ${mode}`);
        if (!isLoginMode) {
            logger.info('服务器', `最大并发: ${MAX_CONCURRENT}，队列缓冲: ${QUEUE_BUFFER}，worker 本地队列上限: ${WORKER_MAX_PENDING}，worker 等待超时: ${WORKER_WAIT_TIMEOUT}ms`);
        }
    });
}

// 启动服务器
startServer();
