// 麦田：本地网页。播种（发布）、长势（流量）、收成（转化）、粮仓（档案）
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { db, NAMES, STATE_CN, episodes, getEpisode, getTasks, recentLogs, getSnapshot, getMeta } from './db.mjs';
import { config } from './feishu.mjs';
import { SITE } from './site.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(DIR, '..');
const W = config.web || { port: 8787, key: '' };
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readPj = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'publish.json'), 'utf8')); } catch { return null; } };
const short = (n) => n.split(/[｜|]/)[0].trim();
const nickOf = (name, pj) => (pj && pj.nick) || (short(name).split(/[，,？?！!：:。]/)[0].trim() || short(name)).slice(0, 16);
const latest = db.prepare('SELECT * FROM metrics WHERE episode_id=? AND platform=? ORDER BY day DESC LIMIT 1');
const actions = [];   // 最近的操作（内存里）

function episodeView(ep, full = false) {
  const snap = getSnapshot(ep.id), pj = (snap && JSON.parse(snap.project)) || readPj(ep.dir) || { platforms: {} };
  let views = 0, inter = 0;
  const tasks = getTasks(ep.id).map(t => {
    const m = latest.get(ep.id, t.platform) || null;
    if (m) { views += m.views || 0; inter += (m.likes || 0) + (m.comments || 0) + (m.favorites || 0) + (m.shares || 0); }
    const p = pj.platforms[t.platform] || {};
    return { platform: t.platform, name: NAMES[t.platform] || t.platform, state: t.state, stateCn: STATE_CN[t.state] || t.state, detail: t.detail || '', url: t.url || '', updatedAt: t.updated_at,
      m: m && { day: m.day, views: m.views, likes: m.likes, comments: m.comments, favorites: m.favorites, shares: m.shares, extra: JSON.parse(m.extra || '{}') },
      ...(full ? { copy: { title: p.title || p.shortTitle || '', body: p.desc || p.body || p.text || p.description || '', tags: p.tags || p.topics || [], covers: p.covers || [] }, shot: fs.existsSync(path.join(ep.dir, '发布档案', `${t.platform}.jpg`)) } : {}) };
  });
  const out = { id: ep.id, episode: ep.episode, name: ep.name, short: short(ep.name), nick: nickOf(ep.name, pj), schedule: ep.schedule, createdAt: ep.created_at, dir: ep.dir,
    campaign: (JSON.stringify(pj.platforms).match(/utm_campaign=([\w-]+)/) || [])[1] || '', covers: Object.keys(pj.covers || {}), durationSec: pj.durationSec || 0, tasks, views, inter };
  if (full) {
    out.logs = recentLogs(ep.id, 200);
    out.metrics = db.prepare('SELECT day, platform, views, likes, comments, favorites, shares FROM metrics WHERE episode_id=? ORDER BY day').all(ep.id);
    out.snapshotAt = snap && snap.taken_at;
    out.files = ['成片.mp4', '字幕.srt', '发布素材.md', 'publish.json', '发布记录.json'].filter(f => fs.existsSync(path.join(ep.dir, f)));
  }
  return out;
}

const ACT = { links: '取链接', mark: '标记', 'login-expired': '登录过期', upload: '上传', fill: '填写', submit: '提交', verify: '核对' };
function feed(n = 14) {
  const names = Object.fromEntries(episodes().map(e => [e.id, e.episode])), nicks = Object.fromEntries(episodes().map(e => [e.id, nickOf(e.name, readPj(e.dir))]));
  return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(n).map(l => {
    let r = l.result || ''; try { const j = JSON.parse(r); r = j.status || j.note || ''; } catch {}
    return { ts: l.ts, episode: names[l.episode_id] || '', nick: nicks[l.episode_id] || '', platform: NAMES[l.platform] || l.platform || '', action: ACT[l.action] || l.action, result: STATE_CN[r] || String(r).slice(0, 40) };
  });
}
async function chromeUp() { try { const r = await fetch(`http://127.0.0.1:${config.chromePort || 9333}/json/version`, { signal: AbortSignal.timeout(800) }); return r.ok; } catch { return false; } }

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  // 访问口令：第一次带 ?key= 进来，之后用 cookie
  const cookieKey = ((req.headers.cookie || '').match(/mt_key=([^;]+)/) || [])[1];
  if (W.key && cookieKey !== W.key) {
    if (u.searchParams.get('key') === W.key) return send(res, 302, '', 'text/plain', { 'set-cookie': `mt_key=${W.key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`, location: '/' });
    return send(res, 401, '<meta charset="utf-8"><body style="font:16px system-ui;padding:40px">需要访问口令。请用带 <code>?key=…</code> 的地址打开一次。</body>', 'text/html; charset=utf-8');
  }
  if (u.pathname.startsWith('/static/')) { const f = path.join(DIR, 'web', path.basename(u.pathname)); if (!/\.(css|js)$/.test(f) || !fs.existsSync(f)) return send(res, 404, ''); return send(res, 200, fs.readFileSync(f), f.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'); }
  if (u.pathname === '/p') return send(res, 200, fs.readFileSync(path.join(DIR, 'web', 'pages.html')), 'text/html; charset=utf-8');
  if (u.pathname === '/board') return send(res, 200, fs.readFileSync(path.join(DIR, 'web', 'board.html')), 'text/html; charset=utf-8');
  if (u.pathname === '/') return send(res, 200, fs.readFileSync(path.join(DIR, 'web', 'board.html')), 'text/html; charset=utf-8');
  if (u.pathname === '/api/overview') {
    return send(res, 200, { name: config.name || '麦田', siteOn: !!SITE, siteName: SITE ? SITE.name : '', siteLogo: !!(SITE && config.site.logo), board: config.board && config.board.url, driver: config.driver,
      episodes: episodes().sort((a, b) => (b.episode || 0) - (a.episode || 0)).map(e => episodeView(e)), actions: actions.slice(-8).reverse(),
      site: { days: db.prepare('SELECT * FROM site_daily ORDER BY day').all(), channels: db.prepare('SELECT * FROM site_channels ORDER BY revenue DESC').all(),
        campaigns: db.prepare('SELECT * FROM site_campaigns ORDER BY reg DESC').all(), campaignsOn: getMeta('siteCampaigns') === 'on' },
      metrics: db.prepare('SELECT day, episode_id, platform, views FROM metrics ORDER BY day').all(),
      followers: db.prepare("SELECT day, platform, total, gain, loss, source FROM followers WHERE day >= date('now','localtime','-40 day') ORDER BY day").all(),
      samples: db.prepare('SELECT ts, episode_id, platform, views FROM samples ORDER BY ts').all(),
      feed: feed(), health: { nas: fs.existsSync(config.rootPath), chrome: await chromeUp(), metricsDay: getMeta('metricsDay') || '', doctorDay: getMeta('doctorDay') || '', login: Object.fromEntries((config.keepAlive || []).map(k => [k, getMeta(`login:${k}`) || '']) ) }, now: new Date().toISOString() });
  }
  if (u.pathname === '/site-logo') { const f = SITE && config.site.logo && path.resolve(ROOT, config.site.logo); return f && fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), /\.svg$/.test(f) ? 'image/svg+xml' : /\.jpe?g$/.test(f) ? 'image/jpeg' : 'image/png', { 'cache-control': 'max-age=3600' }) : send(res, 404, ''); }
  if (u.pathname === '/api/episode') { const ep = getEpisode(u.searchParams.get('id')); return ep ? send(res, 200, episodeView(ep, true)) : send(res, 404, { error: '没有这一期' }); }
  if (u.pathname === '/cover' || u.pathname === '/shot') {
    const ep = getEpisode(u.searchParams.get('id')); if (!ep) return send(res, 404, '');
    let f;
    if (u.pathname === '/shot') f = path.join(ep.dir, '发布档案', `${(u.searchParams.get('p') || '').replace(/\W/g, '')}.jpg`);
    else { const pj = readPj(ep.dir) || {}; const rel = (pj.covers || {})[u.searchParams.get('k') || '4x3'] || Object.values(pj.covers || {})[0]; f = rel && path.join(ep.dir, rel); }
    if (!f || !f.startsWith(ep.dir) || !fs.existsSync(f)) return send(res, 404, '');
    return send(res, 200, fs.readFileSync(f), /\.png$/.test(f) ? 'image/png' : 'image/jpeg', { 'cache-control': 'max-age=300' });
  }
  if (u.pathname === '/api/action' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      let a; try { a = JSON.parse(body); } catch { return send(res, 400, { error: '请求格式不对' }); }
      const map = { sync: ['sync', a.id], metrics: a.id ? ['metrics', a.id] : ['metrics'], doctor: ['doctor', '--notify'], board: ['board'], followers: ['followers'],
        mark: ['mark', a.id, a.platform, a.state, a.note || '在麦田里标记', ...(a.url ? ['--url', a.url] : [])] };
      const argv = map[a.type];
      if (!argv || argv.some(x => x === undefined || x === null || x === '')) return send(res, 400, { error: '不支持的操作' });
      if (a.type === 'mark' && (a.state !== 'published' || !getEpisode(a.id) || !NAMES[a.platform])) return send(res, 400, { error: '状态不对' });
      if (actions.some(x => !x.done && x.type !== 'mark') && a.type !== 'mark') return send(res, 409, { error: '上一个操作还在跑，等它结束' });
      const rec = { type: a.type, label: { sync: '取链接', metrics: '采流量', doctor: '体检', board: '同步知识站数据', followers: '采粉丝', mark: '标记状态', retry: '重跑平台' }[a.type] + (a.platform ? ` · ${NAMES[a.platform] || a.platform}` : ''), startedAt: new Date().toISOString(), done: false, ok: null, tail: '' };
      actions.push(rec);
      const ch = spawn(process.execPath, [path.join(DIR, 'hub.mjs'), ...argv], { cwd: ROOT, env: { ...process.env, HUB_NO_WEB: '1' } });
      const on = (d) => { rec.tail = (rec.tail + d).slice(-600); }; ch.stdout.on('data', on); ch.stderr.on('data', on);
      ch.on('close', (code) => { rec.done = true; rec.ok = code === 0; rec.endedAt = new Date().toISOString(); });
      send(res, 200, { ok: true });
    });
    return;
  }
  send(res, 404, { error: 'not found' });
}
export function startWeb() {
  const srv = http.createServer((req, res) => { handle(req, res).catch((e) => { try { send(res, 500, { error: e.message }); } catch {} }); });
  srv.listen(W.port, '0.0.0.0', () => console.log(`麦田网页：http://localhost:${W.port}/?key=${W.key}`));
  srv.on('error', (e) => console.error('麦田网页没起来：' + e.message));
  return srv;
}
