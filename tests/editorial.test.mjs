import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../src/matrix/server.mjs';
import { Store } from '../src/matrix/store.mjs';
import { nativeOverview } from '../src/matrix/native-overview.mjs';
import { applyTransition, buildCalendar, canonicalStatusUrl, parsePersonaDocument } from '../src/matrix/editorial.mjs';

const root = new URL('..', import.meta.url);

function owned(store, profileId, identity) {
  store.addProfile(profileId, profileId);
  return store.bind({ profileId, platform: 'x', identity, confirmed: true });
}

test('坏的人设 JSON 整份拒绝，合法结构和扩展字段可以导入', () => {
  assert.throws(() => parsePersonaDocument('{'), /无法解析/);
  assert.throws(() => parsePersonaDocument('[]'), /对象/);
  assert.throws(() => parsePersonaDocument({ personas: [] }), /没有可导入/);
  assert.throws(() => parsePersonaDocument({ personas: [{ positioning: '只有定位' }] }), /显示名/);
  assert.throws(() => parsePersonaDocument({ personas: [{ name: '甲', columns: '每周' }] }), /栏目须为数组/);
  assert.throws(() => parsePersonaDocument({ personas: [{ name: '甲', columns: [{ purpose: '没名字' }] }] }), /栏目需要名称/);
  assert.throws(() => parsePersonaDocument({ personas: [{ name: 1 }] }), /显示名须为文本/);
  const cards = parsePersonaDocument({ cards: [{ displayName: '栏目号', oneLiner: '一句话', voice: '稳', sections: [{ title: '早报', cadence: '每天', example: ['样例'] }] }] });
  assert.equal(cards[0].name, '栏目号');
  assert.equal(cards[0].positioning, '一句话');
  assert.equal(cards[0].columns[0].frequency, '每天');
  assert.match(cards[0].columns[0].examples, /样例/);
});

test('状态只能按草稿、待批准、已批准、已发布前进，退回要单独走', () => {
  assert.equal(applyTransition('draft', 'submit'), 'pending');
  assert.equal(applyTransition('pending', 'approve'), 'approved');
  assert.equal(applyTransition('approved', 'mark'), 'published');
  assert.equal(applyTransition('published', 'return'), 'draft');
  assert.equal(applyTransition('approved', 'return'), 'draft');
  assert.throws(() => applyTransition('draft', 'approve'), /不能从/);
  assert.throws(() => applyTransition('draft', 'mark'), /不能从/);
  assert.throws(() => applyTransition('pending', 'mark'), /不能从/);
  assert.throws(() => applyTransition('published', 'approve'), /不能从/);
  assert.equal(canonicalStatusUrl('https://twitter.com/Some_User/status/1234567890'), 'https://x.com/some_user/status/1234567890');
  assert.throws(() => canonicalStatusUrl('https://x.com/compose'), /状态链接/);
  assert.throws(() => canonicalStatusUrl('http://x.com/user/status/1234567890'), /状态链接/);
  assert.throws(() => canonicalStatusUrl('https://example.com/user/status/1234567890'), /状态链接/);
});

test('日历按上海时区把有创建时间的帖子落格，没有时间的进未排期', () => {
  const now = new Date('2026-11-25T03:00:00Z');
  const calendar = buildCalendar({
    now,
    posts: [
      { id: 'in', createdAt: '2026-11-25T02:00:00Z', title: '今天' },
      { id: 'none', createdAt: null, title: '没时间' },
      { id: 'old', createdAt: '2020-01-01T00:00:00Z', title: '窗口外' },
    ],
    items: [
      { id: 'plan', planDate: '2026-11-26', title: '明天', status: 'draft' },
      { id: 'free', planDate: null, title: '未排期', status: 'pending' },
    ],
  });
  assert.equal(calendar.days.length, 28);
  assert.equal(calendar.days.find(day => day.today).posts[0].id, 'in');
  assert.equal(calendar.days.find(day => day.key === '2026-11-26').items[0].id, 'plan');
  assert.deepEqual(calendar.unscheduledPosts.map(post => post.id), ['none']);
  assert.equal(calendar.unscheduledItems[0].id, 'free');
  assert.equal(calendar.days.some(day => day.posts.some(post => post.id === 'old')), false);
});

test('人设数量跟着已接入账号走，状态变更不打开比特，非法链接和坏 JSON 不落库', async () => {
  const store = new Store(':memory:');
  const first = owned(store, 'p1', 'alpha');
  const second = owned(store, 'p2', 'beta');
  store.importPosts(first, [{ sourceKey: 'x:status:1234567890', url: 'https://x.com/alpha/status/1234567890', title: '已采集', createdAt: '2026-11-25T02:00:00Z', status: '已发布', metrics: { views: 9 } }]);
  const calls = [];
  const app = makeApp({
    store,
    bitFactory: () => ({
      running: async () => { calls.push('running'); return {}; },
      open: async () => { calls.push('open'); },
      close: async () => { calls.push('close'); },
      request: async () => { calls.push('request'); },
      list: async () => { calls.push('list'); return []; },
    }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = (pathname, body) => fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', host: new URL(base).host }, body: JSON.stringify(body) });
  try {
    const bad = await send('/api/personas/import', { document: { personas: [{ columns: [] }] } });
    assert.equal(bad.status, 400);
    assert.equal(store.personas().length, 0);
    const imported = await (await send('/api/personas/import', { document: { personas: [{ name: '甲', identity: 'alpha', columns: [{ name: '早报', frequency: '每天' }] }, { name: '乙' }] } })).json();
    assert.equal(imported.imported.length, 2);
    assert.equal(imported.imported[0].accountId, first);
    assert.equal(imported.imported[1].accountId, null);
    const clash = await send('/api/personas', { name: '丙', accountId: first });
    assert.equal(clash.status, 400);
    const itemId = store.saveItem({ title: '一条草稿', personaId: imported.imported[1].id, planDate: '2026-11-26' });
    assert.equal((await send('/api/items/transition', { id: itemId, action: 'mark' })).status, 400);
    assert.equal(store.contentItems()[0].status, 'draft');
    assert.equal((await send('/api/items/transition', { id: itemId, action: 'submit' })).status, 200);
    assert.equal((await send('/api/items/transition', { id: itemId, action: 'return', reason: '' })).status, 400);
    assert.equal(store.contentItems()[0].status, 'pending');
    await send('/api/items/transition', { id: itemId, action: 'return', reason: '再改一版' });
    assert.equal(store.contentItems()[0].returnReason, '再改一版');
    await send('/api/items/transition', { id: itemId, action: 'submit' });
    await send('/api/items/transition', { id: itemId, action: 'approve' });
    assert.equal((await send('/api/items/transition', { id: itemId, action: 'mark', postUrl: 'https://x.com/compose' })).status, 400);
    assert.equal(store.contentItems()[0].status, 'approved');
    const marked = await (await send('/api/items/transition', { id: itemId, action: 'mark', postUrl: 'https://twitter.com/alpha/status/1234567890' })).json();
    assert.equal(marked.item.status, 'published');
    assert.equal(marked.item.postUrl, 'https://x.com/alpha/status/1234567890');
    const overview = nativeOverview(store, new Set(), '');
    assert.equal(overview.roster.length, 2);
    assert.equal(overview.episodes[0].personaName, '甲');
    assert.equal(overview.contentItems[0].matched.views, 9);
    assert.equal(overview.contentItems[0].matched.postId, overview.episodes[0].id);
    const scoped = nativeOverview(store, new Set(), '', 'p2');
    assert.equal(scoped.episodes.length, 0);
    assert.equal(scoped.contentItems.length, 0);
    assert.equal(scoped.roster.length, 2);
    const dir = mkdtempSync(join(tmpdir(), 'persona-'));
    const file = join(dir, 'cards.json');
    writeFileSync(file, JSON.stringify({ personas: [{ name: '路径卡' }] }));
    assert.equal((await send('/api/personas/import', { path: 'relative/cards.json' })).status, 400);
    assert.equal((await send('/api/personas/import', { path: 'C:\\Users\\me\\missing-personas.json' })).status, 400);
    assert.equal((await (await send('/api/personas/import', { path: file })).json()).imported.at(-1).name, '路径卡');
    store.deleteAccount(second);
    assert.equal(store.personas().some(persona => persona.accountId === second), false);
    assert.deepEqual(calls.filter(call => call !== 'running'), []);
    const source = ['src/matrix/editorial.mjs', 'src/web/editorial.js', 'src/matrix/server.mjs'].map(file => readFileSync(new URL(file, root), 'utf8')).join('\n');
    assert.doesNotMatch(source, /等你点发布|awaiting_user|hub plan|\/browser\/open|定时发布|打开发布|\/api\/publish|\/api\/tweet/);
    const page = readFileSync(new URL('src/web/editorial.js', root), 'utf8');
    assert.match(page, /记为已发布/);
    assert.doesNotMatch(page, />(发布|去发布|点发布)</);
    assert.equal(store.accounts().length, 1);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    store.close();
  }
});

test('页面导航有人设、日历、审批，大屏和档案会带人设名', () => {
  const pages = readFileSync(new URL('src/web/pages.html', root), 'utf8');
  const board = readFileSync(new URL('src/web/board.html', root), 'utf8');
  const nav = readFileSync(new URL('src/web/mt.js', root), 'utf8');
  for (const source of [board, nav]) {
    assert.match(source, /人设/);
    assert.match(source, /日历/);
    assert.match(source, /审批/);
  }
  assert.match(pages, /Editorial\.personas/);
  assert.match(pages, /Editorial\.calendar/);
  assert.match(pages, /Editorial\.approval/);
  assert.match(pages, /e\.personaName/);
  assert.match(board, /cur\.personaName/);
  assert.doesNotMatch(readFileSync(new URL('src/web/editorial.js', root), 'utf8'), /方正-|三个号/);
});
