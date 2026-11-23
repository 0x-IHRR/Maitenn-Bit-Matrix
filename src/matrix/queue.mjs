import { identityOf } from './store.mjs';

// A queue slot belongs to one Profile; accounts inside it run sequentially.
export class CollectionQueue {
  constructor(store, collector, bitFactory, limit = 2, prepareAccount = async () => {}) {
    this.store=store; this.collector=collector; this.bitFactory=bitFactory; this.limit=limit;
    this.tasks=[]; this.active=0; this.locked=new Set(); this.pending=[];
    this.prepareAccount=prepareAccount;
  }
  enqueue({profileIds, accountIds, kind='metrics',postIds} = {}) {
    if (!Array.isArray(profileIds) && !Array.isArray(accountIds)) throw new Error('请选择更新范围');
    const accounts = this.store.accounts().filter(a => a.active && (accountIds?.includes(a.id) || profileIds?.includes(a.profileId)));
    if (!accounts.length) throw new Error('所选范围没有当前绑定账号');
    const groups = new Map();
    for (const a of accounts) {
      if (['paused','mismatch'].includes(a.status) || this.locked.has(a.id)) continue;
      this.locked.add(a.id);
      if (!groups.has(a.profileId)) groups.set(a.profileId, []);
      groups.get(a.profileId).push(a.id);
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
    while (this.active < this.limit) {
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
        if (!account?.active || account.profileId!==task.profileId || ['paused','mismatch'].includes(account.status)) continue;
        this.store.status(id,'collecting');
        await this.prepareAccount(account);
        account=this.store.account(id);
        const result=await this.collector({...account,posts:task.postIds?account.posts.filter(p=>task.postIds.includes(p.id)):account.posts,action:task.kind},this.bitFactory());
        const current=this.store.account(id);
        if (!current?.active || current.profileId!==task.profileId) throw new Error('采集中绑定发生变化，结果已丢弃');
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
}
