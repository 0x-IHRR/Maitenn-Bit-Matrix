import { identityOf } from './store.mjs';

const slotOf = account => account?.group === 'benchmark' ? `benchmark:${account.id}` : account?.profileId;
const DAILY_CAP = 2;

// A queue slot belongs to one Profile; accounts inside it run sequentially.
// Benchmark accounts do not share a browser profile, so each is its own slot.
export class CollectionQueue {
  constructor(store, collector, bitFactory, limit = 2, prepareAccount = async () => {}) {
    this.store=store; this.collector=collector; this.bitFactory=bitFactory; this.limit=limit;
    this.tasks=[]; this.active=0; this.locked=new Set(); this.pending=[];
    this.prepareAccount=prepareAccount;
  }
  effectiveLimit() {
    const n = Number(this.store.settings().concurrency || this.limit);
    return Math.min(2, Math.max(1, Number.isFinite(n) ? Math.trunc(n) : this.limit));
  }
  enqueue({profileIds, accountIds, kind='metrics',postIds} = {}) {
    if (!Array.isArray(profileIds) && !Array.isArray(accountIds)) throw new Error('请选择更新范围');
    const accounts = this.store.accounts().filter(a => a.enabled !== false && a.active && (accountIds?.includes(a.id) || profileIds?.includes(a.profileId)));
    if (!accounts.length) throw new Error('所选范围没有当前绑定账号');
    const groups = new Map();
    for (const a of accounts) {
      if (['paused','mismatch'].includes(a.status) || this.locked.has(a.id)) continue;
      const slot = slotOf(a);
      if (!slot) continue;
      this.locked.add(a.id);
      if (!groups.has(slot)) groups.set(slot, []);
      groups.get(slot).push(a.id);
    }
    for (const [profileId, ids] of groups) {
      const task = {id:crypto.randomUUID(),profileId,accountIds:ids,kind,postIds,status:'queued',reason:'',startedAt:new Date().toISOString()};
      this.tasks.push(task); this.pending.push(task);
    }
    this.tasks = this.tasks.filter(t => ['queued','collecting'].includes(t.status)).concat(this.tasks.filter(t => !['queued','collecting'].includes(t.status)).slice(-50));
    this.pump();
    return {queued:[...groups.keys()], skipped:accounts.length-[...groups.values()].flat().length};
  }
  pump() {
    // A Profile cannot occupy two slots, including requests submitted at different times.
    while (this.active < this.effectiveLimit()) {
      const index = this.pending.findIndex(t => !this.tasks.some(x => x.profileId===t.profileId && x.status==='collecting'));
      if (index < 0) break;
      const task = this.pending.splice(index,1)[0];
      this.active++; task.status='collecting';
      this.run(task).finally(() => {this.active--; this.pump();});
    }
  }
  async run(task) {
    let failed = false;
    for (const id of task.accountIds) {
      try {
        let account=this.store.account(id);
        if (!account?.enabled || !account.active || slotOf(account)!==task.profileId || ['paused','mismatch'].includes(account.status)) continue;
        if (this.store.collectionsToday(id) >= DAILY_CAP) { task.reason='今日采集已达 2 次上限'; continue; }
        this.store.recordRun(id, task.slot || '');
        this.store.status(id,'collecting');
        await this.prepareAccount(account);
        account=this.store.account(id);
        const discover=!task.postIds && !['followers','doctor','sync','verify'].includes(task.kind);
        const timelineLimit=discover ? Number(account && this.store.settings().timelineLimit || 20) : 0;
        const result=await this.collector({...account,posts:task.postIds?account.posts.filter(p=>task.postIds.includes(p.id)):account.posts,action:task.kind,timelineLimit},this.bitFactory());
        const current=this.store.account(id);
        if (!current?.active || slotOf(current)!==task.profileId) throw new Error('采集中绑定发生变化，结果已丢弃');
        if (identityOf(account.platform,result.identity)!==account.identity) throw Object.assign(new Error('登录账号不符，请确认或更换绑定'),{code:'mismatch'});
        this.store.saveResult(id,result);
      } catch(e) {
        failed=true;
        const status={risk:'paused',mismatch:'mismatch',identity:'pending',login:'login',offline:'offline'}[e.code] || 'failed';
        this.store.status(id,status,e.message);
        task.reason=e.message;
      } finally {this.locked.delete(id);}
    }
    task.status=failed?'failed':'done';
    task.endedAt=new Date().toISOString();
  }
  async collectAccount(id, {slot, kind='metrics'} = {}) {
    const account=this.store.account(id);
    if (!account) throw new Error('账号不存在');
    if (this.locked.has(id) || !account.enabled || !account.active || ['paused','mismatch'].includes(account.status)) return {skipped:true};
    const profileId=slotOf(account);
    if (!profileId) return {skipped:true};
    this.locked.add(id);
    const task={id:crypto.randomUUID(),profileId,accountIds:[id],kind,slot,status:'collecting',reason:'',startedAt:new Date().toISOString()};
    this.tasks.push(task);
    this.tasks=this.tasks.filter(t=>['queued','collecting'].includes(t.status)).concat(this.tasks.filter(t=>!['queued','collecting'].includes(t.status)).slice(-50));
    this.active++;
    try { await this.run(task); }
    finally { this.active--; this.pump(); }
    return {status:task.status, reason:task.reason, skipped:false};
  }
}
