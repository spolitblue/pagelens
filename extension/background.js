// PageLens background service worker
// 职责：截图、设置存储、API 调用（浏览器扩展与服务 worker 不向页面暴露 Key）、流式转发。

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  normalizeSettings,
  toPublicSettings,
} from './shared.js';

const BRIDGE_PAIR_TIMEOUT_MS = 8000;
const MODELS_TIMEOUT_MS = 20000;
const STREAM_IDLE_TIMEOUT_MS = 180000;
const CAPTURE_MIN_INTERVAL_MS = 620;

let lastCaptureAt = 0;
let captureQueue = Promise.resolve();

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

async function getSettings() {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(data[SETTINGS_KEY]);
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

async function publicSettings() {
  return toPublicSettings(await getSettings());
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

class UserError extends Error {
  constructor(message, code = 'ERROR') {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

function errorMessage(err, settings) {
  if (err instanceof UserError) return { message: err.message, code: err.code };
  if (isAbortError(err)) return { message: '已停止生成。', code: 'ABORTED' };

  const text = String(err?.message || err || '未知错误');
  const causeCode = err?.cause?.code || err?.code || '';
  if (/Failed to fetch|fetch failed|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(text + ' ' + causeCode)) {
    if (settings?.mode === 'bridge') {
      return {
        code: 'BRIDGE_UNREACHABLE',
        message:
          `连不上本机桥接（${settings.bridgeUrl || 'http://127.0.0.1:8790'}）。` +
          '请双击项目里的「bridge/start-bridge.bat」，确认那个窗口还开着；或者到设置里改用直连 API。',
      };
    }
    return {
      code: 'API_UNREACHABLE',
      message: `连不上 API 服务器（${settings?.apiBaseUrl || 'https://api.deepseek.com'}）。请检查网络或代理设置。`,
    };
  }
  if (/timeout|timed out/i.test(text)) {
    return { code: 'TIMEOUT', message: '请求超时了，稍后再试。' };
  }
  return { code: 'ERROR', message: text.slice(0, 500) };
}

// ---------------------------------------------------------------------------
// tiny utils
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // Port has been disconnected by the content script; nobody is listening.
  }
}

function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const local = new AbortController();
  const timer = setTimeout(() => local.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any
      ? AbortSignal.any([options.signal, local.signal])
      : options.signal
    : local.signal;
  return fetch(url, { ...options, signal })
    .catch((err) => {
      // 超时和用户主动取消都表现为 AbortError，这里区分开，给用户明确提示。
      if (local.signal.aborted && !options.signal?.aborted) {
        throw new UserError('请求超时，请检查网络或稍后再试。', 'TIMEOUT');
      }
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

function joinUrl(base, suffix) {
  return `${String(base || '').replace(/\/+$/, '')}${suffix}`;
}

/** DeepSeek 与 OpenAI 兼容服务的 endpoint：用户可能填 .../v1 或完整的 .../chat/completions */
function chatEndpoint(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) b = 'https://api.deepseek.com';
  if (b.endsWith('/chat/completions')) return b;
  if (b.endsWith('/v1')) return `${b}/chat/completions`;
  return `${b}/chat/completions`;
}

function modelsEndpoint(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) b = 'https://api.deepseek.com';
  if (b.endsWith('/chat/completions')) b = b.slice(0, -'/chat/completions'.length);
  return `${b}/models`;
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// bridge pairing / connection test
// ---------------------------------------------------------------------------

async function pairBridge(settings, overrides = {}) {
  const base = String(overrides.bridgeUrl || settings.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl)
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    throw new UserError('桥接地址必须以 http:// 开头，例如 http://127.0.0.1:8790', 'BAD_BRIDGE_URL');
  }
  let res;
  try {
    // 自定义标识头：service worker 的跨域请求不一定带 Origin，桥接端靠它识别扩展并记录配对者。
    res = await fetchWithTimeout(
      joinUrl(base, '/pair'),
      {
        cache: 'no-store',
        headers: {
          'X-PageLens-Client': 'extension',
          'X-PageLens-Extension-Id': chrome.runtime.id,
        },
      },
      BRIDGE_PAIR_TIMEOUT_MS,
    );
  } catch (err) {
    throw new UserError(
      `连不上本机桥接（${base}）。请先在项目文件夹双击「bridge/start-bridge.bat」，并保持窗口开着。`,
      'BRIDGE_UNREACHABLE',
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      const payload = await res.json();
      detail = payload?.error?.message || payload?.message || '';
    } catch {
      // ignore
    }
    throw new UserError(
      detail || `桥接返回 HTTP ${res.status}，配对失败。请重启桥接后重试。`,
      'PAIR_FAILED',
    );
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new UserError('桥接返回的不是有效 JSON，请确认地址填的是 PageLens 桥接。', 'PAIR_FAILED');
  }
  if (!data || !data.token) {
    throw new UserError('桥接没有返回配对令牌，请确认启动的是 PageLens 桥接。', 'PAIR_FAILED');
  }
  const next = await saveSettings({
    ...settings,
    mode: 'bridge',
    bridgeUrl: data.baseUrl || base,
    bridgeToken: data.token,
  });
  return {
    ok: true,
    bridgeUrl: next.bridgeUrl,
    hasKey: Boolean(data.hasKey),
    keySource: data.keySource || '',
    version: data.version || '',
  };
}

async function ensureBridgePairing(settings) {
  if (settings.mode !== 'bridge') return settings;
  if (settings.bridgeToken) return settings;
  await pairBridge(settings);
  return getSettings();
}

async function fetchModels(settings) {
  let headers;
  let url;
  if (settings.mode === 'bridge') {
    if (!settings.bridgeToken) {
      throw new UserError(
        '扩展还没有和本机桥接配对。请先在设置页点「自动配对」，或确认桥接窗口正在运行。',
        'NOT_PAIRED',
      );
    }
    url = joinUrl(settings.bridgeUrl, '/v1/models');
    headers = { Authorization: `Bearer ${settings.bridgeToken}` };
  } else {
    if (!settings.apiKey) {
      throw new UserError('还没有填写 DeepSeek API Key。请在设置页填写后再测试。', 'NO_API_KEY');
    }
    url = modelsEndpoint(settings.apiBaseUrl);
    headers = { Authorization: `Bearer ${settings.apiKey}` };
  }

  let res;
  try {
    res = await fetchWithTimeout(url, { headers, cache: 'no-store' }, MODELS_TIMEOUT_MS);
  } catch (err) {
    throw new UserError(errorMessage(err, settings).message, 'CONNECTION_FAILED');
  }
  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // ignore
  }
  if (!res.ok) {
    const detail =
      data?.error?.message || data?.message || raw.slice(0, 200).replace(/\s+/g, ' ').trim();
    if (res.status === 401 || res.status === 403) {
      throw new UserError(
        settings.mode === 'bridge'
          ? '桥接令牌无效，请在设置页重新配对。'
          : 'DeepSeek API Key 无效或没有权限，请检查后重试。',
        'AUTH_FAILED',
      );
    }
    throw new UserError(detail || `连接失败（HTTP ${res.status}）`, 'CONNECTION_FAILED');
  }
  const models = Array.isArray(data?.data)
    ? data.data.map((m) => ({
        id: String(m.id || ''),
        name: String(m.name || m.id || ''),
        input: Array.isArray(m.input_modalities) ? m.input_modalities : null,
      }))
    : [];
  const selected = models.find((m) => m.id === settings.model);
  return {
    ok: true,
    url,
    models,
    selectedModelFound: Boolean(selected),
    vision:
      selected?.input?.includes('image') ??
      (settings.model === 'deepseek-flash' ? null : null),
  };
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

async function captureVisibleTab(windowId) {
  const job = async () => {
    const wait = Math.max(0, CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureAt));
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'jpeg',
        quality: 92,
      });
      return { ok: true, dataUrl };
    } catch (err) {
      throw new UserError(
        '无法截取当前标签页。浏览器内置页面（chrome://、扩展商店、PDF 阅读器）不允许扩展截图，请换一个普通网页。',
        'CAPTURE_FAILED',
      );
    }
  };
  const next = captureQueue.then(job, job);
  captureQueue = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// chat / streaming
// ---------------------------------------------------------------------------

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const item of messages.slice(-28)) {
    if (!item || !['user', 'assistant', 'system'].includes(item.role)) continue;
    if (typeof item.content === 'string') {
      const text = item.content.trim();
      if (text) out.push({ role: item.role, content: truncate(text, 40000) });
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    const parts = [];
    for (const part of item.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        const text = part.text.trim();
        if (text) parts.push({ type: 'text', text: truncate(text, 40000) });
      } else if (
        part.type === 'image_url' &&
        typeof part.image_url?.url === 'string' &&
        /^data:image\/(png|jpeg|webp);base64,/i.test(part.image_url.url)
      ) {
        if (parts.filter((p) => p.type === 'image_url').length >= 3) continue;
        parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
      }
    }
    if (parts.length) out.push({ role: item.role, content: parts });
  }
  return out;
}

function buildChatBody(settings, messages) {
  const body = {
    model: settings.model,
    messages,
    stream: true,
    max_tokens: settings.maxTokens,
  };
  if (Number.isFinite(settings.temperature)) body.temperature = settings.temperature;
  if (settings.thinking === 'off') {
    body.thinking = { type: 'disabled' };
  } else {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = settings.thinking;
  }
  // 估算请求体大小，避免误配置大图直接打爆接口
  if (JSON.stringify(body).length > 18 * 1024 * 1024) {
    throw new UserError('图片太大了，请把设置里的「截图最大宽度」调小后再试。', 'PAYLOAD_TOO_LARGE');
  }
  return body;
}

async function openChatStream(settings, messages, signal) {
  const headers = { 'Content-Type': 'application/json' };
  let url;
  if (settings.mode === 'bridge') {
    if (!settings.bridgeToken) {
      throw new UserError(
        '扩展还没有和本机桥接配对。请先启动桥接，再在设置页点「自动配对」。',
        'NOT_PAIRED',
      );
    }
    url = joinUrl(settings.bridgeUrl, '/v1/chat');
    headers.Authorization = `Bearer ${settings.bridgeToken}`;
  } else {
    if (!settings.apiKey) {
      throw new UserError('还没有填写 DeepSeek API Key。请先在设置页配置。', 'NO_API_KEY');
    }
    url = chatEndpoint(settings.apiBaseUrl);
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  let body = buildChatBody(settings, messages);
  const doFetch = async (payload) => {
    try {
      return await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { ...headers, Accept: 'text/event-stream' },
          body: JSON.stringify(payload),
          signal,
        },
        STREAM_IDLE_TIMEOUT_MS,
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new UserError(errorMessage(err, settings).message, 'REQUEST_FAILED');
    }
  };

  let res = await doFetch(body);
  if (!res.ok) {
    const info = await parseUpstreamError(res);
    // 兼容部分 OpenAI 兼容网关不认识 thinking / reasoning_effort 的情况：去掉后重试一次。
    if (
      res.status === 400 &&
      body.thinking &&
      /thinking|reasoning|unknown|unrecognized|invalid.*field/i.test(info.raw || info.message)
    ) {
      const fallback = { ...body };
      delete fallback.thinking;
      delete fallback.reasoning_effort;
      res = await doFetch(fallback);
      if (!res.ok) {
        const second = await parseUpstreamError(res);
        throw makeHttpError(res.status, second, settings);
      }
    } else {
      throw makeHttpError(res.status, info, settings);
    }
  }
  return { res, body };
}

async function parseUpstreamError(res) {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    // ignore
  }
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // ignore
  }
  const message =
    data?.error?.message ||
    data?.error?.code ||
    data?.message ||
    raw.slice(0, 400).replace(/\s+/g, ' ').trim();
  return { raw, message };
}

function makeHttpError(status, info, settings) {
  if (status === 401 || status === 403) {
    return new UserError(
      settings.mode === 'bridge'
        ? '桥接令牌无效，请在设置页重新配对。'
        : 'DeepSeek API Key 无效或没有权限。请到设置页检查 Key。',
      'AUTH_FAILED',
    );
  }
  if (status === 402) return new UserError('DeepSeek 账户余额不足，充值后再试。', 'QUOTA');
  if (status === 429) return new UserError('请求太频繁，被限流了，等几秒再试。', 'RATE_LIMIT');
  if (status === 413) return new UserError('截图或上下文太大，请求被拒绝。调小截图宽度后再试。', 'TOO_LARGE');
  if (status === 400) {
    const msg = info.message || '请求格式不正确';
    return new UserError(`模型拒绝了请求：${truncate(msg, 400)}`, 'BAD_REQUEST');
  }
  if (status === 503 || status === 502 || status === 500) {
    return new UserError(`模型服务暂时不可用（HTTP ${status}），稍后再试。`, 'UPSTREAM_ERROR');
  }
  return new UserError(info.message || `模型返回 HTTP ${status}`, 'HTTP_ERROR');
}

function consumeSseChunk(text, onEvent) {
  const lines = text.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return;
  const data = dataLines.join('\n');
  if (data === '[DONE]') {
    onEvent({ type: 'done_marker' });
    return;
  }
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }
  if (json?.error) {
    onEvent({
      type: 'upstream_error',
      message: json.error.message || json.error.code || '模型返回错误',
    });
    return;
  }
  const choice = json.choices?.[0] || null;
  const delta = choice?.delta || {};
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === 'string' && reasoning) onEvent({ type: 'reasoning', text: reasoning });
  let content = delta.content;
  if (Array.isArray(content)) {
    content = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  if (typeof content === 'string' && content) onEvent({ type: 'delta', text: content });
  if (json.usage) onEvent({ type: 'usage', usage: json.usage });
  if (json.model) onEvent({ type: 'model', model: json.model });
  if (choice?.finish_reason) onEvent({ type: 'finish', reason: choice.finish_reason });
}

async function streamChat(payload, port, signal) {
  const settings = await getSettings();
  const messages = normalizeMessages(payload?.messages);
  if (!messages.length || !messages.some((m) => m.role === 'user')) {
    throw new UserError('没有可发送的问题。', 'EMPTY_MESSAGE');
  }

  const { res } = await openChatStream(settings, messages, signal);
  const contentType = res.headers.get('content-type') || '';

  // 少数网关不按 SSE 返回，而是直接给完整 JSON。
  if (!contentType.includes('text/event-stream')) {
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content) {
      safePost(port, { type: 'delta', text: content });
      safePost(port, { type: 'done', usage: json.usage || null, model: json.model || settings.model });
      return;
    }
    throw new UserError(text.slice(0, 400) || '模型没有返回内容。', 'EMPTY_RESPONSE');
  }

  if (!res.body) throw new UserError('模型没有返回可读取的数据流。', 'EMPTY_RESPONSE');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let model = settings.model;
  let finished = false;
  let aborted = false;
  let upstreamError = '';

  const handleEvent = (event) => {
    if (event.type === 'delta') safePost(port, { type: 'delta', text: event.text });
    else if (event.type === 'reasoning') safePost(port, { type: 'reasoning', text: event.text });
    else if (event.type === 'usage') usage = event.usage;
    else if (event.type === 'model') model = event.model;
    else if (event.type === 'finish') finished = true;
    else if (event.type === 'done_marker') finished = true;
    else if (event.type === 'upstream_error') upstreamError = event.message || '模型返回错误';
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const chunk = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consumeSseChunk(chunk, handleEvent);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeSseChunk(buffer, handleEvent);
  } catch (err) {
    if (isAbortError(err)) aborted = true;
    else throw err;
  }

  if (aborted || signal.aborted) {
    safePost(port, { type: 'aborted' });
    return;
  }
  if (upstreamError) throw new UserError(upstreamError, 'UPSTREAM_ERROR');
  safePost(port, { type: 'done', usage, model, finished });
}

// ---------------------------------------------------------------------------
// extension actions
// ---------------------------------------------------------------------------

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
}

async function sendToTab(tabId, message) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {
      if (attempt === 0) {
        try {
          await injectContentScript(tabId);
        } catch {
          return false;
        }
      }
      await sleep(140 + attempt * 120);
    }
  }
  return false;
}

async function flashBadge(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#f97316' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    }, 2600);
  } catch {
    // ignore
  }
}

async function runOnTab(tab, message) {
  if (!tab?.id) return;
  const ok = await sendToTab(tab.id, message);
  if (!ok) await flashBadge(tab.id);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

async function openOptions() {
  await chrome.runtime.openOptionsPage();
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pagelens-ask-selection',
      title: '用 PageLens 询问选中内容',
      contexts: ['selection'],
    });
  });
  if (details.reason === 'install') {
    setTimeout(() => openOptions().catch(() => {}), 500);
  }
  void (async () => {
    const settings = await getSettings();
    if (settings.mode === 'bridge' && !settings.bridgeToken) {
      try {
        await pairBridge(settings);
      } catch {
        // 桥接没开也没关系，设置页会引导用户。
      }
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const settings = await getSettings();
    if (settings.mode === 'bridge' && !settings.bridgeToken) {
      try {
        await pairBridge(settings);
      } catch {
        // ignore
      }
    }
  })();
});

chrome.action.onClicked.addListener((tab) => {
  void runOnTab(tab, { type: 'toggle-panel' });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-panel' && command !== 'capture-region') return;
  void (async () => {
    const tab = await getActiveTab();
    await runOnTab(tab, { type: command });
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'pagelens-ask-selection' || !tab?.id) return;
  void runOnTab(tab, {
    type: 'open-with-selection',
    selection: String(info.selectionText || '').slice(0, 4000),
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  const handle = async () => {
    switch (message.type) {
      case 'ping':
        return { ok: true, version: chrome.runtime.getManifest().version };
      case 'get-ui-settings':
        return { ok: true, settings: await publicSettings(), version: chrome.runtime.getManifest().version };
      case 'capture-visible': {
        const windowId = sender.tab?.windowId ?? (await chrome.windows.getCurrent()).id;
        return captureVisibleTab(windowId);
      }
      case 'pair-bridge': {
        const settings = await getSettings();
        return pairBridge(settings, message);
      }
      case 'test-connection': {
        const settings = await getSettings();
        // 桥接尚未配对时，测试前先自动配对一次。
        if (settings.mode === 'bridge' && !settings.bridgeToken) {
          await pairBridge(settings);
        }
        return { ok: true, result: await fetchModels(await getSettings()) };
      }
      case 'open-options':
        await openOptions();
        return { ok: true };
      case 'update-ui-setting': {
        const allowed = new Set([
          'theme',
          'autoCapture',
          'includePageContext',
          'maxImageWidth',
          'imageQuality',
          'model',
          'thinking',
        ]);
        if (!allowed.has(message.key)) return { ok: false, error: '字段不允许修改。' };
        const next = await saveSettings({ [message.key]: message.value });
        return { ok: true, settings: toPublicSettings(next) };
      }
      case 'get-version':
        return { ok: true, version: chrome.runtime.getManifest().version };
      default:
        return { ok: false, error: `未知消息：${message.type}` };
    }
  };

  handle()
    .then((result) => sendResponse(result))
    .catch(async (err) => {
      const settings = await getSettings().catch(() => null);
      sendResponse({ ok: false, error: errorMessage(err, settings).message, code: errorMessage(err, settings).code });
    });
  return true;
});

// ---------------------------------------------------------------------------
// streaming chat port
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pagelens-chat') return;
  let controller = null;
  let disconnected = false;

  const post = (message) => {
    if (disconnected) return;
    safePost(port, message);
  };

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'abort') {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      return;
    }
    if (message.type !== 'start') return;

    try {
      controller?.abort();
    } catch {
      // ignore
    }
    controller = new AbortController();
    const signal = controller.signal;

    void (async () => {
      try {
        await streamChat(message.payload, port, signal);
      } catch (err) {
        if (signal.aborted) {
          post({ type: 'aborted' });
          return;
        }
        const settings = await getSettings().catch(() => null);
        post({ type: 'error', ...errorMessage(err, settings) });
      }
    })();
  });

  port.onDisconnect.addListener(() => {
    disconnected = true;
    try {
      controller?.abort();
    } catch {
      // ignore
    }
  });
});
