import { fault } from './browser.mjs';

export function numberOf(value) {
  if (value == null || value === '') return null;
  const m = String(value).replaceAll(',', '').trim().match(/^([\d]+(?:\.\d+)?)\s*(万|亿|K|M|w)?/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ '万': 1e4, '亿': 1e8, k: 1e3, m: 1e6, w: 1e4 }[m[2]?.toLowerCase()] || 1));
}
export function normalizeIdentity(platform, value) {
  const s = String(value || '').trim().replace(/^@/, '');
  if (platform === 'youtube') { if (!/^UC[\w-]{22}$/.test(s)) throw fault('identity', 'YouTube 请填写 UC 开头的频道 ID'); return s; }
  if (!['x', 'instagram'].includes(platform) || !(platform === 'x' ? /^[a-zA-Z0-9_]{1,15}$/ : /^[a-zA-Z0-9_.]{1,30}$/).test(s)) throw fault('identity', '请填写平台账号用户名，不要填写昵称');
  return s.toLowerCase();
}
export function postKey(platform, value) {
  let u; try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (platform === 'x' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) return u.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/)?.[1] || null;
  if (platform === 'instagram' && ['instagram.com', 'www.instagram.com'].includes(host)) return u.pathname.match(/^\/reel\/([\w-]+)(?:\/|$)/)?.[1] || null;
  if (platform === 'youtube') {
    let id = null;
    if (host === 'youtu.be') id = u.pathname.split('/')[1];
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) id = u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  }
  return null;
}
function platformPage(platform, value) {
  try { const h = new URL(value).hostname; return platform === 'x' ? ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(h) : platform === 'youtube' ? h === 'studio.youtube.com' : ['instagram.com', 'www.instagram.com'].includes(h); } catch { return false; }
}
function accountUrl(platform, id) { return platform === 'x' ? `https://x.com/${id}` : platform === 'instagram' ? `https://www.instagram.com/${id}/` : `https://studio.youtube.com/channel/${id}`; }

// DOM selectors and IG media/info are adapted from the existing 麦田 followers/metrics collectors.
// Identity checks and page lifecycle are kept here because upstream's global browser driver cannot isolate profiles.
export function snapshot(platform, key) {
  const text = document.body?.innerText || '';
  const visible = el => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const riskArea = [...document.querySelectorAll('[role="alert"],[role="dialog"],[role="status"],[data-testid="toast"],[data-testid="error-detail"],[data-testid="empty_state_header_text"],tp-yt-paper-toast,main > h1,main > h2')].filter(visible).map(e => e.innerText).join('\n');
  const challenge = /\/(?:account\/access|challenge|checkpoint)(?:\/|$)/.test(location.pathname) || [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="arkoselabs"],input[name="captcha"]')].some(visible);
  const risk = challenge ? '页面要求人工验证' : /rate limit(?: exceeded|ed)|too many requests|unusual (?:traffic|activity)|异常访问|操作过于频繁|请求过于频繁|访问过于频繁|已达到.*限制|(?:已)?超出(?:频率|请求)限制|try again later.{0,60}(?:restrict|limit)/i.test(riskArea) ? '平台提示访问异常或明确限流' : null;
  let identity = null, followers = null, metrics = null;
  let login = /\/(?:i\/flow\/login|accounts\/login|signin)(?:\/|$)/.test(location.pathname);
  if (platform === 'x') {
    const self = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    identity = self?.getAttribute('href')?.match(/^\/([\w]+)\/?$/)?.[1] || null;
    login ||= !identity && !!document.querySelector('input[autocomplete="username"],input[name="session[username_or_email]"],a[href="/login"],a[href="/i/flow/login"]');
    const own = location.pathname.replace(/\/$/, '').toLowerCase() === `/${identity?.toLowerCase()}`;
    if (own) followers = document.querySelector(`a[href="/${identity}/verified_followers"],a[href="/${identity}/followers"]`)?.innerText || null;
    if (key) {
      const article = [...document.querySelectorAll('article')].find(a => {
        // The first timestamp permalink belongs to the main post, not a quoted status link in its body.
        const permalink = a.querySelector('a[href] time')?.closest('a');
        return permalink?.getAttribute('href')?.match(/\/status\/(\d+)(?:\/|$)/)?.[1] === key;
      });
      metrics = article ? [...article.querySelectorAll('[role="group"][aria-label]')].filter(g => g.closest('article') === article).at(-1)?.getAttribute('aria-label') || null : null;
    }
  } else if (platform === 'instagram') {
    const self = [...document.querySelectorAll('a[href] img[alt]')].find(img => visible(img) && /的头像|profile picture/i.test(img.alt) && img.getBoundingClientRect().x < 150);
    identity = self?.closest('a')?.getAttribute('href')?.match(/^\/([\w.]+)\/?$/)?.[1] || null;
    login ||= !identity && !!document.querySelector('input[name="username"],input[name="password"],a[href*="/accounts/login"]');
    if (identity && location.pathname.replace(/\/$/, '').toLowerCase() === `/${identity.toLowerCase()}`) followers = text.match(/([\d,.]+\s*[万KM]?)\s*(?:位粉丝|粉丝|followers)/i)?.[1] || null;
  } else {
    // Studio's authenticated drawer links identify the active channel; a requested URL alone is insufficient.
    const ids = [...document.querySelectorAll('ytcp-navigation-drawer a[href*="/channel/"]')].map(a => a.href.match(/\/channel\/(UC[\w-]{22})(?:\/|$)/)?.[1]).filter(Boolean);
    const unique = [...new Set(ids)];
    if (document.querySelector('ytcp-app') && unique.length === 1) identity = unique[0];
    login ||= location.hostname === 'accounts.google.com' || !!document.querySelector('input[type="email"]');
    followers = text.match(/(?:当前订阅人数|Current subscribers)\s*\n?\s*([\d,.]+\s*[万KM]?)/i)?.[1] || null;
    if (key) {
      const row = [...document.querySelectorAll('ytcp-video-row')].find(r => [...r.querySelectorAll('a[href*="/video/"]')].some(a => a.href.match(/\/video\/([\w-]+)(?:\/|$)/)?.[1] === key));
      if (row) metrics = Object.fromEntries(['views', 'comments', 'likes'].map(k => [k, row.querySelector('.tablecell-' + k)?.innerText?.trim() || null]));
    }
  }
  return { identity, followers, metrics, risk, login, url: location.href };
}
const expression = (platform, key) => `(${snapshot.toString()})(${JSON.stringify(platform)},${JSON.stringify(key || null)})`;

// Read-only. Scrolls a temporary profile tab to load posts. Does not click, like, follow, or post.
export function timelineExpression(platform, limit) {
  const cap = Math.max(1, Math.min(50, Number(limit) || 20));
  return `(async()=>{
    const snapshot=${snapshot.toString()};
    const cap=${cap};
    const harvest=()=>{
      const posts=[]; const seen=new Set();
      for (const article of document.querySelectorAll('article')) {
        const permalink=article.querySelector('a[href] time')?.closest('a');
        const href=permalink?.getAttribute('href')||'';
        const id=href.match(/\\/status\\/(\\d+)/)?.[1];
        if(!id||seen.has(id)) continue;
        seen.add(id);
        const label=[...article.querySelectorAll('[role="group"][aria-label]')].filter(g=>g.closest('article')===article).at(-1)?.getAttribute('aria-label')||null;
        const text=article.querySelector('[data-testid="tweetText"]')?.innerText||'';
        const time=article.querySelector('time')?.getAttribute('datetime')||null;
        posts.push({id, text:String(text).slice(0,180), time, metrics:label});
        if(posts.length>=cap) break;
      }
      return posts;
    };
    let stable=0, prev=-1;
    for(let i=0;i<8;i++){
      const snap=snapshot(${JSON.stringify(platform)}, null);
      if(snap.risk||snap.login) return {...snap, posts:harvest()};
      const n=document.querySelectorAll('article').length;
      if(n>=cap) break;
      if(n===prev) stable++; else stable=0;
      if(stable>=2) break;
      prev=n;
      scrollBy(0, Math.max(500, innerHeight||800));
      await new Promise(r=>setTimeout(r,600));
    }
    try { scrollTo(0,0); } catch {}
    const snap=snapshot(${JSON.stringify(platform)}, null);
    return {...snap, posts:harvest()};
  })()`;
}
function mapTimeline(handle, posts, limit) {
  const out = [];
  const seen = new Set();
  for (const post of posts || []) {
    const id = String(post?.id || '').match(/^\d{5,25}$/)?.[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      sourceKey: `x:status:${id}`,
      url: `https://x.com/${handle}/status/${id}`,
      title: String(post.text || `帖子 ${id}`).replace(/\s+/g, ' ').trim().slice(0, 180) || `帖子 ${id}`,
      status: '已发布',
      createdAt: post.time || null,
      metrics: parseMetrics('x', post.metrics) || {},
      source: '主页时间线',
    });
    if (out.length >= limit) break;
  }
  return out;
}
export function checkIdentity(platform, expected, data) {
  if (data?.risk) throw fault('risk', data.risk);
  if (data?.login) throw fault('login', '请在比特环境中人工登录后重新检查');
  if (!data?.identity) throw fault('identity', '无法可靠识别当前登录账号，请检查平台页面或适配版本');
  const actual = normalizeIdentity(platform, data.identity);
  if (actual !== expected) throw fault('mismatch', `当前登录账号 ${actual} 与绑定账号 ${expected} 不一致，请确认绑定`);
  return actual;
}
function parseMetrics(platform, data) {
  if (!data) return null;
  if (platform !== 'x') return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, numberOf(v)]));
  const patterns = { views: 'views?|次观看|次浏览|次查看|观看次数|浏览次数|查看次数', likes: 'likes?|个喜欢|次喜欢|次点赞|喜欢|点赞', comments: 'repl(?:y|ies)|条回复|次回复|回复', favorites: 'bookmarks?|个书签|书签', shares: 'reposts?|次转帖|转帖|转发' };
  return Object.fromEntries(Object.entries(patterns).map(([k, p]) => [k, numberOf(data.match(new RegExp(`([\\d,.]+\\s*[KM万亿]?)\\s*(?:${p})(?:\\b|(?=[，,。、；;\\s]|$))`, 'i'))?.[1])]));
}
async function instagramMedia(cdp, page, key) {
  const result = await cdp.evaluate(page, `(async()=>{const A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';let pk=0n;for(const c of ${JSON.stringify(key)})pk=pk*64n+BigInt(A.indexOf(c));const r=await fetch('/api/v1/media/'+pk+'/info/',{credentials:'include',headers:{'X-IG-App-ID':'936619743392459'}});if(r.status===429)return {risk:'平台明确返回 HTTP 429 限流'};if(r.status===401)return {login:true};if(!r.ok)return {error:'作品接口 HTTP '+r.status};const d=await r.json();if(d.challenge||d.challenge_required||d.message==='challenge_required')return {risk:'平台要求人工验证'};const it=d.items?.[0];return it?{metrics:{views:it.play_count??it.ig_play_count??null,likes:it.like_count??null,comments:it.comment_count??null,shares:it.reshare_count??null}}:{error:'未取得已登记作品指标'}})()`);
  if (result.risk) throw fault('risk', result.risk);
  if (result.login) throw fault('login', '请在比特环境中人工登录后重新检查');
  if (result.error) throw fault('error', result.error);
  return result.metrics;
}

export async function collectAccount(account, bit) {
  const { profileId, platform, identity, posts = [] } = account;
  const expected = normalizeIdentity(platform, identity);
  const cdp = await bit.connect(profileId), owned = [], used = [], collectedPosts = [], warnings = [];
  let completed = false;
  try {
    const pages = await cdp.pages();
    const loginUrl = platform === 'x' ? 'https://x.com/i/flow/login' : platform === 'instagram' ? 'https://www.instagram.com/accounts/login/' : 'https://studio.youtube.com/';
    async function verify(data) {
      if (data?.login && !data.risk) {
        const isLogin = value => {
          const u=new URL(value);
          return platform === 'youtube' ? u.hostname === 'accounts.google.com' :
            platformPage(platform,value) && (platform === 'x' ? /^\/i\/flow\/login(?:\/|$)/ : /^\/accounts\/login(?:\/|$)/).test(u.pathname);
        };
        if (!isLogin(data.url || loginUrl) && !pages.some(p => isLogin(p.url))) owned.push(await cdp.create(loginUrl));
      }
      return checkIdentity(platform, expected, data);
    }
    async function read(url, matcher, key, need) {
      for (const page of pages.filter(p => platformPage(platform, p.url) && matcher(p.url))) {
        const data = await cdp.evaluate(page, expression(platform, key));
        if (!data?.identity && !data?.login && !data?.risk) continue;
        await verify(data);
        if (need(data)) { used.push(page); return { page, data, source: owned.includes(page) ? '采集临时页面' : '已有页面的可读数据（未刷新）' }; }
      }
      const page = await cdp.create(url); owned.push(page); pages.push(page);
      let data;
      for (let i = 0; i < 12; i++) {
        data = await cdp.evaluate(page, expression(platform, key));
        if (data?.risk || data?.login || (data?.identity && need(data))) break;
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      await verify(data);
      used.push(page);
      return { page, data, source: '采集临时页面' };
    }
    const home = accountUrl(platform, expected);
    const ownPage = u => { try { const p = new URL(u).pathname.replace(/\/$/, ''); return platform === 'youtube' ? p === `/channel/${expected}` : p.toLowerCase() === `/${expected}`; } catch { return false; } };
    const follower = await read(home, ownPage, null, d => d.followers != null);
    const followers = numberOf(follower.data.followers);
    let discovered = [];
    const timelineLimit = Math.max(0, Math.min(50, Number(account.timelineLimit) || 0));
    if (platform === 'x' && timelineLimit > 0) {
      const page = await cdp.create(home);
      owned.push(page); pages.push(page);
      let ready;
      for (let i = 0; i < 12; i++) {
        ready = await cdp.evaluate(page, expression(platform, null));
        if (ready?.risk || ready?.login || ready?.identity) break;
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      if (ready?.risk) throw fault('risk', ready.risk);
      if (ready?.login) throw fault('login', '请在比特环境中人工登录后重新检查');
      if (!ready?.identity) warnings.push({ reason: '时间线页面未能确认登录身份，已跳过自动发现' });
      else {
        checkIdentity(platform, expected, ready);
        try {
          const raw = await cdp.evaluate(page, timelineExpression(platform, timelineLimit));
          if (raw?.risk) throw fault('risk', raw.risk);
          if (raw?.login) throw fault('login', '请在比特环境中人工登录后重新检查');
          if (raw?.identity) checkIdentity(platform, expected, raw);
          discovered = mapTimeline(expected, raw?.posts, timelineLimit);
        } catch (error) {
          if (error.code && error.code !== 'error') throw error;
          warnings.push({ reason: `时间线发现失败：${error.message}` });
        }
      }
    }
    const rich = new Set(discovered.filter(post => Object.values(post.metrics || {}).some(v => typeof v === 'number')).map(post => post.sourceKey.match(/^x:status:(\d+)$/)?.[1]));
    const inWindow = new Set(discovered.map(post => post.sourceKey.match(/^x:status:(\d+)$/)?.[1]));
    const pagePosts = !(timelineLimit > 0 && platform === 'x') ? posts
      : discovered.length ? posts.filter(post => { const key = postKey(platform, post.url); return key && inWindow.has(key) && !rich.has(key); })
      : [...posts].sort((a, b) => String(postKey(platform, b.url) || '').localeCompare(String(postKey(platform, a.url) || ''))).slice(0, timelineLimit);
    for (const post of pagePosts) {
      const key = postKey(platform, post.url);
      if (!key) { warnings.push({ id: post.id, reason: '登记链接缺失或接入版本不支持该作品链接' }); continue; }
      try {
      const url = platform === 'youtube' ? `https://studio.youtube.com/channel/${expected}/videos/upload` : post.url;
      const match = u => platform === 'youtube' ? new URL(u).pathname === `/channel/${expected}/videos/upload` : postKey(platform, u) === key;
      const result = await read(url, match, key, d => platform === 'instagram' ? !!d.identity : d.metrics != null);
      let metrics = platform === 'instagram' ? await instagramMedia(cdp, result.page, key) : parseMetrics(platform, result.data.metrics);
      if (platform === 'x') {
        const article = String(post.detail || '').match(/长文\s*(https:\/\/x\.com\/[^\s（）()]+?\/status\/\d+)/)?.[1];
        const articleKey = postKey('x', article);
        if (articleKey && articleKey !== key) {
          const a = await read(article, u => postKey('x', u) === articleKey, articleKey, d => d.metrics != null);
          const extra = parseMetrics('x', a.data.metrics);
          if (metrics && extra) {
            const videoViews = metrics.views;
            metrics = Object.fromEntries(Object.keys(metrics).map(k => [k, metrics[k] == null || extra[k] == null ? null : metrics[k] + extra[k]]));
            metrics.extra = { 视频帖播放: videoViews, 长文播放: extra.views };
          }
        }
      }
      // Verify login identity again after any authenticated media request before allowing persistence.
      await verify(await cdp.evaluate(result.page, expression(platform, key)));
      if (metrics && Object.values(metrics).some(v => typeof v === 'number')) collectedPosts.push({ id: post.id, metrics, source: result.source });
      else warnings.push({ id: post.id, reason: '未取得作品指标；保留上次数据' });
      } catch (error) {
        if (error.code && error.code !== 'error') throw error;
        warnings.push({ id: post.id, reason: error.message });
      }
    }
    for (const page of new Set(used)) await verify(await cdp.evaluate(page, expression(platform)));
    if (followers == null && !collectedPosts.length && !discovered.length) throw fault('error', '页面未提供可读取指标；保留上次数据');
    completed = true;
    return { identity: expected, followers, posts: collectedPosts, discovered, source: follower.source, warnings };
  } finally {
    // Never close the Profile or pre-existing tabs; failed/login/verification pages remain for manual inspection.
    if (completed) for (const page of owned) await cdp.closePage(page).catch(() => {});
    cdp.close();
  }
}
