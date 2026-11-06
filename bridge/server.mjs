#!/usr/bin/env node
/**
 * PageLens Bridge
 *
 * 只监听 127.0.0.1 的小代理：
 *   - 从环境变量 / DSH 凭据读取 DEEPSEEK_API_KEY（Key 不进入浏览器）
 *   - 用随机配对令牌保护 /v1/chat 与 /v1/models
 *   - 把扩展的请求转发给 DeepSeek（或 DEEPSEEK_BASE_URL 指向的兼容网关）
 *
 * 零依赖，Node.js >= 20。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = '1.0.0';
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 18 * 1024 * 1024;
const UPSTREAM_IDLE_TIMEOUT_MS = 150_000;
const MAX_CONCURRENT_STREAMS = 4;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const PORT = Number(args.port || process.env.PAGELENS_BRIDGE_PORT || 8790);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('端口不合法，请用 --port 8790 指定一个 1-65535 的端口。');
  process.exit(1);
}

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.pagelens');
const STATE_FILE = path.join(STATE_DIR, 'bridge.json');
const DSH_CREDENTIAL_FILE = path.join(HOME, '.dsh', '.credentials.yaml');
const DEEPSEEK_BASE = String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// pairing state
// ---------------------------------------------------------------------------

let state = null;

function persistState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (err) {
    console.error(`无法写入配对状态文件 ${STATE_FILE}: ${err.message}`);
  }
}

function loadState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let loaded = null;
  try {
    loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // missing / broken
  }
  if (!loaded || typeof loaded.token !== 'string' || loaded.token.length < 20) {
    loaded = {
      token: crypto.randomBytes(24).toString('base64url'),
      createdAt: new Date().toISOString(),
      version: VERSION,
    };
  }
  if (!loaded.pairedOrigin) loaded.pairedOrigin = '';
  if (args.resetPair) loaded.pairedOrigin = '';
  loaded.lastPort = PORT;
  loaded.version = VERSION;
  return loaded;
}

state = loadState();
const PAIR_TOKEN = state.token;
persistState();

// ---------------------------------------------------------------------------
// key resolution
// ---------------------------------------------------------------------------

function unquoteYamlValue(value) {
  const v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function readDshRefs() {
  let text;
  try {
    text = fs.readFileSync(DSH_CREDENTIAL_FILE, 'utf8');
  } catch {
    return {};
  }
  const refs = {};
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/);
    if (match && match[2]) refs[match[1]] = unquoteYamlValue(match[2]);
  }
  return refs;
}

function resolveKey() {
  const envKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (envKey) return { key: envKey, source: '环境变量 DEEPSEEK_API_KEY' };
  const refs = readDshRefs();
  const key = String(refs.DEEPSEEK_API_KEY || '').trim();
  if (key) return { key, source: 'DSH 凭据（~/.dsh/.credentials.yaml）' };
  return { key: '', source: '' };
}

function keySummary() {
  const { key, source } = resolveKey();
  return { hasKey: Boolean(key), keySource: source };
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const teal = (text) => paint('38;5;80', text);
const dim = (text) => paint('38;5;245', text);
const yellow = (text) => paint('38;5;214', text);
const red = (text) => paint('38;5;203', text);
const bold = (text) => paint('1', text);

function log(message) {
  console.log(`${dim(nowTime())} ${message}`);
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function safeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function originAllowed(origin) {
  if (!origin) return true;
  return (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
  );
}

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-PageLens-Client, X-PageLens-Extension-Id',
  );
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return false;
  const supplied = Buffer.from(match[1].trim());
  const expected = Buffer.from(PAIR_TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体太大（超过 18 MB）'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        reject(Object.assign(new Error('请求体为空'), { status: 400 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求体不是有效 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function countImages(messages) {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url' && part?.image_url?.url) count += 1;
    }
  }
  return count;
}

function clampMaxTokens(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 2048;
  return Math.min(8192, Math.max(256, n));
}

// ---------------------------------------------------------------------------
// status page
// ---------------------------------------------------------------------------

function statusPage() {
  const { hasKey, keySource } = keySummary();
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PageLens Bridge</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b11;color:#e9f0f9;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .card{width:min(620px,calc(100vw - 32px));padding:28px;border:1px solid rgba(255,255,255,.1);border-radius:20px;background:linear-gradient(135deg,rgba(20,31,46,.95),rgba(10,16,25,.98));box-shadow:0 30px 90px rgba(0,0,0,.4)}
  h1{margin:0 0 4px;font-size:22px;letter-spacing:-.3px}
  .sub{color:#91a0b4;font-size:12px;margin-bottom:20px}
  .row{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.07);font-size:12.5px}
  .row:last-of-type{border-bottom:0}
  .k{color:#91a0b4}.v{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;text-align:right;word-break:break-all}
  .ok{color:#5eead4}.warn{color:#fbbf24}
  .tip{margin-top:18px;padding:12px 13px;border:1px solid rgba(94,234,212,.2);border-radius:11px;background:rgba(94,234,212,.06);font-size:12px;line-height:1.65;color:#c9fff7}
  code{background:rgba(255,255,255,.07);padding:1px 4px;border-radius:4px;font-size:11px}
</style></head><body>
<div class="card">
  <h1>PageLens Bridge</h1>
  <div class="sub">本机 DeepSeek 代理 · v${VERSION}</div>
  <div class="row"><span class="k">监听地址</span><span class="v">http://${HOST}:${PORT}</span></div>
  <div class="row"><span class="k">DeepSeek Key</span><span class="v ${hasKey ? 'ok' : 'warn'}">${hasKey ? `已找到 · ${escapeHtml(keySource)}` : '未找到'}</span></div>
  <div class="row"><span class="k">上游地址</span><span class="v">${escapeHtml(DEEPSEEK_BASE)}</span></div>
  <div class="row"><span class="k">配对状态</span><span class="v ok">运行中（令牌已保存）</span></div>
  <div class="tip">${hasKey
    ? '桥接已就绪。回到 PageLens 设置页点「自动配对」即可；这个窗口需要保持开着。'
    : '没有找到 DeepSeek Key。请先配置 DSH，或设置环境变量 <code>DEEPSEEK_API_KEY</code> 后重启桥接；也可以在扩展里改用「直连 API」。'}</div>
</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// upstream calls
// ---------------------------------------------------------------------------

let modelsCache = null;
let modelsCacheAt = 0;
let activeStreams = 0;

async function handleModels(req, res) {
  const { key } = resolveKey();
  if (!key) {
    safeJson(res, 503, {
      error: { message: '桥接没有找到 DeepSeek Key。请配置 DSH 的 DEEPSEEK_API_KEY，或设置环境变量后重启桥接。', code: 'NO_KEY' },
    });
    return;
  }
  if (modelsCache && Date.now() - modelsCacheAt < 60_000) {
    safeJson(res, 200, modelsCache);
    return;
  }
  try {
    const upstream = await fetch(`${DEEPSEEK_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      safeJson(res, upstream.status, {
        error: { message: `上游模型列表返回 HTTP ${upstream.status}`, code: 'UPSTREAM_ERROR' },
      });
      log(red(`模型列表失败 HTTP ${upstream.status}`));
      return;
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!data) {
      safeJson(res, 502, { error: { message: '上游返回了非 JSON 模型列表', code: 'BAD_UPSTREAM' } });
      return;
    }
    modelsCache = data;
    modelsCacheAt = Date.now();
    safeJson(res, 200, data);
  } catch (err) {
    const message = err?.name === 'TimeoutError'
      ? '连接上游超时'
      : `连接上游失败：${String(err?.message || err)}`;
    safeJson(res, 502, { error: { message, code: 'UPSTREAM_UNREACHABLE' } });
    log(red(`模型列表请求失败：${message}`));
  }
}

async function handleChat(req, res) {
  const { key } = resolveKey();
  if (!key) {
    safeJson(res, 503, {
      error: { message: '桥接没有找到 DeepSeek Key。请配置 DSH 的 DEEPSEEK_API_KEY，或设置环境变量后重启桥接。', code: 'NO_KEY' },
    });
    return;
  }
  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    safeJson(res, 429, {
      error: { message: '同时进行的请求太多了，等上一轮回答结束再试。', code: 'TOO_MANY_STREAMS' },
    });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    safeJson(res, err.status || 400, {
      error: { message: err.message || '请求体读取失败', code: 'BAD_REQUEST' },
    });
    return;
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) {
    safeJson(res, 400, { error: { message: 'messages 不能为空', code: 'BAD_REQUEST' } });
    return;
  }

  const model = String(body.model || 'deepseek-flash');
  const stream = body.stream !== false;
  const imageCount = countImages(body.messages);
  const payload = { ...body, model, stream, max_tokens: clampMaxTokens(body.max_tokens) };
  delete payload.api_key;
  delete payload.key;

  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    safeJson(res, 400, { error: { message: '请求无法序列化', code: 'BAD_REQUEST' } });
    return;
  }
  if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
    safeJson(res, 413, { error: { message: '请求体太大', code: 'TOO_LARGE' } });
    return;
  }

  const controller = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  });

  const startedAt = Date.now();
  activeStreams += 1;
  let upstream = null;
  const initialIdle = setTimeout(() => controller.abort(), UPSTREAM_IDLE_TIMEOUT_MS);

  try {
    upstream = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: serialized,
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      let message = `上游返回 HTTP ${upstream.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed?.error?.message || parsed?.message || message;
      } catch {
        if (text) message = text.slice(0, 400);
      }
      safeJson(res, upstream.status, {
        error: { message, code: upstream.status === 401 ? 'AUTH' : 'UPSTREAM_ERROR' },
      });
      log(`${red('✗')} ${model} · ${imageCount} 图 · HTTP ${upstream.status} · ${Date.now() - startedAt}ms`);
      return;
    }

    const contentType =
      upstream.headers.get('content-type') || (stream ? 'text/event-stream' : 'application/json');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    let bytes = 0;
    for (;;) {
      clearTimeout(initialIdle);
      const idle = setTimeout(() => controller.abort(), UPSTREAM_IDLE_TIMEOUT_MS);
      let chunk;
      try {
        const { done, value } = await reader.read();
        clearTimeout(idle);
        if (done) break;
        chunk = value;
      } catch (err) {
        clearTimeout(idle);
        if (clientGone || controller.signal.aborted) break;
        throw err;
      }
      bytes += chunk.byteLength;
      if (clientGone) break;
      const ok = res.write(Buffer.from(chunk));
      if (!ok) await new Promise((resolve) => res.once('drain', resolve));
    }
    if (!clientGone) res.end();
  } catch (err) {
    if (!clientGone && !res.headersSent) {
      const timedOut = controller.signal.aborted;
      safeJson(res, timedOut ? 504 : 502, {
        error: {
          message: timedOut
            ? '连接上游超时，请稍后再试。'
            : `连接 DeepSeek 失败：${String(err?.message || err)}`,
          code: timedOut ? 'TIMEOUT' : 'UPSTREAM_UNREACHABLE',
        },
      });
    } else if (!clientGone) {
      res.destroy();
    }
    if (!clientGone) {
      log(red(`✗ ${model} · 连接中断：${String(err?.message || err).slice(0, 160)}`));
    }
  } finally {
    clearTimeout(initialIdle);
    activeStreams = Math.max(0, activeStreams - 1);
    if (!clientGone) {
      log(`${upstream?.ok ? teal('✓') : red('✗')} ${model} · ${imageCount} 图 · ${Date.now() - startedAt}ms`);
    }
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

function handlePair(req, res) {
  const { hasKey, keySource } = keySummary();
  const origin = req.headers.origin || '';
  const extensionHeader = String(req.headers['x-pagelens-client'] || '');
  const extensionId = String(req.headers['x-pagelens-extension-id'] || '').slice(0, 128);
  const isExtension =
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    extensionHeader === 'extension';
  if (!originAllowed(origin)) {
    safeJson(res, 403, { error: { message: '只允许浏览器扩展或本机页面配对。', code: 'FORBIDDEN_ORIGIN' } });
    return;
  }
  // 令牌只会交给第一个来配对的扩展，避免本机其他扩展轻易拿走访问令牌。
  const clientKey = origin && origin.startsWith('chrome-extension://')
    ? origin
    : extensionId
      ? `extension:${extensionId}`
      : 'extension:unknown';
  if (isExtension && state.pairedOrigin && state.pairedOrigin !== clientKey) {
    safeJson(res, 403, {
      error: {
        message: '这个桥接已经和另一个扩展配对过了。要重新配对，请删除 ~/.pagelens/bridge.json 后重启桥接，或重启时加 --reset-pair。',
        code: 'ALREADY_PAIRED',
      },
    });
    return;
  }
  if (isExtension && !state.pairedOrigin) {
    state.pairedOrigin = clientKey;
    state.pairedAt = new Date().toISOString();
    persistState();
    log(`已配对扩展：${clientKey}`);
  }
  safeJson(res, 200, {
    ok: true,
    token: PAIR_TOKEN,
    baseUrl: `http://${HOST}:${PORT}`,
    hasKey,
    keySource,
    version: VERSION,
    model: 'deepseek-flash',
  });
}

function route(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (!originAllowed(req.headers.origin || '')) {
    safeJson(res, 403, { error: { message: '不允许的 Origin', code: 'FORBIDDEN_ORIGIN' } });
    return;
  }
  applyCors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(statusPage());
    return;
  }

  if (pathname === '/health') {
    safeJson(res, 200, {
      ok: true,
      version: VERSION,
      host: HOST,
      port: PORT,
      uptimeSeconds: Math.round(process.uptime()),
      ...keySummary(),
      model: 'deepseek-flash',
      baseUrl: DEEPSEEK_BASE,
    });
    return;
  }

  if (pathname === '/pair') {
    handlePair(req, res);
    return;
  }

  if (pathname === '/v1/models' || pathname === '/models') {
    if (!isAuthorized(req)) {
      safeJson(res, 401, { error: { message: '配对令牌无效，请在设置页重新配对。', code: 'UNAUTHORIZED' } });
      return;
    }
    void handleModels(req, res);
    return;
  }

  if (pathname === '/v1/chat' || pathname === '/v1/chat/completions' || pathname === '/chat/completions') {
    if (!isAuthorized(req)) {
      safeJson(res, 401, { error: { message: '配对令牌无效，请在设置页重新配对。', code: 'UNAUTHORIZED' } });
      return;
    }
    void handleChat(req, res);
    return;
  }

  safeJson(res, 404, { error: { message: '没有这个接口', code: 'NOT_FOUND' } });
}

const server = http.createServer((req, res) => {
  try {
    route(req, res);
  } catch (err) {
    console.error('请求处理异常：', err);
    if (!res.headersSent) safeJson(res, 500, { error: { message: '桥接内部错误', code: 'INTERNAL' } });
    else res.destroy();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(red(`✗ 端口 ${PORT} 已被占用。`));
    console.error(dim('  可能已经有一个桥接在运行；或者用 --port 8791 换一个端口（扩展设置里同步修改）。'));
  } else {
    console.error(red(`✗ 启动失败：${err.message}`));
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const { hasKey, keySource } = keySummary();
  const line = '─'.repeat(54);
  console.log();
  console.log(`${teal('╭')} ${bold('PageLens Bridge')} ${dim(`v${VERSION}`)}`);
  console.log(`${teal('│')} 监听        ${bold(`http://${HOST}:${PORT}`)}`);
  console.log(
    `${teal('│')} DeepSeek    ${
      hasKey ? `${teal('已找到')} ${dim(`(${keySource})`)}` : yellow('未找到（请配置 DSH 或 DEEPSEEK_API_KEY）')
    }`,
  );
  console.log(`${teal('│')} 上游        ${dim(DEEPSEEK_BASE)}`);
  console.log(`${teal('│')} 配对文件    ${dim(STATE_FILE)}`);
  console.log(`${teal('╰')} ${dim(line)}`);
  console.log(`  ${dim('保持这个窗口开着。扩展设置页点「自动配对」即可。Ctrl+C 停止。')}`);
  if (args.resetPair) {
    console.log(`  ${yellow('配对记录已清除：')}下一个请求配对的浏览器扩展会取得令牌。`);
  }
  if (state.pairedOrigin) {
    console.log(`  ${dim('已配对扩展：')}${dim(state.pairedOrigin)}`);
  }
  if (args.printToken) {
    console.log(`  ${dim('配对令牌：')}${PAIR_TOKEN}`);
  }
  console.log();
  log(`桥接已启动。状态页：${teal(`http://${HOST}:${PORT}/`)}`);
});

function shutdown(signal) {
  log(`收到 ${signal}，正在关闭桥接…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { help: false, printToken: false, resetPair: false, port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--print-token') out.printToken = true;
    else if (arg === '--reset-pair') out.resetPair = true;
    else if (arg === '--port' || arg === '-p') {
      out.port = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--port=')) {
      out.port = arg.slice('--port='.length);
    }
  }
  return out;
}

function printHelp() {
  console.log(`
PageLens Bridge v${VERSION}

用法:
  node bridge/server.mjs [选项]

选项:
  --port <端口>    监听端口（默认 8790，也可用 PAGELENS_BRIDGE_PORT）
  --print-token    在控制台显示配对令牌（默认只写入 ${STATE_FILE}）
  --reset-pair     清除已配对扩展记录，允许另一个扩展来配对
  --help           显示帮助

环境变量:
  DEEPSEEK_API_KEY   DeepSeek API Key（优先于 DSH 凭据）
  DEEPSEEK_BASE_URL  上游地址（默认 https://api.deepseek.com）
  NO_COLOR=1         关闭控制台颜色

桥接只监听 127.0.0.1，不会暴露到局域网。
`);
}
