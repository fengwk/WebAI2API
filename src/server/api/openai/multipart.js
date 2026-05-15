function splitBuffer(buffer, boundaryBuffer) {
    const parts = [];
    let start = 0;
    while (start < buffer.length) {
        const index = buffer.indexOf(boundaryBuffer, start);
        if (index === -1) {
            parts.push(buffer.subarray(start));
            break;
        }
        parts.push(buffer.subarray(start, index));
        start = index + boundaryBuffer.length;
    }
    return parts;
}

function parseHeaders(headerBlock) {
    const headers = {};
    for (const line of headerBlock.split('\r\n')) {
        const index = line.indexOf(':');
        if (index === -1) continue;
        const key = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        headers[key] = value;
    }
    return headers;
}

function parseContentDisposition(value) {
    const result = {};
    for (const part of String(value || '').split(';')) {
        const trimmed = part.trim();
        const index = trimmed.indexOf('=');
        if (index === -1) continue;
        const key = trimmed.slice(0, index).trim();
        const rawValue = trimmed.slice(index + 1).trim();
        result[key] = rawValue.replace(/^"|"$/g, '');
    }
    return result;
}

export function parseMultipartForm(buffer, boundary) {
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const rawParts = splitBuffer(buffer, boundaryBuffer);
    const fields = {};
    const files = [];

    for (const rawPart of rawParts) {
        if (!rawPart || rawPart.length === 0) continue;

        let part = rawPart;
        if (part.subarray(0, 2).toString() === '\r\n') {
            part = part.subarray(2);
        }

        const trimmed = part.toString('latin1').trim();
        if (!trimmed || trimmed === '--') continue;

        const separatorIndex = part.indexOf(Buffer.from('\r\n\r\n'));
        if (separatorIndex === -1) continue;

        const headerBlock = part.subarray(0, separatorIndex).toString('utf8');
        let body = part.subarray(separatorIndex + 4);
        if (body.subarray(body.length - 2).toString() === '\r\n') {
            body = body.subarray(0, body.length - 2);
        }
        if (body.subarray(body.length - 2).toString() === '--') {
            body = body.subarray(0, body.length - 2);
        }

        const headers = parseHeaders(headerBlock);
        const disposition = parseContentDisposition(headers['content-disposition']);
        const name = disposition.name;
        if (!name) continue;

        if (disposition.filename !== undefined) {
            files.push({
                name,
                fileName: disposition.filename,
                mimeType: headers['content-type'] || 'application/octet-stream',
                buffer: body
            });
            continue;
        }

        const value = body.toString('utf8');
        if (fields[name] === undefined) {
            fields[name] = value;
        } else if (Array.isArray(fields[name])) {
            fields[name].push(value);
        } else {
            fields[name] = [fields[name], value];
        }
    }

    return { fields, files };
}
