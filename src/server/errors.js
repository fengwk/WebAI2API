/**
 * @fileoverview 错误码表与中文消息映射模块
 * @description 统一定义服务器错误码及其对应的中文消息和 HTTP 状态码
 */

/**
 * 错误类型枚举
 * @readonly
 * @enum {string}
 */
export const ERROR_TYPES = {
    /** 无效请求 */
    INVALID_REQUEST: 'invalid_request_error',
    /** 服务器错误 */
    SERVER_ERROR: 'server_error',
    /** 限流错误 */
    RATE_LIMIT: 'rate_limit_error',
};

/**
 * 错误码枚举
 * @readonly
 * @enum {string}
 */
export const ERROR_CODES = {
    /** 未授权（Token 无效或缺失） */
    UNAUTHORIZED: 'UNAUTHORIZED',
    /** 请求体非法 */
    INVALID_REQUEST_BODY: 'INVALID_REQUEST_BODY',
    /** 资源不存在 */
    NOT_FOUND: 'NOT_FOUND',
    /** 浏览器未初始化 */
    BROWSER_NOT_INITIALIZED: 'BROWSER_NOT_INITIALIZED',
    /** 服务器繁忙（队列已满） */
    SERVER_BUSY: 'SERVER_BUSY',
    /** 触发人机验证（reCAPTCHA） */
    RECAPTCHA: 'RECAPTCHA',
    /** 服务器内部错误 */
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    /** 生成失败 */
    GENERATION_FAILED: 'GENERATION_FAILED',
};

/**
 * 错误详情映射表
 * @type {Record<string, {message: string, status: number, type: string}>}
 */
const ERROR_DETAILS = {
    [ERROR_CODES.UNAUTHORIZED]: {
        message: '未授权（Token 无效或缺失）',
        status: 401,
        type: ERROR_TYPES.INVALID_REQUEST,
    },
    [ERROR_CODES.INVALID_REQUEST_BODY]: {
        message: '请求体格式无效',
        status: 400,
        type: ERROR_TYPES.INVALID_REQUEST,
    },
    [ERROR_CODES.NOT_FOUND]: {
        message: '资源不存在',
        status: 404,
        type: ERROR_TYPES.INVALID_REQUEST,
    },
    [ERROR_CODES.BROWSER_NOT_INITIALIZED]: {
        message: '浏览器未初始化',
        status: 503,
        type: ERROR_TYPES.SERVER_ERROR,
    },
    [ERROR_CODES.SERVER_BUSY]: {
        message: '服务器繁忙（队列已满）',
        status: 429,
        type: ERROR_TYPES.RATE_LIMIT,
    },
    [ERROR_CODES.RECAPTCHA]: {
        message: '触发人机验证（reCAPTCHA）',
        status: 403,
        type: ERROR_TYPES.SERVER_ERROR,
    },
    [ERROR_CODES.INTERNAL_ERROR]: {
        message: '服务器内部错误',
        status: 500,
        type: ERROR_TYPES.SERVER_ERROR,
    },
    [ERROR_CODES.GENERATION_FAILED]: {
        message: '图片生成失败',
        status: 502,
        type: ERROR_TYPES.SERVER_ERROR,
    },
};

/**
 * 获取错误消息
 * @param {string} code - 错误码
 * @returns {string} 中文错误消息
 */
export function getErrorMessage(code) {
    return ERROR_DETAILS[code]?.message || '未知错误';
}

/**
 * 获取错误对应的 HTTP 状态码
 * @param {string} code - 错误码
 * @returns {number} HTTP 状态码
 */
export function getErrorStatus(code) {
    return ERROR_DETAILS[code]?.status || 500;
}

/**
 * 获取完整的错误详情
 * @param {string} code - 错误码
 * @returns {{message: string, status: number}} 错误详情
 */
export function getErrorDetails(code) {
    return ERROR_DETAILS[code] || { message: '未知错误', status: 500 };
}
