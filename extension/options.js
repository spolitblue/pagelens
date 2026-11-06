import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  normalizeSettings,
} from './shared.js';

const $ = (id) => document.getElementById(id);

const els = {
  heroDot: $('heroDot'),
  heroStatus: $('heroStatus'),
  version: $('version'),
  welcomeBanner: $('welcomeBanner'),
  modeCards: [...document.querySelectorAll('.mode-card')],
  panes: [...document.querySelectorAll('[data-pane]')],
  bridgeUrl: $('bridgeUrl'),
  bridgeToken: $('bridgeToken'),
  toggleBridgeToken: $('toggleBridgeToken'),
  apiBaseUrl: $('apiBaseUrl'),
  apiKey: $('apiKey'),
  toggleApiKey: $('toggleApiKey'),
  pairBtn: $('pairBtn'),
  testBtn: $('testBtn'),
  testDirectBtn: $('testDirectBtn'),
  connectionResult: $('connectionResult'),
  resultIcon: $('resultIcon'),
  resultTitle: $('resultTitle'),
  resultDetail: $('resultDetail'),
  modelChips: $('modelChips'),
  dismissResult: $('dismissResult'),
  model: $('model'),
  thinking: $('thinking'),
  maxTokens: $('maxTokens'),
  temperature: $('temperature'),
  autoCapture: $('autoCapture'),
  includePageContext: $('includePageContext'),
  maxImageWidth: $('maxImageWidth'),
  maxImageWidthOut: $('maxImageWidthOut'),
  imageQuality: $('imageQuality'),
  imageQualityOut: $('imageQualityOut'),
  theme: $('theme'),
  shortcutList: $('shortcutList'),
  shortcutSettingsLink: $('shortcutSettingsLink'),
  saveBtn: $('saveBtn'),
  reloadBtn: $('reloadBtn'),
  saveStatus: $('saveStatus'),
  toast: $('toast'),
};

let current = normalizeSettings(DEFAULT_SETTINGS);
let autoTesting = false;
let saveStatusTimer = null;
let toastTimer = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function messageBackground(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message || '扩展后台无响应'));
        else resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function toast(text, tone = '') {
  clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.className = `toast show${tone ? ` ${tone}` : ''}`;
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast';
  }, 2800);
}

function setSaveStatus(text, tone = '') {
  clearTimeout(saveStatusTimer);
  els.saveStatus.textContent = text;
  els.saveStatus.className = `save-status${tone ? ` ${tone}` : ''}`;
  if (text && tone !== 'err') {
    saveStatusTimer = setTimeout(() => {
      els.saveStatus.textContent = '';
      els.saveStatus.className = 'save-status';
    }, 3000);
  }
}

function setHero(text, tone = '') {
  els.heroStatus.textContent = text;
  els.heroDot.className = `status-dot${tone ? ` ${tone}` : ''}`;
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value === 'direct'
    ? 'direct'
    : 'bridge';
}

function syncModePanes() {
  const mode = selectedMode();
  for (const card of els.modeCards) {
    card.classList.toggle('is-selected', card.dataset.modeCard === mode);
  }
  for (const pane of els.panes) {
    pane.hidden = pane.dataset.pane !== mode;
  }
}

function updateRangeOutputs() {
  els.maxImageWidthOut.textContent = `${els.maxImageWidth.value}px`;
  els.imageQualityOut.textContent = Number(els.imageQuality.value).toFixed(2);
}

function readForm() {
  return normalizeSettings({
    ...current,
    mode: selectedMode(),
    bridgeUrl: els.bridgeUrl.value,
    bridgeToken: els.bridgeToken.value,
    apiBaseUrl: els.apiBaseUrl.value,
    apiKey: els.apiKey.value,
    model: els.model.value,
    thinking: els.thinking.value,
    maxTokens: els.maxTokens.value,
    temperature: els.temperature.value,
    autoCapture: els.autoCapture.checked,
    includePageContext: els.includePageContext.checked,
    maxImageWidth: els.maxImageWidth.value,
    imageQuality: els.imageQuality.value,
    theme: els.theme.value,
  });
}

function fillForm(settings) {
  const modeInput = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
  if (modeInput) modeInput.checked = true;
  els.bridgeUrl.value = settings.bridgeUrl;
  els.bridgeToken.value = settings.bridgeToken;
  els.apiBaseUrl.value = settings.apiBaseUrl;
  els.apiKey.value = settings.apiKey;
  els.model.value = settings.model;
  els.thinking.value = settings.thinking;
  els.maxTokens.value = settings.maxTokens;
  els.temperature.value = settings.temperature;
  els.autoCapture.checked = settings.autoCapture;
  els.includePageContext.checked = settings.includePageContext;
  els.maxImageWidth.value = settings.maxImageWidth;
  els.imageQuality.value = settings.imageQuality;
  els.theme.value = settings.theme;
  syncModePanes();
  updateRangeOutputs();
}

function hasLocalCredential(settings) {
  return settings.mode === 'bridge' ? Boolean(settings.bridgeToken) : Boolean(settings.apiKey);
}

function renderConnectionResult(kind, title, detail = '', models = []) {
  els.connectionResult.hidden = false;
  els.connectionResult.className = `connection-result ${kind}`;
  els.resultIcon.textContent = kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '×';
  els.resultTitle.textContent = title;

  els.resultDetail.replaceChildren();
  if (detail) {
    const span = document.createElement('span');
    span.textContent = detail;
    els.resultDetail.appendChild(span);
  }

  els.modelChips.replaceChildren();
  for (const model of models.slice(0, 16)) {
    const chip = document.createElement('span');
    chip.className = 'model-chip';
    if (model.id === current.model) chip.classList.add('is-current');
    chip.textContent = model.id || String(model);
    if (Array.isArray(model.input) && model.input.includes('image')) {
      const vision = document.createElement('span');
      vision.className = 'vision';
      vision.textContent = '👁';
      vision.title = '支持图片输入';
      chip.appendChild(vision);
    }
    els.modelChips.appendChild(chip);
  }
}

function clearConnectionResult() {
  els.connectionResult.hidden = true;
  els.modelChips.replaceChildren();
  els.resultDetail.replaceChildren();
}

async function readStorage() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(data[SETTINGS_KEY]);
}

async function saveSettings({ quiet = false } = {}) {
  const next = readForm();
  const previous = current;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  current = next;
  // 后台配对会写入 token，刷新字段值但不覆盖用户正在编辑的其他内容。
  if (next.bridgeToken && els.bridgeToken.value !== next.bridgeToken) {
    els.bridgeToken.value = next.bridgeToken;
  }
  if (!quiet) {
    setSaveStatus('已保存', 'ok');
    toast('设置已保存，网页上的面板会立即生效', 'ok');
  }
  if (previous.mode !== next.mode) syncModePanes();
  return next;
}

function setTesting(active, button) {
  for (const btn of [els.pairBtn, els.testBtn, els.testDirectBtn]) {
    btn.disabled = active;
  }
  if (button) {
    if (active) {
      button.dataset.label = button.textContent;
      button.textContent = '测试中…';
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  }
}

function enableActions(enabled) {
  els.pairBtn.disabled = !enabled;
  els.testBtn.disabled = !enabled;
  els.testDirectBtn.disabled = !enabled;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function testConnection({ quiet = false, skipSave = false } = {}) {
  const mode = selectedMode();
  if (!skipSave) {
    try {
      await saveSettings({ quiet: true });
    } catch (err) {
      renderConnectionResult('err', '保存设置失败', String(err?.message || err));
      setHero('保存失败', 'err');
      return;
    }
  }

  const settings = readForm();
  if (mode === 'direct' && !settings.apiKey) {
    renderConnectionResult('err', '还缺 API Key', '在「直连 API」里填写 DeepSeek API Key，再测试连接。');
    setHero('缺少 API Key', 'warn');
    return;
  }
  if (mode === 'bridge' && !settings.bridgeUrl) {
    renderConnectionResult('err', '还缺桥接地址', '默认地址是 http://127.0.0.1:8790。');
    setHero('缺少桥接地址', 'warn');
    return;
  }

  const button = mode === 'bridge' ? els.testBtn : els.testDirectBtn;
  setTesting(true, button);
  if (!quiet) {
    renderConnectionResult('', '正在连接…', mode === 'bridge' ? '向本机桥接请求模型列表…' : '向 DeepSeek API 请求模型列表…');
    setHero('正在测试连接…');
  }

  try {
    const response = await messageBackground({ type: 'test-connection' });
    if (!response?.ok) {
      throw new Error(response?.error || '测试失败');
    }
    // 桥接模式没有令牌时，后台会自动配对；把新令牌同步回设置页面。
    if (mode === 'bridge') {
      const fresh = await readStorage();
      if (fresh.bridgeToken) {
        current = fresh;
        els.bridgeToken.value = fresh.bridgeToken;
        els.bridgeUrl.value = fresh.bridgeUrl;
      }
    }
    const result = response.result || {};
    const models = Array.isArray(result.models) ? result.models : [];
    const selected = models.find((model) => model.id === settings.model);
    const vision = Array.isArray(selected?.input) ? selected.input.includes('image') : null;
    const warning = !selected
      ? `目录里没有找到 ${settings.model}，模型可能会回退或报错。`
      : vision === false
        ? `${settings.model} 当前不支持图片输入，截图问答会失败。建议换回 deepseek-flash。`
        : '';

    const detailParts = [];
    detailParts.push(mode === 'bridge' ? `桥接：${settings.bridgeUrl}` : `API：${settings.apiBaseUrl}`);
    detailParts.push(
      mode === 'bridge' && settings.bridgeToken
        ? `令牌：已配对（${settings.bridgeToken.length} 位）`
        : mode === 'direct' && settings.apiKey
          ? 'Key：已填写'
          : '',
    );
    detailParts.push(`模型：${settings.model}`);
    if (models.length) detailParts.push(`可用模型：${models.map((m) => m.id).join('、')}`);

    if (warning) {
      renderConnectionResult('warn', '连接成功，但要注意', [detailParts.join('\n'), warning].join('\n\n'), models);
      setHero(`已连接 · 但 ${settings.model} 不适合看图`, 'warn');
      if (!quiet) toast(warning, 'err');
    } else {
      renderConnectionResult('ok', '连接成功', detailParts.join('\n'), models);
      setHero(`已连接 · ${settings.model}`, 'ok');
      if (!quiet) toast('连接成功，可以去网页上提问了', 'ok');
    }
    current = readForm();
  } catch (err) {
    const message = String(err?.message || err || '测试失败');
    const bridgeHint =
      mode === 'bridge'
        ? '\n\n如果桥接没在运行，请双击项目里的「bridge/start-bridge.bat」，看到监听地址后再点测试。'
        : '';
    renderConnectionResult('err', '连接失败', message + bridgeHint);
    setHero('连接失败', 'err');
    if (!quiet) toast(message, 'err');
  } finally {
    setTesting(false, button);
    await refreshButtonState();
  }
}

async function pairBridge() {
  setTesting(true, els.pairBtn);
  const pairButton = els.pairBtn;
  if (pairButton.dataset.label === '自动配对') pairButton.textContent = '配对中…';
  try {
    // 先保存地址与模式，再请求配对。
    await saveSettings({ quiet: true });
    const settings = readForm();
    if (!settings.bridgeUrl) {
      throw new Error('请先填写桥接地址');
    }
    const response = await messageBackground({
      type: 'pair-bridge',
      bridgeUrl: settings.bridgeUrl,
    });
    if (!response?.ok) throw new Error(response?.error || '配对失败');
    const fresh = await readStorage();
    current = fresh;
    els.bridgeToken.value = fresh.bridgeToken;
    els.bridgeUrl.value = fresh.bridgeUrl;
    setSaveStatus('配对成功', 'ok');
    if (response.hasKey) {
      renderConnectionResult('ok', '桥接已连接，并找到了 DeepSeek Key', `桥接：${fresh.bridgeUrl}\nKey 来源：${response.keySource || '本机 DSH 凭据'}`);
      setHero('桥接已连接', 'ok');
      toast('配对成功，正在测试模型连接…', 'ok');
      await testConnection({ quiet: false, skipSave: true });
    } else {
      renderConnectionResult(
        'warn',
        '桥接已连接，但没找到 DeepSeek Key',
        '请确认运行桥接的用户目录里有 ~/.dsh/.credentials.yaml，且包含 DEEPSEEK_API_KEY；或者改用直连模式。',
      );
      setHero('桥接没有 Key', 'warn');
      toast('桥接已连接，但没有找到 Key', 'err');
    }
  } catch (err) {
    renderConnectionResult('err', '配对失败', String(err?.message || err));
    setHero('配对失败', 'err');
    toast(String(err?.message || err || '配对失败'), 'err');
  } finally {
    setTesting(false, els.pairBtn);
    await refreshButtonState();
  }
}

async function refreshButtonState() {
  const mode = selectedMode();
  const settings = readForm();
  const hasIdentity = mode === 'bridge' ? Boolean(settings.bridgeToken) : Boolean(settings.apiKey);
  enableActions(true);
  if (mode === 'bridge' && !hasIdentity) {
    els.testBtn.disabled = false; // 测试会先自动配对
  }
  if (mode === 'direct' && !settings.apiKey) {
    els.testDirectBtn.disabled = false;
  }
  if (!hasLocalCredential(settings)) {
    setHero('尚未连接模型', 'warn');
  }
}

async function bootBridgeStatus() {
  if (selectedMode() !== 'bridge') return;
  const settings = readForm();
  if (settings.bridgeToken) {
    // 有令牌：轻量校验模型列表，顺便确认桥接还活着。
    await testConnection({ quiet: true, skipSave: true });
    return;
  }
  // 没有令牌：尝试自动配对。桥接没开就安静地提示。
  autoTesting = true;
  try {
    const response = await messageBackground({
      type: 'pair-bridge',
      bridgeUrl: settings.bridgeUrl,
    });
    if (response?.ok) {
      const fresh = await readStorage();
      current = fresh;
      els.bridgeToken.value = fresh.bridgeToken;
      els.bridgeUrl.value = fresh.bridgeUrl;
      setHero('桥接已自动配对', 'ok');
      renderConnectionResult('ok', '桥接已自动配对', `桥接：${fresh.bridgeUrl}\n现在可以测试模型连接，或直接去网页上提问。`);
      await testConnection({ quiet: true, skipSave: true });
    } else {
      setHero('等待连接', 'warn');
      renderConnectionResult(
        'warn',
        '桥接不在线',
        '要复用 DSH 的 Key：在项目文件夹双击「bridge/start-bridge.bat」，保持窗口开着，然后点「自动配对」。\n\n也可以切到「直连 API」填写自己的 DeepSeek API Key。',
      );
    }
  } catch (err) {
    setHero('等待连接', 'warn');
    renderConnectionResult(
      'warn',
      '桥接不在线',
      '要复用 DSH 的 Key：在项目文件夹双击「bridge/start-bridge.bat」，保持窗口开着，然后点「自动配对」。\n\n也可以切到「直连 API」填写自己的 DeepSeek API Key。',
    );
  } finally {
    autoTesting = false;
    await refreshButtonState();
  }
}

async function loadShortcuts() {
  try {
    const commands = await chrome.commands.getAll();
    const wanted = commands.filter((command) =>
      ['toggle-panel', 'capture-region'].includes(command.name),
    );
    if (!wanted.length) return;
    const container = document.createElement('div');
    for (const command of wanted) {
      const row = document.createElement('span');
      const label = command.name === 'toggle-panel' ? '打开 / 收起面板' : '框选区域';
      if (command.shortcut) {
        const parts = command.shortcut.split('+');
        for (const part of parts) {
          const kbd = document.createElement('kbd');
          kbd.textContent = part === 'Alt' ? 'Alt' : part === 'Shift' ? 'Shift' : part;
          row.appendChild(kbd);
        }
        row.appendChild(document.createTextNode(` ${label}`));
      } else {
        row.textContent = `${label}：未设置（点下方链接分配）`;
      }
      container.appendChild(row);
    }
    els.shortcutList.replaceChildren(container);
  } catch {
    // keep static hints
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener('change', () => {
    syncModePanes();
    void refreshButtonState();
  });
}

for (const el of document.querySelectorAll('input, select')) {
  if (el.name === 'mode') continue;
  el.addEventListener('change', () => {
    if (el === els.maxImageWidth || el === els.imageQuality) updateRangeOutputs();
    setSaveStatus('有未保存的修改');
    void refreshButtonState();
  });
  if (el.type === 'range') {
    el.addEventListener('input', updateRangeOutputs);
  }
}

els.toggleBridgeToken.addEventListener('click', () => {
  const show = els.bridgeToken.type === 'password';
  els.bridgeToken.type = show ? 'text' : 'password';
  els.toggleBridgeToken.textContent = show ? '隐藏' : '显示';
});

els.toggleApiKey.addEventListener('click', () => {
  const show = els.apiKey.type === 'password';
  els.apiKey.type = show ? 'text' : 'password';
  els.toggleApiKey.textContent = show ? '隐藏' : '显示';
});

els.pairBtn.addEventListener('click', () => void pairBridge());
els.testBtn.addEventListener('click', () => void testConnection({ quiet: false }));
els.testDirectBtn.addEventListener('click', () => void testConnection({ quiet: false }));
els.dismissResult.addEventListener('click', () => clearConnectionResult());

els.saveBtn.addEventListener('click', async () => {
  try {
    await saveSettings({ quiet: false });
    setHero(
      hasLocalCredential(current) ? `已保存 · ${current.model}` : '已保存，但还没连接模型',
      hasLocalCredential(current) ? 'ok' : 'warn',
    );
    void refreshButtonState();
  } catch (err) {
    setSaveStatus('保存失败', 'err');
    toast(String(err?.message || err), 'err');
  }
});

els.reloadBtn.addEventListener('click', async () => {
  try {
    current = await readStorage();
    fillForm(current);
    clearConnectionResult();
    setSaveStatus('');
    setHero(
      hasLocalCredential(current) ? `已读取设置 · ${current.model}` : '等待连接',
      hasLocalCredential(current) ? 'ok' : 'warn',
    );
    toast('已重新读取设置');
  } catch (err) {
    toast(String(err?.message || err), 'err');
  }
});

els.shortcutSettingsLink.addEventListener('click', (event) => {
  event.preventDefault();
  try {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  } catch {
    toast('请手动打开 chrome://extensions/shortcuts');
  }
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    current = await readStorage();
  } catch {
    current = normalizeSettings(DEFAULT_SETTINGS);
  }
  fillForm(current);
  els.version.textContent = `v${chrome.runtime.getManifest().version}`;

  const params = new URLSearchParams(location.search);
  if (params.get('welcome') === '1') els.welcomeBanner.hidden = false;

  setHero(
    hasLocalCredential(current) ? `已保存 · ${current.model}` : '等待连接',
    hasLocalCredential(current) ? 'ok' : 'warn',
  );
  await loadShortcuts();
  await refreshButtonState();
  await bootBridgeStatus();
}

void boot();
