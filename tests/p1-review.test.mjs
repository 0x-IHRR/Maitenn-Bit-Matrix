import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/matrix/store.mjs';
import { nativeOverview } from '../src/matrix/native-overview.mjs';
import { healthIssues, isDenseSample, reviewsForPost, weeklyReport } from '../src/matrix/review.mjs';

const day = 864e5;
const born = '2026-11-20T00:00:00.000Z';

test('第 1 天复盘在窗口结束前标成进行中，第 3/7 天要到点才出现', () => {
  const samples = [{ at: '2026-11-20T06:00:00.000Z', metrics: { views: 10, likes: 1, comments: 0, favorites: 0, shares: 0 }, dense: true }, { at: '2026-11-23T00:00:00.000Z', metrics: { views: 40, likes: 4, comments: 1, favorites: 0, shares: 1 } }];
  const early = reviewsForPost({ post: { createdAt: born, title: '新帖' }, samples, now: Date.parse('2026-11-20T12:00:00.000Z') });
  assert.deepEqual(early.map(row => row.age), [1]);
  assert.equal(early[0].partial, true);
  assert.equal(early[0].views, 10);
  const later = reviewsForPost({ post: { createdAt: born, title: '新帖' }, samples, previous: { title: '旧帖', createdAt: '2026-11-10T00:00:00.000Z', samples: [{ at: '2026-11-13T00:00:00.000Z', metrics: { views: 20 } }] }, followerSamples: [{ at: born, followers: 5 }, { at: '2026-11-27T00:00:00.000Z', followers: 8 }], now: Date.parse(born) + 8 * day });
  assert.deepEqual(later.map(row => row.age), [1, 3, 7]);
  assert.equal(later[2].partial, false);
  assert.equal(later[2].views, 40);
  assert.equal(later[2].prev.views, 20);
  assert.equal(later[2].fans, 3);
});

test('72 小时内的采集才算密采样，并且不会多记一次采集', () => {
  assert.equal(isDenseSample(born, '2026-11-21T00:00:00.000Z'), true);
  assert.equal(isDenseSample(born, '2026-11-24T00:00:00.000Z'), false);
  const store = new Store(':memory:');
  store.addProfile('p', '环境');
  const id = store.bind({ profileId: 'p', platform: 'x', identity: 'owned', confirmed: true });
  store.saveResult(id, { identity: 'owned', followers: 5, discovered: [{ sourceKey: 'x:status:1234567890123456789', url: 'https://x.com/owned/status/1234567890123456789', title: '新帖', createdAt: new Date().toISOString(), metrics: { views: 9, likes: 1 }, source: '时间线' }] });
  const snapshot = JSON.parse(store.db.prepare('SELECT data FROM snapshots').get().data);
  assert.equal(snapshot.posts[0].dense, true);
  assert.equal(store.collectionsToday(id), 0);
  const overview = nativeOverview(store, new Set(), '');
  assert.equal(overview.episodes[0].reviews[0].age, 1);
  assert.equal(overview.episodes[0].reviews[0].views, 9);
  store.close();
});

test('周报给出矩阵增量、账号差值和播放最高的帖', () => {
  const now = new Date('2026-11-23T04:00:00.000Z');
  const report = weeklyReport([
    { identity: 'mine', group: 'owned', enabled: true, samples: [{ at: '2026-11-15T00:00:00.000Z', followers: 10 }, { at: '2026-11-22T00:00:00.000Z', followers: 14 }], posts: [{ title: '自己的帖', metrics: { views: 30 } }] },
    { identity: 'theirs', group: 'benchmark', enabled: true, samples: [{ at: '2026-11-15T00:00:00.000Z', followers: 100 }, { at: '2026-11-22T00:00:00.000Z', followers: 90 }], posts: [{ title: '对标帖', metrics: { views: 80 } }] },
  ], now);
  assert.equal(report.from, '2026-11-16');
  assert.equal(report.to, '2026-11-22');
  assert.equal(report.ownedFollowerDelta, 4);
  assert.equal(report.benchmarkFollowerDelta, -10);
  assert.equal(report.followerDelta, -6);
  assert.equal(report.top[0].title, '对标帖');
  assert.match(report.note, /72 小时/);
});

test('健康检查把断线、登录、账号不符和采集断档放在一起', () => {
  const issues = healthIssues({ connectionError: '连接被拒绝', now: Date.parse('2026-11-23T00:00:00.000Z'), accounts: [
    { id: 'a', identity: 'one', enabled: true, status: 'login', lastSuccess: '2026-11-23T00:00:00.000Z' },
    { id: 'b', identity: 'two', enabled: true, status: 'mismatch', lastSuccess: '2026-11-23T00:00:00.000Z' },
    { id: 'c', identity: 'three', enabled: true, status: 'ready', lastSuccess: '2026-11-20T00:00:00.000Z' },
    { id: 'd', identity: 'four', enabled: false, status: 'failed', lastSuccess: null },
  ] });
  assert.deepEqual(issues.map(issue => issue.code), ['bit', 'login', 'mismatch', 'gap']);
  const store = new Store(':memory:');
  store.addProfile('p', '环境');
  store.bind({ profileId: 'p', platform: 'x', identity: 'quiet', confirmed: true });
  const overview = nativeOverview(store, new Set(), '');
  assert.equal(overview.health.platforms[0].state, '');
  assert.equal(overview.health.issues.length, 0);
  store.close();
});
