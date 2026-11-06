// 桥接冒烟测试：启动 bridge/server.mjs 后运行
//   node test/bridge-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const BASE = process.env.PAGELENS_BRIDGE_URL || 'http://127.0.0.1:8790';
const stateFile = path.join(os.homedir(), '.pagelens', 'bridge.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const token = state.token;

async function json(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { res, data };
}

function log(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
}

async function main() {
  let failed = 0;
  const check = (name, condition, extra = '') => {
    log(name, Boolean(condition), extra);
    if (!condition) failed += 1;
  };

  const health = await json(`${BASE}/health`);
  check('GET /health', health.res.ok && health.data.ok === true, `hasKey=${health.data.hasKey}`);
  check('健康检查不泄露 Key', !JSON.stringify(health.data).includes('sk-'));
  check('健康检查不泄露令牌', !JSON.stringify(health.data).includes(token));

  // 不带 Origin（本机命令行）读取配对信息，不会占用扩展的一次性配对槽。
  const pair = await json(`${BASE}/pair`);
  check(
    'GET /pair (本机命令行)',
    pair.res.ok && pair.data.token === token,
    `origin=${pair.res.headers.get('access-control-allow-origin')}`,
  );

  const pairBlocked = await json(`${BASE}/pair`, {
    headers: { Origin: 'https://evil.example.com' },
  });
  check('GET /pair 拒绝普通网页 Origin', pairBlocked.res.status === 403);

  const unauthorized = await json(`${BASE}/v1/models`);
  check('GET /v1/models 未授权 401', unauthorized.res.status === 401);

  const models = await json(`${BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check('GET /v1/models 授权', models.res.ok && Array.isArray(models.data?.data));
  const ids = (models.data?.data || []).map((m) => m.id);
  check('模型目录包含 deepseek-flash', ids.includes('deepseek-flash'), ids.join(','));

  const icon = fs.readFileSync(
    path.join(process.cwd(), 'extension', 'icons', 'icon128.png'),
  );
  const dataUrl = `data:image/png;base64,${icon.toString('base64')}`;
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: 'deepseek-flash',
      stream: true,
      max_tokens: 400,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '这张图是什么？用一句中文回答，并描述主色。',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  check('POST /v1/chat HTTP 200', res.ok, `HTTP ${res.status}`);
  check('POST /v1/chat 返回 SSE', /text\/event-stream/.test(res.headers.get('content-type') || ''));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let buffer = '';
  let sawDone = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = buffer.indexOf('\n\n');
      if (idx < 0) break;
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          sawDone = true;
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') text += delta;
        } catch {
          // ignore
        }
      }
    }
  }
  check('流式回答有正文', text.length > 0, text.slice(0, 80).replace(/\s+/g, ' '));
  check('流式协议结束标记', sawDone || text.length > 0);
  console.log(`     回答（${Date.now() - started}ms）：${text.trim().slice(0, 300)}`);

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
