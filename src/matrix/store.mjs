import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { postKey } from './collector.mjs';
import { isDenseSample } from './review.mjs';
import { shanghaiDay } from './schedule.mjs';

export const platforms = ['x', 'youtube', 'instagram'];
export function identityOf(platform, value) {
  if (!platforms.includes(platform)) throw new Error('不支持的平台');
  const s = String(value || '').trim().replace(/^@/, '');
  if (platform === 'youtube') {
    if (!/^UC[\w-]{22}$/.test(s)) throw new Error('YouTube 请填写 UC 开头的频道 ID（不是昵称或 @handle）');
    return s;
  }
  if (!(platform === 'x' ? /^[a-zA-Z0-9_]{1,15}$/ : /^[a-zA-Z0-9_.]{1,30}$/).test(s)) throw new Error('请填写平台唯一用户名，不是昵称或网址');
  return s.toLowerCase();
}
export const validMetric = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const now = () => new Date().toISOString();
export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,，]/);
  const out = [];
  for (const tag of list) {
    const value = String(tag || '').trim().slice(0, 32);
    if (!value || out.includes(value)) continue;
    out.push(value);
    if (out.length >= 20) break;
  }
  return out;
}
function parseTags(value) {
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.map(String) : []; }
  catch { return []; }
}
function statusIdOf(post) {
  return postKey('x', post?.url || '') || String(post?.sourceKey || post?.source_key || '').match(/^x:status:(\d+)$/)?.[1] || null;
}
const metricAliases = { views: ['views', 'view_count'], likes: ['likes', 'like_count'], comments: ['comments', 'replies', 'reply_count'], favorites: ['favorites', 'bookmarks', 'bookmark_count'], shares: ['shares', 'reposts', 'retweets', 'repost_count'] };
export function normalizeExternalPosts(identity, posts) {
  if (!Array.isArray(posts)) throw new Error('posts 须为数组');
  const out = [];
  const seen = new Set();
  for (const post of posts) {
    const metricsSource = post?.metrics && typeof post.metrics === 'object' ? post.metrics : post || {};
    const id = String(post?.id || post?.statusId || '').trim().match(/^\d{5,25}$/)?.[0] || postKey('x', post?.url || '');
    if (!/^\d{5,25}$/.test(id || '')) throw new Error('帖子 id 无效');
    if (post?.url && postKey('x', post.url) !== id) throw new Error('帖子链接与 id 不一致');
    if (seen.has(id)) continue;
    seen.add(id);
    const metrics = {};
    for (const [key, aliases] of Object.entries(metricAliases)) {
      for (const alias of aliases) {
        if (metricsSource[alias] == null || metricsSource[alias] === '') continue;
        if (!Number.isInteger(metricsSource[alias]) || metricsSource[alias] < 0) throw new Error(`指标 ${alias} 无效`);
        metrics[key] = metricsSource[alias];
        break;
      }
    }
    out.push({ sourceKey: `x:status:${id}`, url: `https://x.com/${identity}/status/${id}`, title: String(post.text || post.title || `帖子 ${id}`).slice(0, 180), status: '已发布', createdAt: post.createdAt || post.created_at || null, metrics, source: '外部导入' });
  }
  return out;
}

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, platform TEXT NOT NULL, identity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL DEFAULT '', project_path TEXT NOT NULL DEFAULT '', UNIQUE(platform,identity));
      CREATE TABLE IF NOT EXISTS bindings (id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), account_id TEXT NOT NULL REFERENCES accounts(id), platform TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS current_slot ON bindings(profile_id,platform) WHERE ended_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS current_account ON bindings(account_id) WHERE ended_at IS NULL;
      CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), source_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), data TEXT NOT NULL, collected_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_runs (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, slot TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'started');
    `);
    const cols = new Set(this.db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name));
    const add = (name, ddl) => { if (!cols.has(name)) this.db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${ddl}`); };
    add('group_kind', "TEXT NOT NULL DEFAULT 'owned'");
    add('notes', "TEXT NOT NULL DEFAULT ''");
    add('tags', "TEXT NOT NULL DEFAULT '[]'");
    add('enabled', 'INTEGER NOT NULL DEFAULT 1');
    add('display_name', "TEXT NOT NULL DEFAULT ''");
    // An interrupted process cannot retain an in-flight collection lock.
    this.db.prepare("UPDATE accounts SET status='failed',reason='上次采集被中断，请手动更新' WHERE status='collecting'").run();
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; }
  }
  settings() {
    return { bitUrl: 'http://127.0.0.1:54345', maitianRoot: '', timelineLimit: '20', collectsPerDay: '1', collectHours: '9', concurrency: '1', intervalMinMinutes: '3', intervalMaxMinutes: '8', scheduleEnabled: '0', ...Object.fromEntries(this.db.prepare('SELECT * FROM settings').all().map(x => [x.key, x.value])) };
  }
  setSettings(values) { for (const [k, v] of Object.entries(values)) this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(k, v); }
  profiles() { return this.db.prepare('SELECT * FROM profiles ORDER BY rowid').all(); }
  addProfile(id, name) {
    if (!id || typeof id !== 'string') throw new Error('环境 ID 不能为空');
    this.db.prepare('INSERT INTO profiles VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(id, String(name || id));
  }
  bind({profileId, platform, identity, projectPath = '', confirmed}) {
    if (confirmed !== true) throw new Error('请明确确认账号和工程归属');
    identity = identityOf(platform, identity);
    if (!this.profiles().some(p => p.id === profileId)) throw new Error('请先纳管环境');
    return this.transaction(() => {
      let account = this.db.prepare('SELECT * FROM accounts WHERE platform=? AND identity=?').get(platform, identity);
      const bound = account && this.db.prepare('SELECT * FROM bindings WHERE account_id=? AND ended_at IS NULL').get(account.id);
      if (bound && bound.profile_id !== profileId) throw new Error(`该账号已归属环境 ${bound.profile_id}`);
      const current = this.db.prepare('SELECT * FROM bindings WHERE profile_id=? AND platform=? AND ended_at IS NULL').get(profileId, platform);
      if (!account) {
        account = {id: randomUUID()};
        this.db.prepare('INSERT INTO accounts(id,platform,identity,project_path) VALUES (?,?,?,?)').run(account.id, platform, identity, projectPath);
      } else if (projectPath) this.db.prepare('UPDATE accounts SET project_path=? WHERE id=?').run(projectPath, account.id);
      if (current?.account_id !== account.id) {
        if (current) this.db.prepare('UPDATE bindings SET ended_at=? WHERE id=?').run(now(), current.id);
        this.db.prepare('INSERT INTO bindings(profile_id,account_id,platform,started_at) VALUES (?,?,?,?)').run(profileId, account.id, platform, now());
      }
      return account.id;
    });
  }
  account(id) { return this.accounts().find(a => a.id === id); }
  accounts() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY rowid').all().map(a => {
      const history = this.db.prepare('SELECT profile_id AS profileId,started_at AS startedAt,ended_at AS endedAt FROM bindings WHERE account_id=? ORDER BY id').all(a.id);
      const current = history.find(b => !b.endedAt);
      const group = a.group_kind || 'owned';
      const enabled = a.enabled == null ? true : Number(a.enabled) !== 0;
      const samples = this.db.prepare('SELECT data,collected_at FROM snapshots WHERE account_id=? ORDER BY id DESC').all(a.id);
      const parsed = samples.map(s => ({ ...JSON.parse(s.data), at: s.collected_at }));
      const last = parsed[0] || null;
      const followerSamples = parsed.filter(s => validMetric(s.followers));
      return { id:a.id, platform:a.platform, identity:a.identity, status:a.status, reason:a.reason, projectPath:a.project_path, group, notes:a.notes || '', tags:parseTags(a.tags), enabled, displayName:a.display_name || '', active: group === 'benchmark' ? true : !!current, profileId:current?.profileId || (group === 'benchmark' ? null : history.at(-1)?.profileId), history,
        followers:followerSamples[0]?.followers ?? null, followersLastSuccess:followerSamples[0]?.at ?? null, growth:followerSamples.length > 1 ? followerSamples[0].followers - followerSamples[1].followers : null,
        lastSuccess:samples[0]?.collected_at ?? null, source:last?.source ?? null,
        analytics: last?.analytics || null, analyticsIssue: last?.analyticsIssue || null,
        analyticsHistory: [...parsed].reverse().filter(s => s.analytics || s.analyticsIssue).map(s => ({ at: s.at, analytics: s.analytics || null, issue: s.analyticsIssue || null })),
        posts:this.db.prepare('SELECT id,data FROM posts WHERE account_id=? ORDER BY rowid').all(a.id).map(p => ({...JSON.parse(p.data), id:p.id})),
        samples: followerSamples.map(s => ({followers:s.followers,at:s.at})),
        postSamples:parsed.flatMap(s=>(s.posts||[]).map(p=>({...p,at:s.at}))).reverse() };
    });
  }
  status(id, status, reason = '') { this.db.prepare('UPDATE accounts SET status=?,reason=? WHERE id=?').run(status, reason, id); }
  resume(id, confirmed) {
    if (confirmed !== true) throw new Error('请先确认已在平台完成验证');
    if (!this.account(id)) throw new Error('账号不存在');
    this.status(id, 'pending');
  }
  createAccount({ platform = 'x', identity, group = 'owned', notes = '', tags = [], enabled = true, displayName = '', profileId, projectPath = '', confirmed } = {}) {
    if (!['owned', 'benchmark'].includes(group)) throw new Error('分组只能是自有或对标');
    identity = identityOf(platform, identity);
    const meta = [String(notes || '').slice(0, 2000), JSON.stringify(normalizeTags(tags)), enabled ? 1 : 0, String(displayName || '').slice(0, 80)];
    if (group === 'benchmark') {
      if (this.db.prepare('SELECT id FROM accounts WHERE platform=? AND identity=?').get(platform, identity)) throw new Error('账号已存在');
      const id = randomUUID();
      this.db.prepare('INSERT INTO accounts(id,platform,identity,group_kind,notes,tags,enabled,display_name) VALUES (?,?,?,?,?,?,?,?)').run(id, platform, identity, 'benchmark', ...meta);
      return id;
    }
    if (confirmed !== true) throw new Error('请明确确认账号归属');
    const id = this.bind({ profileId, platform, identity, projectPath, confirmed: true });
    this.db.prepare('UPDATE accounts SET group_kind=?, notes=?, tags=?, enabled=?, display_name=? WHERE id=?').run('owned', ...meta, id);
    return id;
  }
  updateAccount(id, patch = {}) {
    const current = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    if (!current) throw new Error('账号不存在');
    return this.transaction(() => {
      if (patch.identity !== undefined) {
        const identity = identityOf(current.platform, patch.identity);
        const other = this.db.prepare('SELECT id FROM accounts WHERE platform=? AND identity=?').get(current.platform, identity);
        if (other && other.id !== id) throw new Error('已有相同用户名的账号');
        this.db.prepare('UPDATE accounts SET identity=? WHERE id=?').run(identity, id);
      }
      if (patch.notes !== undefined) this.db.prepare('UPDATE accounts SET notes=? WHERE id=?').run(String(patch.notes).slice(0, 2000), id);
      if (patch.displayName !== undefined) this.db.prepare('UPDATE accounts SET display_name=? WHERE id=?').run(String(patch.displayName).slice(0, 80), id);
      if (patch.tags !== undefined) this.db.prepare('UPDATE accounts SET tags=? WHERE id=?').run(JSON.stringify(normalizeTags(patch.tags)), id);
      if (patch.enabled !== undefined) this.db.prepare('UPDATE accounts SET enabled=? WHERE id=?').run(patch.enabled === false || patch.enabled === 0 || patch.enabled === '0' ? 0 : 1, id);
      if (patch.group !== undefined) {
        if (!['owned', 'benchmark'].includes(patch.group)) throw new Error('分组只能是自有或对标');
        if (patch.group === 'benchmark') {
          const binding = this.db.prepare('SELECT id FROM bindings WHERE account_id=? AND ended_at IS NULL').get(id);
          if (binding) this.db.prepare('UPDATE bindings SET ended_at=? WHERE id=?').run(now(), binding.id);
          this.db.prepare("UPDATE accounts SET group_kind='benchmark' WHERE id=?").run(id);
        } else {
          const identity = patch.identity ? identityOf(current.platform, patch.identity) : current.identity;
          if (patch.profileId) this.bind({ profileId: patch.profileId, platform: current.platform, identity, confirmed: true });
          else if (!this.db.prepare('SELECT id FROM bindings WHERE account_id=? AND ended_at IS NULL').get(id)) throw new Error('改为自有账号需要选择比特环境');
          this.db.prepare("UPDATE accounts SET group_kind='owned' WHERE id=?").run(id);
        }
      }
      return id;
    });
  }
  unbind(id) {
    if (!this.db.prepare('SELECT id FROM accounts WHERE id=?').get(id)) throw new Error('账号不存在');
    const current = this.db.prepare('SELECT * FROM bindings WHERE account_id=? AND ended_at IS NULL').get(id);
    if (!current) return false;
    this.db.prepare('UPDATE bindings SET ended_at=? WHERE id=?').run(now(), current.id);
    return true;
  }
  deleteAccount(id) {
    if (!this.db.prepare('SELECT id FROM accounts WHERE id=?').get(id)) throw new Error('账号不存在');
    this.transaction(() => {
      this.db.prepare('DELETE FROM snapshots WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM posts WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM bindings WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM collection_runs WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id=?').run(id);
    });
  }
  recordRun(accountId, slot = '', status = 'started') {
    if (!this.db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId)) throw new Error('账号不存在');
    this.db.prepare('INSERT INTO collection_runs(account_id,slot,started_at,status) VALUES (?,?,?,?)').run(accountId, String(slot || ''), now(), status);
  }
  collectionRuns(accountId) {
    const rows = accountId
      ? this.db.prepare('SELECT account_id,slot,started_at,status FROM collection_runs WHERE account_id=? ORDER BY id').all(accountId)
      : this.db.prepare('SELECT account_id,slot,started_at,status FROM collection_runs ORDER BY id').all();
    return rows.map(row => ({ accountId: row.account_id, slot: row.slot, startedAt: row.started_at, status: row.status, day: shanghaiDay(new Date(row.started_at)) }));
  }
  collectionsToday(accountId, date = new Date()) {
    const day = shanghaiDay(date);
    return this.collectionRuns(accountId).filter(run => run.day === day).length;
  }
  importExternal(body = {}) {
    const identity = identityOf('x', body.identity || body.handle || body.screen_name);
    if (body.followers != null && (!Number.isInteger(body.followers) || body.followers < 0)) throw new Error('粉丝数须为非负整数');
    const posts = normalizeExternalPosts(identity, body.posts || []);
    if (posts.length > 50) throw new Error('单次最多导入 50 条帖子');
    const existing = this.db.prepare('SELECT * FROM accounts WHERE platform=? AND identity=?').get('x', identity);
    if (existing?.group_kind === 'owned') throw new Error('自有账号请通过比特环境采集，不能外部导入');
    const id = existing?.id || this.createAccount({ platform: 'x', identity, group: 'benchmark', notes: body.notes || '外部导入', tags: body.tags || [], displayName: body.displayName || '' });
    this.saveResult(id, { identity, followers: body.followers ?? null, source: String(body.source || 'external').slice(0, 80), discovered: posts, warnings: [] });
    return { accountId: id, imported: posts.length, created: !existing };
  }
  importPosts(accountId, posts) {
    if (!this.account(accountId)) throw new Error('账号不存在');
    this.transaction(() => {
      for (const post of posts) {
        const existing = this.db.prepare('SELECT * FROM posts WHERE source_key=?').get(post.sourceKey);
        if (existing && existing.account_id !== accountId) throw new Error('该工程记录已归属其他账号，不能转移旧历史');
        const old = existing ? JSON.parse(existing.data) : {};
        const metrics={...old.metrics};
        const metricTimes={...old.metricTimes};
        let hasNew=false;
        for(const [key,value] of Object.entries(post.metrics || {})) {
          const previous=metricTimes[key] || old.lastSuccess;
          if(validMetric(value) && (!validMetric(metrics[key]) || (post.lastSuccess && (!previous || Date.parse(post.lastSuccess)>Date.parse(previous))))) {
            metrics[key]=value;metricTimes[key]=post.lastSuccess || null;hasNew=true;
          }
        }
        const times=[old.lastSuccess,...Object.values(metricTimes)].filter(t=>t && Number.isFinite(Date.parse(t))).sort((a,b)=>Date.parse(a)-Date.parse(b));
        const data = {...old, ...post, metrics,metricTimes,lastSuccess:times.at(-1) || null, source:hasNew?post.source:old.source || post.source};
        if(old.localMetadata && !(post.sourceUpdatedAt && Date.parse(post.sourceUpdatedAt)>Date.parse(old.localMetadata.at))) Object.assign(data,old.localMetadata.fields,{localMetadata:old.localMetadata});
        else delete data.localMetadata;
        this.db.prepare('INSERT INTO posts VALUES (?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET data=excluded.data').run(existing?.id || randomUUID(), accountId, post.sourceKey, JSON.stringify(data));
      }
    });
  }
  saveResult(id, result) {
    const account = this.account(id);
    if (!account?.active || identityOf(account.platform, result.identity) !== account.identity) throw Object.assign(new Error('当前登录账号与绑定不符，请确认或更换绑定'), {code:'mismatch'});
    if (['paused', 'mismatch'].includes(account.status)) throw new Error('账号已暂停');
    const time = now();
    let successes = 0;
    this.transaction(() => {
      const incoming = Array.isArray(result.discovered) ? result.discovered : [];
      if (incoming.length) this.ingestDiscovered(id, incoming, time);
      const posts = [...(result.posts || []), ...this.linkedDiscovered(id, incoming, result.posts || [])];
      for (const p of posts) {
        const old = this.db.prepare('SELECT * FROM posts WHERE id=? AND account_id=?').get(p.id, id);
        if (!old || !Object.values(p.metrics || {}).some(validMetric)) continue;
        const data = JSON.parse(old.data);
        const metrics = {...data.metrics};
        const metricTimes={...data.metricTimes};
        for (const [k, v] of Object.entries(p.metrics)) if (validMetric(v)) {metrics[k] = v;metricTimes[k]=time;}
        const extra=p.metrics.extra && typeof p.metrics.extra==='object' ? p.metrics.extra : data.extra;
        this.db.prepare('UPDATE posts SET data=? WHERE id=?').run(JSON.stringify({...data, metrics,metricTimes,extra, lastSuccess:time, source:p.source || result.source}), p.id);
        successes++;
      }
      for(const update of result.postUpdates||[])this.markPost(id,update.id,update);
      for (const item of result.postAnalytics || []) {
        const row = item.id
          ? this.db.prepare('SELECT * FROM posts WHERE id=? AND account_id=?').get(item.id, id)
          : this.db.prepare('SELECT * FROM posts WHERE account_id=? AND source_key=?').get(id, `x:status:${item.statusId}`);
        if (!row || !item.analytics) continue;
        const data = JSON.parse(row.data);
        this.db.prepare('UPDATE posts SET data=? WHERE id=?').run(JSON.stringify({ ...data, analytics: item.analytics, lastSuccess: data.lastSuccess || time }), row.id);
        successes++;
      }
      const hasAnalytics = !!result.analytics || !!result.analyticsIssue;
      if (!validMetric(result.followers) && !successes && !result.postUpdates?.length && !incoming.length && !hasAnalytics) throw new Error('没有获取到有效指标，保留上次数据');
      if(validMetric(result.followers)||successes||hasAnalytics) {
        const born = new Map(this.db.prepare('SELECT id,data FROM posts WHERE account_id=?').all(id).map(row => [row.id, JSON.parse(row.data).createdAt]));
        const snapshotPosts = posts.filter(post => post.id).map(post => ({ id: post.id, metrics: post.metrics, analytics: post.analytics, source: post.source || result.source, ...(isDenseSample(born.get(post.id), time) ? { dense: true } : {}) }));
        for (const item of result.postAnalytics || []) {
          const row = item.id
            ? this.db.prepare('SELECT id FROM posts WHERE id=? AND account_id=?').get(item.id, id)
            : this.db.prepare('SELECT id FROM posts WHERE account_id=? AND source_key=?').get(id, `x:status:${item.statusId}`);
          if (!row) continue;
          const slot = snapshotPosts.find(post => post.id === row.id);
          if (slot) slot.analytics = item.analytics;
          else snapshotPosts.push({ id: row.id, metrics: {}, analytics: item.analytics, source: 'X Analytics' });
        }
        this.db.prepare('INSERT INTO snapshots(account_id,data,collected_at) VALUES (?,?,?)').run(id, JSON.stringify({followers:validMetric(result.followers) ? result.followers : null, source:result.source, posts: snapshotPosts, analytics: result.analytics || null, analyticsIssue: result.analyticsIssue || null}), time);
      }
      const warnings=(result.warnings || []).map(w => w?.id ? `${account.posts.find(p=>p.id===w.id)?.title || '作品'}：${w.reason}` : w?.reason).filter(Boolean).join('；');
      this.status(id, 'ready', warnings ? `部分作品未更新：${warnings}` : '');
    });
  }
  ingestDiscovered(accountId, posts, time) {
    const existing = this.db.prepare('SELECT source_key,data FROM posts WHERE account_id=?').all(accountId);
    const byStatus = new Map();
    for (const row of existing) {
      const data = JSON.parse(row.data);
      const sid = statusIdOf({ url: data.url, sourceKey: row.source_key });
      if (sid) byStatus.set(sid, row.source_key);
    }
    const identity = this.db.prepare('SELECT identity FROM accounts WHERE id=?').get(accountId)?.identity;
    const mapped = [];
    for (const post of posts) {
      const sid = statusIdOf(post);
      if (!sid) continue;
      const sourceKey = byStatus.get(sid) || `x:status:${sid}`;
      byStatus.set(sid, sourceKey);
      const metrics = {};
      for (const [key, value] of Object.entries(post.metrics || {})) if (validMetric(value)) metrics[key] = value;
      mapped.push({ ...post, sourceKey, url: post.url || `https://x.com/${identity}/status/${sid}`, title: String(post.title || post.text || `帖子 ${sid}`).slice(0, 180), status: post.status || '已发布', metrics, lastSuccess: Object.keys(metrics).length ? (post.lastSuccess || time) : null, source: post.source || '主页时间线' });
    }
    if (mapped.length) this.importPosts(accountId, mapped);
  }
  linkedDiscovered(accountId, posts, already) {
    const seen = new Set(already.map(post => post.id).filter(Boolean));
    const rows = this.db.prepare('SELECT id,source_key,data FROM posts WHERE account_id=?').all(accountId);
    const extras = [];
    for (const post of posts) {
      const sid = statusIdOf(post);
      if (!sid) continue;
      const row = rows.find(item => statusIdOf({ url: JSON.parse(item.data).url, sourceKey: item.source_key }) === sid);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      extras.push({ id: row.id, metrics: post.metrics || {}, source: post.source });
    }
    return extras;
  }
  markPost(accountId,postId,fields) {
    const post=this.db.prepare('SELECT * FROM posts WHERE id=? AND account_id=?').get(postId,accountId);
    if(!post)throw new Error('作品不属于当前账号');
    const patch={};
    for(const key of ['url','status','detail'])if(fields[key]!==undefined)patch[key]=String(fields[key]);
    if(patch.url) {
      const u=new URL(patch.url);
      if(u.protocol!=='https:'||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname)||!/^\/[^/]+\/status\/\d+(?:\/|$)/.test(u.pathname))throw new Error('X 作品链接无效');
    }
    const data=JSON.parse(post.data);
    this.db.prepare('UPDATE posts SET data=? WHERE id=?').run(JSON.stringify({...data,...patch,localMetadata:{at:now(),fields:patch}}),postId);
  }
  close() { this.db.close(); }
}
