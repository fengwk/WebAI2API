/**
 * @fileoverview API 路由总装配
 * @description 统一挂载 /api 和 /admin 路由。
 */

import fs from 'fs';
import path from 'path';
import { createAdapterRouter } from './adapter/routes.js';
import { createAdminRouter } from './admin/routes.js';
import { createAuthMiddleware } from '../middlewares/auth.js';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
};

const WEBUI_DIR = path.join(process.cwd(), 'webui', 'dist');
const PUBLIC_FILES_DIR = path.join(process.cwd(), 'data', 'files');

export function createGlobalRouter(context) {
    const { authToken, config, queueManager, tempDir, loginMode, getSafeMode } = context;
    const checkAuth = createAuthMiddleware(authToken);
    const handleAdapterRequest = loginMode ? null : createAdapterRouter(context);
    const handleAdminRequest = createAdminRouter({ config, queueManager, tempDir, getSafeMode });

    return async function handleRequest(req, res) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const pathname = parsedUrl.pathname;

        if (req.method === 'GET' && pathname.startsWith('/files/')) {
            const relativePath = decodeURIComponent(pathname.replace(/^\/files\//, ''));
            const filePath = path.join(PUBLIC_FILES_DIR, relativePath);
            if (!filePath.startsWith(PUBLIC_FILES_DIR)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }

            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath).toLowerCase();
                const contentType = MIME_TYPES[ext] || 'application/octet-stream';
                const content = fs.readFileSync(filePath);
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-cache'
                });
                res.end(content);
                return;
            }

            res.writeHead(404);
            res.end();
            return;
        }

        if (req.method === 'GET' && !pathname.startsWith('/api') && !pathname.startsWith('/admin')) {
            let filePath = pathname === '/' ? '/index.html' : pathname;
            filePath = path.join(WEBUI_DIR, filePath);

            if (!filePath.startsWith(WEBUI_DIR)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }

            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath).toLowerCase();
                const contentType = MIME_TYPES[ext] || 'application/octet-stream';
                const content = fs.readFileSync(filePath);
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
                return;
            }

            const indexPath = path.join(WEBUI_DIR, 'index.html');
            if (fs.existsSync(indexPath)) {
                const content = fs.readFileSync(indexPath);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(content);
                return;
            }
        }

        if (!checkAuth(req, res)) {
            return;
        }

        if (pathname.startsWith('/admin')) {
            const adminPath = pathname.slice(6);
            await handleAdminRequest(req, res, adminPath);
            return;
        }

        if (pathname.startsWith('/api')) {
            const safeMode = getSafeMode?.();
            if (safeMode?.enabled) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: `服务运行在安全模式，API 不可用。原因: ${safeMode.reason}`,
                        type: 'service_unavailable'
                    }
                }));
                return;
            }

            if (!handleAdapterRequest) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: { message: '服务运行在登录模式，API 不可用', type: 'service_unavailable' }
                }));
                return;
            }

            const adapterPath = pathname.slice(4);
            await handleAdapterRequest(req, res, adapterPath);
            return;
        }

        res.writeHead(404);
        res.end();
    };
}
