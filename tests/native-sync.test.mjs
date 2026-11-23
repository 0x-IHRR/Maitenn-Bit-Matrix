import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runNativeLinks } from '../src/matrix/native-sync-worker.mjs';
import { syncAccount, engineDirectory } from '../src/matrix/native-sync.mjs';

function mockDriver(data = { identity: 'example' }, attack = false) {
  const calls = [], chrome = {
    tabs: {
      async create() { calls.push('create'); return { id: 1000 }; },
      async remove(id) { calls.push(['remove', id]); },
    },
    debugger: { async sendCommand(target, method, params) {
      calls.push([method, target.tabId, params?.expression]);
      return { result: { value: data } };
    } },
  };
  const driver = {
    async ensure() { globalThis.chrome = chrome; },
    async links(project, ids) {
      assert.deepEqual(ids, ['x']);
      assert.equal(project.data.platforms.x.text, 'original');
      const page = await chrome.tabs.create({ url: 'https://x.com/home' });
      // Like native collectLinks, catches platform errors and always attempts cleanup.
      try {
        await chrome.debugger.sendCommand({ tabId: attack ? 777 : page.id }, 'Runtime.evaluate', { expression: "(location.href='https://x.com/example',1)" });
        return { x: { status: '已发布', url: 'https://x.com/example/status/123' } };
      } catch { return { x: { status: '出错', url: '' } }; }
      finally { await chrome.tabs.remove(page.id).catch(() => {}); }
    },
    async close() { calls.push('disconnect'); },
  };
  return { driver, calls };
}
const input = { platform: 'x', identity: 'example', projects: [{ id: 'post1', data: { platforms: { x: { text: 'original' } } } }] };
test('native sync calls original links, isolates created tabs, and cleans only its own page', async t => {
  const previous = globalThis.chrome; t.after(() => { globalThis.chrome = previous; });
  const { driver, calls } = mockDriver();
  const result = await runNativeLinks(input, driver);
  assert.equal(result.updates[0].url, 'https://x.com/example/status/123');
  assert.deepEqual(calls.filter(c => Array.isArray(c) && c[0] === 'remove'), [['remove', 1000]]);
  assert.equal(calls.at(-1), 'disconnect');
});
test('native catch/finally cannot swallow risk, login or account mismatch; pages stay open', async t => {
  const previous = globalThis.chrome; t.after(() => { globalThis.chrome = previous; });
  for (const [data, code] of [[{ risk: '明确限流' }, 'risk'], [{ login: true }, 'login'], [{ identity: 'other' }, 'mismatch'], [{}, 'identity']]) {
    const { driver, calls } = mockDriver(data);
    let reported;
    await assert.rejects(runNativeLinks(input, driver, e => { reported = e; }), { code });
    assert.equal(reported.code, code);
    assert.equal(calls.some(c => Array.isArray(c) && c[0] === 'remove'), false);
    assert.equal(calls.filter(c => Array.isArray(c) && c[0] === 'Runtime.evaluate').some(c => /location.href=/.test(c[2] || '')), false);
  }
});
test('native code cannot use a pre-existing tab', async t => {
  const previous = globalThis.chrome; t.after(() => { globalThis.chrome = previous; });
  const { driver, calls } = mockDriver({ identity: 'example' }, true);
  await assert.rejects(runNativeLinks(input, driver), /原有页面/);
  assert.equal(calls.some(c => Array.isArray(c) && c[1] === 777), false);
});
test('offline sync fails before worker creation or any implicit open', async () => {
  let opened = false;
  await assert.rejects(syncAccount({ profileId: 'off', platform: 'x', identity: 'example', posts: [] }, {
    async connect() { throw Object.assign(new Error('未运行'), { code: 'offline' }); },
    async open() { opened = true; },
  }), { code: 'offline' });
  assert.equal(opened, false);
});

test('Bit-mode native driver never falls back to creating a dedicated Chrome profile', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bt-shim-test-'));
  const server = http.createServer((req, res) => { res.writeHead(503); res.end('unavailable'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = path.join(dir, 'must-not-create');
  const config = path.join(dir, 'config.json');
  try {
    await fs.writeFile(config, JSON.stringify({ bitBrowser: true, chromePort: server.address().port, chromeProfile: profile }), { mode: 0o600 });
    const moduleUrl = new URL('../src/chrome-shim.mjs', import.meta.url).href;
    const script = `const shim=await import(${JSON.stringify(moduleUrl)});try{await shim.launchChrome();process.exitCode=2}catch(e){console.log(e.code)}`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, MAITIAN_CONFIG: config, NO_PROXY: 'localhost,127.0.0.1,::1' }, timeout: 10000 });
    assert.equal(stdout.trim(), 'offline');
    await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('engine lookup ignores old Chrome profile settings and accepts only explicit code dependency', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bt-engine-test-'));
  try {
    const oldProfile = path.join(dir, 'chrome-profile');
    const oldEngine = path.join(oldProfile, 'Default/Extensions/eaaipbilkhibicihiollecmbpneikpnj/0.5.1_0');
    await fs.mkdir(path.join(oldEngine, 'lib'), { recursive: true });
    await fs.writeFile(path.join(oldEngine, 'lib/publish.js'), '');
    await fs.writeFile(path.join(oldEngine, 'lib/cdp.js'), '');
    try {
      const selected = await engineDirectory({ chromeProfile: oldProfile });
      assert.notEqual(selected, oldEngine);
      assert.equal(selected, path.resolve(new URL('../vendor/maitian-publisher', import.meta.url).pathname));
    } catch (error) { assert.match(error.message, /尚未配置采集引擎代码/); }
    assert.equal(await engineDirectory({ pluginDir: oldEngine }), oldEngine);
    await assert.rejects(engineDirectory({ pluginDir: path.join(dir, 'missing'), chromeProfile: oldProfile }), /配置的采集引擎目录缺少/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('项目内采集引擎可独立加载，不需要浏览器资料或旧实例配置',async t=>{
  const previous=globalThis.chrome;t.after(()=>{globalThis.chrome=previous;});
  globalThis.chrome={debugger:{onDetach:{addListener(){}}}};
  const engine=await import('../vendor/maitian-publisher/lib/publish.js');
  assert.equal(typeof engine.collectLinks,'function');assert.equal(typeof engine.ADAPTERS.x.links.collect,'function');
  assert.deepEqual(await engine.collectLinks({data:{platforms:{}}},[]),{});
});
