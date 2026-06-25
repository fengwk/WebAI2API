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
  description: '在 ChatGPT 页面中执行对话，支持固定会话复用，并优先通过上游会话流还原 Markdown 文本。',
  homePageUrl: 'https://chatgpt.com',
  inputJsonSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', title: '提示词' },
      sessionId: { type: 'string', title: '会话 ID（可选，传入后进入指定对话）' }
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
  return applyTextPatch(event, currentText);
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
    wsTrace: []
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
        }
      }
    } catch {}
  };

  ws.on('framereceived', onFrameReceived);
  wsHandlers.set(ws, onFrameReceived);
};

page.on('websocket', onWebSocket);

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

  progress.sendStartedAt = Date.now() - t0;
  const sendBtn = page.locator('button[data-testid="send-button"]');
  try {
    await composer.press('Enter', { timeout: 5000 });
  } catch {
    await sendBtn.click({ timeout: 8000 });
  }
  await dismissAnyDialog();

  const sendConfirmStart = Date.now();
  let userMessageSent = false;
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

  const reply = String(currentText || '').trim() || String(domText || '').trim();
  const source = currentText ? 'stream' : 'dom_fallback';
  if (!reply) {
    const ui = await sampleUiState();
    throw new Error('EMPTY_REPLY:' + JSON.stringify(ui));
  }

  return {
    sessionId: extractSessionId(page.url()) || requestedSid || null,
    url: page.url(),
    title: await page.title().catch(() => ''),
    format: 'markdown',
    reply,
    source,
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
  }
  for (const [ws, handler] of wsHandlers.entries()) {
    if (typeof ws.off === 'function') {
      ws.off('framereceived', handler);
    }
  }
}
`
};
