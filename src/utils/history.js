/**
 * @fileoverview 请求历史记录管理模块
 * @description 使用 SQLite 存储动态适配器请求/响应历史。
 */

import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

const DATA_DIR = path.join(process.cwd(), 'data', 'history');
const DB_PATH = path.join(DATA_DIR, 'history.db');

let db = null;

export async function initHistoryDb() {
    if (db) return db;

    await fs.mkdir(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);

    db.exec(`
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            adapter_id TEXT,
            endpoint_path TEXT,
            request_summary TEXT,
            request_body TEXT,
            response_summary TEXT,
            response_body TEXT,
            status TEXT DEFAULT 'pending',
            error_message TEXT,
            duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_created_at ON requests(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_status ON requests(status);
        CREATE INDEX IF NOT EXISTS idx_adapter_id ON requests(adapter_id);
    `);

    const migrations = [
        'ALTER TABLE requests ADD COLUMN adapter_id TEXT',
        'ALTER TABLE requests ADD COLUMN endpoint_path TEXT',
        'ALTER TABLE requests ADD COLUMN request_summary TEXT',
        'ALTER TABLE requests ADD COLUMN request_body TEXT',
        'ALTER TABLE requests ADD COLUMN response_summary TEXT',
        'ALTER TABLE requests ADD COLUMN response_body TEXT'
    ];
    for (const sql of migrations) {
        try {
            db.exec(sql);
        } catch { }
    }

    logger.info('历史记录', '数据库初始化完成');
    return db;
}

function getDb() {
    if (!db) {
        throw new Error('历史记录数据库未初始化，请先调用 initHistoryDb()');
    }
    return db;
}

function safeParseJson(text, fallback = null) {
    if (!text) return fallback;
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

export function createRecord(data) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO requests (id, created_at, adapter_id, endpoint_path, request_summary, request_body, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        data.id,
        Date.now(),
        data.adapterId || null,
        data.endpointPath || null,
        data.requestSummary || null,
        data.requestBody !== undefined ? JSON.stringify(data.requestBody) : null,
        data.status || 'pending'
    );

    return data.id;
}

export function updateRecord(id, updates) {
    const db = getDb();
    const fields = [];
    const values = [];

    if (updates.status !== undefined) {
        fields.push('status = ?');
        values.push(updates.status);
    }
    if (updates.responseSummary !== undefined) {
        fields.push('response_summary = ?');
        values.push(updates.responseSummary);
    }
    if (updates.responseBody !== undefined) {
        fields.push('response_body = ?');
        values.push(JSON.stringify(updates.responseBody));
    }
    if (updates.errorMessage !== undefined) {
        fields.push('error_message = ?');
        values.push(updates.errorMessage);
    }
    if (updates.durationMs !== undefined) {
        fields.push('duration_ms = ?');
        values.push(updates.durationMs);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = db.prepare(`UPDATE requests SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
}

export function getList(filters = {}, page = 1, pageSize = 20) {
    const db = getDb();
    const conditions = [];
    const params = [];

    if (filters.status && filters.status !== 'all') {
        conditions.push('status = ?');
        params.push(filters.status);
    }
    if (filters.adapterId) {
        conditions.push('adapter_id LIKE ?');
        params.push(`%${filters.adapterId}%`);
    }
    if (filters.search) {
        conditions.push('(request_summary LIKE ? OR response_summary LIKE ? OR error_message LIKE ?)');
        params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
    }
    if (filters.startDate) {
        conditions.push('created_at >= ?');
        params.push(new Date(filters.startDate).setHours(0, 0, 0, 0));
    }
    if (filters.endDate) {
        conditions.push('created_at <= ?');
        params.push(new Date(filters.endDate).setHours(23, 59, 59, 999));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM requests ${whereClause}`);
    const { count: total } = countStmt.get(...params);

    const offset = (page - 1) * pageSize;
    const dataStmt = db.prepare(`
        SELECT * FROM requests ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `);
    const items = dataStmt.all(...params, pageSize, offset).map(row => ({
        id: row.id,
        created_at: row.created_at,
        adapter_id: row.adapter_id,
        endpoint_path: row.endpoint_path,
        request_summary: row.request_summary,
        request_body: safeParseJson(row.request_body, null),
        response_summary: row.response_summary,
        response_body: safeParseJson(row.response_body, null),
        status: row.status,
        error_message: row.error_message,
        duration_ms: row.duration_ms
    }));

    return { items, total, page, pageSize };
}

export function getDetail(id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM requests WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    return {
        id: row.id,
        created_at: row.created_at,
        adapter_id: row.adapter_id,
        endpoint_path: row.endpoint_path,
        request_summary: row.request_summary,
        request_body: safeParseJson(row.request_body, null),
        response_summary: row.response_summary,
        response_body: safeParseJson(row.response_body, null),
        status: row.status,
        error_message: row.error_message,
        duration_ms: row.duration_ms
    };
}

export async function deleteRecords(ids) {
    if (!ids || ids.length === 0) return 0;
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`DELETE FROM requests WHERE id IN (${placeholders})`);
    const result = stmt.run(...ids);
    return result.changes;
}

export async function deleteByDateRange(startDate, endDate) {
    const db = getDb();
    const start = new Date(startDate).setHours(0, 0, 0, 0);
    const end = new Date(endDate).setHours(23, 59, 59, 999);
    const stmt = db.prepare('DELETE FROM requests WHERE created_at >= ? AND created_at <= ?');
    const result = stmt.run(start, end);
    return result.changes;
}
