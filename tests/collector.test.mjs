import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { BitBrowser, Cdp } from '../src/matrix/browser.mjs';
import { collectAccount, checkIdentity, numberOf, normalizeIdentity, postKey, snapshot } from '../src/matrix/collector.mjs';

const identity = 'example';
function browser(pages, values, temporary = {}) {
  const calls = [];
  const cdp = {
    async pages() { calls.push('pages'); return pages; },
    async create(url) { calls.push(['create', url]); const p = { targetId: 'temp', url }; values.temp = temporary; return p; },
    async evaluate(page) { calls.push(['read', page.targetId]); return values[page.targetId]; },
    async closePage(page) { calls.push(['close', page.targetId]); },
    close() { calls.push('disconnect'); },
  };
  return { bit: { async connect(id) { calls.push(['connect', id]); return cdp; } }, calls };
}
const account = { profileId: 'p1', platform: 'x', identity, posts: [] };
test('identity is a platform identifier and unknown metrics remain null', () => {
  assert.equal(numberOf('0'), 0); assert.equal(numberOf('1.2万'), 12000); assert.equal(numberOf('—'), null);
  assert.equal(normalizeIdentity('x', '@Example'), 'example');
  assert.throws(() => normalizeIdentity('youtube', 'channel nickname'));
  assert.equal(postKey('x', 'https://evil.test/example/status/123'), null);
  assert.equal(postKey('x', 'https://x.com/example/status/123'), '123');
  assert.throws(() => checkIdentity('x', identity, {}), { code: 'identity' });
  assert.throws(() => checkIdentity('x', identity, { identity: 'another' }), { code: 'mismatch' });
});
test('existing matching page is reused without creating, navigating or closing it', async () => {
  const { bit, calls } = browser([{ targetId: 'user', url: 'https://x.com/example' }], { user: { identity, followers: '0' } });
  const result = await collectAccount(account, bit);
  assert.equal(result.followers, 0); assert.match(result.source, /已有页面/);
  assert.equal(calls.filter(x => Array.isArray(x) && ['create', 'close'].includes(x[0])).length, 0);
  assert.equal(calls.at(-1), 'disconnect');
});
test('new collection tabs are cleaned after a successful read, never existing unrelated tabs', async () => {
  const { bit, calls } = browser([{ targetId: 'user', url: 'https://x.com/home' }], {}, { identity, followers: '42' });
  assert.equal((await collectAccount(account, bit)).followers, 42);
  assert.deepEqual(calls.filter(x => Array.isArray(x) && x[0] === 'close'), [['close', 'temp']]);
});
test('login and explicit risk preserve temporary pages and return no data', async () => {
  for (const [data, code] of [[{ login: true }, 'login'], [{ risk: '人工验证码' }, 'risk']]) {
    const { bit, calls } = browser([], {}, data);
    await assert.rejects(collectAccount(account, bit), { code });
    assert.equal(calls.some(x => Array.isArray(x) && x[0] === 'close'), false);
    assert.equal(calls.at(-1), 'disconnect');
  }
});
test('identity mismatch prevents metrics collection and persistence result', async () => {
  const { bit, calls } = browser([{ targetId: 'user', url: 'https://x.com/example' }], { user: { identity: 'other', followers: '999' } });
  await assert.rejects(collectAccount(account, bit), { code: 'mismatch' });
  assert.equal(calls.some(x => Array.isArray(x) && x[0] === 'create'), false);
});
test('registered X posts preserve missing values instead of manufacturing zeros', async () => {
  const { bit } = browser([{ targetId: 'home', url: 'https://x.com/example' }, { targetId: 'post', url: 'https://x.com/example/status/123' }], { home: { identity, followers: '10' }, post: { identity, metrics: '0 likes, 12 views' } });
  const result = await collectAccount({ ...account, posts: [{ id: 7, url: 'https://x.com/example/status/123' }] }, bit);
  assert.equal(result.posts[0].metrics.likes, 0);
  assert.equal(result.posts[0].metrics.views, 12);
  assert.equal(result.posts[0].metrics.comments, null);
});
test('registered X Chinese metrics accept list punctuation and count labels',async()=>{
  for(const metrics of ['2 条回复、3 次转帖、4 个喜欢、5 个书签、6 次观看','2 次回复；3 次转帖;4 次喜欢，5 个书签，6 次查看']) {
    const {bit}=browser([{targetId:'home',url:'https://x.com/example'},{targetId:'post',url:'https://x.com/example/status/123'}],{home:{identity,followers:'10'},post:{identity,metrics}});
    const r=await collectAccount({...account,posts:[{id:7,url:'https://x.com/example/status/123'}]},bit);
    assert.deepEqual(r.posts[0].metrics,{views:6,likes:4,comments:2,favorites:5,shares:3});
  }
});
test('Bit connect uses only live profile ports; an offline profile never opens', async t => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url); res.setHeader('Content-Type', 'application/json');
    const port = server.address().port;
    res.end(JSON.stringify(req.url === '/browser/pids/all' ? { success: true, data: { running: 9 } } : req.url === '/browser/ports' ? { success: true, data: { running: String(port) } } : { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  t.mock.method(Cdp, 'connect', async url => ({ url }));
  const bit = new BitBrowser(`http://127.0.0.1:${server.address().port}`);
  await assert.rejects(bit.connect('offline'), { code: 'offline' });
  assert.match((await bit.connect('running')).url, /devtools\/browser\/test$/);
  assert.equal(paths.includes('/browser/open'), false);
  assert.deepEqual(paths, ['/browser/pids/all', '/browser/pids/all', '/browser/ports', '/json/version']);
});

function snapshotDocument({ articles = [], alerts = [], bodyText = '' } = {}) {
  return { body: { innerText: bodyText },
    querySelector(selector) { return selector.includes('AppTabBar_Profile_Link') ? { getAttribute: () => '/example' } : null; },
    querySelectorAll(selector) { return selector === 'article' ? articles : selector.includes('role="alert"') ? alerts : []; },
  };
}
function article(mainId, label) {
  const a = {
    querySelector(selector) { return selector === 'a[href] time' ? { closest: () => ({ getAttribute: () => `/example/status/${mainId}` }) } : null; },
    querySelectorAll() { return [{ closest: () => a, getAttribute: () => label }]; },
  }; return a;
}
function pageData(document, key = '123') {
  return vm.runInNewContext(`(${snapshot.toString()})('x', '${key}')`, { document, location: { pathname: '/example/status/123', href: 'https://x.com/example/status/123' } });
}
test('X metrics match the main timestamp permalink, excluding quoted links', () => {
  const quotedContainer = article('999', '999 views');
  const intended = article('123', '12 views');
  assert.equal(pageData(snapshotDocument({ articles: [quotedContainer, intended] })).metrics, '12 views');
  assert.equal(pageData(snapshotDocument({ articles: [quotedContainer] })).metrics, null);
});
test('explicit UI error causes pause; risk terms in post body do not', () => {
  for(const message of ['Rate limit exceeded','已超出频率限制，请稍后再试','You are rate limited. Please wait a few moments then try again.']) {
    const toast = { innerText: message, getBoundingClientRect: () => ({ width: 100, height: 30 }) };
    assert.match(pageData(snapshotDocument({ alerts: [toast] })).risk, /限流/);
    assert.equal(pageData(snapshotDocument({ bodyText: message })).risk, null);
  }
});
test('unsupported registered post URLs return a visible per-post warning', async () => {
  const { bit } = browser([{ targetId: 'home', url: 'https://x.com/example' }], { home: { identity, followers: '10' } });
  const result = await collectAccount({ ...account, posts: [{ id: 2, url: '' }] }, bit);
  assert.equal(result.posts.length, 0);
  assert.equal(result.warnings[0].id, 2);
  assert.match(result.warnings[0].reason, /链接/);
});
test('another platform login tab cannot suppress this account login entry',async()=>{
  const {bit,calls}=browser([
    {targetId:'home',url:'https://x.com/example'},
    {targetId:'other',url:'https://www.instagram.com/accounts/login/'}
  ],{home:{login:true,url:'https://x.com/example'}});
  await assert.rejects(collectAccount(account,bit),{code:'login'});
  assert.ok(calls.some(c=>Array.isArray(c)&&c[0]==='create'&&c[1]==='https://x.com/i/flow/login'));
});
test('YouTube reuses its task-created video list for subsequent registered posts',async()=>{
  const id='UCabcdefghijklmnopqrstuv';
  const {bit,calls}=browser([{targetId:'home',url:`https://studio.youtube.com/channel/${id}`}],{home:{identity:id,followers:'10'}},{identity:id,metrics:{views:'2',likes:'0'}});
  const result=await collectAccount({profileId:'p1',platform:'youtube',identity:id,posts:[{id:'a',url:'https://youtu.be/abcdefghijk'},{id:'b',url:'https://youtu.be/lmnopqrstuv'}]},bit);
  assert.equal(result.posts.length,2);
  assert.equal(calls.filter(c=>Array.isArray(c)&&c[0]==='create').length,1);
  assert.equal(result.posts[1].source,'采集临时页面');
});
