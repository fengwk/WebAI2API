/**
 * @fileoverview 统一响应写出模块
 * @description 封装 JSON 与错误响应的统一处理函数
 */

import { getErrorDetails } from './errors.js';

/**
 * 发送 JSON 响应
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} status - HTTP 状态码
 * @param {object} payload - 响应数据
 */
export function sendJson(res, status, payload) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

/**
 * 发送统一 API 错误响应
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {object} options - 错误选项
 * @param {string} [options.code] - 错误码（使用 ERROR_CODES 枚举）
 * @param {string} [options.message] - 自定义错误消息（如提供则覆盖 code 对应的消息）
 * @param {number} [options.status] - 自定义 HTTP 状态码
 */
export function sendApiError(res, options) {
    const { code, message, status } = options;

    // 获取错误详情
    const details = code ? getErrorDetails(code) : null;
    const errorMessage = message || (details ? details.message : '未知错误');
    const errorType = details?.type || 'server_error';
    const httpStatus = status || (details ? details.status : 500);

    const payload = {
        error: {
            message: errorMessage,
            type: errorType,
            code: code || 'INTERNAL_ERROR'
        }
    };

    sendJson(res, httpStatus, payload);
}
