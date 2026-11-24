import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CFG = process.env.MAITIAN_CONFIG || path.join(ROOT, 'config.json');
if (!fs.existsSync(CFG)) { console.error('还没有配置：直接 npm start，会在 data/config.json 写入只读监控配置；也可以从 config.example.json 复制。'); process.exit(1); }
export const config = JSON.parse(fs.readFileSync(CFG, 'utf8'));

// ---------- 文字 → 飞书卡片（2026-11-14） ----------
// 调用方仍然传文字：第一行当标题，开头的表情决定卡片颜色；「平台：状态（说明） 链接」这种行排成带颜色的状态行。
const COLOR = [[/^(✅|🎉)/, 'green'], [/^(👉|⏰)/, 'orange'], [/^❌/, 'red'], [/^⚠️/, 'yellow'], [/^🚀/, 'blue'], [/^(📋|🔗)/, 'wathet'], [/^🩺/, 'turquoise'], [/^(📊|📈)/, 'purple'], [/^🌐/, 'indigo']];
const PLAT = /^(B站|小红书|抖音|视频号|YouTube|X|知识站)：([^（(\s]+)(?:[（(](.*)[)）])?\s*(https?:\/\/\S+)?\s*$/;
const STATE_COLOR = (s) => /已发布|已上线/.test(s) ? 'green' : /已定时|已填好/.test(s) ? 'blue' : /待你点发布/.test(s) ? 'orange' : /异常|未登录|失败/.test(s) ? 'red' : 'grey';
const esc = (s) => String(s).replace(/[<>]/g, (c) => ({ '<': '&lt;', '>': '&gt;' }[c]));
const link = (s) => esc(s).replace(/https?:\/\/[^\s；;，,）)]+/g, (u) => `[${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 42)}${u.length > 50 ? '…' : ''}](${u})`);

function webUrl() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tunnel.json'), 'utf8')).url; } catch { return ''; } }

export function toCard(text) {
  const lines = String(text).split('\n').map((l) => l.trim());
  const head = lines.shift() || '麦田';
  const template = (COLOR.find(([re]) => re.test(head)) || [null, 'blue'])[1];
  // 标题太长（比如「✅ 期名」）：期名放标题，后半句放副标题
  const [title, ...restHead] = head.split(/\s*[|｜]\s*(?=[^|｜]*$)/);
  const elements = [];
  let buf = [], rows = [];
  const flushText = () => { if (buf.length) { elements.push({ tag: 'markdown', content: buf.map(link).join('\n') }); buf = []; } };
  const flushRows = () => {
    if (!rows.length) return;
    elements.push({ tag: 'markdown', content: rows.map(([, p, st, detail, url]) => `**${p}**　<font color='${STATE_COLOR(st)}'>${esc(st)}</font>${detail ? `　<font color='grey'>${esc(detail.length > 46 ? detail.slice(0, 46) + '…' : detail)}</font>` : ''}${url ? `　[打开](${url})` : ''}`).join('\n') });
    rows = [];
  };
  for (const l of lines) {
    if (!l) { flushText(); flushRows(); continue; }
    const m = l.match(PLAT);
    if (m) { flushText(); rows.push(m); } else { flushRows(); buf.push(l); }
  }
  flushText(); flushRows();
  if (!elements.length) elements.push({ tag: 'markdown', content: link(head) });
  const url = webUrl();
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `麦田 · ${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).slice(5, 16)}` }] });
  if (url) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开麦田' }, type: 'primary', url }] });
  return { config: { wide_screen_mode: true }, header: { template, title: { tag: 'plain_text', content: title.slice(0, 80) }, ...(restHead.length ? { subtitle: { tag: 'plain_text', content: restHead.join(' ').slice(0, 80) } } : {}) }, elements };
}

async function post(body, webhook = config.feishuWebhook) {
  const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return r.json().catch(() => ({}));
}

// 飞书卡片发不出去就退回纯文字；失败只打印，不影响其他通知通道
async function notifyFeishu(text) {
  if (!config.feishuWebhook) return;
  try {
    let j = await post({ msg_type: 'interactive', card: toCard(text) });
    if (j.code && j.code !== 0) { console.error('飞书卡片被拒，改发文字：', JSON.stringify(j)); j = await post({ msg_type: 'text', content: { text } }); }
    if (j.code && j.code !== 0) console.error('飞书返回：', JSON.stringify(j));
  } catch (e) { console.error('飞书通知失败：', e.message); }
}

export function validateTelegram(t = {}) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(t.botToken || '')) throw new Error('请填写有效的 Bot Token');
  if (!/^(?:-?\d+|@[A-Za-z0-9_]+)$/.test(t.chatId || '')) throw new Error('请填写有效的 Chat ID');
}

async function sendTelegram(text, t) {
  validateTelegram(t);
  try {
    // 每段最多 2000 个字符，兼容 Telegram 的 4096 字符上限和 emoji。
    const chars = Array.from(String(text));
    for (let i = 0; i < chars.length; i += 2000) {
      const r = await fetch(`https://api.telegram.org/bot${t.botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: t.chatId, text: chars.slice(i, i + 2000).join('') }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      if (!r.ok || j.ok !== true) throw new Error(j.description || `Telegram 返回 HTTP ${r.status}`);
    }
  } catch (e) { throw new Error(String(e.message).split(t.botToken).join('[已隐藏]')); }
}

export async function testTelegram(t) {
  try {
    await sendTelegram('麦田 · 集成测试 ✅\n这是一条从系统页发出的测试消息。', t);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function notify(text, { quiet = false } = {}) {
  if (!quiet) console.log(`[通知] ${text.replace(/\n/g, ' | ')}`);
  await Promise.all([
    notifyFeishu(text),
    // quiet 用于飞书登录验证码，不将验证码转发到 Telegram。
    !quiet && config.telegram?.enabled
      ? sendTelegram(text, config.telegram).catch(e => console.error('Telegram 通知失败：', e.message))
      : null,
  ]);
}

// 系统页「测试发送」：用给定的 webhook 发一条文字消息，返回成功/失败原因
export async function testFeishu(webhook) {
  if (!webhook) return { ok: false, error: '先填 webhook' };
  try {
    const j = await post({ msg_type: 'text', content: { text: '麦田 · 集成测试 ✅\n这是一条从系统页发出的测试消息。' } }, webhook);
    if (j && j.code !== undefined && j.code !== 0) return { ok: false, error: (j.msg && String(j.msg).slice(0, 200)) || JSON.stringify(j).slice(0, 200) };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
