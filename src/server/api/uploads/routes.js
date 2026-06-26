import { registerUploadedFile } from '../../../backend/uploadStore.js';
import { saveBufferToTempFile } from '../../../utils/inputFiles.js';
import { ERROR_CODES } from '../../errors.js';
import { sendApiError, sendJson } from '../../respond.js';

async function readUploadForm(req) {
    const request = new Request(`http://${req.headers.host || 'localhost'}${req.url || '/'}`, {
        method: req.method,
        headers: req.headers,
        body: req,
        duplex: 'half'
    });
    return await request.formData();
}

export function createUploadRouter(context) {
    const { tempDir } = context;

    return async function handleUploadRequest(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
        }

        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('multipart/form-data')) {
            sendApiError(res, {
                code: ERROR_CODES.INVALID_REQUEST_BODY,
                message: '仅支持 multipart/form-data 请求体',
                status: 400
            });
            return;
        }

        try {
            const formData = await readUploadForm(req);
            const uploads = [];
            for (const [fieldName, value] of formData.entries()) {
                if (typeof value === 'string') continue;
                const fileName = value.name || fieldName || 'upload.bin';
                const mimeType = value.type || 'application/octet-stream';
                const buffer = Buffer.from(await value.arrayBuffer());
                const saved = await saveBufferToTempFile(buffer, {
                    tempDir,
                    prefix: 'api-upload',
                    fileName,
                    mimeType
                });
                uploads.push(registerUploadedFile(saved, {
                    fieldName,
                    fileName,
                    mimeType,
                    size: value.size
                }));
            }

            sendJson(res, 200, { ok: true, uploads });
        } catch (err) {
            sendApiError(res, {
                code: ERROR_CODES.INVALID_REQUEST_BODY,
                message: err.message,
                status: 400
            });
        }
    };
}
