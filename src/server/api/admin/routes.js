/**
 * @fileoverview Admin API 路由模块
 * @description 提供管理接口，包括系统状态、配置管理、适配器元数据等
 */

import { sendJson, sendApiError } from '../../respond.js';
import { ERROR_CODES } from '../../errors.js';
import { logger } from '../../../utils/logger.js';
import {
    getSystemStatus,
    getDataFolders,
    deleteDataFolders,
    clearTempFiles
} from '../../../utils/systemInfo.js';
import {
    getServerConfig,
    saveServerConfig,
    getBrowserConfig,
    saveBrowserConfig,
    getQueueConfig,
    saveQueueConfig,
    getInstancesConfig,
    saveInstancesConfig,
    getAdaptersConfig,
    saveAdaptersConfig,
    getPoolConfig,
    savePoolConfig
} from '../../../config/manager.js';
import {
    validateServerConfig,
    validateBrowserConfig,
    validateInstancesConfig,
    validatePoolConfig,
    validateAdaptersConfig
} from '../../../config/validator.js';
import { registry } from '../../../backend/registry.js';
import { sendRestartSignal, sendStopSignal, isUnderSupervisor, getVncInfo } from '../../../utils/ipc.js';
import { getTodayStats, getStatsRange, clearStatsRange } from '../../../utils/stats.js';
import {
    getList as getHistoryList,
    getDetail as getHistoryDetail,
    getBodyText as getHistoryBodyText,
    deleteRecords as deleteHistoryRecords,
    deleteByDateRange as deleteHistoryByDateRange
} from '../../../utils/history.js';
import path from 'path';
import fs from 'fs/promises';
import {
    listAdapterFiles,
    readAdapterSource,
    writeAdapterSource,
    deleteAdapterSource,
    importAdapterModule,
    normalizeAdapterId,
    adapterSourceExists
} from '../../../backend/adapterStore.js';

function buildRequestId() {
    return `adapter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getArtifactContentType(fileName) {
    if (fileName.endsWith('.png')) return 'image/png';
    if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
    if (fileName.endsWith('.gif')) return 'image/gif';
    if (fileName.endsWith('.webp')) return 'image/webp';
    if (fileName.endsWith('.html')) return 'text/html; charset=utf-8';
    if (fileName.endsWith('.txt')) return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
}

function getDebugArtifactsRoot(tempDir) {
    return path.join(tempDir, 'debug-artifacts');
}

async function ensureDebugArtifactsDir(tempDir) {
    await fs.mkdir(getDebugArtifactsRoot(tempDir), { recursive: true });
}

async function cleanupDebugArtifacts(tempDir, ttlMs = 30 * 60 * 1000) {
    const root = getDebugArtifactsRoot(tempDir);
    try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        const now = Date.now();
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const fullPath = path.join(root, entry.name);
            try {
                const stat = await fs.stat(fullPath);
                if (now - stat.mtimeMs > ttlMs) {
                    await fs.rm(fullPath, { recursive: true, force: true });
                }
            } catch { }
        }
    } catch { }
}

function buildAdapterMeta(manifest, valid = true, error = null) {
    return {
        id: manifest.id,
        fileId: manifest.id,
        valid,
        error,
        name: manifest.name || manifest.id,
        endpoint: `/api/${manifest.id}`,
        inputJsonSchema: manifest.inputJsonSchema || null,
        outputJsonSchema: manifest.outputJsonSchema || null
    };
}

async function inspectAdapterFile(file) {
    try {
        const module = await importAdapterModule(file.filePath);
        if (!module.manifest) {
            return {
                id: file.id,
                fileId: file.id,
                valid: false,
                error: '未导出 manifest',
                name: file.id,
                endpoint: `/api/${file.id}`,
                inputJsonSchema: null,
                outputJsonSchema: null
            };
        }

        const manifest = module.manifest;
        if (manifest.id !== file.id) {
            return buildAdapterMeta({
                id: file.id,
                name: manifest.name || file.id,
                inputJsonSchema: manifest.inputJsonSchema || null,
                outputJsonSchema: manifest.outputJsonSchema || null
            }, false, `manifest.id 必须与文件名一致 (${file.id})`);
        }

        const errors = registry.getManifestErrors(manifest, file.fileName);
        if (errors.length > 0) {
            return buildAdapterMeta(manifest, false, errors.join('; '));
        }

        return buildAdapterMeta(manifest, true, null);
    } catch (err) {
        return {
            id: file.id,
            fileId: file.id,
            valid: false,
            error: err.message,
            name: file.id,
            endpoint: `/api/${file.id}`,
            inputJsonSchema: null,
            outputJsonSchema: null
        };
    }
}

async function listDynamicAdapters() {
    const files = await listAdapterFiles();
    const results = [];
    for (const file of files) {
        results.push(await inspectAdapterFile(file));
    }
    return results;
}

/**
 * 读取请求体
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object>}
 */
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    return body ? JSON.parse(body) : {};
}

/**
 * 创建 Admin 路由处理器
 * @param {object} context - 路由上下文
 * @param {object} context.config - 完整配置对象
 * @param {object} context.queueManager - 队列管理器
 * @param {string} context.tempDir - 临时目录
 * @returns {Function} Admin 路由处理函数
 */
export function createAdminRouter(context) {
    const { config, queueManager, tempDir, getSafeMode } = context;

    /**
     * Admin 路由处理函数
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     * @param {string} pathname - 去除 /admin 前缀后的路径
     */
    return async function handleAdminRequest(req, res, pathname) {
        const method = req.method;

        try {
            // ==================== 系统管理 ====================

            // GET /admin/status - 系统状态
            if (method === 'GET' && pathname === '/status') {
                const status = getSystemStatus();
                const safeMode = getSafeMode?.() || { enabled: false, reason: null };
                sendJson(res, 200, { ...status, safeMode });
                return;
            }

            // POST /admin/restart - 重启服务
            if (method === 'POST' && pathname === '/restart') {
                // 解析请求体获取重启参数
                let loginMode = null;
                let workerName = null;
                try {
                    const body = await readBody(req);
                    loginMode = body.loginMode || null;
                    workerName = body.workerName || null;
                } catch { /* 无请求体时使用默认值 */ }

                const modeDesc = loginMode
                    ? (workerName ? `登录模式 (${workerName})` : '登录模式')
                    : '普通模式';
                sendJson(res, 200, { success: true, message: `服务正在以${modeDesc}重启...` });
                logger.info('管理器', `收到重启请求: ${modeDesc}`);

                setTimeout(async () => {
                    // 构建启动参数（仅登录模式相关）
                    const extraArgs = [];
                    if (loginMode) {
                        extraArgs.push(workerName ? `-login=${workerName}` : '-login');
                    }

                    if (isUnderSupervisor()) {
                        // Supervisor 模式：通过 IPC 发送带参数的重启信号
                        const sent = await sendRestartSignal(extraArgs);
                        if (!sent) {
                            logger.warn('管理器', 'IPC 重启信号发送失败，尝试自重启');
                            // 降级到自重启
                            const { spawn } = await import('child_process');
                            const newArgs = process.argv.slice(1).filter(arg => !arg.startsWith('-login'));
                            newArgs.push(...extraArgs);
                            const child = spawn(process.execPath, newArgs, {
                                cwd: process.cwd(),
                                detached: true,
                                stdio: 'ignore',
                                env: process.env
                            });
                            child.unref();
                            setTimeout(() => process.exit(0), 500);
                        }
                    } else {
                        // 独立模式：使用子进程自重启
                        const { spawn } = await import('child_process');
                        const newArgs = process.argv.slice(1).filter(arg => !arg.startsWith('-login'));
                        newArgs.push(...extraArgs);
                        const child = spawn(process.execPath, newArgs, {
                            cwd: process.cwd(),
                            detached: true,
                            stdio: 'ignore',
                            env: process.env
                        });
                        child.unref();
                        setTimeout(() => process.exit(0), 500);
                    }
                }, 500);
                return;
            }

            // POST /admin/stop - 停止服务
            if (method === 'POST' && pathname === '/stop') {
                sendJson(res, 200, { success: true, message: '服务正在停止...' });
                logger.info('管理器', '收到停止请求，将在 1 秒后退出');

                setTimeout(() => process.exit(0), 1000);
                return;
            }

            // GET /admin/vnc/status - VNC 状态
            if (method === 'GET' && pathname === '/vnc/status') {
                const vncInfo = await getVncInfo();
                if (vncInfo) {
                    sendJson(res, 200, vncInfo);
                } else {
                    // 非 Supervisor 模式或无法获取信息
                    sendJson(res, 200, {
                        enabled: false,
                        port: 0,
                        display: '',
                        xvfbMode: false
                    });
                }
                return;
            }

            // ==================== 缓存与数据管理 ====================

            // POST /admin/cache/clear - 清理缓存
            if (method === 'POST' && pathname === '/cache/clear') {
                const result = clearTempFiles(tempDir);
                sendJson(res, 200, { success: true, cleaned: result.cleaned });
                return;
            }

            // GET /admin/logs - 读取系统日志
            if (method === 'GET' && pathname === '/logs') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const lines = parseInt(url.searchParams.get('lines') || '200', 10);
                const result = logger.readLogs(lines);
                sendJson(res, 200, result);
                return;
            }

            // DELETE /admin/logs - 清除系统日志
            if (method === 'DELETE' && pathname === '/logs') {
                const success = logger.clearLogs();
                if (success) {
                    logger.info('管理器', '系统日志已清除');
                    sendJson(res, 200, { success: true, message: '日志已清除' });
                } else {
                    sendJson(res, 500, { success: false, message: '日志清除失败' });
                }
                return;
            }

            // GET /admin/data-folders - 列出数据文件夹
            if (method === 'GET' && pathname === '/data-folders') {
                const workers = config.backend?.pool?.workers || [];
                const folders = getDataFolders(workers);
                sendJson(res, 200, folders);
                return;
            }

            // POST /admin/data-folders/delete - 删除数据文件夹
            if (method === 'POST' && pathname === '/data-folders/delete') {
                const body = await readBody(req);
                if (!body.folders || !Array.isArray(body.folders)) {
                    sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 folders 数组' });
                    return;
                }
                const workers = config.backend?.pool?.workers || [];
                const result = deleteDataFolders(body.folders, workers);

                if (result.errors.length > 0) {
                    sendJson(res, 207, result); // 207 Multi-Status
                } else {
                    sendJson(res, 200, result);
                }
                return;
            }

            // ==================== 配置管理 ====================

            // GET/POST /admin/config/server
            if (pathname === '/config/server') {
                if (method === 'GET') {
                    const serverConfig = getServerConfig();
                    const queueConfig = getQueueConfig();
                    sendJson(res, 200, {
                        ...serverConfig,
                        queueBuffer: queueConfig.queueBuffer
                    });
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // 校验配置
                    const validation = validateServerConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    // 分别保存 server 和 queue 配置
                    saveServerConfig(body);
                    if (body.queueBuffer !== undefined) {
                        saveQueueConfig(body);
                    }
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // GET/POST /admin/config/browser
            if (pathname === '/config/browser') {
                if (method === 'GET') {
                    sendJson(res, 200, getBrowserConfig());
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // 校验配置
                    const validation = validateBrowserConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    saveBrowserConfig(body);
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // GET/POST /admin/config/instances (对应原设计的 workers)
            if (pathname === '/config/instances' || pathname === '/config/workers') {
                if (method === 'GET') {
                    sendJson(res, 200, getInstancesConfig());
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // Worker 配置保存时，先重新加载当前动态适配器，确保 validator 能识别最新脚本
                    await registry.reload();

                    // 校验配置（包括 Instance/Worker 名称唯一性）
                    const validation = validateInstancesConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    saveInstancesConfig(body);
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // GET/POST /admin/config/adapters
            if (pathname === '/config/adapters') {
                if (method === 'GET') {
                    sendJson(res, 200, getAdaptersConfig());
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // 校验配置
                    const validation = validateAdaptersConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    saveAdaptersConfig(body);
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // GET/POST /admin/config/pool - 负载均衡和故障转移配置
            if (pathname === '/config/pool') {
                if (method === 'GET') {
                    sendJson(res, 200, getPoolConfig());
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // 校验配置
                    const validation = validatePoolConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    savePoolConfig(body);
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // ==================== 元数据 ====================

            // GET /admin/adapters - 获取动态适配器列表
            if (method === 'GET' && pathname === '/adapters') {
                sendJson(res, 200, await listDynamicAdapters());
                return;
            }

            // GET /admin/adapters/:id/source - 获取脚本源码
            const adapterSourceMatch = pathname.match(/^\/adapters\/([^/]+)\/source$/);
            if (method === 'GET' && adapterSourceMatch) {
                const adapterId = normalizeAdapterId(decodeURIComponent(adapterSourceMatch[1]));
                if (!await adapterSourceExists(adapterId)) {
                    sendApiError(res, { code: ERROR_CODES.NOT_FOUND, message: '适配器不存在', status: 404 });
                    return;
                }
                const source = await readAdapterSource(adapterId);
                sendJson(res, 200, { id: adapterId, source });
                return;
            }

            // PUT /admin/adapters/:id/source - 保存脚本源码
            if (method === 'PUT' && adapterSourceMatch) {
                const adapterId = normalizeAdapterId(decodeURIComponent(adapterSourceMatch[1]));
                const body = await readBody(req);
                if (typeof body.source !== 'string') {
                    sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 source 字段' });
                    return;
                }

                await writeAdapterSource(adapterId, body.source);
                await registry.reload();
                const adapters = await listDynamicAdapters();
                const adapter = adapters.find(item => item.id === adapterId);
                const success = !!adapter?.valid;
                sendJson(res, 200, {
                    success,
                    message: success ? '脚本已保存并生效' : `脚本已保存，但当前无效: ${adapter?.error || '未知错误'}`,
                    adapter
                });
                return;
            }

            // DELETE /admin/adapters/:id - 删除动态适配器
            const adapterDeleteMatch = pathname.match(/^\/adapters\/([^/]+)$/);
            if (method === 'DELETE' && adapterDeleteMatch) {
                const adapterId = normalizeAdapterId(decodeURIComponent(adapterDeleteMatch[1]));
                if (!await adapterSourceExists(adapterId)) {
                    sendApiError(res, { code: ERROR_CODES.NOT_FOUND, message: '适配器不存在', status: 404 });
                    return;
                }
                await deleteAdapterSource(adapterId);
                await registry.reload();
                sendJson(res, 200, { success: true, message: '适配器已删除' });
                return;
            }

            // POST /admin/debug/run - 直接执行临时调试脚本
            if (method === 'POST' && pathname === '/debug/run') {
                const body = await readBody(req);
                const script = typeof body.script === 'string' ? body.script : body.source;
                if (typeof script !== 'string' || !script.trim()) {
                    sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 script 字段' });
                    return;
                }

                const workerName = body.workerName || null;
                const input = body.input && typeof body.input === 'object' ? body.input : {};
                const keepPageOpen = !!body.keepPageOpen;
                const timeout = body.timeout || null;

                let poolContext = queueManager?.getPoolContext?.();
                if (!poolContext) {
                    poolContext = await queueManager.initializePool();
                }

                const runId = buildRequestId();
                await ensureDebugArtifactsDir(tempDir);
                await cleanupDebugArtifacts(tempDir);
                const artifactDir = path.join(getDebugArtifactsRoot(tempDir), runId);
                const artifactBasePath = `/admin/debug/artifacts/${encodeURIComponent(runId)}`;

                const result = await poolContext.poolManager.runDebugScript(
                    workerName,
                    script,
                    input,
                    { id: runId, debug: true },
                    { keepPageOpen, timeout, artifactDir, artifactBasePath }
                );
                result.runId = runId;
                sendJson(res, 200, result);
                return;
            }

            const debugArtifactMatch = pathname.match(/^\/debug\/artifacts\/([^/]+)\/([^/]+)$/);
            if (method === 'GET' && debugArtifactMatch) {
                const runId = decodeURIComponent(debugArtifactMatch[1]);
                const fileName = decodeURIComponent(debugArtifactMatch[2]);
                const filePath = path.join(getDebugArtifactsRoot(tempDir), runId, fileName);
                try {
                    const content = await fs.readFile(filePath);
                    res.writeHead(200, {
                        'Content-Type': getArtifactContentType(fileName),
                        'Cache-Control': 'no-cache'
                    });
                    res.end(content);
                } catch {
                    sendApiError(res, { code: ERROR_CODES.NOT_FOUND, message: '调试产物不存在', status: 404 });
                }
                return;
            }

            // ==================== 统计与监控 ====================

            // GET /admin/stats - 基本统计（包含今日成功/失败）
            if (method === 'GET' && pathname === '/stats') {
                const instances = config.backend?.pool?.instances || [];
                const workers = config.backend?.pool?.workers || [];
                const todayStats = getTodayStats();

                sendJson(res, 200, {
                    instances: instances.length,
                    workers: workers.length,
                    success: todayStats.success,
                    failed: todayStats.failed
                });
                return;
            }

            // GET /admin/stats/range - 查询日期范围统计
            if (method === 'GET' && pathname === '/stats/range') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const start = url.searchParams.get('start');
                const end = url.searchParams.get('end');

                if (!start || !end) {
                    sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 start 或 end 参数' });
                    return;
                }

                const result = await getStatsRange(start, end);
                sendJson(res, 200, result);
                return;
            }

            // DELETE /admin/stats/range - 删除日期范围统计
            if (method === 'DELETE' && pathname === '/stats/range') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const start = url.searchParams.get('start');
                const end = url.searchParams.get('end');

                if (!start || !end) {
                    sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 start 或 end 参数' });
                    return;
                }

                const result = await clearStatsRange(start, end);
                sendJson(res, 200, { success: true, deleted: result.deleted });
                return;
            }

            // GET /admin/queue - 任务队列状态
            if (method === 'GET' && pathname === '/queue') {
                const queueStatus = queueManager.getStatus();
                const detailedStatus = queueManager.getDetailedStatus();

                sendJson(res, 200, {
                    processing: queueStatus.processing,
                    waiting: queueStatus.queueLength,
                    total: queueStatus.total,
                    processingTasks: detailedStatus.processing,
                    waitingTasks: detailedStatus.waiting
                });
                return;
            }

            // ==================== 请求历史 ====================

            // GET /admin/history - 历史记录列表
            if (method === 'GET' && pathname === '/history') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const page = parseInt(url.searchParams.get('page') || '1', 10);
                const pageSize = parseInt(url.searchParams.get('pageSize') || '20', 10);
                const filters = {
                    status: url.searchParams.get('status') || null,
                    adapterId: url.searchParams.get('adapter') || null,
                    search: url.searchParams.get('search') || null,
                    startDate: url.searchParams.get('startDate') || null,
                    endDate: url.searchParams.get('endDate') || null
                };

                const result = getHistoryList(filters, page, pageSize);
                sendJson(res, 200, result);
                return;
            }

            // GET /admin/history/:id - 单条记录详情
            const historyDetailMatch = pathname.match(/^\/history\/([^/]+)$/);
            if (method === 'GET' && historyDetailMatch) {
                const id = historyDetailMatch[1];
                const record = getHistoryDetail(id);
                if (record) {
                    sendJson(res, 200, record);
                } else {
                    sendApiError(res, { code: ERROR_CODES.NOT_FOUND, message: '记录不存在', status: 404 });
                }
                return;
            }

            const historyBodyDownloadMatch = pathname.match(/^\/history\/([^/]+)\/(request|response)-body$/);
            if (method === 'GET' && historyBodyDownloadMatch) {
                const id = historyBodyDownloadMatch[1];
                const bodyType = historyBodyDownloadMatch[2];
                const bodyText = getHistoryBodyText(id, bodyType);
                if (bodyText === null) {
                    sendApiError(res, {
                        code: ERROR_CODES.NOT_FOUND,
                        message: bodyType === 'request' ? '请求体不存在' : '响应体不存在',
                        status: 404
                    });
                    return;
                }

                const fileName = `history-${id}-${bodyType}-body.json`;
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Disposition': `attachment; filename="${fileName}"`,
                    'Cache-Control': 'no-cache'
                });
                res.end(bodyText);
                return;
            }

            // DELETE /admin/history - 批量删除记录
            if (method === 'DELETE' && pathname === '/history') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const startDate = url.searchParams.get('startDate');
                const endDate = url.searchParams.get('endDate');

                // 支持按日期范围删除
                if (startDate && endDate) {
                    const deleted = await deleteHistoryByDateRange(startDate, endDate);
                    sendJson(res, 200, { success: true, deleted });
                    return;
                }

                // 支持按 ID 列表删除
                const body = await readBody(req);
                if (body.ids && Array.isArray(body.ids)) {
                    const deleted = await deleteHistoryRecords(body.ids);
                    sendJson(res, 200, { success: true, deleted });
                    return;
                }

                sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 ids 数组或日期范围参数' });
                return;
            }

            // 404
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not Found' }));

        } catch (err) {
            logger.error('管理器', `请求处理失败: ${err.message}`);
            sendApiError(res, {
                code: ERROR_CODES.INTERNAL_ERROR,
                message: err.message
            });
        }
    };
}
