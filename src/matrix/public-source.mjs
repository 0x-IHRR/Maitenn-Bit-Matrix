import { fault } from './browser.mjs';
import { normalizeIdentity } from './collector.mjs';

export const PUBLIC_HOSTS = ['api.fxtwitter.com', 'api.vxtwitter.com'];

function allow(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !PUBLIC_HOSTS.includes(u.hostname) || u.username || u.password) throw new Error('公开源主机不在允许列表');
  return u;
}

async function getJson(fetchImpl, url) {
  allow(url);
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(`公开源连接失败：${error.message}`);
  }
  if (response.status === 429) throw fault('risk', '公开源限流，已暂停该账号');
  if (response.status === 401 || response.status === 403) throw fault('risk', '公开源拒绝访问，已暂停该账号');
  if (response.status === 404) throw fault('error', '公开源没有这个账号');
  if (response.status >= 300 && response.status < 400) throw new Error(`公开源重定向 HTTP ${response.status}`);
  if (!response.ok) throw new Error(`公开源 HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('公开源响应过大');
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('公开源返回的不是 JSON'); }
  if (data?.code === 429) throw fault('risk', '公开源限流，已暂停该账号');
  if (data?.code === 401 || data?.code === 403) throw fault('risk', '公开源拒绝访问，已暂停该账号');
  if (typeof data?.code === 'number' && data.code >= 400) throw new Error(`公开源 code ${data.code}`);
  return data;
}

function metric(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function profileOf(data) {
  return data?.profile || data?.user || data || {};
}

function statusEntries(data) {
  const list = data?.results || data?.statuses || data?.tweets || [];
  const flat = [];
  for (const item of list) {
    if (item?.type === 'thread' && Array.isArray(item.statuses)) flat.push(...item.statuses);
    else flat.push(item);
  }
  return flat;
}

export function mapPublicAccount(handle, profileData, timelineData, host) {
  const profile = profileOf(profileData);
  const screen = String(profile.screen_name || profile.screenName || '').replace(/^@/, '').toLowerCase();
  if (!screen) throw fault('identity', '公开源没有返回用户名');
  if (screen !== handle) throw fault('mismatch', `公开源账号 ${screen} 与 ${handle} 不一致`);
  const followers = metric(profile.followers ?? profile.followers_count);
  const discovered = [];
  const seen = new Set();
  for (const item of statusEntries(timelineData)) {
    if (!item || item.type === 'tombstone' || item.reposted_by || item.retweeted_status) continue;
    const author = String(item.author?.screen_name || item.user?.screen_name || screen).replace(/^@/, '').toLowerCase();
    if (author !== handle) continue;
    const id = String(item.id || item.id_str || '').match(/^\d{5,25}$/)?.[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const metrics = {};
    const views = metric(item.views ?? item.view_count);
    const likes = metric(item.likes ?? item.like_count);
    const comments = metric(item.replies ?? item.reply_count);
    const shares = metric(item.reposts ?? item.retweets ?? item.repost_count);
    const favorites = metric(item.bookmarks ?? item.bookmark_count);
    if (views != null) metrics.views = views;
    if (likes != null) metrics.likes = likes;
    if (comments != null) metrics.comments = comments;
    if (shares != null) metrics.shares = shares;
    if (favorites != null) metrics.favorites = favorites;
    discovered.push({
      sourceKey: `x:status:${id}`,
      url: `https://x.com/${handle}/status/${id}`,
      title: String(item.text || item.full_text || `帖子 ${id}`).replace(/\s+/g, ' ').trim().slice(0, 180) || `帖子 ${id}`,
      status: '已发布',
      createdAt: item.created_at || item.createdAt || null,
      metrics,
      source: host,
    });
  }
  return { identity: handle, followers, posts: [], discovered, source: host, warnings: [] };
}

async function readOptional(fetchImpl, url) {
  try { return await getJson(fetchImpl, url); }
  catch (error) {
    if (error.code === 'risk' || error.code === 'login') throw error;
    return { error };
  }
}
function canonicalHandle(timeline, handle) {
  for (const item of statusEntries(timeline || {})) {
    const screen = String(item?.author?.screen_name || item?.user?.screen_name || '').replace(/^@/, '');
    if (screen && screen.toLowerCase() === handle) return screen;
  }
  return '';
}
export async function collectPublicAccount(account, { fetch: fetchImpl = globalThis.fetch, hosts = PUBLIC_HOSTS, limit } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('缺少公开源请求方法');
  const handle = normalizeIdentity('x', account.identity);
  const count = Math.max(1, Math.min(50, Number(limit || account.timelineLimit) || 20));
  let last;
  for (const host of hosts) {
    const base = `https://${host}`;
    try {
      // Some public hosts 404 a lowercased profile even when the canonical handle and its timeline exist.
      let profile = await readOptional(fetchImpl, `${base}/2/profile/${encodeURIComponent(handle)}`);
      const timeline = await readOptional(fetchImpl, `${base}/2/profile/${encodeURIComponent(handle)}/statuses?count=${count}`);
      if (timeline.error?.code === 'risk' || timeline.error?.code === 'login') throw timeline.error;
      if (profile.error?.code === 'risk' || profile.error?.code === 'login') throw profile.error;
      const canonical = canonicalHandle(timeline.error ? {} : timeline, handle);
      if (profile.error && canonical && canonical !== handle) profile = await readOptional(fetchImpl, `${base}/2/profile/${encodeURIComponent(canonical)}`);
      if (profile.error) throw profile.error;
      const mapped = mapPublicAccount(handle, profile, timeline.error ? { results: [] } : timeline, host);
      if (timeline.error) mapped.warnings.push({ reason: `时间线暂不可用：${timeline.error.message}` });
      return { ...mapped, discovered: mapped.discovered.slice(0, count) };
    } catch (error) {
      if (error.code === 'risk' || error.code === 'login' || error.code === 'mismatch') throw error;
      last = error;
    }
  }
  throw last || fault('error', '公开源不可用');
}
