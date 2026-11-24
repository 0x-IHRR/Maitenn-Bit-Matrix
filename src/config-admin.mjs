// 集成配置管理：Telegram、飞书群机器人的合并 / 保存 / 测试。
// 只动对应集成字段，写回 config.json 前备份。
import fs from 'node:fs';
import { CFG, validateTelegram } from './feishu.mjs';

// ---------- Telegram ----------
export function applyTelegramPatch(config, p = {}) {
  const t = {
    enabled: p.enabled === true,
    botToken: String(p.botToken || config.telegram?.botToken || '').trim(),
    chatId: String(p.chatId ?? config.telegram?.chatId ?? '').trim(),
  };
  if (t.enabled) validateTelegram(t);
  config.telegram = t;
}

// ---------- 飞书 ----------
export function applyFeishuPatch(config, { webhook = '', login = false } = {}) {
  const hook = String(webhook || '').trim();
  // 飞书验证码登录靠 webhook 发码：没有 webhook 还开着登录，远程就再也登不进来
  if (login && !hook) throw new Error('开启飞书验证码登录前先填 webhook');
  config.feishuWebhook = hook;
  if (login) config.web = { ...(config.web || {}), login: 'feishu' };
  else if (config.web) delete config.web.login;
  return { webhook: config.feishuWebhook, login: !!(config.web && config.web.login === 'feishu') };
}

// 写回 config.json；失败抛错（调用方负责回滚内存）
export function saveConfig(config) {
  fs.copyFileSync(CFG, CFG + '.bak');
  fs.writeFileSync(CFG, JSON.stringify(config, null, 2) + '\n');
}
