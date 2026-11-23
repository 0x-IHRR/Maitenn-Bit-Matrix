import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { Store } from '../src/matrix/store.mjs';
import { CollectionQueue } from '../src/matrix/queue.mjs';
import { BitBrowser } from '../src/matrix/browser.mjs';
import { timelineExpression, snapshot } from '../src/matrix/collector.mjs';
import { makeApp } from '../src/matrix/server.mjs';
import { nativeOverview } from '../src/matrix/native-overview.mjs';
import { withOwnedWindow } from '../src/matrix/window.mjs';
import { collectPublicAccount, PUBLIC_HOSTS } from '../src/matrix/public-source.mjs';
import { dueSlot, parseMonitorSettings, randomIntervalMs, runPaced, CollectionScheduler, shanghaiHour } from '../src/matrix/schedule.mjs';
import { isAbsolutePath } from '../src/matrix/paths.mjs';

const morning = new Date('2026-11-23T02:30:00Z');
const evening = new Date('2026-11-23T13:30:00Z');
const statusId = '1234567890123456789';

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, async text() { return text; } };
}
function publicFixture(handle = 'demo') {
  return {
    profile: { code: 200, profile: { screen_name: handle, followers: 40 } },
    statuses: { code: 200, results: [
      { type: 'status', id: statusId, text: '公开帖', likes: 2, replies: 1, reposts: 4, views: 9, bookmarks: 3, author: { screen_name: handle }, created_at: '2026-11-23T01:00:00Z' },
      { type: 'status', id: '2234567890123456789', text: '转帖', reposted_by: { screen_name: handle }, author: { screen_name: 'other' } },
    ] },
  };
}

test('绝对路径同时接受 POSIX、Windows 盘符和 UNC', () => {
  assert.equal(isAbsolutePath('/tmp/maitian'), true);
  assert.equal(isAbsolutePath('C:\\Users\\me\\maitian'), true);
  assert.equal(isAbsolutePath('\\\\server\\share\\maitian'), true);
  assert.equal(isAbsolutePath('projects/maitian'), false);
  assert.equal(isAbsolutePath(''), false);
});

test('采集计划只接受每天 1–2 次、并发 1–2、至少 1 分钟间隔', () => {
  assert.equal(parseMonitorSettings({ collectsPerDay: 2, collectHours: '21,9', concurrency: 2, timelineLimit: 15, intervalMinMinutes: 2, intervalMaxMinutes: 5, scheduleEnabled: '1' }).collectHours.join(','), '9,21');
  assert.throws(() => parseMonitorSettings({ collectsPerDay: 3, collectHours: '1,2,3' }), /1 或 2/);
  assert.throws(() => parseMonitorSettings({ concurrency: 3 }), /并发/);
  assert.throws(() => parseMonitorSettings({ intervalMinMinutes: 0, intervalMaxMinutes: 5 }), /间隔/);
  assert.equal(randomIntervalMs(3, 8, () => 0), 180_000);
  const high = randomIntervalMs(3, 8, () => 0.999);
  assert.ok(high > 180_000 && high <= 480_000);
});

test('到期时段按上海时区，错过的早班不会在晚班再补跑两次', () => {
  assert.equal(shanghaiHour(morning), 10);
  assert.equal(dueSlot([9], [], morning), '2026-11-23#9');
  assert.equal(dueSlot([9, 21], [{ day: '2026-11-23', slot: '2026-11-23#9' }], morning), null);
  assert.equal(dueSlot([9, 21], [{ day: '2026-11-23', slot: '2026-11-23#9' }], evening), '2026-11-23#21');
  assert.equal(dueSlot([9, 21], [{ day: '2026-11-23', slot: 'manual' }, { day: '2026-11-23', slot: 'manual-2' }], evening), null);
  assert.equal(dueSlot([9], [], new Date('2026-11-23T00:30:00Z')), null);
});

test('账号之间才等待，串行时两次间隔，第一号立即开始', async () => {
  const order = [], sleeps = [];
  await runPaced(['a', 'b', 'c'], { concurrency: 1, intervalMs: () => 5, sleep: async ms => sleeps.push(ms), worker: async item => order.push(item) });
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(sleeps, [5, 5]);
});

test('时间线脚本只读取文章，风险出现时不再滚动', async () => {
  function article(id, label) {
    const node = {
      querySelector(selector) {
        if (selector === 'a[href] time') return { closest: () => ({ getAttribute: () => `/demo/status/${id}` }) };
        if (selector === '[data-testid="tweetText"]') return { innerText: `正文 ${id}` };
        if (selector === 'time') return { getAttribute: () => '2026-11-23T01:00:00.000Z' };
        return null;
      },
      querySelectorAll() { return [{ closest: () => node, getAttribute: () => label }]; },
    };
    return node;
  }
  const articles = [article(statusId, '2 likes, 9 views'), article('2234567890123456789', '1 reply')];
  let scrolled = 0;
  const document = {
    body: { innerText: '' },
    querySelector(selector) { return selector.includes('AppTabBar_Profile_Link') ? { getAttribute: () => '/demo' } : null; },
    querySelectorAll(selector) { return selector === 'article' ? articles : []; },
  };
  const context = { document, location: { pathname: '/demo', href: 'https://x.com/demo' }, scrollBy() { scrolled++; }, scrollTo() {}, innerHeight: 800, setTimeout };
  const found = await vm.runInNewContext(timelineExpression('x', 2), context);
  assert.equal(found.identity, 'demo');
  assert.equal(found.posts.length, 2);
  assert.equal(found.posts[0].id, statusId);
  assert.equal(scrolled, 0);
  assert.doesNotMatch(timelineExpression('x', 20), /\.click\(/);
  const toast = { innerText: 'Rate limit exceeded', getBoundingClientRect: () => ({ width: 40, height: 20 }) };
  const risky = { ...document, querySelectorAll(selector) { return selector === 'article' ? articles : selector.includes('role="alert"') ? [toast] : []; } };
  const stopped = await vm.runInNewContext(timelineExpression('x', 20), { ...context, document: risky, scrollBy() { throw new Error('不应继续滚动'); } });
  assert.match(stopped.risk, /限流/);
  assert.equal(snapshot.length > 0, true);
});

test('账号可新增、修改、解绑、停用和删除，自有与对标分组分开', () => {
  const store = new Store(':memory:');
  store.addProfile('p', '环境');
  const owned = store.createAccount({ platform: 'x', identity: 'OwnedUser', group: 'owned', profileId: 'p', notes: '我的号', tags: ['矩阵', '矩阵'], displayName: '自有', confirmed: true });
  const bench = store.createAccount({ platform: 'x', identity: 'bench_user', group: 'benchmark', notes: '对标', tags: '观察,晚高峰' });
  assert.equal(store.account(owned).group, 'owned');
  assert.equal(store.account(owned).active, true);
  assert.deepEqual(store.account(owned).tags, ['矩阵']);
  assert.equal(store.account(bench).group, 'benchmark');
  assert.equal(store.account(bench).profileId, null);
  assert.equal(store.account(bench).active, true);
  store.updateAccount(bench, { notes: '改后备注', tags: ['a', 'b'], enabled: false, displayName: '对标甲' });
  assert.equal(store.account(bench).enabled, false);
  assert.equal(store.account(bench).notes, '改后备注');
  assert.equal(store.unbind(owned), true);
  assert.equal(store.account(owned).active, false);
  assert.equal(store.account(owned).posts.length, 0);
  store.deleteAccount(bench);
  assert.equal(store.account(bench), undefined);
  assert.throws(() => store.createAccount({ platform: 'x', identity: 'owneduser', group: 'benchmark' }), /已存在/);
  store.close();
});

test('发现的帖子会入库并持续追踪，旧帖不因掉出最近 N 条而消失', () => {
  const store = new Store(':memory:');
  store.addProfile('p', '环境');
  const id = store.bind({ profileId: 'p', platform: 'x', identity: 'owned', confirmed: true });
  store.importPosts(id, [{ sourceKey: 'project::x', title: '旧工程帖', url: 'https://x.com/owned/status/100', metrics: { views: 5 }, lastSuccess: '2026-11-20T00:00:00Z' }]);
  store.saveResult(id, { identity: 'owned', followers: 10, source: '主页时间线', discovered: [
    { sourceKey: 'x:status:100', url: 'https://x.com/owned/status/100', title: '旧工程帖', metrics: { views: 8, likes: 1 }, source: '主页时间线' },
    { sourceKey: `x:status:${statusId}`, url: `https://x.com/owned/status/${statusId}`, title: '新帖', metrics: { likes: 2 }, source: '主页时间线' },
  ] });
  assert.equal(store.account(id).posts.length, 2);
  assert.equal(store.account(id).posts.find(post => post.url.endsWith('/status/100')).metrics.views, 8);
  store.saveResult(id, { identity: 'owned', followers: 11, source: '主页时间线', discovered: [
    { sourceKey: `x:status:${statusId}`, url: `https://x.com/owned/status/${statusId}`, title: '新帖', metrics: { likes: 4 }, source: '主页时间线' },
  ] });
  const posts = store.account(id).posts;
  assert.equal(posts.length, 2);
  assert.equal(posts.find(post => post.url.endsWith('/status/100')).metrics.views, 8);
  assert.equal(posts.find(post => post.url.endsWith(`/${statusId}`)).metrics.likes, 4);
  assert.equal(store.account(id).growth, 1);
  store.close();
});

test('每号每天最多采集两次，第三次不再打开采集', async () => {
  const store = new Store(':memory:');
  store.addProfile('p', '环境');
  const id = store.bind({ profileId: 'p', platform: 'x', identity: 'owned', confirmed: true });
  let calls = 0;
  const queue = new CollectionQueue(store, async account => { calls++; return { identity: account.identity, followers: calls, posts: [] }; }, () => ({}));
  assert.equal((await queue.collectAccount(id)).status, 'done');
  assert.equal((await queue.collectAccount(id)).status, 'done');
  assert.equal((await queue.collectAccount(id)).reason, '今日采集已达 2 次上限');
  assert.equal(calls, 2);
  assert.equal(store.account(id).followers, 2);
  store.close();
});

test('自有号只打开本次需要的窗口，用户已打开的不关，登录页保留窗口', async () => {
  const events = [];
  let running = {};
  const bit = {
    async running() { events.push('running'); return { ...running }; },
    async open(id) { events.push(['open', id]); running[id] = 9; },
    async close(id) { events.push(['close', id]); delete running[id]; },
  };
  await withOwnedWindow(bit, 'p', async () => 'ok');
  assert.deepEqual(events, ['running', ['open', 'p'], ['close', 'p']]);
  events.length = 0;
  running = { p: 9 };
  await withOwnedWindow(bit, 'p', async () => 'ok');
  assert.deepEqual(events, ['running']);
  events.length = 0;
  running = {};
  await assert.rejects(withOwnedWindow(bit, 'p', async () => { throw Object.assign(new Error('验证码'), { code: 'risk' }); }), { code: 'risk' });
  assert.deepEqual(events, ['running', ['open', 'p']]);
  assert.equal(running.p, 9);
});

test('比特 close 只打本机 /browser/close', async t => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    res.end(JSON.stringify({ success: true, data: {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const bit = new BitBrowser(`http://127.0.0.1:${server.address().port}`);
  assert.deepEqual(await bit.close('profile-1'), { id: 'profile-1', closed: true });
  assert.deepEqual(paths, ['/browser/close']);
});

test('对标号走公开源，限流立即暂停且不换源重试，其他主机失败才换', async () => {
  const calls = [];
  const ok = publicFixture();
  const result = await collectPublicAccount({ identity: 'Demo', timelineLimit: 20 }, { fetch: async url => {
    calls.push(url);
    if (String(url).includes('/statuses')) return jsonResponse(200, ok.statuses);
    return jsonResponse(200, ok.profile);
  } });
  assert.equal(result.followers, 40);
  assert.equal(result.discovered.length, 1);
  assert.equal(result.discovered[0].metrics.views, 9);
  assert.equal(result.discovered[0].metrics.comments, 1);
  assert.match(calls[0], /^https:\/\/api\.fxtwitter\.com\/2\/profile\/demo$/);
  assert.deepEqual(PUBLIC_HOSTS, ['api.fxtwitter.com', 'api.vxtwitter.com']);
  let fetchCalls = 0;
  await assert.rejects(collectPublicAccount({ identity: 'demo' }, { fetch: async () => { fetchCalls++; return jsonResponse(429, { code: 429 }); } }), { code: 'risk' });
  assert.equal(fetchCalls, 1);
  const hosts = [];
  const recovered = await collectPublicAccount({ identity: 'demo' }, { fetch: async url => {
    hosts.push(new URL(url).hostname);
    if (new URL(url).hostname === 'api.fxtwitter.com') return jsonResponse(500, {});
    return jsonResponse(200, String(url).includes('/statuses') ? ok.statuses : ok.profile);
  } });
  assert.equal(recovered.source, 'api.vxtwitter.com');
  await assert.rejects(collectPublicAccount({ identity: 'demo' }, { hosts: ['evil.test'], fetch: async () => { throw new Error('不应请求未允许的主机'); } }), /允许列表/);
});

async function listen(app) {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}
async function post(base, url, data, extra = {}) {
  return fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...extra.headers }, body: JSON.stringify(data) });
}

test('采集按需开关窗口、发现帖子，且不再读取麦田目录', async () => {
  const store = new Store(':memory:');
  const events = [];
  let running = {};
  const bit = {
    async list() { return [{ id: 'p', name: '环境' }]; },
    async running() { events.push('running'); return { ...running }; },
    async open(id) { events.push(['open', id]); running[id] = 1; },
    async close(id) { events.push(['close', id]); delete running[id]; },
  };
  const app = makeApp({ store, bitFactory: () => bit, collector: async account => {
    events.push(['collect', account.identity, account.timelineLimit]);
    assert.equal(account.projectPath, '');
    return { identity: account.identity, followers: 7, posts: [], discovered: [{ sourceKey: `x:status:${statusId}`, url: `https://x.com/${account.identity}/status/${statusId}`, title: '时间线', metrics: { likes: 3 }, source: '主页时间线' }], warnings: [] };
  } });
  const base = await listen(app);
  try {
    assert.equal((await post(base, '/api/settings', { maitianRoot: 'C:\\Users\\me\\maitian', bitUrl: 'http://127.0.0.1:54345' })).status, 200);
    assert.equal((await post(base, '/api/settings', { maitianRoot: 'relative\\path', bitUrl: 'http://127.0.0.1:54345' })).status, 400);
    assert.equal((await post(base, '/api/profiles', { id: 'p' })).status, 200);
    const created = await (await post(base, '/api/accounts', { action: 'create', group: 'owned', platform: 'x', identity: 'owned', profileId: 'p', notes: '备注', tags: ['自有'], confirmed: true })).json();
    const updated = await post(base, '/api/update', { accountIds: [created.accountId] });
    assert.equal(updated.status, 200);
    for (let i = 0; i < 50 && app.queue.active; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const account = store.account(created.accountId);
    assert.equal(account.followers, 7);
    assert.equal(account.posts.length, 1);
    assert.equal(account.posts[0].title, '时间线');
    assert.deepEqual(events.filter(item => Array.isArray(item) && item[0] !== 'collect'), [['open', 'p'], ['close', 'p']]);
    assert.equal(events.find(item => Array.isArray(item) && item[0] === 'collect')[2], 20);
    const state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.accounts[0].notes, '备注');
    assert.equal(state.monitor.timelineLimit, 20);
  } finally { await new Promise(resolve => app.server.close(resolve)); store.close(); }
});

test('对标采集不接触比特，外部 JSON 可导入并拒绝覆盖自有号', async () => {
  const store = new Store(':memory:');
  store.addProfile('p', '环境');
  const owned = store.createAccount({ platform: 'x', identity: 'owned', group: 'owned', profileId: 'p', confirmed: true });
  let bitCalls = 0;
  const fixture = publicFixture('bench');
  const app = makeApp({ store, bitFactory: () => ({ running: async () => { bitCalls++; return {}; }, open: async () => { bitCalls++; }, close: async () => { bitCalls++; } }), fetch: async url => jsonResponse(200, String(url).includes('/statuses') ? fixture.statuses : fixture.profile) });
  const base = await listen(app);
  try {
    const created = await (await post(base, '/api/accounts', { action: 'create', group: 'benchmark', platform: 'x', identity: 'bench', notes: '观察' })).json();
    assert.equal((await post(base, '/api/update', { accountIds: [created.accountId] })).status, 200);
    for (let i = 0; i < 50 && app.queue.active; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(bitCalls, 0);
    assert.equal(store.account(created.accountId).followers, 40);
    assert.equal(store.account(created.accountId).posts[0].metrics.likes, 2);
    const imported = await (await post(base, '/api/external-import', { identity: 'grokbot', followers: 15, source: 'grok-bot', posts: [{ id: '3234567890123456789', text: '机器人读到的', metrics: { views: 6, likes: 1, replies: 0, reposts: 1, bookmarks: 0 } }] })).json();
    assert.equal(imported.created, true);
    assert.equal(store.account(imported.accountId).group, 'benchmark');
    assert.equal(store.account(imported.accountId).posts[0].metrics.views, 6);
    const again = await (await post(base, '/api/external-import', { identity: 'grokbot', followers: 16, posts: [{ id: '3234567890123456789', metrics: { likes: 5 } }] })).json();
    assert.equal(again.created, false);
    assert.equal(store.account(imported.accountId).posts[0].metrics.views, 6);
    assert.equal(store.account(imported.accountId).posts[0].metrics.likes, 5);
    assert.equal((await post(base, '/api/external-import', { identity: 'owned', followers: 1, posts: [] })).status, 400);
    assert.equal(store.account(owned).followers, null);
    const overview = nativeOverview(store, new Set(), '');
    assert.equal(overview.scope.accountCount, 3);
    store.updateAccount(created.accountId, { enabled: false });
    assert.equal(nativeOverview(store, new Set(), '').episodes.every(episode => episode.identity !== 'bench'), true);
    assert.equal((await post(base, '/api/accounts', { action: 'unbind', id: owned })).status, 200);
    assert.equal(store.account(owned).active, false);
    assert.equal((await post(base, '/api/accounts', { action: 'delete', id: imported.accountId })).status, 200);
    assert.equal(store.account(imported.accountId), undefined);
  } finally { await new Promise(resolve => app.server.close(resolve)); store.close(); }
});

test('定时采集到点跑启用账号，暂停号不重试，号间使用配置的随机间隔', async () => {
  const store = new Store(':memory:');
  store.addProfile('p1', '一');
  store.addProfile('p2', '二');
  const a = store.createAccount({ platform: 'x', identity: 'one', group: 'owned', profileId: 'p1', confirmed: true });
  const b = store.createAccount({ platform: 'x', identity: 'two', group: 'owned', profileId: 'p2', confirmed: true });
  store.createAccount({ platform: 'x', identity: 'off', group: 'benchmark', enabled: false });
  store.status(b, 'paused', '验证码');
  store.setSettings({ scheduleEnabled: '1', collectsPerDay: '1', collectHours: '9', concurrency: '1', intervalMinMinutes: '3', intervalMaxMinutes: '8', timelineLimit: '20' });
  const sleeps = [], calls = [];
  const queue = new CollectionQueue(store, async account => { calls.push(account.identity); return { identity: account.identity, followers: 1, posts: [] }; }, () => ({ running: async () => ({ p1: 1, p2: 1 }), open: async () => { throw new Error('不应打开'); }, close: async () => { throw new Error('不应关闭'); } }));
  const scheduler = new CollectionScheduler({ store, queue, now: () => morning, sleep: async ms => sleeps.push(ms), rng: () => 0 });
  assert.deepEqual((await scheduler.tick(morning)).started, [a]);
  assert.deepEqual(calls, ['one']);
  assert.deepEqual(sleeps, []);
  assert.deepEqual((await scheduler.tick(morning)).started, []);
  store.resume(b, true);
  store.setSettings({ collectsPerDay: '2', collectHours: '9,21' });
  const second = new CollectionScheduler({ store, queue, now: () => evening, sleep: async ms => sleeps.push(ms), rng: () => 0 });
  const started = (await second.tick(evening)).started;
  assert.deepEqual(started, [a, b]);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 180_000);
  assert.equal(store.account(b).status, 'ready');
  store.close();
});

test('暂停账号出现在状态告警里', async () => {
  const store = new Store(':memory:');
  store.addProfile('p', '环境');
  const app = makeApp({ store, bitFactory: () => ({ running: async () => ({ p: 1 }), list: async () => [{ id: 'p', name: '环境' }] }), collector: async () => { throw Object.assign(new Error('页面要求人工验证'), { code: 'risk' }); } });
  const base = await listen(app);
  try {
    await post(base, '/api/profiles', { id: 'p' });
    const created = await (await post(base, '/api/accounts', { action: 'create', group: 'owned', platform: 'x', identity: 'owned', profileId: 'p', confirmed: true })).json();
    await post(base, '/api/update', { accountIds: [created.accountId] });
    for (let i = 0; i < 50 && store.account(created.accountId).status !== 'paused'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.alerts[0].status, 'paused');
    assert.match(state.alerts[0].reason, /验证/);
    assert.equal((await post(base, '/api/collect', {})).status, 200);
  } finally { await new Promise(resolve => app.server.close(resolve)); store.close(); }
});
