export const ACCOUNT_ANALYTICS_URL = 'https://x.com/i/account_analytics';
export function postAnalyticsUrl(handle, id) {
  return `https://x.com/${encodeURIComponent(handle)}/status/${id}/analytics`;
}

const COUNT_KEYS = [
  ['impressions', /impression|曝光|展示次数|展示量/i],
  ['profileVisits', /profile.?visit|主页访问|个人资料访问/i],
  ['linkClicks', /link.?click|url.?click|链接点击/i],
  ['engagements', /engagements?(?! rate)|互动次数|互动量/i],
  ['likes', /likes?|喜欢|点赞/i],
  ['replies', /repl(?:y|ies)|回复/i],
  ['reposts', /reposts?|转帖|转发/i],
  ['bookmarks', /bookmarks?|书签/i],
];

function percentOf(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const matched = text.match(/([\d,.]+)\s*%/);
  if (matched) {
    const n = Number(matched[1].replaceAll(',', ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const n = Number(text.replaceAll(',', ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return n <= 1 ? Math.round(n * 1000) / 10 : n;
}

function countOf(value) {
  if (value == null || value === '') return null;
  const matched = String(value).replaceAll(',', '').trim().match(/^([\d]+(?:\.\d+)?)\s*(万|亿|K|M|w)?/i);
  if (!matched) return null;
  const n = Math.round(Number(matched[1]) * ({ '万': 1e4, '亿': 1e8, k: 1e3, m: 1e6, w: 1e4 }[matched[2]?.toLowerCase()] || 1));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function labeled(text, pattern) {
  const source = String(text || '');
  const ahead = source.match(new RegExp(`(?:${pattern.source})[^\\d%]{0,32}([\\d,.]+\\s*(?:%|[万亿KM])?)`, 'i'));
  if (ahead) return ahead[1];
  const behind = source.match(new RegExp(`([\\d,.]+\\s*(?:%|[万亿KM])?)[^\\d%]{0,16}(?:${pattern.source})`, 'i'));
  return behind?.[1] || null;
}

function trendFrom(list) {
  const out = [];
  for (const item of list || []) {
    const day = String(item?.day || item?.date || '').slice(0, 10);
    const value = countOf(item?.value ?? item?.count ?? item?.followers);
    if (!day || value == null || out.some(row => row.day === day)) continue;
    out.push({ day, value });
    if (out.length >= 30) break;
  }
  return out;
}

function readJsonMetrics(bodies) {
  const found = {};
  const trend = [];
  const visit = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      const rows = node.slice(0, 40).map(item => item && typeof item === 'object' ? { day: item.date || item.day || item.timestamp, value: item.count ?? item.value ?? item.follows ?? item.followers } : null).filter(Boolean);
      if (!found.followerTrend && rows.some(row => row.day && row.value != null)) found.followerTrend = trendFrom(rows);
      for (const item of node.slice(0, 40)) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        for (const [name, pattern] of COUNT_KEYS) if (found[name] == null && pattern.test(key)) found[name] = value;
        if (found.engagementRate == null && /engagement.?rate|互动率/i.test(key)) found.engagementRate = percentOf(value);
      } else if (typeof value === 'string' && found.engagementRate == null && /engagement.?rate|互动率/i.test(key)) found.engagementRate = percentOf(value);
      else visit(value, depth + 1);
    }
  };
  for (const body of bodies || []) {
    if (!body) continue;
    try { visit(typeof body === 'string' ? JSON.parse(body) : body, 0); } catch { /* 页面自己的响应不是这份指标 */ }
  }
  if (found.followerTrend) trend.push(...found.followerTrend);
  return { ...found, followerTrend: trend };
}

export function parseAccountAnalytics(raw = {}) {
  if (raw.risk) return { halt: 'risk', message: raw.risk };
  if (raw.login) return { halt: 'login', message: '请在比特环境中人工登录后重新检查' };
  const text = String(raw.text || '');
  const fromPage = {
    impressions: countOf(raw.numbers?.impressions ?? labeled(text, /曝光|展示次数|展示量|impressions/i)),
    engagementRate: percentOf(raw.numbers?.engagementRate ?? labeled(text, /互动率|engagement rate/i)),
    profileVisits: countOf(raw.numbers?.profileVisits ?? labeled(text, /主页访问|个人资料访问|profile visits/i)),
    linkClicks: countOf(raw.numbers?.linkClicks ?? labeled(text, /链接点击|link clicks/i)),
    followerTrend: trendFrom(raw.trend),
  };
  const fromJson = readJsonMetrics(raw.bodies);
  const analytics = {
    impressions: fromPage.impressions ?? fromJson.impressions ?? null,
    engagementRate: fromPage.engagementRate ?? fromJson.engagementRate ?? null,
    profileVisits: fromPage.profileVisits ?? fromJson.profileVisits ?? null,
    linkClicks: fromPage.linkClicks ?? fromJson.linkClicks ?? null,
    followerTrend: fromPage.followerTrend.length ? fromPage.followerTrend : (fromJson.followerTrend || []),
  };
  const hasMetric = ['impressions', 'engagementRate', 'profileVisits', 'linkClicks'].some(key => analytics[key] != null) || analytics.followerTrend.length > 0;
  if (!hasMetric && /advanced analytics with plus|upgrade to continue|升级.{0,12}(?:继续|分析)/i.test(text)) {
    return { analytics: null, issue: { code: 'analytics-denied', text: 'X Analytics 要求升级订阅，未获取后台指标；粉丝和帖子可正常采集' } };
  }
  if (!hasMetric && (raw.permission || /没有.{0,24}权限|无权|无法查看分析|analytics isn.?t available|not available for this account|upgrade to premium|需要\s*premium/i.test(text))) {
    return { analytics: null, issue: { code: 'analytics-denied', text: '没有 X Analytics 权限，已跳过后台指标' } };
  }
  if (!hasMetric) return { analytics: null, issue: { code: 'analytics-layout', text: 'Analytics 页面结构对不上，本次没有写入后台指标' } };
  return { analytics, issue: null };
}

export function parsePostAnalytics(raw = {}) {
  if (raw.risk) return { halt: 'risk', message: raw.risk };
  if (raw.login) return { halt: 'login', message: '请在比特环境中人工登录后重新检查' };
  const text = String(raw.text || '');
  const fromJson = readJsonMetrics(raw.bodies);
  const analytics = {
    impressions: countOf(raw.numbers?.impressions ?? labeled(text, /曝光|展示次数|impressions/i)) ?? fromJson.impressions ?? null,
    engagementRate: percentOf(raw.numbers?.engagementRate ?? labeled(text, /互动率|engagement rate/i)) ?? fromJson.engagementRate ?? null,
    engagements: countOf(raw.numbers?.engagements ?? labeled(text, /互动次数|互动量|engagements/i)) ?? fromJson.engagements ?? null,
    likes: countOf(raw.numbers?.likes) ?? fromJson.likes ?? null,
    replies: countOf(raw.numbers?.replies) ?? fromJson.replies ?? null,
    reposts: countOf(raw.numbers?.reposts) ?? fromJson.reposts ?? null,
    bookmarks: countOf(raw.numbers?.bookmarks) ?? fromJson.bookmarks ?? null,
    profileVisits: countOf(raw.numbers?.profileVisits ?? labeled(text, /主页访问|profile visits/i)) ?? fromJson.profileVisits ?? null,
    linkClicks: countOf(raw.numbers?.linkClicks ?? labeled(text, /链接点击|link clicks/i)) ?? fromJson.linkClicks ?? null,
  };
  if (!Object.values(analytics).some(value => value != null)) {
    if (raw.permission || /没有.{0,24}权限|无权|无法查看分析|analytics isn.?t available/i.test(text)) return { analytics: null, issue: { code: 'analytics-denied', text: '没有该帖的 Analytics 权限' } };
    return { analytics: null, issue: { code: 'analytics-layout', text: '单帖分析页面结构对不上' } };
  }
  return { analytics, issue: null };
}

function pageProbe(kind) {
  return `(async()=>{
    /* matrix-analytics-read ${kind} */
    try {
      const text = document.body?.innerText || '';
      const visible = el => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
      const riskArea = [...document.querySelectorAll('[role="alert"],[role="dialog"],[role="status"],[data-testid="toast"],[data-testid="error-detail"]')].filter(visible).map(el => el.innerText).join('\\n');
      const challenge = /\\/(?:account\\/access|challenge|checkpoint)(?:\\/|$)/.test(location.pathname) || [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="arkoselabs"]')].some(visible);
      const risk = challenge ? '页面要求人工验证' : /rate limit(?: exceeded|ed)|too many requests|unusual (?:traffic|activity)|异常访问|操作过于频繁|请求过于频繁|已达到.*限制|(?:已)?超出(?:频率|请求)限制/i.test(riskArea) ? '平台提示访问异常或明确限流' : null;
      const self = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      const identity = self?.getAttribute('href')?.match(/^\\/([\\w]+)\\/?$/)?.[1] || null;
      const login = !!risk ? false : (/\\/(?:i\\/flow\\/login|accounts\\/login|signin)(?:\\/|$)/.test(location.pathname) || (!identity && !!document.querySelector('input[autocomplete="username"],a[href="/login"],a[href="/i/flow/login"]')));
      const grab = (label) => {
        const nodes = [...document.querySelectorAll('div,span,td,th,a,h1,h2,h3')];
        const hit = nodes.find(el => visible(el) && label.test(el.innerText || '') && (el.innerText || '').length < 80);
        if (!hit) return null;
        const blob = hit.parentElement?.innerText || hit.innerText || '';
        return (blob.match(/[\\d,.]+\\s*(?:%|[万亿KM])?/) || [])[0] || null;
      };
      const numbers = {
        impressions: grab(/曝光|展示次数|展示量|impressions/i),
        engagementRate: grab(/互动率|engagement rate/i),
        profileVisits: grab(/主页访问|个人资料访问|profile visits/i),
        linkClicks: grab(/链接点击|link clicks/i),
        engagements: grab(/互动次数|互动量|^engagements$/i),
      };
      const trend = [];
      for (const row of document.querySelectorAll('table tr,[role="row"],li')) {
        const line = row.innerText || '';
        const day = (line.match(/\\d{4}-\\d{2}-\\d{2}/) || line.match(/\\d{1,2}\\/\\d{1,2}/) || [])[0];
        const value = (line.match(/[\\d,.]+\\s*[万亿KM]?/) || [])[0];
        if (day && value) trend.push({ day, value });
        if (trend.length >= 30) break;
      }
      const permission = /没有权限|无权访问|无法查看分析|analytics isn.?t available|not available for this account|upgrade to premium|advanced analytics with plus|upgrade to continue|升级.{0,12}(?:继续|分析)|需要\\s*premium/i.test(text);
      const missing = !numbers.impressions && !numbers.profileVisits && !numbers.linkClicks && !trend.length;
      let bodies = [];
      if (missing && !risk && !login && !permission) {
        const names = (performance.getEntriesByType('resource') || []).map(entry => entry.name).filter(name => {
          try { const url = new URL(name); return ['x.com','www.x.com','api.x.com'].includes(url.hostname) && /analytics/i.test(url.pathname + url.search); }
          catch { return false; }
        }).slice(0, 2);
        for (const url of names) {
          const response = await fetch(url, { credentials: 'include' });
          if (response.status === 429) return { risk: '平台明确返回 HTTP 429 限流', login: false, ready: true, url: location.href };
          if (response.status === 401) return { login: true, ready: true, url: location.href };
          if (response.status === 403) return { permission: true, ready: true, text, url: location.href };
          if (!response.ok) continue;
          const body = await response.text();
          if (body.length <= 200000) bodies.push(body);
        }
      }
      const ready = !!(risk || login || permission || numbers.impressions || numbers.engagementRate || numbers.profileVisits || numbers.linkClicks || trend.length || bodies.length);
      return { kind: ${JSON.stringify(kind)}, identity, risk, login, permission, numbers, trend, text: text.slice(0, 4000), bodies, ready, url: location.href };
    } catch (error) {
      return { layout: true, ready: true, text: '', error: String(error && error.message || error).slice(0, 180), url: location.href };
    }
  })()`;
}

export function accountAnalyticsExpression() { return pageProbe('account'); }
export function postAnalyticsExpression() { return pageProbe('post'); }
