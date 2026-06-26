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
  if (!/chatgpt\\.com\//i.test(url)) return false;
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

async function waitForAttachmentTransferReady(expectedFileNames, baselineState, maxMs = 30000) {
  const start = Date.now();
  let lastSignature = '';

  while (Date.now() - start < maxMs) {
    const confirmation = await waitForAttachmentConfirmation(expectedFileNames, baselineState, 500).catch(() => ({ ok: false, state: null }));
    const sendState = await sampleSendState();
    const networkState = snapshotUploadNetwork();
    const idleMs = networkState.lastEventAt ? (Date.now() - networkState.lastEventAt) : (Date.now() - start);
    const sendReady = sendState.sendButton
      ? sendState.sendButton.visible && !sendState.sendButton.disabled
      : !!sendState.composerText;
    const networkSettled = networkState.pending.length === 0 && idleMs >= 1500;

    const signature = JSON.stringify({
      confirmationOk: confirmation.ok,
      matchedFileNames: confirmation.state && confirmation.state.matchedFileNames || [],
      pending: networkState.pending.map(item => ({ id: item.id, method: item.method, url: item.url, status: item.status || null })),
      totalEvents: networkState.totalEvents,
      idleMs,
      sendReady,
      sendButton: sendState.sendButton
    });

    if (signature !== lastSignature) {
      lastSignature = signature;
      log('attachment transfer state', {
        confirmation,
        sendState,
        networkState,
        idleMs,
        sendReady,
        networkSettled
      });
    }

    if (confirmation.ok && networkSettled && sendReady) {
      return {
        ok: true,
        confirmation,
        sendState,
        networkState,
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
  const idleMs = networkState.lastEventAt ? (Date.now() - networkState.lastEventAt) : (Date.now() - start);
  const sendReady = sendState.sendButton
    ? sendState.sendButton.visible && !sendState.sendButton.disabled
    : !!sendState.composerText;

  return {
    ok: false,
    confirmation,
    sendState,
    networkState,
    idleMs,
    sendReady,
    networkSettled: networkState.pending.length === 0 && idleMs >= 1500
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

  resetUploadNetworkTracking();
  uploadNetwork.active = true;
  uploadNetwork.startedAt = Date.now();

  let action = { ok: false, attempt: null, errors: [] };
  let transferReady = null;
  try {
    action = await trySetFilesOnExistingInput(payloadResult.payloads);
    if (!action.ok) {
      const selectors = [
        'button[aria-label*="Attach"]',
        'button[aria-label*="attach"]',
        'button[aria-label*="上传"]',
        'button[data-testid*="attach"]',
        '[data-testid*="attach"] button',
        'button[aria-label*="Add photos"]',
        'button[aria-label*="files"]'
      ];

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

          action = await trySetFilesOnExistingInput(payloadResult.payloads);
          if (action.ok) {
            action.openedBy = selector;
            break;
          }

          const menuAction = await tryUploadMenuAction(payloadResult.payloads);
          if (menuAction.ok) {
            action = {
              ...menuAction,
              openedBy: selector
            };
            break;
          }
        } catch (e) {
          log('attachment button click failed', {
            selector,
            error: e && e.message ? e.message : String(e || '')
          });
        }
      }
    }

    log('attachment action result', action);
    transferReady = await waitForAttachmentTransferReady(expectedFileNames, baselineState, 30000);
    log('attachment transfer ready result', transferReady);
    log('attachment network summary', snapshotUploadNetwork());
  } finally {
    uploadNetwork.active = false;
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
      networkState: snapshotUploadNetwork()
    }));
  }

  await api.step('attachments:confirmed', {
    expectedFileNames,
    action,
    transferReady
  }).catch(() => null);

  return {
    requested: attachments.length,
    resolved: payloadResult.resolved.length,
    expectedFileNames,
    confirmed: true,
    action,
    transferReady,
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
      const likelyGenerated = (width >= 256 && height >= 256)
        && (
          src.includes('/backend-api/estuary/content')
          || src.startsWith('blob:')
          || src.startsWith('data:image/')
          || alt.toLowerCase().includes('generated image')
        );
      if (!likelyGenerated) continue;
      seen.add(src);
      out.push({ src, alt, width, height });
    }
    return out;
  }).catch(() => []);
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
        const response = await page.request.get(src, { timeout: 90000 });
        if (!response.ok()) continue;
        mimeType = response.headers()['content-type'] || mimeType;
        buffer = await response.body();
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

async function dismissAnyDialog() {
  const hasDialog = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .some(node => !!(node.offsetWidth || node.offsetHeight));
  }).catch(() => false);
  if (!hasDialog) return false;

  await page.keyboard.press('Escape').catch(() => null);
  await page.waitForTimeout(300, { timeout: 1000 }).catch(() => null);

  const dismissedByEscape = await page.evaluate(() => {
    return !Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .some(node => !!(node.offsetWidth || node.offsetHeight));
  }).catch(() => false);
  if (dismissedByEscape) return true;

  return await page.evaluate(() => {
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
}

async function waitUntilPageReady(maxMs = 25000) {
  const start = Date.now();
  let reloaded = false;
  while (Date.now() - start < maxMs) {
    const state = await sampleUiState();
    if (state.dialogs.length > 0) {
      await dismissAnyDialog();
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
      await dismissAnyDialog();
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
      await dismissAnyDialog();
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

  const sendReady = await waitForSendReady(input.attachments && input.attachments.length ? 20000 : 12000);
  log('send ready result', sendReady);
  await captureDebugState('before-send', { screenshot: true, text: true, fullPage: false });

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

    if (Date.now() - waitStart > NO_PROGRESS_FAIL_MS && progress.firstProgressAt === null) {
      const domPreview = await sampleNewAssistantText(baselineIds);
      if (!wsReady || ui.stopVisible || ui.streamingCount > 0 || domPreview) {
        log('stream unavailable, switching to dom fallback', {
          wsReady,
          stopVisible: ui.stopVisible,
          streamingCount: ui.streamingCount,
          domPreview: domPreview.slice(0, 120)
        });
        break;
      }
      throw new Error('NO_STREAM_PROGRESS:' + JSON.stringify(ui));
    }

    await page.waitForTimeout(500, { timeout: 1500 }).catch(() => null);
  }

  let currentText = '';
  const eventTrace = [];
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
          if (eventTrace.length < 120) eventTrace.push({ type: 'raw', preview: line.slice(0, 120) });
        }
      }
    }
  }

  let domText = '';
  let lastChange = Date.now();
  const domStart = Date.now();
  while (Date.now() - domStart < DOM_FALLBACK_WAIT_MS) {
    const ui = await sampleUiState();
    if (ui.dialogs.length > 0) {
      await dismissAnyDialog();
    }
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
    if ((progress.turnCompleteSeen || progress.doneSeen || progress.messageStreamCompleteSeen) && Date.now() - lastChange >= 3000) {
      break;
    }
    if (domText && Date.now() - lastChange >= DOM_STABLE_MS) {
      break;
    }
    await page.waitForTimeout(500, { timeout: 1500 }).catch(() => null);
  }

  const reply = String(currentText || "").trim() || String(domText || "").trim();
  const source = currentText ? "stream" : "dom_fallback";

  // Resolve images from WS stream pointers first; fallback to poll if needed
  let images = [];
  let imagesSource = null;
  try {
    let pointers = Array.isArray(progress.imagePointers) ? progress.imagePointers.slice() : [];
    if ((!pointers || pointers.length === 0) && progress.conversationId) {
      const polled = await pollConversationImages(progress.conversationId, 120000).catch(() => []);
      if (Array.isArray(polled) && polled.length > 0) {
        pointers = polled;
        imagesSource = "poll";
      }
    } else if (pointers.length > 0) {
      imagesSource = "stream";
    }
    if (pointers.length > 0) {
      images = await resolvePointers(pointers, progress.conversationId || requestedSid).catch(() => []);
    }
  } catch (e) {
    // do not break text path on image errors
  }

  if ((!images || images.length === 0)) {
    const domImageCandidates = await collectDomImageCandidates().catch(() => []);
    if (domImageCandidates.length > 0) {
      const domImages = await resolveDomImages(domImageCandidates).catch(() => []);
      if (domImages.length > 0) {
        images = domImages;
        imagesSource = 'dom';
        log('dom images resolved', { count: domImages.length, preview: domImages[0] });
      }
    }
  }

  if (!reply && images.length === 0) {
    const ui = await sampleUiState();
    throw new Error("EMPTY_REPLY:" + JSON.stringify(ui));
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
