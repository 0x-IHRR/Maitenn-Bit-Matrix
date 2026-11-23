import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { collectAccount, postKey } from './collector.mjs';
import { fault } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function usable(dir) {
  if (!dir) return false;
  try { await fs.access(path.join(dir, 'lib/publish.js')); await fs.access(path.join(dir, 'lib/cdp.js')); return true; } catch { return false; }
}
// Engine code is an explicit dependency, never discovered through another app's browser profile.
export async function engineDirectory(config = {}) {
  const configured = config.pluginDir;
  if (configured != null && (typeof configured !== 'string' || !configured.trim())) throw fault('error', 'pluginDir 须填写麦田采集引擎代码目录');
  const dir = configured ? path.resolve(root, configured.replace(/^~(?=\/|$)/, os.homedir())) : path.join(root, 'vendor/maitian-publisher');
  if (await usable(dir)) return dir;
  throw fault('error', configured ?
    '配置的采集引擎目录缺少 lib/publish.js 或 lib/cdp.js，请检查本项目配置中的 pluginDir' :
    '尚未配置采集引擎代码：请在本项目配置中设置 pluginDir，或将代码依赖放入 vendor/maitian-publisher；无需接入原麦田运行实例');
}

function runWorker(configPath, input) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./native-sync-worker.mjs', import.meta.url), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, MAITIAN_CONFIG: configPath, HUB_DRIVER: 'direct', NO_PROXY: 'localhost,127.0.0.1,::1' } });
    let settled = false;
    const finish = (error, data) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(data); };
    const timer = setTimeout(() => finish(fault('error', '原生取链接任务超时；保留原有数据')), 300_000);
    child.on('error', () => finish(fault('error', '无法启动原生取链接进程')));
    child.on('exit', code => { if (!settled) finish(fault('error', `原生取链接进程提前结束（${code}）`)); });
    child.on('message', message => message.error ? finish(fault(message.error.code || 'error', message.error.message)) : finish(null, message));
    child.send(input);
  });
}

// Uses an isolated copy of driver.links; it never imports hub/daemon or writes source projects/DBs.
export async function syncAccount(account, bit) {
  const before = await collectAccount({ ...account, posts: [] }, bit);
  const endpoint = await bit.endpoint(account.profileId);
  const configFile = process.env.MAITIAN_CONFIG || path.join(root, 'config.json');
  let config;
  try { config = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch { throw fault('error', '无法读取本项目运行配置'); }
  const pluginDir = await engineDirectory(config);
  const projects = [], warnings = [];
  for (const post of account.posts || []) {
    if (!post.projectPath || !path.isAbsolute(post.projectPath)) { warnings.push({ id: post.id, reason: '缺少已归属的原工程目录' }); continue; }
    try {
      const file = path.join(post.projectPath, 'publish.json');
      if ((await fs.stat(file)).size > 4 * 1024 * 1024) throw new Error('工程文件过大');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!data.platforms?.[account.platform]) throw new Error('原工程没有该平台配置');
      projects.push({ id: post.id, data });
    } catch { warnings.push({ id: post.id, reason: '无法读取原工程平台配置；保留现有记录' }); }
  }
  if (!projects.length) return { ...before, postUpdates: [], warnings: [...before.warnings, ...warnings] };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bt-maitian-sync-'));
  let result;
  try {
    await fs.chmod(dir, 0o700);
    const privateConfig = path.join(dir, 'config.json');
    // Copy only driver requirements. Notification tokens and platform credentials never enter the worker config.
    await fs.writeFile(privateConfig, JSON.stringify({ chromePort: endpoint.port, bitBrowserWs: endpoint.ws, driver: 'direct', bitBrowser: true, plugin: 'local', pluginDir }), { mode: 0o600 });
    result = await runWorker(privateConfig, { platform: account.platform, identity: account.identity, projects });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  const postUpdates = [];
  for (const update of result.updates || []) {
    const post = account.posts.find(p => p.id === update.id);
    if (!post) continue;
    if (update.url && !postKey(account.platform, update.url)) { warnings.push({ id: post.id, reason: '原生返回的作品链接不受当前平台支持，未保存' }); continue; }
    postUpdates.push({ id: post.id, url: update.url || post.url || '', status: update.status, detail: [post.detail, update.note, update.time].filter(Boolean).join('；') });
  }
  // A fresh endpoint lookup and identity check catch Profile exits/restarts or a user switching accounts mid-task.
  if ((await bit.endpoint(account.profileId)).ws !== endpoint.ws) throw fault('identity', '环境连接在取链接期间发生变化，请重新检查');
  const updated = (account.posts || []).map(p => ({ ...p, ...postUpdates.find(u => u.id === p.id) }));
  const after = await collectAccount({ ...account, posts: updated }, bit);
  return { ...after, postUpdates, warnings: [...warnings, ...(result.warnings || []), ...(after.warnings || [])], source: '麦田原生取链接 / ' + after.source };
}
