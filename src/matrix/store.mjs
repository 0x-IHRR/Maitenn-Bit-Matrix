import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
    `);
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
  settings() { return { bitUrl: 'http://127.0.0.1:54345', maitianRoot: '', ...Object.fromEntries(this.db.prepare('SELECT * FROM settings').all().map(x => [x.key, x.value])) }; }
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
      const samples = this.db.prepare('SELECT data,collected_at FROM snapshots WHERE account_id=? ORDER BY id DESC').all(a.id);
      const last = samples[0] && JSON.parse(samples[0].data);
      const followerSamples = samples.map(s => ({...JSON.parse(s.data), at:s.collected_at})).filter(s => validMetric(s.followers));
      return { id:a.id, platform:a.platform, identity:a.identity, status:a.status, reason:a.reason, projectPath:a.project_path, active:!!current, profileId:current?.profileId || history.at(-1)?.profileId, history,
        followers:followerSamples[0]?.followers ?? null, followersLastSuccess:followerSamples[0]?.at ?? null, growth:followerSamples.length > 1 ? followerSamples[0].followers - followerSamples[1].followers : null,
        lastSuccess:samples[0]?.collected_at ?? null, source:last?.source ?? null,
        posts:this.db.prepare('SELECT id,data FROM posts WHERE account_id=? ORDER BY rowid').all(a.id).map(p => ({...JSON.parse(p.data), id:p.id})),
        samples: followerSamples.map(s => ({followers:s.followers,at:s.at})),
        postSamples:samples.flatMap(s=>(JSON.parse(s.data).posts||[]).map(p=>({...p,at:s.collected_at}))) };
    });
  }
  status(id, status, reason = '') { this.db.prepare('UPDATE accounts SET status=?,reason=? WHERE id=?').run(status, reason, id); }
  resume(id, confirmed) {
    if (confirmed !== true) throw new Error('请先确认已在平台完成验证');
    if (!this.account(id)) throw new Error('账号不存在');
    this.status(id, 'pending');
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
      for (const p of result.posts || []) {
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
      if (!validMetric(result.followers) && !successes && !result.postUpdates?.length) throw new Error('没有获取到有效指标，保留上次数据');
      if(validMetric(result.followers)||successes)this.db.prepare('INSERT INTO snapshots(account_id,data,collected_at) VALUES (?,?,?)').run(id, JSON.stringify({followers:validMetric(result.followers) ? result.followers : null, source:result.source,posts:result.posts||[]}), time);
      const warnings=(result.warnings || []).map(w=>`${account.posts.find(p=>p.id===w.id)?.title || '作品'}：${w.reason}`).join('；');
      this.status(id, 'ready', warnings ? `部分作品未更新：${warnings}` : '');
    });
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
