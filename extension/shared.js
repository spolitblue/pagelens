// PageLens 共享常量与设置归一化（background / options 共用）

export const SETTINGS_KEY = 'pagelens.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  // 连接方式：bridge = 复用本机 DSH 的 DeepSeek Key；direct = 在扩展里填 API Key
  mode: 'bridge',
  bridgeUrl: 'http://127.0.0.1:8790',
  bridgeToken: '',
  apiBaseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  // off | low | high | max
  thinking: 'off',
  maxTokens: 2048,
  temperature: 0.6,
  // 截图与上下文
  autoCapture: true,
  includePageContext: true,
  maxImageWidth: 1440,
  imageQuality: 0.85,
  // 外观
  theme: 'dark',
});

export const MODEL_PRESETS = Object.freeze([
  {
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    note: '支持图片输入，快，默认推荐',
    vision: true,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    note: '更强，但当前目录仅文本输入，不适合截图问答',
    vision: false,
  },
]);

export const THINKING_PRESETS = Object.freeze([
  { id: 'off', name: '关闭', note: '最快，适合看图问答' },
  { id: 'low', name: '低', note: '少量思考' },
  { id: 'high', name: '高', note: '更稳，稍慢' },
  { id: 'max', name: '最高', note: '最慢，最费 token' },
]);

export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_SETTINGS, ...input };

  out.mode = out.mode === 'direct' ? 'direct' : 'bridge';
  out.bridgeUrl = cleanUrl(out.bridgeUrl, DEFAULT_SETTINGS.bridgeUrl);
  out.bridgeToken = String(out.bridgeToken || '').trim();
  out.apiBaseUrl = cleanUrl(out.apiBaseUrl, DEFAULT_SETTINGS.apiBaseUrl);
  out.apiKey = String(out.apiKey || '').trim();
  out.model = String(out.model || DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model;
  out.thinking = ['off', 'low', 'high', 'max'].includes(out.thinking)
    ? out.thinking
    : DEFAULT_SETTINGS.thinking;

  out.maxTokens = clampInt(out.maxTokens, 256, 8192, DEFAULT_SETTINGS.maxTokens);
  out.temperature = clampNumber(out.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature);
  out.autoCapture = out.autoCapture !== false;
  out.includePageContext = out.includePageContext !== false;
  out.maxImageWidth = clampInt(out.maxImageWidth, 640, 2560, DEFAULT_SETTINGS.maxImageWidth);
  out.imageQuality = clampNumber(out.imageQuality, 0.5, 0.95, DEFAULT_SETTINGS.imageQuality);
  out.theme = ['dark', 'light', 'auto'].includes(out.theme) ? out.theme : DEFAULT_SETTINGS.theme;

  return out;
}

/** 给 content script 的公开设置：绝不包含 API Key / bridgeToken */
export function toPublicSettings(s) {
  return {
    mode: s.mode,
    model: s.model,
    thinking: s.thinking,
    autoCapture: s.autoCapture,
    includePageContext: s.includePageContext,
    maxImageWidth: s.maxImageWidth,
    imageQuality: s.imageQuality,
    theme: s.theme,
    hasCredential:
      s.mode === 'bridge'
        ? Boolean(s.bridgeToken)
        : Boolean(s.apiKey),
  };
}

export function maskSecret(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 8) return '••••••••';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function cleanUrl(value, fallback) {
  const v = String(value || '').trim();
  if (!v) return fallback;
  return v.replace(/\/+$/, '');
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
