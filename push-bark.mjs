// 多后端推送。配置优先级：环境变量 > ./push-config.json > %USERPROFILE%\.dsh\bark.json
//
// 支持两种 provider：
//   "bark"    标准 Bark 协议：GET {barkUrl}/{title}/{body}
//   "webhook" 任意 HTTP 接口：用模板拼 URL / 请求体，适配未知格式的推送服务
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadConfig() {
  const candidates = [join(HERE, 'push-config.json'), join(process.env.USERPROFILE || '', '.dsh', 'bark.json')];
  let cfg = {};
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j && (j.barkUrl || j.webhook?.url || j.provider)) { cfg = j; break; }
    } catch (e) {
      console.warn(`配置解析失败 ${p}: ${e.message}`);
    }
  }
  const webhookUrl = process.env.PUSH_WEBHOOK_URL || cfg.webhook?.url || '';
  const provider = process.env.PUSH_PROVIDER || cfg.provider || (webhookUrl ? 'webhook' : 'bark');
  return {
    provider,
    barkUrl: process.env.BARK_URL || cfg.barkUrl || '',
    group: cfg.group || 'DSH盘后',
    level: cfg.level || 'active',
    sound: cfg.sound || '',
    webhook: {
      url: webhookUrl,
      method: (cfg.webhook?.method || 'POST').toUpperCase(),
      contentType: cfg.webhook?.contentType || 'application/json',
      // 模板变量: {title} {body} {group}
      body: cfg.webhook?.body ?? '{"title":"{title}","body":"{body}","group":"{group}"}',
      headers: cfg.webhook?.headers || {},
    },
  };
}

const fill = (tpl, vars) => String(tpl).replace(/\{(title|body|group)\}/g, (_, k) => vars[k] ?? '');

/** 发送一条推送。返回 { ok, message } */
export async function push(title, body, opts = {}) {
  const cfg = loadConfig();
  const vars = { title, body, group: opts.group ?? cfg.group };

  try {
    if (cfg.provider === 'bark') {
      if (!cfg.barkUrl) return { ok: false, message: '未配置 Bark 地址（barkUrl 或 BARK_URL）' };
      const params = new URLSearchParams({ group: vars.group, level: opts.level ?? cfg.level });
      if (cfg.sound) params.set('sound', cfg.sound);
      const url = `${cfg.barkUrl.replace(/\/+$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${params}`;
      return await fire(url, 'GET');
    }

    if (cfg.provider === 'webhook') {
      if (!cfg.webhook.url) return { ok: false, message: '未配置 webhook.url（或 PUSH_WEBHOOK_URL）' };
      const url = fill(cfg.webhook.url, vars);
      const init = {
        method: cfg.webhook.method,
        headers: { 'Content-Type': cfg.webhook.contentType, ...cfg.webhook.headers },
      };
      if (cfg.webhook.method !== 'GET') {
        const payload = fill(cfg.webhook.body, vars);
        init.body = cfg.webhook.contentType.includes('json') ? payload : new URLSearchParams({ raw: payload }).toString();
      }
      const r = await fire(url, init.method, init);
      // 未知格式的服务：只要 HTTP 2xx 且响应体不像错误就算成功
      if (r.ok && /无效数据|invalid|error|失败|fail/i.test(r.body || '')) {
        return { ok: false, message: `HTTP ${r.status} 响应疑似失败: ${r.body.slice(0, 120)}` };
      }
      return r.ok ? { ok: true, message: 'sent' } : { ok: false, message: `HTTP ${r.status} ${r.body?.slice(0, 120)}` };
    }

    return { ok: false, message: `未知 provider: ${cfg.provider}` };
  } catch (e) {
    return { ok: false, message: `${e.cause?.code ?? e.message}` };
  }
}

async function fire(url, method = 'GET', init = {}) {
  const res = await fetch(url, { method, ...init });
  const text = await res.text().catch(() => '');
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (res.ok && j && j.code !== undefined && String(j.code) !== '200') {
    return { ok: false, status: res.status, body: text };
  }
  return { ok: res.ok, status: res.status, body: text };
}

// 命令行: node push-bark.mjs "标题" "内容"
if (process.argv[1] && process.argv[1].endsWith('push-bark.mjs')) {
  const [title = 'DSH 测试推送', body = '如果你收到这条，说明推送配置正确。'] = process.argv.slice(2);
  const cfg = loadConfig();
  console.log(`provider=${cfg.provider}`);
  const r = await push(title, body);
  console.log(r.ok ? '✓ 推送成功' : `✗ 推送失败: ${r.message}`);
  process.exit(r.ok ? 0 : 1);
}
