/**
 * PageLens 端到端测试（Edge / Chromium 内核）
 *
 *   node test/e2e.mjs
 *
 * 1. 用 mock API 验证：注入、截图、页面文字、流式 Markdown、框选裁剪尺寸
 * 2. 如果本机桥接在 127.0.0.1:8790 运行，则用真实 DeepSeek 视觉模型再问一次，并生成演示截图
 *
 * 依赖：npm install（playwright-core），本机安装 Microsoft Edge。
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
const EXTENSION = path.join(ROOT, 'extension');
const DOCS = path.join(ROOT, 'docs');
const ARTIFACTS = path.join(ROOT, 'test', '.artifacts');
const BRIDGE_URL = process.env.PAGELENS_BRIDGE_URL || 'http://127.0.0.1:8790';
const SKIP_REAL = process.env.PAGELENS_SKIP_REAL === '1';
fs.mkdirSync(DOCS, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });

const log = (...args) => console.log(...args);
let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 15000, interval = 80, message = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`等待超时：${message}`);
    await sleep(interval);
  }
}

// ---------------------------------------------------------------------------
// mock model API
// ---------------------------------------------------------------------------

function jpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    const length = buffer.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  return null;
}

function createMockApi() {
  const requests = [];
  let server;
  const answers = [
    [
      '## 页面概览\n\n这是一个 **Lumen Analytics 增长分析看板**，主要在看访问、转化与渠道表现。\n\n',
      '- 访问量 **128,430**（+12.4%）\n',
      '- 转化率 **4.86%**（+0.7pp）\n',
      '- 客单价 **¥312**（-2.1%）\n\n',
      '> 最值得注意的是：付费广告 CPA 已超目标 18%。\n\n',
      '可以优先检查「品牌词」和「再营销」两组广告的预算。',
    ],
    [
      '框选区域里是**访问与转化趋势图**：访问量（紫色实线）整体上升，转化率（绿色虚线）缓慢抬升。',
      '\n\n结论：流量增长是健康的，但转化率提升幅度小于访问增长，值得单独看落地页。',
    ],
  ];

  const toSse = (content) =>
    `data: ${JSON.stringify({
      id: 'mock',
      object: 'chat.completion.chunk',
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: { content } }],
    })}\n\n`;

  server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      const body = JSON.stringify({
        object: 'list',
        data: [
          { id: 'deepseek-flash', object: 'model', input_modalities: ['text', 'image'] },
          { id: 'deepseek-v4-pro', object: 'model', input_modalities: ['text'] },
        ],
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && req.url.includes('/chat/completions')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json' } }));
        return;
      }
      const imageParts = [];
      for (const message of body.messages || []) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (part.type !== 'image_url') continue;
          const url = part.image_url?.url || '';
          const comma = url.indexOf(',');
          const buffer = Buffer.from(url.slice(comma + 1), 'base64');
          imageParts.push({
            bytes: buffer.length,
            size: jpegSize(buffer),
            prefix: url.slice(0, 30),
          });
          fs.writeFileSync(path.join(ARTIFACTS, `captured-${requests.length}.jpg`), buffer);
        }
      }
      const record = {
        index: requests.length,
        model: body.model,
        stream: body.stream,
        thinking: body.thinking,
        maxTokens: body.max_tokens,
        imageParts,
        contextText: JSON.stringify(body.messages || []),
        at: Date.now(),
      };
      requests.push(record);

      const answer = answers[Math.min(record.index, answers.length - 1)];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      for (const chunk of answer) {
        res.write(toSse(chunk));
        await sleep(55);
      }
      res.write(
        `data: ${JSON.stringify({
          id: 'mock',
          object: 'chat.completion.chunk',
          model: 'deepseek-flash',
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  return {
    requests,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createStaticServer() {
  const html = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'sample-page.html'));
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  });
  return {
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}/`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function bridgeHealth() {
  if (SKIP_REAL) return null;
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.hasKey) return null;
    const stateFile = path.join(os.homedir(), '.pagelens', 'bridge.json');
    const token = JSON.parse(fs.readFileSync(stateFile, 'utf8')).token;
    return { ...data, token };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// extension / browser helpers
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'pagelens.settings';

async function setExtensionSettings(worker, settings) {
  await worker.evaluate(
    async ({ key, value }) => {
      await chrome.storage.local.set({ [key]: value });
    },
    { key: SETTINGS_KEY, value: settings },
  );
}

/**
 * 首次安装时 background 会自动尝试桥接配对，可能和测试写入设置发生竞态。
 * 这里等到配对动作结束后再写入，并做一次稳定性确认。
 */
async function forceSettings(worker, settings) {
  await sleep(1600);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await setExtensionSettings(worker, settings);
    await sleep(450);
    const stored = await worker.evaluate(async (key) => {
      const data = await chrome.storage.local.get(key);
      return data[key] || null;
    }, SETTINGS_KEY);
    if (
      stored &&
      stored.mode === settings.mode &&
      stored.apiBaseUrl === settings.apiBaseUrl &&
      stored.apiKey === settings.apiKey &&
      stored.bridgeToken === settings.bridgeToken
    ) {
      return;
    }
  }
  throw new Error('无法稳定写入扩展设置（可能仍在自动配对）');
}

function baseSettings(overrides = {}) {
  return {
    mode: 'direct',
    bridgeUrl: BRIDGE_URL,
    bridgeToken: '',
    apiBaseUrl: 'http://127.0.0.1:1',
    apiKey: 'test-key',
    model: 'deepseek-flash',
    thinking: 'off',
    maxTokens: 2048,
    temperature: 0.6,
    autoCapture: true,
    includePageContext: true,
    maxImageWidth: 1440,
    imageQuality: 0.85,
    theme: 'dark',
    ...overrides,
  };
}

async function waitForHost(page) {
  await page.waitForFunction(
    () => Boolean(document.getElementById('pagelens-root')?.shadowRoot),
    null,
    { timeout: 15000 },
  );
}

async function openPanel(page) {
  await page.locator('.pl-bubble').click();
  await page.waitForFunction(
    () => document.querySelector('#pagelens-root')?.shadowRoot?.querySelector('.pl-panel.is-open'),
    null,
    { timeout: 5000 },
  );
}

async function ask(page, text) {
  const input = page.locator('.pl-input');
  await input.fill(text);
  await page.locator('.pl-send[data-act="send"]').click();
}

async function assistantTexts(page) {
  return page.evaluate(() => {
    const root = document.getElementById('pagelens-root')?.shadowRoot;
    if (!root) return [];
    return [...root.querySelectorAll('.pl-msg.assistant')].map((node) => ({
      text: node.querySelector('.pl-md')?.innerText || '',
      error: node.querySelector('.pl-msg-error:not([hidden])')?.innerText || '',
      streaming: node.classList.contains('is-streaming'),
    }));
  });
}

async function waitForAssistant(page, index, { timeout = 30000 } = {}) {
  return waitFor(
    async () => {
      const items = await assistantTexts(page);
      const item = items[index];
      if (!item) return null;
      if (item.streaming) return null;
      if (!item.text && !item.error) return null;
      return item;
    },
    { timeout, message: `第 ${index + 1} 个助手回答` },
  );
}

async function dragRegion(page, from, to) {
  await page.locator('.pl-tool[data-act="region"]').click();
  await page.waitForFunction(
    () =>
      !document.querySelector('#pagelens-root')?.shadowRoot?.querySelector('.pl-overlay')?.hidden,
    null,
    { timeout: 4000 },
  );
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(
    () => {
      const root = document.getElementById('pagelens-root')?.shadowRoot;
      const title = root?.querySelector('[data-ref="attachTitle"]')?.textContent || '';
      return title.includes('框选');
    },
    null,
    { timeout: 10000 },
  );
}

async function closeExtraPages(context) {
  // 注意：不要把最后一个页面也关掉，否则 Chromium 会直接退出 persistent context。
  for (const page of context.pages()) {
    if (page.url().includes('options.html')) {
      await page.close().catch(() => {});
    }
  }
  if (!context.pages().length) {
    await context.newPage();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const mock = createMockApi();
const site = createStaticServer();
const mockBase = await mock.start();
const siteUrl = await site.start();
const bridge = await bridgeHealth();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagelens-e2e-'));
const extensionErrors = [];

let context;
try {
  log(`Mock API: ${mockBase}`);
  log(`示例页面: ${siteUrl}`);
  log(`本机桥接: ${bridge ? '可用，将运行真实模型测试' : '不可用，跳过真实模型测试'}`);

  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1440, height: 960 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
    ],
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = new URL(worker.url()).host;
  log(`扩展 ID: ${extensionId}`);
  await closeExtraPages(context);

  await forceSettings(worker, baseSettings({ apiBaseUrl: mockBase }));

  // ---------- mock: 注入 + 视口截图 + 流式回答 ----------
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') extensionErrors.push(msg.text());
  });
  await page.goto(siteUrl, { waitUntil: 'load' });
  await waitForHost(page);
  check('content script 注入悬浮宿主', true);
  check('气泡出现在页面上', (await page.locator('.pl-bubble').count()) === 1);

  await openPanel(page);
  check('点击气泡打开面板', true);
  await page.mouse.move(10, 10);
  await page.waitForTimeout(250);

  if (process.env.PAGELENS_DEBUG === '1') {
    const stored = await worker.evaluate(async () => chrome.storage.local.get('pagelens.settings'));
    console.log('DEBUG stored settings:', JSON.stringify({ ...stored['pagelens.settings'], apiKey: '<redacted>' }, null, 2));
    console.log(
      'DEBUG ui:',
      await page.evaluate(() => {
        const root = document.getElementById('pagelens-root')?.shadowRoot;
        return {
          status: root?.querySelector('[data-ref="status"]')?.textContent,
          setupHidden: root?.querySelector('[data-ref="setup"]')?.hidden,
          setupText: root?.querySelector('[data-ref="setupText"]')?.textContent,
          inputValue: root?.querySelector('.pl-input')?.value,
          sendDisabled: root?.querySelector('[data-act="send"]')?.disabled,
          dotClass: root?.querySelector('[data-ref="dot"]')?.className,
        };
      }),
    );
  }

  await ask(page, '这个页面是做什么的？最需要注意什么？');
  try {
    await waitFor(() => mock.requests.length >= 1, { timeout: 15000, message: 'mock 收到第一次请求' });
  } catch (err) {
    console.log(
      'DEBUG after send:',
      JSON.stringify(
        {
          status: await page.evaluate(
            () => document.querySelector('#pagelens-root')?.shadowRoot?.querySelector('[data-ref="status"]')?.textContent,
          ),
          assistants: await assistantTexts(page),
          requests: mock.requests.length,
          pageErrors,
          consoleErrors: extensionErrors.slice(0, 20),
        },
        null,
        2,
      ),
    );
    throw err;
  }
  const first = await waitForAssistant(page, 0);
  check('模型回答渲染到面板', first.text.includes('Lumen Analytics'), first.text.slice(0, 40).replace(/\s+/g, ' '));
  check('Markdown 标题/列表/引用被渲染', await page.evaluate(() => {
    const root = document.getElementById('pagelens-root')?.shadowRoot;
    const last = [...root.querySelectorAll('.pl-msg.assistant')].at(-1);
    return Boolean(last?.querySelector('.pl-md h2') && last?.querySelector('.pl-md ul') && last?.querySelector('.pl-md blockquote'));
  }));
  await page.screenshot({ path: path.join(DOCS, 'demo-mock.png') });

  // 重新开一个干净对话，让框选演示截图只包含「问题 → 裁剪图 → 回答」。
  await page.locator('[data-act="new"]').click();
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(
    () => document.querySelector('#pagelens-root')?.shadowRoot?.querySelectorAll('.pl-msg').length,
  );
  check('新建对话会清空消息', cleared === 0, `messages=${cleared}`);

  const req1 = mock.requests[0];
  check('请求带 1 张 JPEG 截图', req1.imageParts.length === 1 && req1.imageParts[0].prefix.startsWith('data:image/jpeg'), `bytes=${req1.imageParts[0]?.bytes}`);
  const shotSize = req1.imageParts[0]?.size;
  check(
    '视口截图宽度符合上限且不是长截图',
    shotSize?.width === 1440 && shotSize?.height >= 900 && shotSize?.height <= 1010,
    JSON.stringify(shotSize),
  );
  check('附带页面文字上下文', /Lumen Analytics/.test(req1.contextText) && /付费广告/.test(req1.contextText));
  check('thinking 关闭（默认速度优先）', req1.thinking?.type === 'disabled');

  // ---------- mock: 框选截图裁剪 ----------
  await dragRegion(page, { x: 250, y: 210 }, { x: 800, y: 560 });
  const attachTitle = await page.evaluate(
    () => document.querySelector('#pagelens-root')?.shadowRoot?.querySelector('[data-ref="attachTitle"]')?.textContent,
  );
  check('框选后附上裁剪截图', String(attachTitle).includes('框选'), String(attachTitle));

  await ask(page, '框选的这个图表说明了什么？');
  await waitFor(() => mock.requests.length >= 2, { timeout: 15000, message: 'mock 收到框选请求' });
  const second = await waitForAssistant(page, 0);
  check('框选问题得到回答', second.text.includes('框选区域'), second.text.slice(0, 40).replace(/\s+/g, ' '));

  const req3 = mock.requests[1];
  const cropSize = req3.imageParts[0]?.size;
  check(
    '框选截图被裁剪成更小的图',
    Boolean(cropSize) && cropSize.width < 1440 && cropSize.height < 960,
    `crop=${JSON.stringify(cropSize)}`,
  );
  check('请求上下文中标明是框选局部', req3.contextText.includes('用户框选'));

  await page.waitForTimeout(3200); // 等截图提示浮层消失，截图更干净
  await page.screenshot({ path: path.join(DOCS, 'demo-region.png') });

  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

  // ---------- mock: 设置页可打开 ----------
  const optionsPage = await context.newPage();
  const optionsErrors = [];
  optionsPage.on('pageerror', (err) => optionsErrors.push(String(err)));
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.waitForTimeout(1200);
  check('设置页正常渲染', await optionsPage.locator('.hero-status').isVisible());
  check('设置页无未捕获异常', optionsErrors.length === 0, optionsErrors.join(' | '));

  // ---------- real bridge: 真实 DeepSeek 视觉回答 ----------
  if (bridge) {
    log('切换到本机桥接，使用真实 deepseek-flash 视觉模型…');
    await forceSettings(
      worker,
      baseSettings({
        mode: 'bridge',
        bridgeUrl: BRIDGE_URL,
        bridgeToken: bridge.token,
        apiBaseUrl: 'https://api.deepseek.com',
        apiKey: '',
      }),
    );

    const realPage = await context.newPage();
    const realErrors = [];
    realPage.on('pageerror', (err) => realErrors.push(String(err)));
    await realPage.goto(siteUrl, { waitUntil: 'load' });
    await waitForHost(realPage);
    await openPanel(realPage);
    await realPage.mouse.move(10, 10);

    await ask(realPage, '用两句话说明这个页面是做什么的，并指出最需要注意的一个指标。');
    const realAnswer = await waitFor(
      async () => {
        const items = await assistantTexts(realPage);
        const item = items[0];
        if (!item || item.streaming) return null;
        if (item.error) throw new Error(item.error);
        return item.text.length > 20 ? item : null;
      },
      { timeout: 120000, interval: 350, message: '真实模型回答' },
    );
    check('真实 DeepSeek 视觉模型回答成功', realAnswer.text.length > 20, realAnswer.text.slice(0, 80).replace(/\s+/g, ' '));
    check('真实回答提到了页面指标', /128,430|4\.86|CPA|转化/.test(realAnswer.text));
    await realPage.waitForTimeout(800);
    await realPage.screenshot({ path: path.join(DOCS, 'pagelens-demo.png') });
    check('真实页面无未捕获异常', realErrors.length === 0, realErrors.join(' | '));

    // 设置页此时处于 bridge 模式，会显示真实连接状态，顺便截一张。
    await optionsPage.reload();
    await optionsPage.waitForTimeout(2200);
    await optionsPage.screenshot({ path: path.join(DOCS, 'pagelens-options.png') });
  } else {
    log('跳过真实模型测试（桥接未运行或没有 Key）');
    await optionsPage.screenshot({ path: path.join(DOCS, 'pagelens-options.png') });
  }

  // 输出 mock 收到的请求摘要，便于排查
  fs.writeFileSync(
    path.join(ARTIFACTS, 'mock-requests.json'),
    JSON.stringify(
      mock.requests.map((request) => ({
        index: request.index,
        model: request.model,
        images: request.imageParts,
        hasPageContext: /页面可见文字|页面】/.test(request.contextText),
      })),
      null,
      2,
    ),
  );

  if (extensionErrors.length) {
    console.log(`\n页面 console.error（${extensionErrors.length} 条）：`);
    for (const error of extensionErrors.slice(0, 10)) console.log(`  - ${error}`);
  }
} catch (err) {
  failures += 1;
  console.error('\nE2E 异常：', err);
} finally {
  try {
    await context?.close();
  } catch {
    // ignore
  }
  await mock.stop().catch(() => {});
  await site.stop().catch(() => {});
  fs.rmSync(profileDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'E2E 全部通过' : `E2E 有 ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
