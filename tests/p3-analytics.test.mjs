import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Store } from '../src/matrix/store.mjs';
import { CollectionQueue } from '../src/matrix/queue.mjs';
import { nativeOverview } from '../src/matrix/native-overview.mjs';
import { healthIssues } from '../src/matrix/review.mjs';
import { collectAccount } from '../src/matrix/collector.mjs';
import { accountAnalyticsExpression, parseAccountAnalytics, parsePostAnalytics, postAnalyticsExpression } from '../src/matrix/analytics.mjs';
import { exportRows, renderCsv, writeExport } from '../src/matrix/export.mjs';
import { isAbsolutePath } from '../src/matrix/paths.mjs';

const text = `曝光\n1.2万\n互动率\n3.4%\n主页访问\n88\n链接点击\n5`;

test('账号 Analytics 能从页面文字和页面自己的 JSON 读出指标', () => {
  const parsed = parseAccountAnalytics({ text, numbers: { impressions: '1.2万', engagementRate: '3.4%', profileVisits: '88', linkClicks: '5' }, trend: [{ day: '2026-11-20', value: '2' }, { day: '2026-11-21', value: '4' }] });
  assert.equal(parsed.issue, null);
  assert.equal(parsed.analytics.impressions, 12000);
  assert.equal(parsed.analytics.engagementRate, 3.4);
  assert.equal(parsed.analytics.profileVisits, 88);
  assert.equal(parsed.analytics.linkClicks, 5);
  assert.deepEqual(parsed.analytics.followerTrend, [{ day: '2026-11-20', value: 2 }, { day: '2026-11-21', value: 4 }]);
  const fromJson = parseAccountAnalytics({ text: '', bodies: [JSON.stringify({ data: { impression_count: 70, engagement_rate: 0.025, profile_visits: 3, link_clicks: 1, followerTrend: [{ date: '2026-11-22', count: 6 }] } })] });
  assert.equal(fromJson.analytics.impressions, 70);
  assert.equal(fromJson.analytics.engagementRate, 2.5);
  assert.equal(fromJson.analytics.followerTrend[0].value, 6);
});

test('页面改版、无权限、登录和限流都有明确结果，脚本本身不下指令互动', () => {
  assert.equal(parseAccountAnalytics({ text: '全新的欢迎页，没有任何指标' }).issue.code, 'analytics-layout');
  assert.equal(parseAccountAnalytics({ text: '此账号没有 Analytics 权限' }).issue.code, 'analytics-denied');
  assert.equal(parsePostAnalytics({ text: '单帖页改版了' }).issue.code, 'analytics-layout');
  assert.equal(parseAccountAnalytics({ login: true }).halt, 'login');
  assert.equal(parseAccountAnalytics({ risk: '平台提示访问异常或明确限流' }).halt, 'risk');
  for (const source of [accountAnalyticsExpression(), postAnalyticsExpression()]) {
    assert.match(source, /matrix-analytics-read/);
    assert.doesNotMatch(source, /\.click\(|twscrape|twikit|Scweet|api\.twitter\.com\/2\//);
  }
});

test('DOM 读得到指标时不再额外请求，缺指标时只重放 x.com 上页面自己的 analytics 地址', async () => {
  const element = (label) => ({ innerText: label, parentElement: { innerText: label }, getBoundingClientRect: () => ({ width: 10, height: 10 }) });
  const labels = ['曝光 1.2万', '互动率 3.4%', '主页访问 88', '链接点击 5'];
  let fetched = 0;
  const document = {
    body: { innerText: labels.join('\n') },
    querySelector(selector) { return selector.includes('AppTabBar_Profile_Link') ? { getAttribute: () => '/owned' } : null; },
    querySelectorAll(selector) {
      if (/iframe|alert|dialog|status|toast|error-detail|table|role="row"/.test(selector)) return [];
      return labels.map(element);
    },
  };
  const found = await vm.runInNewContext(accountAnalyticsExpression(), {
    document, URL, location: { pathname: '/i/account_analytics', href: 'https://x.com/i/account_analytics' },
    performance: { getEntriesByType: () => [{ name: 'https://api.twitter.com/2/tweets' }] },
    fetch() { fetched++; throw new Error('不应请求'); },
  });
  assert.equal(fetched, 0);
  assert.equal(parseAccountAnalytics(found).analytics.impressions, 12000);
  const calls = [];
  const empty = {
    body: { innerText: '加载中' },
    querySelector() { return { getAttribute: () => '/owned' }; },
    querySelectorAll() { return []; },
  };
  await vm.runInNewContext(accountAnalyticsExpression(), {
    document: empty, URL, location: { pathname: '/i/account_analytics', href: 'https://x.com/i/account_analytics' },
    performance: { getEntriesByType: () => [{ name: 'https://x.com/i/api/graphql/AccountAnalytics?q=1' }, { name: 'https://evil.test/analytics' }, { name: 'https://api.x.com/1.1/jot' }] },
    fetch(url) { calls.push(String(url)); return { status: 200, async text() { return JSON.stringify({ impression_count: 9 }); } }; },
  });
  assert.deepEqual(calls, ['https://x.com/i/api/graphql/AccountAnalytics?q=1']);
});

function analyticsBit(pages, evaluate) {
  const calls = [];
  const cdp = {
    async pages() { return pages; },
    async create(url) { calls.push(['create', url]); return { targetId: 'analytics-' + calls.length, url }; },
    async evaluate(page, expression) { return evaluate(page, expression); },
    async closePage(page) { calls.push(['close', page.targetId]); },
    close() { calls.push('disconnect'); },
  };
  return { bit: { async connect() { calls.push('connect'); return cdp; }, async open() { calls.push('open'); } }, calls };
}
const home = { targetId: 'home', url: 'https://x.com/owned' };

test('自有号在同一次采集里读 Analytics，登录和限流会停并且不关临时页', async () => {
  const postPage = { targetId: 'post', url: 'https://x.com/owned/status/1890000000000000001' };
  const ok = analyticsBit([home, postPage], (page, expression) => {
    if (String(expression).includes('matrix-analytics-read')) {
      return page.url.includes('/status/')
        ? { ready: true, identity: 'owned', numbers: { impressions: '300', engagementRate: '1%' }, text: '曝光 300' }
        : { ready: true, identity: 'owned', numbers: { impressions: '1000', engagementRate: '2%', profileVisits: '7', linkClicks: '1' }, trend: [{ day: '2026-11-21', value: '3' }], text };
    }
    if (page.url.includes('/status/')) return { identity: 'owned', metrics: '1 like, 2 views' };
    return { identity: 'owned', followers: '15' };
  });
  const result = await collectAccount({ profileId: 'p', platform: 'x', identity: 'owned', group: 'owned', readAnalytics: true, posts: [{ id: 'post-1', url: 'https://x.com/owned/status/1890000000000000001' }] }, ok.bit);
  assert.equal(result.analytics.impressions, 1000);
  assert.equal(result.postAnalytics[0].analytics.impressions, 300);
  assert.equal(ok.calls.filter(call => call === 'open').length, 0);
  assert.equal(ok.calls.some(call => Array.isArray(call) && call[1] === 'https://x.com/i/account_analytics'), true);
  assert.equal(ok.calls.filter(call => Array.isArray(call) && call[0] === 'close').length, 2);

  const denied = analyticsBit([home], (page, expression) => String(expression).includes('matrix-analytics-read')
    ? { ready: true, identity: 'owned', permission: true, text: '没有 Analytics 权限' }
    : { identity: 'owned', followers: '15' });
  const skipped = await collectAccount({ profileId: 'p', platform: 'x', identity: 'owned', group: 'owned', readAnalytics: true, posts: [] }, denied.bit);
  assert.equal(skipped.analyticsIssue.code, 'analytics-denied');
  assert.equal(skipped.followers, 15);

  for (const [payload, code] of [[{ ready: true, login: true }, 'login'], [{ ready: true, risk: '平台提示访问异常或明确限流' }, 'risk']]) {
    const failed = analyticsBit([home], (page, expression) => String(expression).includes('matrix-analytics-read') ? payload : { identity: 'owned', followers: '15' });
    await assert.rejects(collectAccount({ profileId: 'p', platform: 'x', identity: 'owned', group: 'owned', readAnalytics: true, posts: [] }, failed.bit), { code });
    assert.equal(failed.calls.some(call => Array.isArray(call) && call[0] === 'close'), false);
  }
});

test('Analytics 快照保留历史，总曝光进总览，健康条能看到改版', () => {
  const store = new Store(':memory:');
  store.addProfile('p', '环境');
  const id = store.bind({ profileId: 'p', platform: 'x', identity: 'owned', confirmed: true });
  store.saveResult(id, { identity: 'owned', followers: 10, source: '已有页面', analytics: { impressions: 100, engagementRate: 1, profileVisits: 4, linkClicks: 1, followerTrend: [{ day: '2026-11-20', value: 2 }] }, postAnalytics: [{ statusId: '1890000000000000001', analytics: { impressions: 80, likes: 3 } }], discovered: [{ sourceKey: 'x:status:1890000000000000001', url: 'https://x.com/owned/status/1890000000000000001', title: '后台帖', metrics: { views: 10 }, source: '主页时间线' }] });
  store.saveResult(id, { identity: 'owned', followers: 12, source: '已有页面', analytics: { impressions: 140, engagementRate: 1.5, profileVisits: 6, linkClicks: 2, followerTrend: [{ day: '2026-11-21', value: 3 }] }, analyticsIssue: null });
  const account = store.account(id);
  assert.equal(account.analytics.impressions, 140);
  assert.equal(account.analyticsHistory.length, 2);
  assert.equal(account.posts[0].analytics.impressions, 80);
  assert.equal(nativeOverview(store, new Set(['p']), '').analytics.impressions, 140);
  store.saveResult(id, { identity: 'owned', followers: 12, source: '已有页面', analyticsIssue: { code: 'analytics-layout', text: 'Analytics 页面结构对不上，本次没有写入后台指标' } });
  const issues = healthIssues({ accounts: [store.account(id)] });
  assert.equal(issues.some(issue => issue.code === 'analytics-layout'), true);
  const csv = renderCsv(store, 'all');
  assert.match(csv, /analytics-account/);
  assert.match(csv, /1890000000000000001/);
  assert.throws(() => writeExport(store, 'relative.csv'), /绝对/);
  assert.equal(isAbsolutePath('C:\\Users\\me\\matrix.csv'), true);
  let written = '';
  const saved = writeExport(store, 'C:\\Users\\me\\matrix.csv', 'analytics', (file, body) => { written = file + '\n' + body; });
  assert.match(written, /^C:\\Users\\me\\matrix.csv/);
  assert.match(written, /analytics-account/);
  assert.ok(saved.bytes > 20);
  store.close();
});

test('Analytics 不增加每天的采集次数，对标号不读后台', async () => {
  const store = new Store(':memory:');
  store.addProfile('p', '环境');
  const owned = store.createAccount({ platform: 'x', identity: 'owned', group: 'owned', profileId: 'p', confirmed: true });
  const bench = store.createAccount({ platform: 'x', identity: 'bench', group: 'benchmark' });
  const seen = [];
  const queue = new CollectionQueue(store, async account => {
    seen.push({ id: account.identity, readAnalytics: account.readAnalytics === true });
    return { identity: account.identity, followers: 1, posts: [] };
  }, () => ({ running: async () => ({ p: 1 }), open: async () => { throw new Error('不应另开窗口'); }, close: async () => { throw new Error('不应关闭窗口'); } }));
  queue.enqueue({ accountIds: [owned, bench] });
  for (let n = 0; n < 50 && (queue.active || queue.pending.length); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen.map(item => item.id).sort(), ['bench', 'owned']);
  assert.equal(seen.find(item => item.id === 'owned').readAnalytics, true);
  assert.equal(seen.find(item => item.id === 'bench').readAnalytics, false);
  assert.equal(store.collectionsToday(owned), 1);
  queue.enqueue({ accountIds: [owned] });
  queue.enqueue({ accountIds: [owned] });
  for (let n = 0; n < 50 && (queue.active || queue.pending.length); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.collectionsToday(owned), 2);
  assert.equal(seen.filter(item => item.id === 'owned').length, 2);
  store.close();
});
