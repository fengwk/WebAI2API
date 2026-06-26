/**
 * ChatGPT 适配器（新 manifest）
 *
 * 目标：
 *   - 固定 worker resident page 上执行对话
 *   - 进入指定 session（可选）
 *   - 优先通过 ChatGPT conversation 流协议还原 Markdown 文本
 *   - 在流协议失配时再退回 DOM 增量文本，保证可用性
 */

export const manifest = {
  id: 'chatgpt',
  name: 'ChatGPT',
  description: '在 ChatGPT 页面中执行对话，支持固定会话复用。支持 prompt + attachments 多模态输入（通过正常对话实现图片生成/编辑）。优先通过 conversation 流协议还原文本 + 图片（role=tool && async_task_type=image_gen）。',
  homePageUrl: 'https://chatgpt.com',
  inputJsonSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', title: '提示词' },
      sessionId: { type: 'string', title: '会话 ID（可选，传入后进入指定对话）' },
      attachments: {
        type: 'array',
        title: '附件列表（支持图片，用于多模态对话、图片生成/编辑）',
        items: {
          type: 'object',
          properties: {
            dataUrl: { type: 'string', title: 'data:xxx;base64,...' },
            url: { type: 'string', title: 'https://...' },
            fileName: { type: 'string' },
            mimeType: { type: 'string' }
          }
        }
      }
    }
  },
  script: `
const t0 = Date.now();
const HOME_URL = 'https://chatgpt.com/';
const STREAM_WAIT_MS = 5 * 60 * 1000;
const NO_PROGRESS_FAIL_MS = 15 * 1000;
const DOM_FALLBACK_WAIT_MS = 60 * 1000;
const DOM_STABLE_MS = 5 * 1000;

const prompt = String(input.prompt || '').trim();
if (!prompt) {
  throw new Error('prompt is required');
}

const log = (message, extra = {}) => {
  api.log('info', message, extra);
};

const uploadNetwork = {
  active: false,
  seq: 0,
  startedAt: null,
  lastEventAt: null,
  events: [],
  pending: new Map()
};
const uploadRequestIds = new WeakMap();

function recordUploadNetworkEvent(entry) {
  uploadNetwork.lastEventAt = Date.now();
  if (uploadNetwork.events.length >= 200) uploadNetwork.events.shift();
  uploadNetwork.events.push(entry);
}

function resetUploadNetworkTracking() {
  uploadNetwork.active = false;
  uploadNetwork.seq = 0;
  uploadNetwork.startedAt = null;
  uploadNetwork.lastEventAt = null;
  uploadNetwork.events = [];
  uploadNetwork.pending.clear();
}

function snapshotUploadNetwork() {
  return {
    active: uploadNetwork.active,
    startedAt: uploadNetwork.startedAt,
    lastEventAt: uploadNetwork.lastEventAt,
    totalEvents: uploadNetwork.events.length,
    pending: Array.from(uploadNetwork.pending.values()).slice(0, 20),
    recentEvents: uploadNetwork.events.slice(-20)
  };
}

function isAttachmentTransferRequest(request) {
  const url = String(request && typeof request.url === 'function' ? request.url() : '').trim();
  const method = String(request && typeof request.method === 'function' ? request.method() : '').toUpperCase().trim();
  if (!url) return false;
  if (!/chatgpt\\.com\\//i.test(url)) return false;
  if (/(upload|attachment|asset|file)/i.test(url)) return true;
  if (method && method !== 'GET' && /backend-api/i.test(url)) return true;
  return false;
}

function extractSessionId(url) {
  return (String(url || '').match(/\\/c\\/([0-9a-f-]{8,})/i) || [])[1] || null;
}

function normalizeText(text) {
  return String(text || '').replace(/\\s+/g, ' ').trim();
}

function collectProtocolFileHints(value, path, out, depth = 0) {
  if (!out || out.length >= 40 || depth > 6 || value == null) return;
  if (typeof value === 'string') {
    const text = value;
    const lowered = text.toLowerCase();
    if (
      lowered.includes('sandbox_path')
      || lowered.includes('/mnt/data/')
      || lowered.includes('interpreter/download')
      || lowered.includes('download_url')
      || lowered.includes('backend-api/files/download')
      || lowered.includes('/backend-api/estuary/content')
      || lowered.includes('file_name')
    ) {
      out.push({ path, preview: text.slice(0, 400) });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectProtocolFileHints(value[index], path + '[' + index + ']', out, depth + 1);
      if (out.length >= 40) break;
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (out.length >= 40) break;
      const childPath = path ? (path + '.' + key) : key;
      if (key === 'sandbox_path' || key === 'download_url' || key === 'file_name' || key === 'url') {
        out.push({ path: childPath, preview: String(child).slice(0, 400) });
      }
      collectProtocolFileHints(child, childPath, out, depth + 1);
    }
  }
}

function collectEncodedItems(obj, out) {
  if (!obj) return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectEncodedItems(item, out);
    return;
  }
  if (typeof obj === 'object') {
    if (typeof obj.encoded_item === 'string') out.push(obj.encoded_item);
    for (const value of Object.values(obj)) collectEncodedItems(value, out);
  }
}

function assistantMessageText(message) {
  const content = message?.content || {};
  const parts = content.parts || [];
  if (!Array.isArray(parts)) return '';
  return parts.filter(part => typeof part === 'string').join('');
}

function applyPatchOp(operation, currentText) {
  const op = operation?.o;
  const value = String(operation?.v || '');
  if (op === 'append') return currentText + value;
  if (op === 'replace') return value;
  return currentText;
}

function applyTextPatch(event, currentText) {
  if (event?.p === '/message/content/parts/0') {
    return applyPatchOp(event, currentText);
  }

  const operations = event?.v;
  if (typeof operations === 'string' && !event?.p && !event?.o) {
    return currentText + operations;
  }

  if (event?.o === 'patch' && Array.isArray(operations)) {
    let text = currentText;
    for (const item of operations) {
      if (item && typeof item === 'object') {
        text = applyTextPatch(item, text);
      }
    }
    return text;
  }

  if (Array.isArray(operations)) {
    let text = currentText;
    for (const item of operations) {
      if (item && typeof item === 'object') {
        text = applyTextPatch(item, text);
      }
    }
    return text;
  }

  return currentText;
}

function assistantText(event, currentText) {
  for (const candidate of [event, event?.v]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const message = candidate.message;
    if (!message || typeof message !== 'object') continue;
    const role = String(message?.author?.role || '').trim().toLowerCase();
    if (role !== 'assistant') continue;
    const text = assistantMessageText(message);
    if (text) return text;
  }

  return currentText;
}

function isImageToolEvent(event) {
  const candidates = [event, event && event.v, event && event.message];
  for (const cand of candidates) {
    if (!cand || typeof cand !== "object") continue;
    const message = cand.message || (cand.v && cand.v.message) || cand;
    if (!message || typeof message !== "object") continue;
    const role = String((message.author && message.author.role) || "").toLowerCase().trim();
    const meta = message.metadata || {};
    if (role === "tool" && meta.async_task_type === "image_gen") {
      return true;
    }
  }
  return false;
}

function extractImagePointers(event) {
  const pointers = [];
  const candidates = [event, event && event.v];
  for (const cand of candidates) {
    if (!cand || typeof cand !== "object") continue;
    const message = cand.message || (cand.v && cand.v.message);
    if (!message || typeof message !== "object") continue;
    const content = message.content || {};
    const parts = content.parts || [];
    const collect = (val) => {
      if (typeof val === "string") {
        let m = val.match(/file-service:\\/\\/([A-Za-z0-9_-]+)/);
        if (m) pointers.push({ type: "file-service", id: m[1] });
        m = val.match(/sediment:\\/\\/([A-Za-z0-9_-]+)/);
        if (m) pointers.push({ type: "sediment", id: m[1] });
      } else if (val && typeof val === "object" && val.asset_pointer) {
        const ap = String(val.asset_pointer);
        let m = ap.match(/file-service:\\/\\/([A-Za-z0-9_-]+)/);
        if (m) pointers.push({ type: "file-service", id: m[1] });
        m = ap.match(/sediment:\\/\\/([A-Za-z0-9_-]+)/);
        if (m) pointers.push({ type: "sediment", id: m[1] });
      }
    };
    if (Array.isArray(parts)) parts.forEach(collect);
    else collect(parts);
  }
  return pointers;
}

function extractConversationId(event) {
  const cands = [event, event && event.v];
  for (const c of cands) {
    if (c && typeof c === "object") {
      if (c.conversation_id) return String(c.conversation_id);
      if (c.v && c.v.conversation_id) return String(c.v.conversation_id);
      if (c.message && c.message.conversation_id) return String(c.message.conversation_id);
    }
  }
  return null;
}

function extractToolInvoked(event) {
  if (event && event.type === "server_ste_metadata") {
    const meta = event.metadata || (event.v && event.v.metadata);
    if (meta && typeof meta.tool_invoked === "boolean") return meta.tool_invoked;
  }
  return null;
}

async function inspectAttachmentUi(expectedFileNames = []) {
  return await page.evaluate((expectedNames) => {
    const normalize = text => String(text || '').replace(/\\s+/g, ' ').trim();
    const isVisible = node => !!(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const expected = Array.isArray(expectedNames)
      ? expectedNames.map(name => normalize(name).toLowerCase()).filter(Boolean)
      : [];

    const actionCandidates = Array.from(document.querySelectorAll('button, [role="button"], label'))
      .filter(isVisible)
      .map(node => ({
        tag: node.tagName.toLowerCase(),
        text: normalize(node.innerText || '').slice(0, 120),
        aria: String(node.getAttribute('aria-label') || '').slice(0, 120),
        testId: String(node.getAttribute('data-testid') || '').slice(0, 120)
      }))
      .filter(item => /attach|upload|file|image|photo|plus|附件|上传|文件|图片|照片/i.test(
        [item.text, item.aria, item.testId].join(' ')
      ))
      .slice(0, 20);

    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((node, index) => ({
      index,
      visible: isVisible(node),
      multiple: !!node.multiple,
      accept: String(node.getAttribute('accept') || ''),
      aria: String(node.getAttribute('aria-label') || ''),
      testId: String(node.getAttribute('data-testid') || ''),
      value: String(node.value || '')
    }));

    const bodyText = normalize(document.body.innerText || '');
    const matchedFileNames = expected.filter(name => bodyText.toLowerCase().includes(name));
    const inputMatchedFileNames = expected.filter(name => fileInputs.some(item => String(item.value || '').toLowerCase().includes(name)));
    const attachmentHints = Array.from(document.querySelectorAll('button, div, span, a'))
      .filter(isVisible)
      .map(node => normalize(node.innerText || ''))
      .filter(text => {
        if (!text) return false;
        const lower = text.toLowerCase();
        if (expected.some(name => lower.includes(name))) return true;
        return /upload from computer|upload files?|add photos? & files|attachments?|uploaded|uploading|remove|drag and drop|附件|上传|已上传|文件|图片|照片/i.test(lower);
      })
      .slice(0, 40);

    const previewImageCount = Array.from(document.querySelectorAll('img'))
      .filter(node => isVisible(node))
      .filter(node => {
        const src = String(node.currentSrc || node.getAttribute('src') || '');
        return src.startsWith('blob:') || src.startsWith('data:image/');
      })
      .length;

    const removeButtonCount = Array.from(document.querySelectorAll('button'))
      .filter(isVisible)
      .filter(node => {
        const label = normalize(node.getAttribute('aria-label') || node.innerText || '').toLowerCase();
        return /remove|delete|移除|删除/.test(label);
      })
      .length;

    return {
      actionCandidates,
      fileInputs,
      matchedFileNames,
      inputMatchedFileNames,
      attachmentHints,
      previewImageCount,
      removeButtonCount,
      bodyPreview: bodyText.slice(0, 500)
    };
  }, expectedFileNames).catch(() => ({
    actionCandidates: [],
    fileInputs: [],
    matchedFileNames: [],
    inputMatchedFileNames: [],
    attachmentHints: [],
    previewImageCount: 0,
    removeButtonCount: 0,
    bodyPreview: ''
  }));
}

async function captureDebugState(name, options = {}) {
  try {
    return await api.capture(name, {
      screenshot: options.screenshot !== false,
      text: options.text !== false,
      html: !!options.html,
      fullPage: !!options.fullPage
    });
  } catch (e) {
    log('capture failed', {
      name,
      error: e && e.message ? e.message : String(e || '')
    });
    return null;
  }
}

async function buildAttachmentPayloads(attachments) {
  const payloads = [];
  const resolved = [];
  const errors = [];

  for (const att of attachments || []) {
    try {
      const saved = await helpers.files.resolve(att, { prefix: 'attach' });
      const fileObject = await helpers.files.fromPath(saved.path, {
        fileName: saved.fileName,
        mimeType: saved.mimeType
      });
      if (!fileObject || typeof fileObject.base64 !== 'string') {
        throw new Error('helpers.files.fromPath did not return base64 payload');
      }
      payloads.push({
        name: saved.fileName,
        mimeType: saved.mimeType || fileObject.mimeType || 'application/octet-stream',
        buffer: Buffer.from(fileObject.base64, 'base64')
      });
      resolved.push({
        path: saved.path,
        fileName: saved.fileName,
        mimeType: saved.mimeType || fileObject.mimeType || 'application/octet-stream'
      });
    } catch (e) {
      errors.push(e && e.message ? e.message : String(e || 'resolve failed'));
    }
  }

  return { payloads, resolved, errors };
}

function normalizeAttachmentMimeType(mimeType) {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

function attachmentExtension(fileName) {
  const name = String(fileName || '').trim().toLowerCase();
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index) : '';
}

function acceptTokenMatchesFile(token, filePayload) {
  const normalizedToken = String(token || '').trim().toLowerCase();
  if (!normalizedToken || normalizedToken === '*/*') return true;

  const mimeType = normalizeAttachmentMimeType(filePayload && filePayload.mimeType);
  const ext = attachmentExtension(filePayload && filePayload.name);

  if (normalizedToken.startsWith('.')) {
    return normalizedToken === ext;
  }
  if (normalizedToken.endsWith('/*')) {
    return mimeType.startsWith(normalizedToken.slice(0, -1));
  }
  return mimeType === normalizedToken;
}

function scoreFileInputAccept(accept, filePayloads) {
  const tokens = String(accept || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);

  if (!tokens.length) return 70;

  let score = 0;
  for (const filePayload of filePayloads || []) {
    let matched = false;
    for (const token of tokens) {
      if (!acceptTokenMatchesFile(token, filePayload)) continue;
      matched = true;
      if (token === '*/*') score += 60;
      else if (token.endsWith('/*')) score += 80;
      else score += 100;
      break;
    }
    if (!matched) return -1;
  }

  return score;
}

async function trySetFilesOnExistingInput(filePayloads) {
  const fileInputs = page.locator('input[type="file"]');
  const count = await fileInputs.count().catch(() => 0);
  const inputState = await inspectAttachmentUi((filePayloads || []).map(item => item.name || ''));
  const candidates = (inputState.fileInputs || [])
    .map(item => ({
      ...item,
      score: scoreFileInputAccept(item.accept, filePayloads),
      visibilityScore: item.visible ? 1 : 0
    }))
    .filter(item => item.index >= 0 && item.index < count)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.visibilityScore !== a.visibilityScore) return b.visibilityScore - a.visibilityScore;
      return a.index - b.index;
    });
  let lastError = null;

  for (const candidate of candidates) {
    if (candidate.score < 0) continue;
    try {
      await fileInputs.nth(candidate.index).setInputFiles(filePayloads, { timeout: 8000 });
      return {
        ok: true,
        strategy: 'input',
        index: candidate.index,
        count,
        accept: candidate.accept,
        visible: candidate.visible,
        score: candidate.score
      };
    } catch (e) {
      lastError = e && e.message ? e.message : String(e || 'setInputFiles failed');
    }
  }

  return {
    ok: false,
    strategy: 'input',
    count,
    error: lastError,
    candidates
  };
}

async function tryUploadMenuAction(filePayloads) {
  const candidates = [
    { label: 'menuitem:upload-from-computer', locator: page.getByRole('menuitem', { name: /upload from computer/i }).first() },
    { label: 'button:upload-from-computer', locator: page.getByRole('button', { name: /upload from computer/i }).first() },
    { label: 'text:upload-from-computer', locator: page.getByText(/upload from computer/i).first() },
    { label: 'menuitem:upload-files', locator: page.getByRole('menuitem', { name: /upload files?/i }).first() },
    { label: 'button:upload-files', locator: page.getByRole('button', { name: /upload files?/i }).first() },
    { label: 'text:upload-files', locator: page.getByText(/upload files?|add photos? & files|upload photos?/i).first() },
    { label: 'text:upload-cn', locator: page.getByText(/从电脑上传|上传文件|上传图片|添加照片和文件/i).first() }
  ];

  for (const candidate of candidates) {
    const count = await candidate.locator.count().catch(() => 0);
    if (count <= 0) continue;
    try {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
      await candidate.locator.click({ timeout: 5000 }).catch(() => null);
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(filePayloads);
        return { ok: true, strategy: 'filechooser', label: candidate.label };
      }

      const inputResult = await trySetFilesOnExistingInput(filePayloads);
      if (inputResult.ok) {
        return {
          ok: true,
          strategy: 'menu-then-input',
          label: candidate.label,
          inputIndex: inputResult.index,
          inputCount: inputResult.count
        };
      }
    } catch (e) {
      log('menu upload candidate failed', {
        label: candidate.label,
        error: e && e.message ? e.message : String(e || '')
      });
    }
  }

  return { ok: false, strategy: 'menu', error: 'no upload menu action succeeded' };
}

async function waitForAttachmentConfirmation(expectedFileNames, baselineState, maxMs = 20000) {
  const start = Date.now();
  let lastSignature = '';

  while (Date.now() - start < maxMs) {
    const state = await inspectAttachmentUi(expectedFileNames);
    const signature = JSON.stringify({
      matchedFileNames: state.matchedFileNames,
      inputMatchedFileNames: state.inputMatchedFileNames,
      attachmentHints: state.attachmentHints.slice(0, 8),
      previewImageCount: state.previewImageCount,
      removeButtonCount: state.removeButtonCount,
      fileInputs: state.fileInputs.map(item => ({ index: item.index, value: item.value }))
    });

    if (signature !== lastSignature) {
      lastSignature = signature;
      log('attachment ui state', state);
    }

    const allInText = expectedFileNames.length > 0 && state.matchedFileNames.length >= expectedFileNames.length;
    const allInInputs = expectedFileNames.length > 0 && state.inputMatchedFileNames.length >= expectedFileNames.length;
    const hintedText = state.attachmentHints.join(' || ').toLowerCase();
    const allInHints = expectedFileNames.length > 0 && expectedFileNames.every(name => hintedText.includes(String(name).toLowerCase()));
    const previewIncreased = state.previewImageCount > (baselineState && baselineState.previewImageCount || 0);
    const removeButtonsIncreased = state.removeButtonCount > (baselineState && baselineState.removeButtonCount || 0);

    if (allInText || allInInputs || allInHints || previewIncreased || removeButtonsIncreased) {
      return { ok: true, state };
    }

    await page.waitForTimeout(500).catch(() => null);
  }

  return { ok: false, state: await inspectAttachmentUi(expectedFileNames) };
}

async function detectAttachmentUploadError() {
  return await page.evaluate(() => {
    const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
    const text = normalize(document.body.innerText || '');
    const lowered = text.toLowerCase();
    const phrases = [
      'unknown error occurred',
      'failed to upload',
      'upload failed',
      '出现未知错误',
      '上传失败'
    ];
    const matched = phrases.filter(phrase => lowered.includes(phrase));
    return {
      hasError: matched.length > 0,
      matched,
      preview: text.slice(0, 800)
    };
  }).catch(() => ({
    hasError: false,
    matched: [],
    preview: ''
  }));
}

async function waitForAttachmentTransferReady(expectedFileNames, baselineState, maxMs = 30000) {
  const start = Date.now();
  let lastSignature = '';

  while (Date.now() - start < maxMs) {
    const confirmation = await waitForAttachmentConfirmation(expectedFileNames, baselineState, 500).catch(() => ({ ok: false, state: null }));
    const sendState = await sampleSendState();
    const networkState = snapshotUploadNetwork();
    const uploadError = await detectAttachmentUploadError();
    const idleMs = networkState.lastEventAt ? (Date.now() - networkState.lastEventAt) : (Date.now() - start);
    const sendReady = sendState.sendButton
      ? sendState.sendButton.visible && !sendState.sendButton.disabled
      : !!sendState.composerText;
    const networkSettled = (networkState.pending.length === 0 && idleMs >= 1500)
      || (confirmation.ok && idleMs >= 3000);

    const signature = JSON.stringify({
      confirmationOk: confirmation.ok,
      matchedFileNames: confirmation.state && confirmation.state.matchedFileNames || [],
      pending: networkState.pending.map(item => ({ id: item.id, method: item.method, url: item.url, status: item.status || null })),
      totalEvents: networkState.totalEvents,
      idleMs,
      sendReady,
      sendButton: sendState.sendButton,
      uploadError
    });

    if (signature !== lastSignature) {
      lastSignature = signature;
      log('attachment transfer state', {
        confirmation,
        sendState,
        networkState,
        uploadError,
        idleMs,
        sendReady,
        networkSettled
      });
    }

    if (uploadError.hasError) {
      return {
        ok: false,
        confirmation,
        sendState,
        networkState,
        uploadError,
        idleMs,
        sendReady,
        networkSettled
      };
    }

    if (confirmation.ok && networkSettled) {
      return {
        ok: true,
        confirmation,
        sendState,
        networkState,
        uploadError,
        idleMs,
        sendReady,
        networkSettled
      };
    }

    await page.waitForTimeout(500).catch(() => null);
  }

  const confirmation = await waitForAttachmentConfirmation(expectedFileNames, baselineState, 500).catch(() => ({ ok: false, state: null }));
  const sendState = await sampleSendState();
  const networkState = snapshotUploadNetwork();
  const uploadError = await detectAttachmentUploadError();
  const idleMs = networkState.lastEventAt ? (Date.now() - networkState.lastEventAt) : (Date.now() - start);
  const sendReady = sendState.sendButton
    ? sendState.sendButton.visible && !sendState.sendButton.disabled
    : !!sendState.composerText;

  return {
    ok: false,
    confirmation,
    sendState,
    networkState,
    uploadError,
    idleMs,
    sendReady,
    networkSettled: (networkState.pending.length === 0 && idleMs >= 1500)
      || (confirmation.ok && idleMs >= 3000)
  };
}

async function uploadAttachments(attachments) {
  if (!attachments || !attachments.length) {
    return {
      requested: 0,
      resolved: 0,
      expectedFileNames: [],
      confirmed: true,
      action: null,
      errors: []
    };
  }

  const payloadResult = await buildAttachmentPayloads(attachments);
  const expectedFileNames = payloadResult.resolved.map(item => item.fileName).filter(Boolean);
  await api.step('attachments:start', {
    requested: attachments.length,
    resolved: payloadResult.resolved.length,
    expectedFileNames,
    resolveErrors: payloadResult.errors
  }).catch(() => null);

  log('attachments resolved', {
    resolved: payloadResult.resolved,
    errors: payloadResult.errors
  });

  if (!payloadResult.payloads.length) {
    throw new Error('ATTACHMENTS_RESOLVE_FAILED:' + JSON.stringify({
      requested: attachments.length,
      errors: payloadResult.errors
    }));
  }

  const baselineState = await inspectAttachmentUi(expectedFileNames);
  log('attachment ui before upload', baselineState);
  await captureDebugState('attachments-before', { screenshot: true, text: true, fullPage: false });

  const selectors = [
    'button[aria-label*="Attach"]',
    'button[aria-label*="attach"]',
    'button[aria-label*="上传"]',
    'button[data-testid*="attach"]',
    '[data-testid*="attach"] button',
    'button[aria-label*="Add photos"]',
    'button[aria-label*="files"]'
  ];

  async function trySelectFilesViaButtons(filePayloads) {
    let lastAction = { ok: false, strategy: 'button', error: 'no attach button succeeded' };
    for (let index = 0; index < selectors.length; index += 1) {
      const selector = selectors[index];
      const button = page.locator(selector).first();
      const count = await button.count().catch(() => 0);
      if (count <= 0) continue;
      try {
        log('attachment button candidate', { selector, index });
        await button.click({ timeout: 5000 }).catch(() => null);
        await page.waitForTimeout(400).catch(() => null);
        await captureDebugState('attachments-open-' + index, { screenshot: true, text: true, fullPage: false });

        lastAction = await trySetFilesOnExistingInput(filePayloads);
        if (lastAction.ok) {
          lastAction.openedBy = selector;
          return lastAction;
        }

        const menuAction = await tryUploadMenuAction(filePayloads);
        if (menuAction.ok) {
          return {
            ...menuAction,
            openedBy: selector
          };
        }
      } catch (e) {
        log('attachment button click failed', {
          selector,
          error: e && e.message ? e.message : String(e || '')
        });
      }
    }

    return lastAction;
  }

  async function selectFiles(filePayloads, options = {}) {
    const preferOpenButton = !!options.preferOpenButton;

    if (preferOpenButton) {
      const viaButtonsFirst = await trySelectFilesViaButtons(filePayloads);
      if (viaButtonsFirst.ok) return viaButtonsFirst;
    }

    let currentAction = await trySetFilesOnExistingInput(filePayloads);
    if (currentAction.ok) return currentAction;

    const viaButtons = await trySelectFilesViaButtons(filePayloads);
    if (viaButtons.ok) return viaButtons;

    return currentAction;
  }

  async function uploadBatch(filePayloads, batchFileNames, batchBaselineState, batchLabel, batchOptions = {}) {
    resetUploadNetworkTracking();
    uploadNetwork.active = true;
    uploadNetwork.startedAt = Date.now();

    let batchAction = { ok: false, attempt: null, errors: [] };
    let batchTransferReady = null;
    try {
      batchAction = await selectFiles(filePayloads, batchOptions);
      log('attachment action result', {
        label: batchLabel,
        action: batchAction,
        expectedFileNames: batchFileNames
      });
      batchTransferReady = await waitForAttachmentTransferReady(batchFileNames, batchBaselineState, 30000);
      log('attachment transfer ready result', {
        label: batchLabel,
        ...batchTransferReady
      });
      log('attachment network summary', {
        label: batchLabel,
        ...snapshotUploadNetwork()
      });
    } finally {
      uploadNetwork.active = false;
    }

    return {
      label: batchLabel,
      action: batchAction,
      transferReady: batchTransferReady,
      networkState: snapshotUploadNetwork()
    };
  }

  let action = { ok: false, attempt: null, errors: [] };
  let transferReady = null;
  let currentBaselineState = baselineState;
  const batchResults = [];

  if (payloadResult.payloads.length > 1) {
    for (let index = 0; index < payloadResult.payloads.length; index += 1) {
      const batchLabel = 'item-' + (index + 1);
      const filePayload = payloadResult.payloads[index];
      const fileName = payloadResult.resolved[index] && payloadResult.resolved[index].fileName || ('attachment-' + (index + 1));
      await api.step('attachments:item', {
        index: index + 1,
        total: payloadResult.payloads.length,
        fileName
      }).catch(() => null);

      const batchResult = await uploadBatch(
        [filePayload],
        [fileName],
        currentBaselineState,
        batchLabel,
        { preferOpenButton: index > 0 }
      );
      batchResults.push(batchResult);
      action = batchResult.action;
      transferReady = batchResult.transferReady;

      const batchOk = batchResult.action && batchResult.action.ok && batchResult.transferReady && batchResult.transferReady.ok;
      if (!batchOk) {
        break;
      }

      currentBaselineState = batchResult.transferReady.confirmation && batchResult.transferReady.confirmation.state
        ? batchResult.transferReady.confirmation.state
        : currentBaselineState;
      await page.waitForTimeout(600).catch(() => null);
    }
  } else {
    const batchResult = await uploadBatch(payloadResult.payloads, expectedFileNames, currentBaselineState, 'batch');
    batchResults.push(batchResult);
    action = batchResult.action;
    transferReady = batchResult.transferReady;
  }

  await captureDebugState('attachments-after', { screenshot: true, text: true, fullPage: false });

  if (!action.ok || !transferReady || !transferReady.ok) {
    throw new Error('ATTACHMENTS_NOT_CONFIRMED:' + JSON.stringify({
      action,
      expectedFileNames,
      resolved: payloadResult.resolved,
      resolveErrors: payloadResult.errors,
      baselineState,
      transferReady,
      networkState: snapshotUploadNetwork(),
      batchResults
    }));
  }

  await api.step('attachments:confirmed', {
    expectedFileNames,
    action,
    transferReady,
    batchResults
  }).catch(() => null);

  return {
    requested: attachments.length,
    resolved: payloadResult.resolved.length,
    expectedFileNames,
    confirmed: true,
    action,
    transferReady,
    batchResults,
    errors: payloadResult.errors
  };
}

async function resolvePointers(pointers, conversationId) {
  const results = [];
  const seen = new Set();
  for (const p of pointers) {
    const key = p.type + ":" + p.id;
    if (seen.has(key)) continue; seen.add(key);
    let dl = "";
    try {
      if (p.type === "file-service") {
        const r = await page.request.get("https://chatgpt.com/backend-api/files/" + p.id + "/download", { timeout: 30000 });
        if (r.ok()) {
          const j = await r.json().catch(() => ({}));
          dl = j.download_url || j.url || "";
        }
      } else if (p.type === "sediment" && conversationId) {
        const r = await page.request.get("https://chatgpt.com/backend-api/conversation/" + conversationId + "/attachment/" + p.id + "/download", { timeout: 30000 });
        if (r.ok()) {
          const j = await r.json().catch(() => ({}));
          dl = j.download_url || j.url || "";
        }
      }
    } catch (e) {}
    if (!dl) continue;
    try {
      const imgR = await page.request.get(dl, { timeout: 90000 });
      if (imgR.ok()) {
        const buf = await imgR.body();
        const saved = await api.saveFile({
          relativePath: "images/chatgpt_img_" + Date.now() + "_" + p.id.slice(0,8) + ".png",
          content: buf,
          mimeType: "image/png"
        });
        results.push({ url: saved.url, pointerType: p.type, id: p.id });
      }
    } catch (e) {}
  }
  return results;
}

function imageMimeToExtension(mimeType) {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  return 'bin';
}

function mimeTypeToExtension(mimeType) {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!normalized) return 'bin';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'application/json') return 'json';
  if (normalized === 'text/csv') return 'csv';
  if (normalized === 'text/plain') return 'txt';
  if (normalized === 'text/markdown') return 'md';
  if (normalized === 'application/zip') return 'zip';
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (normalized === 'application/vnd.ms-excel') return 'xls';
  if (normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (normalized === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  return normalized.split('/')[1] || 'bin';
}

function sanitizeFileName(fileName, fallback = 'file.bin') {
  const value = String(fileName || '').trim().replace(/[\\/:*?"<>|]+/g, '_');
  return value || fallback;
}

function extractFileNameFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const fn = url.searchParams.get('fn');
    if (fn) return fn;
    const sandboxPath = url.searchParams.get('sandbox_path');
    if (sandboxPath) {
      const parts = String(sandboxPath).split('/').filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    const pathName = url.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(pathName);
  } catch {
    return '';
  }
}

function extractFileNameFromArtifact(artifact) {
  if (!artifact) return '';
  const rawCandidates = [
    artifact.fileName,
    artifact.download,
    artifact.aria,
    artifact.text,
    artifact.outerHTML
  ].filter(Boolean).map(item => String(item));

  for (const raw of rawCandidates) {
    const text = raw.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim();
    const lowered = text.toLowerCase();
    const withoutPrefix = lowered.startsWith('下载 ') ? text.slice(3).trim() : text;
    const match = withoutPrefix.match(/([A-Za-z0-9_()\\-\\. ]+\\.(json|csv|zip|txt|md|pdf|xlsx?|docx?|pptx?))/i);
    if (match && match[1]) {
      return match[1].replace(/\\s+/g, ' ').trim();
    }
  }
  return '';
}

function fileNameFromSandboxPath(value) {
  const text = String(value || '').trim();
  const normalized = text.replace(/^sandbox:/i, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function extractSandboxPathsFromProtocolHints(hints) {
  const out = [];
  const seen = new Set();
  for (const item of hints || []) {
    const preview = String(item && item.preview || '');
    const matches = preview.match(/(?:sandbox:)?\\/mnt\\/data\\/[^\\s'"\\])>]+/g) || [];
    for (const raw of matches) {
      const normalized = raw.replace(/^sandbox:/i, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

async function discoverPageAccessToken() {
  return await page.evaluate(async () => {
    const result = {
      token: '',
      tokenSource: '',
      sessionPreview: '',
      sessionError: '',
      localStorageKeys: [],
      sessionStorageKeys: []
    };

    try {
      result.localStorageKeys = Object.keys(window.localStorage || {});
    } catch {}
    try {
      result.sessionStorageKeys = Object.keys(window.sessionStorage || {});
    } catch {}

    const pickToken = value => {
      if (!value) return '';
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^eyJ/i.test(trimmed) || trimmed.length > 20) return trimmed;
        return '';
      }
      if (typeof value === 'object') {
        for (const key of ['accessToken', 'access_token', 'token', 'bearerToken']) {
          const nested = pickToken(value[key]);
          if (nested) return nested;
        }
      }
      return '';
    };

    try {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
      const text = await response.text();
      result.sessionPreview = text.slice(0, 500);
      try {
        const payload = JSON.parse(text);
        const token = pickToken(payload);
        if (token) {
          result.token = token;
          result.tokenSource = 'api/auth/session';
        }
      } catch {}
    } catch (error) {
      result.sessionError = error && error.message ? error.message : String(error || '');
    }

    if (!result.token) {
      const stores = [
        { name: 'localStorage', store: window.localStorage },
        { name: 'sessionStorage', store: window.sessionStorage }
      ];
      for (const { name, store } of stores) {
        if (!store) continue;
        for (const key of Object.keys(store)) {
          const raw = store.getItem(key);
          const token = pickToken(raw);
          if (token) {
            result.token = token;
            result.tokenSource = name + ':' + key;
            break;
          }
          try {
            const parsed = JSON.parse(raw);
            const nestedToken = pickToken(parsed);
            if (nestedToken) {
              result.token = nestedToken;
              result.tokenSource = name + ':' + key;
              break;
            }
          } catch {}
        }
        if (result.token) break;
      }
    }

    return result;
  }).catch(() => ({
    token: '',
    tokenSource: '',
    sessionPreview: '',
    sessionError: 'evaluate-failed',
    localStorageKeys: [],
    sessionStorageKeys: []
  }));
}

function parseFileNameFromContentDisposition(contentDisposition) {
  const value = String(contentDisposition || '');
  const starMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (starMatch && starMatch[1]) {
    try {
      return decodeURIComponent(starMatch[1]);
    } catch {
      return starMatch[1];
    }
  }
  const match = value.match(/filename="?([^";]+)"?/i);
  return match && match[1] ? match[1] : '';
}

function parseAssetPointer(value) {
  const text = String(value || '').trim();
  const fileMatch = text.match(/^file-service:\\/\\/([A-Za-z0-9_-]+)/i);
  if (fileMatch) return { type: 'file-service', id: fileMatch[1] };
  const sedimentMatch = text.match(/^sediment:\\/\\/([A-Za-z0-9_-]+)/i);
  if (sedimentMatch) return { type: 'sediment', id: sedimentMatch[1] };
  return null;
}

async function collectDomImageCandidates() {
  return await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const nodes = Array.from(document.querySelectorAll('img'));
    for (const node of nodes) {
      if (!(node.offsetWidth || node.offsetHeight)) continue;
      const src = String(node.currentSrc || node.getAttribute('src') || '').trim();
      if (!src || seen.has(src)) continue;
      const width = Number(node.naturalWidth || node.width || 0);
      const height = Number(node.naturalHeight || node.height || 0);
      const alt = String(node.getAttribute('alt') || '').trim();
      const messageNode = node.closest('[data-message-author-role]');
      const role = String(messageNode && messageNode.getAttribute('data-message-author-role') || '').trim().toLowerCase();
      const buttonNode = node.closest('button');
      const buttonAria = String(buttonNode && buttonNode.getAttribute('aria-label') || '').trim();
      const likelyGenerated = (
        role === 'assistant'
        && width >= 64
        && height >= 64
        && (
          src.includes('/backend-api/estuary/content')
          || src.startsWith('blob:')
          || src.startsWith('data:image/')
          || alt.toLowerCase().includes('generated image')
          || buttonAria.toLowerCase().includes('open image')
        )
      ) || (
        width >= 64
        && height >= 64
        && alt.toLowerCase().includes('generated image')
      );
      if (!likelyGenerated) continue;
      seen.add(src);
      out.push({ src, alt, width, height, role, buttonAria });
    }
    return out;
  }).catch(() => []);
}

async function inspectVisibleImages() {
  return await page.evaluate(() => {
    const out = [];
    const nodes = Array.from(document.querySelectorAll('img'));
    for (const node of nodes) {
      if (!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)) continue;
      const src = String(node.currentSrc || node.getAttribute('src') || '').trim();
      const width = Number(node.naturalWidth || node.width || 0);
      const height = Number(node.naturalHeight || node.height || 0);
      const alt = String(node.getAttribute('alt') || '').trim();
      const messageNode = node.closest('[data-message-author-role]');
      const role = String(messageNode && messageNode.getAttribute('data-message-author-role') || '').trim().toLowerCase();
      const buttonNode = node.closest('button');
      const buttonAria = String(buttonNode && buttonNode.getAttribute('aria-label') || '').trim();
      out.push({ src, alt, width, height, role, buttonAria });
    }
    return out.slice(0, 30);
  }).catch(() => []);
}

async function inspectAssistantFileArtifacts() {
  return await page.evaluate(() => {
    const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = node => !!(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const looksFileLike = text => /\.(csv|json|zip|txt|md|pdf|xlsx?|docx?|pptx?)\b/i.test(text);
    const looksDownloadLike = text => /download|open file|file|attachment|下载|文件/i.test(text);
    const out = [];
    const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter(isVisible);
    for (const message of messages) {
      const messageId = String(message.getAttribute('data-message-id') || '');
      const candidates = Array.from(message.querySelectorAll('a, button'));
      for (const node of candidates) {
        if (!isVisible(node)) continue;
        const text = normalize(node.innerText || '');
        const aria = String(node.getAttribute('aria-label') || '').trim();
        const href = node.tagName.toLowerCase() === 'a' ? String(node.getAttribute('href') || '').trim() : '';
        const download = String(node.getAttribute('download') || '').trim();
        const combined = [text, aria, href, download].join(' ');
        if (!combined || (!looksFileLike(combined) && !looksDownloadLike(combined))) continue;
        out.push({
          kind: node.tagName.toLowerCase(),
          messageId,
          text,
          aria,
          href,
          download,
          testId: String(node.getAttribute('data-testid') || '').trim(),
          className: String(node.getAttribute('class') || '').trim(),
          role: String(node.getAttribute('role') || '').trim()
        });
      }

      const textNodes = Array.from(message.querySelectorAll('div, span, p, li'));
      for (const node of textNodes) {
        if (!isVisible(node)) continue;
        const text = normalize(node.innerText || '');
        if (!text || (!looksFileLike(text) && !looksDownloadLike(text))) continue;
        out.push({
          kind: 'text',
          messageId,
          text: text.slice(0, 300),
          aria: '',
          href: '',
          download: '',
          testId: '',
          className: String(node.getAttribute('class') || '').trim(),
          role: String(node.getAttribute('role') || '').trim()
        });
      }
    }
    return out.slice(0, 60);
  }).catch(() => []);
}

async function inspectAssistantFileArtifactsDetailed() {
  return await page.evaluate(() => {
    const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = node => !!(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const looksFileLike = text => /\.(csv|json|zip|txt|md|pdf|xlsx?|docx?|pptx?)\b/i.test(text);
    const looksDownloadLike = text => /download|open file|file|attachment|下载|文件/i.test(text);
    const out = [];
    const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter(isVisible);
    for (const message of messages) {
      const messageId = String(message.getAttribute('data-message-id') || '');
      const candidates = Array.from(message.querySelectorAll('a, button, [role="button"]'));
      for (const node of candidates) {
        if (!isVisible(node)) continue;
        const text = normalize(node.innerText || '');
        const aria = String(node.getAttribute('aria-label') || '').trim();
        const href = node.tagName.toLowerCase() === 'a' ? String(node.getAttribute('href') || '').trim() : '';
        const download = String(node.getAttribute('download') || '').trim();
        const combined = [text, aria, href, download].join(' ');
        if (!combined || (!looksFileLike(combined) && !looksDownloadLike(combined))) continue;
        const parent = node.parentElement;
        out.push({
          kind: node.tagName.toLowerCase(),
          messageId,
          text,
          aria,
          href,
          download,
          testId: String(node.getAttribute('data-testid') || '').trim(),
          className: String(node.getAttribute('class') || '').trim(),
          role: String(node.getAttribute('role') || '').trim(),
          outerHTML: String(node.outerHTML || '').slice(0, 1500),
          parentHTML: String(parent && parent.outerHTML || '').slice(0, 2000)
        });
      }
    }
    return out.slice(0, 20);
  }).catch(() => []);
}

function looksLikeFileArtifactText(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return /download|open file|file|attachment|下载|文件/.test(text)
    || /\.(csv|json|zip|txt|md|pdf|xlsx?|docx?|pptx?)\b/.test(text);
}

function messageTextFromConversationMessage(message) {
  const content = message && message.content || {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const texts = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') {
      texts.push(part.text);
      continue;
    }
    if (typeof part.content === 'string') {
      texts.push(part.content);
    }
  }
  return texts.join('');
}

async function fetchConversationDetail(conversationId) {
  if (!conversationId) return null;
  try {
    const r = await page.request.get('https://chatgpt.com/backend-api/conversation/' + conversationId, {
      timeout: 30000,
      headers: { Accept: 'application/json' }
    });
    if (!r.ok()) return null;
    return await r.json();
  } catch (e) {
    log('fetch conversation detail failed', {
      conversationId,
      error: e && e.message ? e.message : String(e || '')
    });
    return null;
  }
}

function extractAssistantConversationState(data) {
  const mapping = data && data.mapping || {};
  const records = [];
  for (const messageId in mapping) {
    const node = mapping[messageId] || {};
    const message = node.message || {};
    const author = message.author || {};
    if (String(author.role || '').trim().toLowerCase() !== 'assistant') continue;
    const metadata = message.metadata || {};
    const content = message.content || {};
    const attachments = Array.isArray(metadata.attachments)
      ? metadata.attachments.map(item => ({
        id: String(item && item.id || ''),
        name: String(item && item.name || ''),
        mimeType: String(item && item.mimeType || ''),
        size: Number(item && item.size || 0)
      })).filter(item => item.id || item.name)
      : [];
    const assetPointers = [];
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const pointer = parseAssetPointer(part.asset_pointer);
      if (pointer && !assetPointers.some(item => item.type === pointer.type && item.id === pointer.id)) {
        assetPointers.push(pointer);
      }
    }
    records.push({
      messageId,
      createTime: Number(message.create_time || 0),
      status: String(message.status || ''),
      endTurn: message.end_turn === true,
      text: String(messageTextFromConversationMessage(message) || ''),
      attachments,
      assetPointers
    });
  }
  records.sort((a, b) => a.createTime - b.createTime);
  return {
    latest: records.length ? records[records.length - 1] : null,
    records
  };
}

async function pollConversationAssistantState(conversationId, maxMs = 30000) {
  if (!conversationId) return null;
  const start = Date.now();
  let lastState = null;
  let lastSignature = '';
  let stableSince = Date.now();
  while (Date.now() - start < maxMs) {
    const data = await fetchConversationDetail(conversationId);
    if (data) {
      const state = extractAssistantConversationState(data);
      lastState = state;
      const latest = state && state.latest || null;
      const text = String(latest && latest.text || '');
      const signature = JSON.stringify({
        text,
        status: latest && latest.status || '',
        endTurn: latest && latest.endTurn || false,
        attachments: latest && latest.attachments || [],
        assetPointers: latest && latest.assetPointers || []
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
        log('conversation detail assistant state', {
          conversationId,
          textLength: text.length,
          status: latest && latest.status || '',
          endTurn: latest && latest.endTurn || false,
          attachmentCount: latest && latest.attachments ? latest.attachments.length : 0,
          assetPointerCount: latest && latest.assetPointers ? latest.assetPointers.length : 0
        });
      }
      const hasMaterial = !!text || !!(latest && latest.attachments && latest.attachments.length) || !!(latest && latest.assetPointers && latest.assetPointers.length);
      const stable = hasMaterial && (Date.now() - stableSince >= 3000);
      const finished = latest && (latest.status === 'finished_successfully' || latest.endTurn === true);
      if (stable && finished) {
        return state;
      }
    }
    await page.waitForTimeout(1500).catch(() => null);
  }
  return lastState;
}

async function resolveConversationFileDownload(pointer, conversationId) {
  const candidateId = String(pointer && pointer.id || '').trim();
  const candidateType = String(pointer && pointer.type || '').trim();
  if (!candidateId) return { url: '', pointerType: candidateType || 'unknown' };

  const attempts = [];
  if (candidateType === 'file-service') {
    attempts.push({ type: 'file-service', url: 'https://chatgpt.com/backend-api/files/' + candidateId + '/download' });
  } else if (candidateType === 'sediment' && conversationId) {
    attempts.push({ type: 'sediment', url: 'https://chatgpt.com/backend-api/conversation/' + conversationId + '/attachment/' + candidateId + '/download' });
  } else {
    attempts.push({ type: 'file-service', url: 'https://chatgpt.com/backend-api/files/' + candidateId + '/download' });
    if (conversationId) {
      attempts.push({ type: 'sediment', url: 'https://chatgpt.com/backend-api/conversation/' + conversationId + '/attachment/' + candidateId + '/download' });
    }
  }

  for (const attempt of attempts) {
    try {
      const response = await page.request.get(attempt.url, { timeout: 30000, headers: { Accept: 'application/json' } });
      if (!response.ok()) continue;
      const data = await response.json().catch(() => ({}));
      const downloadUrl = data.download_url || data.url || '';
      if (downloadUrl) {
        return { url: downloadUrl, pointerType: attempt.type };
      }
    } catch (e) {
      log('conversation file download resolve failed', {
        candidateId,
        pointerType: attempt.type,
        error: e && e.message ? e.message : String(e || '')
      });
    }
  }

  return { url: '', pointerType: candidateType || 'unknown' };
}

async function downloadConversationFileArtifact(downloadUrl, options = {}) {
  if (!downloadUrl) return null;
  try {
    const response = await page.request.get(downloadUrl, { timeout: 120000 });
    if (!response.ok()) return null;
    let buffer = null;
    try {
      const rawBody = await response.body();
      buffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    } catch (bodyError) {
      const textBody = await response.text().catch(() => '');
      buffer = Buffer.from(String(textBody || ''), 'utf8');
      log('download conversation file fell back to text body', {
        downloadUrl,
        error: bodyError && bodyError.message ? bodyError.message : String(bodyError || ''),
        textLength: textBody.length
      });
    }
    const mimeType = String(response.headers()['content-type'] || options.mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const headerFileName = parseFileNameFromContentDisposition(response.headers()['content-disposition'] || '');
    const urlFileName = extractFileNameFromUrl(downloadUrl);
    const preferredName = sanitizeFileName(options.fileName || headerFileName || urlFileName || ('file_' + Date.now() + '.' + mimeTypeToExtension(mimeType)));
    const ext = preferredName.includes('.') ? '' : ('.' + mimeTypeToExtension(mimeType));
    const finalName = sanitizeFileName(preferredName + ext);
    const isTextLike = /^text\\//.test(mimeType) || mimeType === 'application/json' || mimeType === 'application/xml';
    let contentForSave = buffer;
    if (isTextLike) {
      const textBody = await response.text().catch(() => buffer.toString('utf8'));
      contentForSave = String(textBody || '');
    }
    let saved = null;
    try {
      saved = await api.saveFile({
        relativePath: 'files/' + Date.now() + '_' + finalName,
        content: contentForSave,
        mimeType
      });
    } catch (saveError) {
      log('save conversation file failed', {
        downloadUrl,
        mimeType,
        finalName,
        isTextLike,
        isBuffer: Buffer.isBuffer(buffer),
        bufferType: buffer && buffer.constructor ? buffer.constructor.name : typeof buffer,
        bufferLength: buffer && typeof buffer.length === 'number' ? buffer.length : null,
        error: saveError && saveError.message ? saveError.message : String(saveError || '')
      });
      return null;
    }
    return {
      url: saved.url,
      name: finalName,
      mimeType,
      downloadUrl
    };
  } catch (e) {
    log('download conversation file failed', {
      downloadUrl,
      error: e && e.message ? e.message : String(e || '')
    });
    return null;
  }
}

async function resolveAssistantFilesFromConversationState(conversationId, state) {
  const latest = state && state.latest || null;
  if (!latest) return [];

  const candidates = [];
  for (const item of latest.attachments || []) {
    candidates.push({
      id: item.id,
      type: item.id && /^file[-_]/i.test(item.id) ? 'file-service' : 'unknown',
      fileName: item.name,
      mimeType: item.mimeType,
      size: item.size
    });
  }
  for (const pointer of latest.assetPointers || []) {
    const exists = candidates.some(item => item.id === pointer.id && item.type === pointer.type);
    if (!exists) candidates.push({ id: pointer.id, type: pointer.type, fileName: '', mimeType: '', size: 0 });
  }

  const results = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = String(candidate.type || 'unknown') + ':' + String(candidate.id || candidate.fileName || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const resolved = await resolveConversationFileDownload(candidate, conversationId);
    if (!resolved.url) continue;
    const saved = await downloadConversationFileArtifact(resolved.url, {
      fileName: candidate.fileName,
      mimeType: candidate.mimeType
    });
    if (!saved) continue;
    results.push({
      ...saved,
      id: candidate.id,
      pointerType: resolved.pointerType,
      size: candidate.size || 0
    });
  }
  return results;
}

async function resolveDomFileArtifacts(artifacts) {
  const results = [];
  const seen = new Set();
  for (const item of artifacts || []) {
    const href = String(item && item.href || '').trim();
    if (!href) continue;
    if (/^(javascript:|mailto:)/i.test(href)) continue;
    let absoluteUrl = href;
    try {
      absoluteUrl = new URL(href, page.url()).toString();
    } catch {
      absoluteUrl = href;
    }
    if (seen.has(absoluteUrl)) continue;
    seen.add(absoluteUrl);
    const saved = await downloadConversationFileArtifact(absoluteUrl, {
      fileName: item.download || item.text || item.aria || ''
    });
    if (!saved) continue;
    results.push({
      ...saved,
      id: '',
      pointerType: 'dom-link',
      size: 0
    });
  }
  return results;
}

async function probeDomFileArtifactDownload(artifact, maxMs = 8000, options = {}) {
  if (!artifact || !artifact.messageId) {
    return { clicked: false, events: [], downloadUrl: '' };
  }

  const events = [];
  const conversationId = extractSessionId(page.url());
  const fileName = String(options.fileName || extractFileNameFromArtifact(artifact) || '').trim();
  let downloadUrl = '';
  if (!conversationId || !fileName) {
    return { clicked: false, events, downloadUrl: '', fileName };
  }

  const sandboxPath = String(options.sandboxPath || ('/mnt/data/' + fileName)).trim();
  const directUrl = 'https://chatgpt.com/backend-api/conversation/'
    + conversationId
    + '/interpreter/download?message_id='
    + encodeURIComponent(String(artifact.messageId || ''))
    + '&sandbox_path='
    + encodeURIComponent(sandboxPath);

  events.push({
    phase: 'direct-request',
    method: 'GET',
    url: directUrl,
    fileName,
    sandboxPath
  });
  try {
    const doFetch = async (fetchOptions) => await page.evaluate(async ({ url, timeoutMs, authorization }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = { Accept: 'application/json' };
        if (authorization) headers.Authorization = authorization;
        const r = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers,
          signal: controller.signal
        });
        const bodyText = await r.text();
        return {
          ok: r.ok,
          status: r.status,
          contentType: r.headers.get('content-type') || '',
          bodyText
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          contentType: '',
          bodyText: '',
          error: error && error.message ? error.message : String(error || '')
        };
      } finally {
        clearTimeout(timer);
      }
    }, fetchOptions);

    let response = await doFetch({ url: directUrl, timeoutMs: maxMs, authorization: '' });
    events.push({
      phase: 'direct-response',
      status: response.status,
      url: directUrl,
      contentType: response.contentType || '',
      bodyPreview: String(response.bodyText || '').slice(0, 1000),
      error: response.error || ''
    });
    if (!response.ok && response.status === 401) {
      const authState = await discoverPageAccessToken();
      events.push({
        phase: 'auth-discovery',
        tokenFound: !!authState.token,
        tokenSource: authState.tokenSource,
        sessionPreview: String(authState.sessionPreview || '').slice(0, 300),
        sessionError: authState.sessionError || '',
        localStorageKeys: (authState.localStorageKeys || []).slice(0, 20),
        sessionStorageKeys: (authState.sessionStorageKeys || []).slice(0, 20)
      });
      if (authState.token) {
        response = await doFetch({
          url: directUrl,
          timeoutMs: maxMs,
          authorization: 'Bearer ' + authState.token
        });
        events.push({
          phase: 'direct-response-auth',
          status: response.status,
          url: directUrl,
          contentType: response.contentType || '',
          bodyPreview: String(response.bodyText || '').slice(0, 1000),
          error: response.error || ''
        });
      }
    }
    if (response.ok) {
      try {
        const payload = JSON.parse(String(response.bodyText || ''));
        downloadUrl = payload.download_url || payload.url || '';
      } catch {}
    }
  } catch (e) {
    events.push({
      phase: 'direct-error',
      url: directUrl,
      error: e && e.message ? e.message : String(e || '')
    });
  }

  return { clicked: false, events, downloadUrl, fileName };
}

async function fetchBrowserBlobAsDataUrl(src) {
  return await page.evaluate(async imageSrc => {
    try {
      const response = await fetch(imageSrc);
      const blob = await response.blob();
      return await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
      });
    } catch {
      return '';
    }
  }, src).catch(() => '');
}

async function resolveDomImages(candidates) {
  const results = [];
  for (const item of candidates || []) {
    const src = String(item && item.src || '').trim();
    if (!src) continue;
    try {
      let buffer = null;
      let mimeType = 'image/png';
      if (/^https?:\\/\\//i.test(src)) {
        if (src.includes('/backend-api/estuary/content')) {
          const dataUrl = await fetchBrowserBlobAsDataUrl(src);
          const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
          if (match) {
            mimeType = match[1].trim().toLowerCase();
            buffer = Buffer.from(match[2], 'base64');
          }
        }
        if (!buffer || !buffer.length) {
          const response = await page.request.get(src, { timeout: 90000 });
          if (!response.ok()) continue;
          mimeType = response.headers()['content-type'] || mimeType;
          buffer = await response.body();
        }
      } else if (src.startsWith('data:')) {
        const match = /^data:([^;]+);base64,(.+)$/s.exec(src);
        if (!match) continue;
        mimeType = match[1].trim().toLowerCase();
        buffer = Buffer.from(match[2], 'base64');
      } else if (src.startsWith('blob:')) {
        const dataUrl = await fetchBrowserBlobAsDataUrl(src);
        const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
        if (!match) continue;
        mimeType = match[1].trim().toLowerCase();
        buffer = Buffer.from(match[2], 'base64');
      }
      if (!buffer || !buffer.length) continue;
      const ext = imageMimeToExtension(mimeType);
      const saved = await api.saveFile({
        relativePath: 'images/chatgpt_dom_' + Date.now() + '_' + results.length + '.' + ext,
        content: buffer,
        mimeType
      });
      results.push({
        url: saved.url,
        pointerType: 'dom',
        src,
        alt: item.alt || '',
        width: item.width || 0,
        height: item.height || 0
      });
    } catch (e) {}
  }
  return results;
}

async function pollConversationImages(conversationId, maxMs = 180000) {
  const start = Date.now();
  const filePat = /file-service:\\/\\/([A-Za-z0-9_-]+)/g;
  const sedPat = /sediment:\\/\\/([A-Za-z0-9_-]+)/g;
  while (Date.now() - start < maxMs) {
    try {
      const r = await page.request.get("https://chatgpt.com/backend-api/conversation/" + conversationId, {
        timeout: 30000, headers: { Accept: "application/json" }
      });
      if (r.ok()) {
        const data = await r.json();
        const mapping = data.mapping || {};
        const found = [];
        for (const mid in mapping) {
          const m = (mapping[mid] || {}).message || {};
          const author = m.author || {};
          const meta = m.metadata || {};
          if (author.role !== "tool" || meta.async_task_type !== "image_gen") continue;
          const parts = (m.content && m.content.parts) || [];
          for (const part of parts) {
            const txt = typeof part === "string" ? part : (part && part.asset_pointer ? String(part.asset_pointer) : "");
            let m;
            while ((m = filePat.exec(txt)) !== null) found.push({ type: "file-service", id: m[1] });
            filePat.lastIndex = 0;
            while ((m = sedPat.exec(txt)) !== null) found.push({ type: "sediment", id: m[1] });
            sedPat.lastIndex = 0;
          }
        }
        if (found.length > 0) return found;
      }
    } catch (e) {}
    await page.waitForTimeout(3500).catch(() => null);
  }
  return [];
}

async function sampleUiState() {
  return await page.evaluate(() => {
    const composer = document.querySelector('.ProseMirror');
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .filter(node => !!(node.offsetWidth || node.offsetHeight))
      .map(node => ({
        text: (node.innerText || '').slice(0, 300),
        buttons: Array.from(node.querySelectorAll('button')).map(button => ({
          text: (button.innerText || '').trim(),
          aria: button.getAttribute('aria-label') || ''
        })).slice(0, 10)
      }));
    const stop = document.querySelector('[aria-label="Stop answering"], [aria-label="Stop generating"], button[aria-label="Stop answering"], button[aria-label="Stop generating"]');
    return {
      composerVisible: composer ? !!(composer.offsetWidth || composer.offsetHeight) : false,
      dialogs,
      stopVisible: stop ? !!(stop.offsetWidth || stop.offsetHeight) : false,
      streamingCount: document.querySelectorAll('.result-streaming').length,
      bodyTextPreview: (document.body.innerText || '').slice(0, 300)
    };
  }).catch(() => ({
    composerVisible: false,
    dialogs: [],
    stopVisible: false,
    streamingCount: 0,
    bodyTextPreview: ''
  }));
}

async function snapshotVisibleMessages(role) {
  return await page.evaluate(targetRole => {
    return Array.from(document.querySelectorAll('[data-message-author-role]'))
      .filter(node => node.getAttribute('data-message-author-role') === targetRole)
      .filter(node => !!(node.offsetWidth || node.offsetHeight))
      .map(node => ({
        id: node.getAttribute('data-message-id') || '',
        text: (node.innerText || '').trim().slice(0, 500)
      }));
  }, role).catch(() => []);
}

async function sampleNewAssistantText(baselineIds) {
  return await page.evaluate((baseline) => {
    const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const texts = [];
    for (const node of nodes) {
      const id = node.getAttribute('data-message-id');
      if (id && baseline.includes(id)) continue;
      const text = String(node.innerText || '').trim();
      if (text) texts.push(text);
    }
    return texts.join('\\n\\n');
  }, baselineIds).catch(() => '');
}

async function sampleAssistantFileArtifactSummary(baselineIds) {
  return await page.evaluate((baseline) => {
    const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = node => !!(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const looksFileLike = text => /\.(csv|json|zip|txt|md|pdf|xlsx?|docx?|pptx?)\b/i.test(text);
    const looksDownloadLike = text => /download|open file|file|attachment|下载|文件/i.test(text);
    const items = [];
    const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    for (const message of messages) {
      const messageId = String(message.getAttribute('data-message-id') || '');
      if (messageId && baseline.includes(messageId)) continue;
      if (!isVisible(message)) continue;
      const candidates = Array.from(message.querySelectorAll('a, button, [role="button"], div, span, p, li'));
      for (const node of candidates) {
        if (!isVisible(node)) continue;
        const text = normalize(node.innerText || '');
        if (!text) continue;
        if (!looksFileLike(text) && !looksDownloadLike(text)) continue;
        items.push({ messageId, text: text.slice(0, 200), tag: node.tagName.toLowerCase() });
      }
    }
    return {
      count: items.length,
      items: items.slice(0, 20)
    };
  }, baselineIds).catch(() => ({ count: 0, items: [] }));
}

async function sampleSendState() {
  return await page.evaluate(() => {
    const normalize = text => String(text || '').replace(/\\s+/g, ' ').trim();
    const isVisible = node => !!(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const composer = document.querySelector('.ProseMirror');
    const sendButton = document.querySelector('button[data-testid="send-button"]');
    const stop = document.querySelector('[aria-label="Stop answering"], [aria-label="Stop generating"], button[aria-label="Stop answering"], button[aria-label="Stop generating"]');

    return {
      composerText: composer ? normalize(composer.innerText || '') : '',
      sendButton: sendButton ? {
        visible: isVisible(sendButton),
        disabled: !!sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true',
        aria: String(sendButton.getAttribute('aria-label') || ''),
        title: String(sendButton.getAttribute('title') || ''),
        text: normalize(sendButton.innerText || '')
      } : null,
      stopVisible: stop ? isVisible(stop) : false,
      bodyPreview: normalize(document.body.innerText || '').slice(0, 400)
    };
  }).catch(() => ({
    composerText: '',
    sendButton: null,
    stopVisible: false,
    bodyPreview: ''
  }));
}

async function waitForSendReady(maxMs = 15000) {
  const start = Date.now();
  let lastSignature = '';

  while (Date.now() - start < maxMs) {
    const state = await sampleSendState();
    const signature = JSON.stringify({
      composerText: state.composerText.slice(0, 80),
      sendButton: state.sendButton,
      stopVisible: state.stopVisible
    });

    if (signature !== lastSignature) {
      lastSignature = signature;
      log('send ui state', state);
    }

    if (state.sendButton && state.sendButton.visible && !state.sendButton.disabled) {
      return { ok: true, state };
    }
    if (!state.sendButton && state.composerText) {
      return { ok: true, state };
    }

    await page.waitForTimeout(500).catch(() => null);
  }

  return { ok: false, state: await sampleSendState() };
}

async function triggerSendAction(preferClick = false) {
  const composer = page.locator('.ProseMirror').first();
  const sendButton = page.locator('button[data-testid="send-button"]').first();
  const attempts = preferClick
    ? ['click-send-button', 'press-enter']
    : ['press-enter', 'click-send-button'];
  const errors = [];

  for (const attempt of attempts) {
    try {
      if (attempt === 'press-enter') {
        await composer.click({ timeout: 5000 }).catch(() => null);
        await composer.press('Enter', { timeout: 5000 });
      } else {
        await sendButton.click({ timeout: 5000 });
      }
      log('send action attempted', { attempt });
      return { ok: true, attempt, errors };
    } catch (e) {
      const error = e && e.message ? e.message : String(e || 'send failed');
      errors.push({ attempt, error });
      log('send action failed', { attempt, error });
    }
  }

  return { ok: false, attempt: null, errors };
}

async function dismissAnyDialog(options = {}) {
  const allowEscape = options && options.allowEscape === true;
  const hasDialog = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .some(node => !!(node.offsetWidth || node.offsetHeight));
  }).catch(() => false);
  if (!hasDialog) return false;

  const dismissedByButtons = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .filter(node => !!(node.offsetWidth || node.offsetHeight));
    if (!dialogs.length) return false;

    const buttonPrefs = ['Not now', 'Maybe later', 'Skip', 'Close', 'Dismiss', 'Got it', 'Continue', 'Okay', 'OK'];
    for (const dialog of dialogs) {
      const buttons = Array.from(dialog.querySelectorAll('button'));
      for (const pref of buttonPrefs) {
        const button = buttons.find(node => (node.innerText || '').trim() === pref || (node.getAttribute('aria-label') || '').trim() === pref);
        if (button) {
          button.click();
          return true;
        }
      }
      const closeButton = buttons.find(node => {
        const aria = (node.getAttribute('aria-label') || '').toLowerCase();
        const text = (node.innerText || '').trim().toLowerCase();
        return aria.includes('close') || aria.includes('dismiss') || text === '×' || text === 'x';
      });
      if (closeButton) {
        closeButton.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
  if (dismissedByButtons) {
    await page.waitForTimeout(300, { timeout: 1000 }).catch(() => null);
    return true;
  }

  if (!allowEscape) return false;

  const canUseEscape = !(progress && (progress.sendStartedAt !== null || progress.firstProgressAt !== null));
  if (!canUseEscape) return false;

  await page.keyboard.press('Escape').catch(() => null);
  await page.waitForTimeout(300, { timeout: 1000 }).catch(() => null);

  return await page.evaluate(() => {
    return !Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .some(node => !!(node.offsetWidth || node.offsetHeight));
  }).catch(() => false);
}

async function waitUntilPageReady(maxMs = 25000) {
  const start = Date.now();
  let reloaded = false;
  while (Date.now() - start < maxMs) {
    const state = await sampleUiState();
    if (state.dialogs.length > 0) {
      await dismissAnyDialog({ allowEscape: true });
      await page.waitForTimeout(500, { timeout: 1200 }).catch(() => null);
      continue;
    }
    if (state.composerVisible) {
      return { ok: true, state };
    }
    if (!reloaded && Date.now() - start > 8000) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      reloaded = true;
      continue;
    }
    await page.waitForTimeout(1000, { timeout: 1500 }).catch(() => null);
  }
  return { ok: false, state: await sampleUiState() };
}

async function waitForRouteState(expectedSid, maxMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const state = await sampleUiState();
    if (state.dialogs.length > 0) {
      await dismissAnyDialog({ allowEscape: true });
    }

    const currentSid = extractSessionId(page.url());
    const routeReady = expectedSid ? currentSid === expectedSid : !currentSid;
    if (routeReady && state.composerVisible) {
      return { ok: true, state, url: page.url(), currentSid };
    }

    await page.waitForTimeout(400, { timeout: 1000 }).catch(() => null);
  }

  return {
    ok: false,
    state: await sampleUiState(),
    url: page.url(),
    currentSid: extractSessionId(page.url())
  };
}

async function setComposerText(composer, text) {
  const normalizedPrompt = normalizeText(text);
  await composer.click({ timeout: 5000 }).catch(() => null);
  await page.keyboard.press('ControlOrMeta+a', { timeout: 2000 }).catch(() => null);
  await page.keyboard.press('Delete', { timeout: 2000 }).catch(() => null);

  await page.keyboard.insertText(text).catch(async () => {
    await composer.fill(text, { timeout: 30000 }).catch(() => null);
  });

  let currentText = normalizeText(await composer.innerText().catch(() => ''));
  if (!currentText || (normalizedPrompt && !currentText.includes(normalizedPrompt.slice(0, 20)))) {
    await composer.click({ timeout: 5000 }).catch(() => null);
    await page.keyboard.press('ControlOrMeta+a', { timeout: 2000 }).catch(() => null);
    await page.keyboard.press('Delete', { timeout: 2000 }).catch(() => null);
    await page.keyboard.insertText(text).catch(() => null);
    currentText = normalizeText(await composer.innerText().catch(() => ''));
  }

  return currentText;
}

async function waitForSessionHydration(maxMs = 30000) {
  let prevCount = 0;
  let stableSince = Date.now();
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const count = await page.evaluate(() => {
      return document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author-role="user"]').length;
    }).catch(() => 0);
    if (count > prevCount) {
      prevCount = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 3000) {
      return count;
    }
    await page.waitForTimeout(500, { timeout: 1500 }).catch(() => null);
  }
  return prevCount;
}

function makeProgressState() {
  return {
    turnCompleteSeen: false,
    messageStreamCompleteSeen: false,
    doneSeen: false,
    activeTurnId: null,
    activeTopicId: null,
    websocketOpenedCount: 0,
    lastWebsocketOpenAt: null,
    sendStartedAt: null,
    firstProgressAt: null,
    lastProgressAt: null,
    encodedItems: [],
    wsTrace: [],
    // image support (additive, does not affect text path)
    conversationId: null,
    toolInvoked: null,
    imagePointers: []
  };
}

async function waitForWebsocketReady(maxMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (progress.websocketOpenedCount > 0) {
      return true;
    }
    const ui = await sampleUiState();
    if (ui.dialogs.length > 0) {
      await dismissAnyDialog({ allowEscape: true });
    }
    await page.waitForTimeout(500, { timeout: 1500 }).catch(() => null);
  }
  return progress.websocketOpenedCount > 0;
}

const progress = makeProgressState();
const wsHandlers = new Map();

const onWebSocket = ws => {
  progress.websocketOpenedCount += 1;
  progress.lastWebsocketOpenAt = Date.now() - t0;
  const onFrameReceived = payload => {
    try {
      const ts = Date.now() - t0;
      const text = payload.payload.toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      if (!parsed || !Array.isArray(parsed)) return;

      for (const item of parsed) {
        if (item?.type !== 'message') continue;
        const topicId = item.topic_id || '';
        const payloadType = item.payload?.type || '';
        const inner = item.payload?.payload || {};

        if (progress.sendStartedAt !== null && ts < progress.sendStartedAt) continue;

        if (payloadType === 'conversation-turn-stream') {
          const turnId = inner.turn_id || (topicId.startsWith('conversation-turn-') ? topicId.slice('conversation-turn-'.length) : null);
          if (!progress.activeTurnId) {
            progress.activeTurnId = turnId;
            progress.activeTopicId = topicId;
          }
          if (turnId === progress.activeTurnId && typeof inner.encoded_item === 'string') {
            progress.encodedItems.push(inner.encoded_item);
            if (progress.firstProgressAt === null) progress.firstProgressAt = ts;
            progress.lastProgressAt = ts;
            if (inner.encoded_item.includes('[DONE]')) progress.doneSeen = true;
            if (inner.encoded_item.includes('message_stream_complete')) progress.messageStreamCompleteSeen = true;
            if (progress.wsTrace.length < 40) {
              progress.wsTrace.push({ ts, kind: 'stream', topicId, preview: inner.encoded_item.slice(0, 200) });
            }
          }
          continue;
        }

        if (payloadType === 'conversation-turn-complete') {
          const turnId = topicId.startsWith('conversation-turn-') ? topicId.slice('conversation-turn-'.length) : null;
          if (!progress.activeTurnId) {
            progress.activeTurnId = turnId;
            progress.activeTopicId = topicId;
          }
          if (turnId === progress.activeTurnId) {
            progress.turnCompleteSeen = true;
            if (progress.firstProgressAt === null) progress.firstProgressAt = ts;
            progress.lastProgressAt = ts;
            if (progress.wsTrace.length < 40) {
              progress.wsTrace.push({ ts, kind: 'turn-complete', topicId, preview: JSON.stringify(item).slice(0, 220) });
            }
          }

        // image detection from WS (protocol first) immediately after turn-complete handling, inside for (item of parsed)
        try {
          const candidates = [item, inner, item && item.payload && item.payload.payload];
          let detected = false;
          for (const cand of candidates) {
            if (isImageToolEvent(cand)) {
              detected = true;
              const ptrs = extractImagePointers(cand);
              if (Array.isArray(ptrs)) {
                for (const p of ptrs) {
                  if (!p || !p.id) continue;
                  const exists = progress.imagePointers.some(pp => pp.type === p.type && pp.id === p.id);
                  if (!exists) progress.imagePointers.push(p);
                }
              }
            }
          }
          for (const cand of candidates) {
            const cid = extractConversationId(cand);
            if (cid && !progress.conversationId) progress.conversationId = cid;
            const ti = extractToolInvoked(cand);
            if (ti !== null) progress.toolInvoked = ti;
          }
          if (detected && progress.wsTrace.length < 40) {
            progress.wsTrace.push({ ts, kind: "image-tool", topicId, preview: "image_gen tool detected" });
          }
        } catch (e) {}
        }
      }
    } catch {}
  };

  ws.on('framereceived', onFrameReceived);
  wsHandlers.set(ws, onFrameReceived);
};

const onRequest = request => {
  try {
    if (!uploadNetwork.active || !isAttachmentTransferRequest(request)) return;
    const id = 'upload-' + (++uploadNetwork.seq);
    uploadRequestIds.set(request, id);
    const entry = {
      id,
      phase: 'request',
      ts: Date.now() - t0,
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url()
    };
    uploadNetwork.pending.set(id, entry);
    recordUploadNetworkEvent(entry);
  } catch (e) {
    log('upload request tracker failed', {
      error: e && e.message ? e.message : String(e || '')
    });
  }
};

const onResponse = response => {
  try {
    if (!uploadNetwork.active) return;
    const request = response.request();
    const id = uploadRequestIds.get(request);
    if (!id) return;
    const pendingEntry = uploadNetwork.pending.get(id) || {};
    const entry = {
      id,
      phase: 'response',
      ts: Date.now() - t0,
      method: request.method(),
      status: response.status(),
      resourceType: request.resourceType(),
      url: response.url(),
      contentType: response.headers()['content-type'] || ''
    };
    uploadNetwork.pending.set(id, {
      ...pendingEntry,
      status: response.status(),
      contentType: response.headers()['content-type'] || ''
    });
    recordUploadNetworkEvent(entry);
  } catch (e) {
    log('upload response tracker failed', {
      error: e && e.message ? e.message : String(e || '')
    });
  }
};

const onRequestFinished = request => {
  try {
    if (!uploadNetwork.active) return;
    const id = uploadRequestIds.get(request);
    if (!id) return;
    const pendingEntry = uploadNetwork.pending.get(id) || {};
    uploadNetwork.pending.delete(id);
    recordUploadNetworkEvent({
      id,
      phase: 'finished',
      ts: Date.now() - t0,
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      status: pendingEntry.status || null
    });
  } catch (e) {
    log('upload requestfinished tracker failed', {
      error: e && e.message ? e.message : String(e || '')
    });
  }
};

const onRequestFailed = request => {
  try {
    if (!uploadNetwork.active) return;
    const id = uploadRequestIds.get(request);
    if (!id) return;
    uploadNetwork.pending.delete(id);
    recordUploadNetworkEvent({
      id,
      phase: 'failed',
      ts: Date.now() - t0,
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      failure: request.failure() && request.failure().errorText || ''
    });
  } catch (e) {
    log('upload requestfailed tracker failed', {
      error: e && e.message ? e.message : String(e || '')
    });
  }
};

page.on('websocket', onWebSocket);
page.on('request', onRequest);
page.on('response', onResponse);
page.on('requestfinished', onRequestFinished);
page.on('requestfailed', onRequestFailed);

try {
  const requestedSid = String(input.sessionId || '').trim();
  const currentSid = extractSessionId(page.url());
  const target = requestedSid ? HOME_URL + 'c/' + requestedSid : HOME_URL;

  if (!requestedSid) {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  } else if (currentSid === requestedSid) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  } else {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  }

  const ready = await waitUntilPageReady(25000);
  if (!ready.ok) {
    throw new Error('PAGE_NOT_READY:' + JSON.stringify(ready.state));
  }

  if (requestedSid) {
    const routeReady = await waitForRouteState(requestedSid, 12000);
    if (!routeReady.ok) {
      throw new Error('SESSION_ROUTE_NOT_READY:' + JSON.stringify({
        requestedSid,
        url: routeReady.url,
        currentSid: routeReady.currentSid,
        ...routeReady.state
      }));
    }
  }

  await page.waitForTimeout(2000, { timeout: 3000 }).catch(() => null);
  const wsReady = await waitForWebsocketReady(8000);
  log('channel ready', { wsReady, websocketOpenedCount: progress.websocketOpenedCount });

  if (requestedSid) {
    const hydrated = await waitForSessionHydration(30000);
    log('session hydrated', { requestedSid, hydrated });
  }

  const composer = page.locator('.ProseMirror').first();
  const before = (await composer.innerText()).trim();
  if (before) {
    await page.keyboard.press('ControlOrMeta+a', { timeout: 2000 }).catch(() => null);
    await page.keyboard.press('Delete', { timeout: 2000 }).catch(() => null);
  }

  const baselineIds = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-message-author-role="assistant"]').forEach(n => {
      const id = n.getAttribute('data-message-id');
      if (id) out.push(id);
    });
    return out;
  });
  const userMessagesBeforeSend = await snapshotVisibleMessages('user');
  const userCountBeforeSend = userMessagesBeforeSend.length;
  const userIdsBeforeSend = new Set(userMessagesBeforeSend.map(item => item.id).filter(Boolean));

  const composerText = await setComposerText(composer, String(input.prompt || ''));
  log('composer prepared', { composerTextPreview: composerText.slice(0, 120) });
  await dismissAnyDialog();

  if (input.attachments && input.attachments.length) {
    const attached = await uploadAttachments(input.attachments);
    log('attachments processed', attached);
  }

  const attachmentsCount = Array.isArray(input.attachments) ? input.attachments.length : 0;
  const sendReadyTimeoutMs = attachmentsCount > 1
    ? 60000
    : (attachmentsCount > 0 ? 30000 : 12000);
  const sendReady = await waitForSendReady(sendReadyTimeoutMs);
  log('send ready result', sendReady);
  await captureDebugState('before-send', { screenshot: true, text: true, fullPage: false });
  if (!sendReady.ok) {
    throw new Error('SEND_NOT_READY:' + JSON.stringify(sendReady.state || {}));
  }

  progress.sendStartedAt = Date.now() - t0;
  const primarySend = await triggerSendAction(!!(input.attachments && input.attachments.length));
  if (!primarySend.ok) {
    throw new Error('SEND_ACTION_FAILED:' + JSON.stringify({
      sendReady,
      primarySend
    }));
  }
  await dismissAnyDialog();

  const sendConfirmStart = Date.now();
  let userMessageSent = false;
  let retryTriggered = false;
  const promptNeedle = normalizeText(String(input.prompt || '')).slice(0, 80);
  while (Date.now() - sendConfirmStart < 5000) {
    const currentUserMessages = await snapshotVisibleMessages('user');
    const currentUserCount = currentUserMessages.length;
    const hasNewUserMessage = currentUserMessages.some(item => {
      if (item.id && !userIdsBeforeSend.has(item.id)) return true;
      if (currentUserCount <= userCountBeforeSend) return false;
      if (!promptNeedle) return true;
      return normalizeText(item.text).includes(promptNeedle);
    });
    if (hasNewUserMessage) {
      userMessageSent = true;
      break;
    }

    if (!retryTriggered && Date.now() - sendConfirmStart > 2500) {
      const sendState = await sampleSendState();
      log('send confirm retry state', sendState);
      await captureDebugState('send-retry', { screenshot: true, text: true, fullPage: false });
      const retrySend = await triggerSendAction(true);
      log('send retry result', retrySend);
      retryTriggered = true;
    }

    const ui = await sampleUiState();
    if (ui.dialogs.length > 0) {
      await dismissAnyDialog();
    }
    await page.waitForTimeout(300, { timeout: 1000 }).catch(() => null);
  }
  if (!userMessageSent) {
    const ui = await sampleUiState();
    throw new Error('SEND_NOT_EFFECTIVE:' + JSON.stringify(ui));
  }

  if (!requestedSid) {
    const sessionCreateStart = Date.now();
    let sessionCreated = false;
    while (Date.now() - sessionCreateStart < 8000) {
      const ui = await sampleUiState();
      const newSid = extractSessionId(page.url());
      if (newSid || progress.firstProgressAt !== null || ui.stopVisible || ui.streamingCount > 0) {
        sessionCreated = true;
        break;
      }
      if (ui.dialogs.length > 0) {
        await dismissAnyDialog();
      }
      await page.waitForTimeout(300, { timeout: 1000 }).catch(() => null);
    }
    if (!sessionCreated) {
      const ui = await sampleUiState();
      throw new Error('SESSION_NOT_CREATED:' + JSON.stringify({ url: page.url(), ...ui }));
    }
  }

  const waitStart = Date.now();
  while (Date.now() - waitStart < STREAM_WAIT_MS) {
    const ui = await sampleUiState();
    if (ui.dialogs.length > 0) {
      await dismissAnyDialog();
    }

    if (progress.turnCompleteSeen || progress.doneSeen || progress.messageStreamCompleteSeen) {
      break;
    }

    const fileArtifactSummary = await sampleAssistantFileArtifactSummary(baselineIds);
    if (fileArtifactSummary.count > 0 && !ui.stopVisible && ui.streamingCount === 0) {
      log('assistant file artifact detected during stream wait', fileArtifactSummary);
      break;
    }

    if (Date.now() - waitStart > NO_PROGRESS_FAIL_MS && progress.firstProgressAt === null) {
      const domPreview = await sampleNewAssistantText(baselineIds);
      if (!wsReady || ui.stopVisible || ui.streamingCount > 0 || domPreview || fileArtifactSummary.count > 0) {
        log('stream unavailable, switching to dom fallback', {
          wsReady,
          stopVisible: ui.stopVisible,
          streamingCount: ui.streamingCount,
          domPreview: domPreview.slice(0, 120),
          fileArtifactCount: fileArtifactSummary.count
        });
        break;
      }
      throw new Error('NO_STREAM_PROGRESS:' + JSON.stringify(ui));
    }

    await page.waitForTimeout(500, { timeout: 1500 }).catch(() => null);
  }

  let currentText = '';
  const eventTrace = [];
  const protocolFileHints = [];
  for (const chunk of progress.encodedItems) {
    for (const part of chunk.split(/\\n\\n+/)) {
      const lines = part.split(/\\r?\\n/);
      for (const rawLine of lines) {
        let line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('event:')) {
          if (eventTrace.length < 120) eventTrace.push({ type: 'event', value: line.slice(6).trim() });
          continue;
        }
        if (line.startsWith('data:')) line = line.slice(5).trim();
        if (!line) continue;
        if (line === '[DONE]') {
          if (eventTrace.length < 120) eventTrace.push({ type: 'done' });
          continue;
        }
        try {
          const event = JSON.parse(line);
          collectProtocolFileHints(event, 'event', protocolFileHints);
          const aggregateResultCode = event && event.v && event.v.message && event.v.message.metadata && event.v.message.metadata.aggregate_result && event.v.message.metadata.aggregate_result.code;
          if (aggregateResultCode) {
            log('protocol aggregate result', {
              messageId: event.v.message.id || '',
              role: event.v.message.author && event.v.message.author.role || '',
              status: event.v.message.status || '',
              codePreview: String(aggregateResultCode).slice(0, 400)
            });
          }
          const serializedEvent = JSON.stringify(event);
          if (serializedEvent.includes('sandbox:/mnt/data/')) {
            const message = (event && event.v && event.v.message) || event.message || {};
            log('protocol sandbox link event', {
              messageId: message.id || '',
              role: message.author && message.author.role || '',
              status: message.status || '',
              preview: serializedEvent.slice(0, 500)
            });
          }
          const nextText = assistantText(event, currentText);
          if (nextText !== currentText) {
            currentText = nextText;
            if (eventTrace.length < 120) {
              eventTrace.push({ type: 'delta', textLen: currentText.length, preview: currentText.slice(0, 120) });
            }
          } else if (eventTrace.length < 120) {
            eventTrace.push({
              type: 'event',
              eventType: event.type || null,
              o: event.o || null,
              p: event.p || null
            });
          }
          if (event.type === 'message_stream_complete') {
            progress.messageStreamCompleteSeen = true;
          }
        } catch {
          collectProtocolFileHints(line, 'raw', protocolFileHints);
          if (eventTrace.length < 120) eventTrace.push({ type: 'raw', preview: line.slice(0, 120) });
        }
      }
    }
  }
  if (protocolFileHints.length > 0) {
    log('protocol file hints', {
      count: protocolFileHints.length,
      hints: protocolFileHints.slice(0, 20)
    });
  }
  const protocolSandboxPaths = extractSandboxPathsFromProtocolHints(protocolFileHints);
  if (protocolSandboxPaths.length > 0) {
    log('protocol sandbox paths', {
      paths: protocolSandboxPaths.slice(0, 10)
    });
  }

  let domText = '';
  let lastChange = Date.now();
  const domStart = Date.now();
  let lastFileArtifactTs = 0;
  let domFileArtifactDetected = false;
  while (Date.now() - domStart < DOM_FALLBACK_WAIT_MS) {
    const ui = await sampleUiState();
    if (ui.dialogs.length > 0) {
      await dismissAnyDialog();
    }
    const fileArtifactSummary = await sampleAssistantFileArtifactSummary(baselineIds);
    const next = await page.evaluate((baseline) => {
      const out = [];
      document.querySelectorAll('[data-message-author-role="assistant"]').forEach(n => {
        const id = n.getAttribute('data-message-id');
        if (id && !baseline.includes(id)) {
          const text = (n.innerText || '').trim();
          if (text) out.push(text);
        }
      });
      return out.join('\\n\\n');
    }, baselineIds);
    if (next !== domText) {
      domText = next;
      lastChange = Date.now();
    }
    if (fileArtifactSummary.count > 0) {
      if (!lastFileArtifactTs) lastFileArtifactTs = Date.now();
      domFileArtifactDetected = true;
      if (!ui.stopVisible && ui.streamingCount === 0) {
        log('assistant file artifact detected during dom fallback', fileArtifactSummary);
        break;
      }
    } else {
      lastFileArtifactTs = 0;
    }
    if ((progress.turnCompleteSeen || progress.doneSeen || progress.messageStreamCompleteSeen) && Date.now() - lastChange >= 3000) {
      break;
    }
    if (domText && Date.now() - lastChange >= DOM_STABLE_MS) {
      break;
    }
    if (lastFileArtifactTs && Date.now() - lastFileArtifactTs >= 1500) {
      break;
    }
    await page.waitForTimeout(500, { timeout: 1500 }).catch(() => null);
  }

  const resolvedConversationId = progress.conversationId || extractSessionId(page.url()) || requestedSid || null;
  let reply = String(currentText || "").trim() || String(domText || "").trim();
  let source = currentText ? "stream" : "dom_fallback";

  const conversationState = domFileArtifactDetected
    ? null
    : await pollConversationAssistantState(resolvedConversationId, 30000).catch(() => null);
  const conversationReply = String(conversationState && conversationState.latest && conversationState.latest.text || '').trim();
  if (conversationReply) {
    const normalizedReply = normalizeText(reply);
    const normalizedConversationReply = normalizeText(conversationReply);
    const preferConversationReply = !reply
      || normalizedConversationReply.length > normalizedReply.length + 40
      || (normalizedReply && normalizedConversationReply.startsWith(normalizedReply))
      || (/\|.+\|/.test(conversationReply) && conversationReply.length > reply.length);
    if (preferConversationReply) {
      log('conversation detail reply selected', {
        previousSource: source,
        previousLength: reply.length,
        nextLength: conversationReply.length
      });
      reply = conversationReply;
      source = 'conversation_detail';
    }
  }
  const replyLooksFileLike = looksLikeFileArtifactText(reply);

  // Resolve images from WS stream pointers first; fallback to poll if needed
  let images = [];
  let imagesSource = null;
  if (!replyLooksFileLike) {
    try {
      let pointers = Array.isArray(progress.imagePointers) ? progress.imagePointers.slice() : [];
      if ((!pointers || pointers.length === 0) && resolvedConversationId) {
        const polled = await pollConversationImages(resolvedConversationId, 120000).catch(() => []);
        if (Array.isArray(polled) && polled.length > 0) {
          pointers = polled;
          imagesSource = "poll";
        }
      } else if (pointers.length > 0) {
        imagesSource = "stream";
      }
      if (pointers.length > 0) {
        images = await resolvePointers(pointers, resolvedConversationId).catch(() => []);
      }
    } catch (e) {
      // do not break text path on image errors
    }
  } else {
    log('skip image resolution for file-like reply', { reply: reply.slice(0, 120) });
  }

  if ((!images || images.length === 0) && !replyLooksFileLike) {
    const domImageCandidates = await collectDomImageCandidates().catch(() => []);
    if (domImageCandidates.length > 0) {
      log('dom image candidates', {
        count: domImageCandidates.length,
        preview: domImageCandidates.slice(0, 4)
      });
      const domImages = await resolveDomImages(domImageCandidates).catch(() => []);
      if (domImages.length > 0) {
        images = domImages;
        imagesSource = 'dom';
        log('dom images resolved', { count: domImages.length, preview: domImages[0] });
      } else {
        log('dom image resolution produced no files', {
          count: domImageCandidates.length,
          preview: domImageCandidates.slice(0, 4)
        });
      }
    }
  }

  let files = [];
  let visibleArtifacts = [];
  const replyFileName = extractFileNameFromArtifact({ text: reply });
  const preferredSandboxPath = protocolSandboxPaths.find(item => !replyFileName || fileNameFromSandboxPath(item) === replyFileName) || protocolSandboxPaths[0] || '';
  try {
    if (conversationState) {
      files = await resolveAssistantFilesFromConversationState(resolvedConversationId, conversationState).catch(() => []);
      if (files.length > 0) {
        log('conversation files resolved', {
          count: files.length,
          preview: files.slice(0, 4)
        });
      }
    }
  } catch (e) {
    log('resolve conversation files failed', {
      error: e && e.message ? e.message : String(e || '')
    });
  }

  if (files.length === 0 && replyLooksFileLike) {
    visibleArtifacts = await inspectAssistantFileArtifacts().catch(() => []);
    log('visible file artifacts', {
      count: visibleArtifacts.length,
      artifacts: visibleArtifacts.slice(0, 20)
    });
    if (visibleArtifacts.length > 0) {
      const domFiles = await resolveDomFileArtifacts(visibleArtifacts).catch(() => []);
      if (domFiles.length > 0) {
        files = domFiles;
        log('dom files resolved', {
          count: files.length,
          preview: files.slice(0, 4)
        });
      } else {
        const detailedArtifacts = await inspectAssistantFileArtifactsDetailed().catch(() => []);
        log('visible file artifacts detailed', {
          count: detailedArtifacts.length,
          artifacts: detailedArtifacts.slice(0, 10)
        });
        const probeTarget = detailedArtifacts.find(item => item.kind === 'button' || item.kind === 'a' || item.role === 'button') || detailedArtifacts[0] || null;
        if (probeTarget) {
          const probe = await probeDomFileArtifactDownload(probeTarget, 5000, {
            fileName: replyFileName || extractFileNameFromArtifact(probeTarget),
            sandboxPath: preferredSandboxPath
          }).catch(() => ({ clicked: false, events: [], downloadUrl: '', fileName: '' }));
          log('file artifact probe', {
            clicked: probe.clicked,
            downloadUrl: probe.downloadUrl,
            fileName: probe.fileName,
            events: (probe.events || []).slice(0, 20)
          });
          if (probe.downloadUrl) {
            const probedFile = await downloadConversationFileArtifact(probe.downloadUrl, {
              fileName: probe.fileName || probeTarget.download || probeTarget.text || probeTarget.aria || ''
            }).catch(() => null);
            if (probedFile) {
              files = [{
                ...probedFile,
                id: '',
                pointerType: 'dom-probe',
                size: 0
              }];
              log('dom probe file resolved', {
                preview: files[0]
              });
            }
          }
        }
      }
    }
  }

  if (!reply && images.length === 0 && files.length === 0) {
    const visibleImages = await inspectVisibleImages().catch(() => []);
    visibleArtifacts = visibleArtifacts.length > 0 ? visibleArtifacts : await inspectAssistantFileArtifacts().catch(() => []);
    log('empty reply visible images', { count: visibleImages.length, images: visibleImages.slice(0, 12) });
    log('empty reply visible file artifacts', { count: visibleArtifacts.length, artifacts: visibleArtifacts.slice(0, 20) });
    const ui = await sampleUiState();
    throw new Error("EMPTY_REPLY:" + JSON.stringify(ui));
  }

  if (replyLooksFileLike && files.length === 0) {
    throw new Error('FILE_ARTIFACT_NOT_CAPTURED:' + JSON.stringify({
      reply,
      conversationId: resolvedConversationId,
      visibleArtifacts: (visibleArtifacts || []).slice(0, 20)
    }));
  }

  return {
    sessionId: extractSessionId(page.url()) || requestedSid || null,
    url: page.url(),
    title: await page.title().catch(() => ""),
    format: "markdown",
    reply,
    source,
    images,
    imagesSource,
    hasImages: Array.isArray(images) && images.length > 0,
    files,
    hasFiles: Array.isArray(files) && files.length > 0,
    toolInvoked: progress.toolInvoked,
    conversationId: progress.conversationId || extractSessionId(page.url()) || requestedSid || null,
    meta: {
      turnCompleteSeen: progress.turnCompleteSeen,
      messageStreamCompleteSeen: progress.messageStreamCompleteSeen,
      doneSeen: progress.doneSeen,
      activeTurnId: progress.activeTurnId,
      activeTopicId: progress.activeTopicId,
      websocketOpenedCount: progress.websocketOpenedCount,
      encodedItemCount: progress.encodedItems.length,
      protocolFileHints,
      totalMs: Date.now() - t0
    }
  };
} finally {
  if (typeof page.off === 'function') {
    page.off('websocket', onWebSocket);
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onRequestFinished);
    page.off('requestfailed', onRequestFailed);
  }
  for (const [ws, handler] of wsHandlers.entries()) {
    if (typeof ws.off === 'function') {
      ws.off('framereceived', handler);
    }
  }
}
`
};
