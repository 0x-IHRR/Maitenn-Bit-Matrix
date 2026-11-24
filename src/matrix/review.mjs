import { shanghaiDay } from './schedule.mjs';

const DAY = 864e5;
const HOUR = 36e5;
const DENSE_WINDOW = 72 * HOUR;
const weekdays = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function isDenseSample(createdAt, collectedAt) {
  const born = Date.parse(createdAt || '');
  const at = Date.parse(collectedAt || '');
  return Number.isFinite(born) && Number.isFinite(at) && at >= born && at - born <= DENSE_WINDOW;
}

function addDays(ymd, days) {
  return shanghaiDay(new Date(Date.parse(`${ymd}T12:00:00+08:00`) + days * DAY));
}
function weekdayIndex(date) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(date);
  return weekdays[name] ?? 0;
}
export function lastCompletedWeek(now = new Date()) {
  const today = shanghaiDay(now);
  const thisMonday = addDays(today, -weekdayIndex(now));
  return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
}
function atOrBefore(samples, untilMs) {
  return [...samples].filter(sample => Date.parse(sample.at) <= untilMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1) || null;
}
function viewsOf(sample) {
  const value = sample?.metrics?.views ?? sample?.views;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function interactionsOf(sample) {
  if (!sample) return null;
  const metrics = sample.metrics || sample;
  const keys = ['likes', 'comments', 'favorites', 'shares'];
  if (!keys.some(key => typeof metrics[key] === 'number')) return null;
  return keys.reduce((sum, key) => sum + (typeof metrics[key] === 'number' ? metrics[key] : 0), 0);
}
function publishedAt(post, samples) {
  const created = Date.parse(post?.createdAt || '');
  if (Number.isFinite(created)) return created;
  const first = [...samples].map(sample => Date.parse(sample.at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return first ?? null;
}

// Same 1/3/7 shape the archive page already renders. Day 1 is shown immediately and marked partial until the day has elapsed.
export function reviewsForPost({ post, samples = [], previous = null, followerSamples = [], now = Date.now() } = {}) {
  const t0 = publishedAt(post, samples);
  if (!t0) return [];
  return [1, 3, 7].filter(age => age === 1 || now >= t0 + age * DAY).map(age => {
    const until = Math.min(now, t0 + age * DAY);
    const sample = atOrBefore(samples, until) || (post.metrics ? { metrics: post.metrics, at: new Date(until).toISOString() } : null);
    const prevSamples = previous?.samples || [];
    const prevStart = previous ? publishedAt(previous, prevSamples) : null;
    const prevSample = prevStart ? atOrBefore(prevSamples, Math.min(now, prevStart + age * DAY)) : null;
    const startFans = atOrBefore(followerSamples, t0);
    const endFans = atOrBefore(followerSamples, until);
    const fans = startFans && endFans && typeof startFans.followers === 'number' && typeof endFans.followers === 'number' ? endFans.followers - startFans.followers : null;
    return {
      age,
      partial: now < t0 + age * DAY,
      views: viewsOf(sample),
      ints: interactionsOf(sample),
      prev: previous ? { nick: previous.title || previous.identity || '上一帖', views: viewsOf(prevSample) } : null,
      fans,
      conv: null,
      dense: Boolean(sample?.dense) || isDenseSample(post.createdAt, sample?.at),
    };
  });
}

function followersOn(account, day) {
  const sample = [...(account.samples || [])].filter(item => shanghaiDay(new Date(item.at)) <= day).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  return typeof sample?.followers === 'number' ? sample.followers : null;
}
function postViews(post) {
  const value = post?.metrics?.views;
  return typeof value === 'number' ? value : 0;
}

export function weeklyReport(accounts = [], now = new Date()) {
  const { from, to } = lastCompletedWeek(now);
  const rows = accounts.filter(account => account.enabled !== false).map(account => {
    const start = followersOn(account, addDays(from, -1));
    const end = followersOn(account, to);
    return { identity: account.identity, group: account.group || 'owned', delta: start != null && end != null ? end - start : null, followers: end };
  });
  const sum = list => list.reduce((total, row) => total + (row.delta || 0), 0);
  const owned = rows.filter(row => row.group !== 'benchmark');
  const benchmark = rows.filter(row => row.group === 'benchmark');
  const posts = accounts.flatMap(account => (account.posts || []).map(post => ({ identity: account.identity, group: account.group || 'owned', title: post.title || post.url || post.id, views: postViews(post), url: post.url || '' })));
  posts.sort((a, b) => b.views - a.views);
  return {
    from, to,
    followerDelta: sum(rows),
    ownedFollowerDelta: sum(owned),
    benchmarkFollowerDelta: sum(benchmark),
    accounts: rows,
    top: posts.slice(0, 5),
    note: '新帖前 72 小时只在每天最多 2 次的采集里记密采样，不会为了每 6 小时再打开一次浏览器或再打一次公开源。',
  };
}

export function healthIssues({ accounts = [], connectionError = '', now = Date.now() } = {}) {
  const issues = [];
  if (connectionError) issues.push({ level: 'bad', code: 'bit', text: `比特接口异常：${connectionError}` });
  for (const account of accounts) {
    if (account.enabled === false) continue;
    const name = `@${account.identity}`;
    if (account.status === 'login') issues.push({ level: 'bad', code: 'login', accountId: account.id, text: `${name} 停在登录页，需要人工登录` });
    else if (account.status === 'mismatch') issues.push({ level: 'bad', code: 'mismatch', accountId: account.id, text: `${name} 登录账号与绑定不一致` });
    else if (account.status === 'paused') issues.push({ level: 'bad', code: 'paused', accountId: account.id, text: `${name} 已暂停：${account.reason || '验证码或限流'}` });
    else if (account.status === 'failed') issues.push({ level: 'bad', code: 'failed', accountId: account.id, text: `${name} 采集失败：${account.reason || '没有拿到数据'}` });
    else if (account.status === 'offline') issues.push({ level: 'bad', code: 'offline', accountId: account.id, text: `${name} 的比特窗口没有运行` });
    if (account.analyticsIssue?.text) issues.push({ level: 'warn', code: account.analyticsIssue.code || 'analytics', accountId: account.id, text: `${name} ${account.analyticsIssue.text}` });
    const last = Date.parse(account.lastSuccess || '');
    if (account.lastSuccess && Number.isFinite(last) && now - last > 48 * HOUR) issues.push({ level: 'warn', code: 'gap', accountId: account.id, text: `${name} 已超过 48 小时没有新的成功采集` });
  }
  return issues;
}
