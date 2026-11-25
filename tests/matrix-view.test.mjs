import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeApp } from '../src/matrix/server.mjs';
import { nativeOverview } from '../src/matrix/native-overview.mjs';
import { Store } from '../src/matrix/store.mjs';
import { growthOverDays, matrixRows } from '../src/matrix/matrix-view.mjs';

const now = new Date('2026-11-25T04:00:00Z');

test('近 7 天缺任意一天就是未获取，真实持平记为 0', () => {
  assert.equal(growthOverDays([
    { at: '2026-11-18T02:00:00Z', followers: 5 },
    { at: '2026-11-25T02:00:00Z', followers: 5 },
  ], 7, now), 0);
  assert.equal(growthOverDays([
    { at: '2026-11-18T02:00:00Z', followers: 5 },
    { at: '2026-11-25T02:00:00Z', followers: 8 },
  ], 7, now), 3);
  assert.equal(growthOverDays([{ at: '2026-11-25T02:00:00Z', followers: 8 }], 7, now), null);
  assert.equal(growthOverDays([], 7, now), null);
});

test('矩阵行数跟着已接入账号走，无权限不清粉丝，空指标保持空', () => {
  const personas = [{ id: 'p', accountId: 'owned', name: '栏目甲' }];
  const rows = matrixRows([
    { id: 'owned', platform: 'x', enabled: true, active: true, group: 'owned', profileId: 'win', identity: 'alpha', displayName: '', followers: 0, lastSuccess: '2026-11-25T02:00:00Z', reason: '', analytics: { impressions: 0, engagementRate: 1.5, profileVisits: 2, linkClicks: 0 }, analyticsIssue: null, samples: [{ at: '2026-11-18T02:00:00Z', followers: 0 }, { at: '2026-11-25T02:00:00Z', followers: 0 }] },
    { id: 'denied', platform: 'x', enabled: true, active: true, group: 'owned', profileId: 'win2', identity: 'beta', displayName: '乙', followers: 4, lastSuccess: '2026-11-25T02:00:00Z', reason: '', analytics: null, analyticsIssue: { code: 'analytics-denied', text: '没有 X Analytics 权限，已跳过后台指标' }, samples: [{ at: '2026-11-25T02:00:00Z', followers: 4 }] },
    { id: 'bench', platform: 'x', enabled: true, active: true, group: 'benchmark', profileId: null, identity: 'public', displayName: '', followers: null, lastSuccess: null, reason: '', analytics: null, analyticsIssue: null, samples: [] },
    { id: 'off', platform: 'x', enabled: false, active: true, group: 'owned', profileId: 'win3', identity: 'stopped', followers: 9, samples: [] },
    { id: 'other', platform: 'youtube', enabled: true, active: true, group: 'owned', identity: 'video', followers: 100, samples: [] },
  ], personas, now);
  assert.deepEqual(rows.map(row => row.identity), ['alpha', 'beta', 'public']);
  assert.equal(rows[0].followers, 0);
  assert.equal(rows[0].growth7, 0);
  assert.equal(rows[0].impressions, 0);
  assert.equal(rows[0].engagementRate, 1.5);
  assert.equal(rows[0].personaName, '栏目甲');
  assert.equal(rows[0].scope, 'win');
  assert.equal(rows[1].followers, 4);
  assert.equal(rows[1].impressions, null);
  assert.equal(rows[1].engagementRate, null);
  assert.equal(rows[1].profileVisits, null);
  assert.equal(rows[1].linkClicks, null);
  assert.match(rows[1].gap, /没有 X Analytics 权限/);
  assert.equal(rows[2].followers, null);
  assert.equal(rows[2].growth7, null);
  assert.equal(rows[2].scope, 'history:bench');
  assert.equal(rows[2].gap, '尚未采集');
  assert.equal(rows[2].personaName, '');
});

test('总览带上全部已接入账号，读取矩阵不打开窗口', async () => {
  const store = new Store(':memory:');
  store.addProfile('p1', '一');
  store.addProfile('p2', '二');
  const alpha = store.bind({ profileId: 'p1', platform: 'x', identity: 'alpha', confirmed: true });
  const beta = store.bind({ profileId: 'p2', platform: 'x', identity: 'beta', confirmed: true });
  store.createAccount({ platform: 'x', identity: 'public', group: 'benchmark' });
  store.saveResult(alpha, { identity: 'alpha', followers: 3, analytics: { impressions: 10, engagementRate: 2, profileVisits: 1, linkClicks: 0 } });
  store.saveResult(beta, { identity: 'beta', followers: 6, analyticsIssue: { code: 'analytics-denied', text: '没有 X Analytics 权限，已跳过后台指标' } });
  store.savePersona({ name: '栏目甲', accountId: alpha });
  const calls = [];
  const app = makeApp({ store, bitFactory: () => ({ running: async () => { calls.push('running'); return {}; }, open: async () => { calls.push('open'); }, close: async () => { calls.push('close'); }, request: async () => { calls.push('request'); } }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const overview = await (await fetch(base + '/api/overview')).json();
    assert.deepEqual(overview.matrix.map(row => row.identity), ['alpha', 'beta', 'public']);
    assert.equal(overview.matrix[0].followers, 3);
    assert.equal(overview.matrix[0].impressions, 10);
    assert.equal(overview.matrix[0].personaName, '栏目甲');
    assert.equal(overview.matrix[1].followers, 6);
    assert.equal(overview.matrix[1].impressions, null);
    assert.match(overview.matrix[1].gap, /权限/);
    assert.equal(overview.matrix[2].followers, null);
    const scoped = nativeOverview(store, new Set(), '', 'p1');
    assert.equal(scoped.episodes.every(episode => episode.identity === 'alpha'), true);
    assert.equal(scoped.matrix.length, 3);
    assert.deepEqual(calls.filter(call => call !== 'running'), []);
    const page = readFileSync(new URL('../src/web/editorial.js', import.meta.url), 'utf8');
    const view = readFileSync(new URL('../src/matrix/matrix-view.mjs', import.meta.url), 'utf8');
    assert.match(page, /未获取/);
    assert.match(page, /data-matrix-scope/);
    assert.doesNotMatch(page + view, /\/browser\/open|等你点发布|打开发布/);
    assert.doesNotMatch(page.slice(page.indexOf('function matrix'), page.indexOf('function drawMatrix')), /fetch\(/);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    store.close();
  }
});
