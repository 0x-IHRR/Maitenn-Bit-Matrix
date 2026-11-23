import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-tg-'));
process.env.MAITIAN_CONFIG = path.join(dir, 'config.json');
fs.writeFileSync(process.env.MAITIAN_CONFIG, '{}');
const { config, notify, testTelegram } = await import('../src/feishu.mjs');
const { applyTelegramPatch } = await import('../src/config-admin.mjs');
const realFetch = globalThis.fetch;
const tg = { enabled: true, botToken: '123:TEST_TOKEN', chatId: '-100123' };
after(() => { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }); });

test('独立发送 Telegram，并拆分长消息而不破坏 emoji', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true }) }; };
  config.telegram = tg; delete config.feishuWebhook;
  const text = '🙂'.repeat(4500);
  await notify(text);
  assert.equal(calls.length, 3);
  assert.equal(calls.map(c => c.body.text).join(''), text);
  assert.ok(calls.every(c => c.body.chat_id === tg.chatId && c.body.text.length <= 4096));
});

test('Telegram 失败不影响飞书；错误不泄露 Token', async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(url); if (url.includes('api.telegram.org')) throw new Error('failed ' + tg.botToken); return { json: async () => ({ code: 0 }) }; };
  config.feishuWebhook = 'https://feishu.test';
  await notify('双通道');
  assert.equal(calls.length, 2);
  const r = await testTelegram(tg);
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(tg.botToken));
});

test('停用 Telegram 不发送；飞书验证码不转发', async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(url); return { json: async () => ({ code: 0 }) }; };
  config.telegram = { ...tg, enabled: false }; await notify('普通通知');
  config.telegram = tg; await notify('验证码', { quiet: true });
  assert.deepEqual(calls, ['https://feishu.test', 'https://feishu.test']);
});

test('Telegram API 拒绝和无效配置返回明确错误', async () => {
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false, description: 'chat not found' }) });
  assert.match((await testTelegram(tg)).error, /chat not found/);
  assert.match((await testTelegram({})).error, /Bot Token/);
});

test('保存时保留已有 Token；校验失败不更改配置', () => {
  config.telegram = tg;
  applyTelegramPatch(config, { enabled: true, botToken: '', chatId: '@channel' });
  assert.equal(config.telegram.botToken, tg.botToken);
  assert.equal(config.telegram.chatId, '@channel');
  const before = structuredClone(config);
  assert.throws(() => applyTelegramPatch(config, { enabled: true, chatId: '' }), /Chat ID/);
  assert.deepEqual(config, before);
});
