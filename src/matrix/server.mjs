import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, identityOf } from './store.mjs';
import { readProjects } from './importer.mjs';
import { CollectionQueue } from './queue.mjs';
import { BitBrowser } from './browser.mjs';
import { collectAccount } from './collector.mjs';
import { collectPublicAccount } from './public-source.mjs';
import { nativeOverview } from './native-overview.mjs';
import { isAbsolutePath } from './paths.mjs';
import { CollectionScheduler, parseMonitorSettings, readMonitorSettings } from './schedule.mjs';
import { withOwnedWindow } from './window.mjs';
import { renderCsv, writeExport } from './export.mjs';
import {detectAccounts, connectDetected} from './detect.mjs';

export function accountAlerts(accounts) {
  return accounts.filter(account => account.enabled !== false && ['paused', 'mismatch', 'login', 'failed', 'offline'].includes(account.status))
    .map(account => ({ accountId: account.id, identity: account.identity, group: account.group, status: account.status, reason: account.reason || '' }));
}

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export function makeApp({store=new Store(join(root,'data','matrix.db')), bitFactory, collector=collectAccount, fetch, scheduler: schedulerOptions}={}) {
  bitFactory ||= () => new BitBrowser(store.settings().bitUrl);
  const readAccount = collector;
  // Posts come from the profile timeline or a public/imported source.
  // Maitian publish.json is no longer read during collection.
  const wrapped = async (account, bit) => {
    if (account.action === 'sync') throw new Error('取链接已移除，帖子由时间线采集');
    if ((account.group || 'owned') === 'benchmark') return collectPublicAccount(account, { fetch });
    return withOwnedWindow(bit, account.profileId, () => readAccount(account, bit));
  };
  const queue = new CollectionQueue(store, wrapped, bitFactory, 2, async () => {});
  const scheduler = new CollectionScheduler({ store, queue, ...schedulerOptions });
  scheduler.start();
  let running = new Set(), connectionError='尚未检查比特接口', detecting=false;
  async function refreshRunning() {
    try {
      const result=await bitFactory().running();
      running=new Set(Array.isArray(result)?result.map(p=>typeof p==='string'?p:p.id):Object.keys(result));
      connectionError='';
    } catch(e) {running=new Set();connectionError=e.message;}
  }
  async function body(req) {
    let data='';
    for await (const chunk of req) {data+=chunk;if (Buffer.byteLength(data)>65536) throw new Error('请求过大');}
    return JSON.parse(data || '{}');
  }
  const server=createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try {
      const host=req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return send(403,{error:'只接受本机访问'});
      // Prevent a remote website from invoking local filesystem or browser actions.
      if (req.headers.origin && ![`http://${host}`].includes(req.headers.origin)) return send(403,{error:'不允许跨站请求'});
      if (req.headers['sec-fetch-site']==='cross-site') return send(403,{error:'不允许跨站请求'});
      const url=new URL(req.url,`http://${host}`);
      if (req.url.startsWith('/api/')) {
        if(req.method==='GET' && url.pathname==='/api/overview') {
          await refreshRunning();
          return send(200,nativeOverview(store,running,connectionError,url.searchParams.get('profileId')||''));
        }
        if(req.method==='GET' && req.url==='/api/state') {
          await refreshRunning();
          const accounts=store.accounts();
          return send(200,{settings:store.settings(),monitor:readMonitorSettings(store.settings()),profiles:store.profiles().map(p=>({...p,running:running.has(p.id)})),accounts,tasks:queue.tasks,connectionError,alerts:accountAlerts(accounts)});
        }
        if(req.method==='GET' && url.pathname==='/api/export') {
          const kind=url.searchParams.get('kind') || 'all';
          const csv=`\uFEFF${renderCsv(store, kind)}`;
          res.writeHead(200, {'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="matrix-${kind}.csv"`,'Cache-Control':'no-store'});
          res.end(csv);
          return;
        }
        if(req.method==='GET' && req.url==='/api/discover') {
          const profiles=await bitFactory().list();await refreshRunning();
          return send(200,{profiles:profiles.map(p=>({id:p.id,name:p.name || p.remark || p.id,running:running.has(p.id)}))});
        }
        if(req.method!=='POST') return send(404,{error:'接口不存在'});
        if(!req.headers['content-type']?.startsWith('application/json')) return send(415,{error:'需要 application/json'});
        const b=await body(req);
        if(detecting) throw new Error('正在检测账号，请稍后再操作');
        if(req.url==='/api/detect') {
          if(b.confirmed!==true) throw new Error('请确认检测并接入已打开的账号');
          if(queue.active || queue.pending.length || scheduler.running) throw new Error('采集执行中，请完成后再检测接入');
          detecting=true;
          try {
            const results=await detectAccounts(bitFactory());
            if(queue.active || queue.pending.length || scheduler.running) throw new Error('采集已开始，本次检测结果未接入，请稍后重试');
            return send(200,{results:connectDetected(store,results)});
          }
          finally {detecting=false;}
        } else if(req.url==='/api/settings') {
          const next={};
          if(b.bitUrl!==undefined) {
            const u=new URL(b.bitUrl);
            if(u.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password || u.pathname!=='/' || u.search || u.hash) throw new Error('比特地址须为本机 HTTP 接口');
            next.bitUrl=u.origin;
          }
          if(b.maitianRoot!==undefined) {
            if(b.maitianRoot && !isAbsolutePath(b.maitianRoot)) throw new Error('麦田目录须为绝对路径');
            next.maitianRoot=String(b.maitianRoot || '');
          }
          if(['timelineLimit','collectsPerDay','collectHours','concurrency','intervalMinMinutes','intervalMaxMinutes','scheduleEnabled'].some(key=>b[key]!==undefined)) {
            const parsed=parseMonitorSettings({...readMonitorSettings(store.settings()),...b});
            Object.assign(next,{timelineLimit:String(parsed.timelineLimit),collectsPerDay:String(parsed.collectsPerDay),collectHours:parsed.collectHours.join(','),concurrency:String(parsed.concurrency),intervalMinMinutes:String(parsed.intervalMinMinutes),intervalMaxMinutes:String(parsed.intervalMaxMinutes),scheduleEnabled:parsed.scheduleEnabled?'1':'0'});
          }
          if(!Object.keys(next).length) throw new Error('没有可保存的设置');
          if((next.bitUrl || next.maitianRoot!==undefined) && (queue.active || queue.pending.length)) throw new Error('采集执行中，请稍后修改连接配置');
          store.setSettings(next);
        } else if(req.url==='/api/profiles') {
          const profile=(await bitFactory().list()).find(p=>p.id===b.id);
          if(!profile) throw new Error('比特当前可见列表中没有这个环境');
          store.addProfile(profile.id,profile.name || profile.remark || profile.id);
        } else if(req.url==='/api/bind') {
          if(queue.tasks.some(t=>['collecting','queued'].includes(t.status)&&t.profileId===b.profileId)) throw new Error('该环境有采集任务，请完成后再更换绑定');
          const posts=b.projectPath ? await readProjects(b.projectPath,b.platform,store.settings().maitianRoot) : [];
          if(queue.tasks.some(t=>['collecting','queued'].includes(t.status)&&t.profileId===b.profileId)) throw new Error('该环境有采集任务，请完成后再更换绑定');
          // Validate ownership before changing an existing binding.
          const identity=identityOf(b.platform,b.identity);
          const existing=store.accounts().find(a=>a.platform===b.platform&&a.identity===identity);
          for(const post of posts) {
            const owner=store.db.prepare('SELECT account_id FROM posts WHERE source_key=?').get(post.sourceKey);
            if(owner && owner.account_id!==existing?.id) throw new Error('该工程已有其他账号归属，请为新账号关联其他工程');
          }
          const id=store.transaction(()=>{const id=store.bind(b);store.importPosts(id,posts);return id;});
          return send(200,{accountId:id,imported:posts.length});
        } else if(req.url==='/api/import') {
          if(b.confirmed!==true) throw new Error('请确认工程内所选平台记录全部属于该账号');
          const a=store.account(b.accountId);if(!a) throw new Error('账号不存在');
          const posts=await readProjects(b.projectPath,a.platform,store.settings().maitianRoot);
          if(queue.locked.has(a.id)) throw new Error('该账号正在采集，请稍后重新读取工程');
          store.transaction(()=>{
            store.importPosts(a.id,posts);
            store.db.prepare('UPDATE accounts SET project_path=? WHERE id=?').run(b.projectPath,a.id);
          });return send(200,{imported:posts.length});
        } else if(req.url==='/api/update') return send(200,queue.enqueue(b));
        else if(req.url==='/api/accounts') {
          if(b.action==='create') return send(200,{accountId:store.createAccount(b)});
          if(!b.id) throw new Error('缺少账号');
          if(queue.locked.has(b.id)) throw new Error('该账号正在采集，请稍后再改');
          if(b.action==='update') { store.updateAccount(b.id,b); return send(200,{ok:true}); }
          if(b.action==='delete') { store.deleteAccount(b.id); return send(200,{ok:true}); }
          if(b.action==='unbind') return send(200,{unbound:store.unbind(b.id)});
          throw new Error('未知账号操作');
        } else if(url.pathname==='/api/personas') {
          if(b.action==='delete') { store.deletePersona(b.id); return send(200,{ok:true}); }
          return send(200,{id:store.savePersona(b)});
        } else if(url.pathname==='/api/personas/import') {
          let raw=b.document ?? b.json ?? null;
          let sourceLabel=b.sourceLabel || 'JSON';
          if(b.path) {
            if(!isAbsolutePath(b.path)) throw new Error('人设文件须为绝对路径');
            try { raw=readFileSync(b.path,'utf8'); }
            catch { throw new Error('人设文件无法读取'); }
            if(String(raw).length>200000) throw new Error('人设文件过大');
            sourceLabel=basename(b.path);
          }
          if(raw==null) throw new Error('没有人设内容');
          return send(200, store.importPersonas(raw,{sourceLabel}));
        } else if(url.pathname==='/api/items') {
          if(b.action==='delete') { store.deleteItem(b.id); return send(200,{ok:true}); }
          return send(200,{id:store.saveItem(b)});
        } else if(url.pathname==='/api/items/transition') {
          return send(200,{item:store.transitionItem(b.id,b)});
        } else if(url.pathname==='/api/export') {
          const saved=writeExport(store, b.path, b.kind || 'all');
          return send(200, { ok: true, ...saved });
        } else if(req.url==='/api/external-import') {
          const identity=identityOf('x', b.identity || b.handle || b.screen_name);
          const existing=store.accounts().find(account=>account.platform==='x' && account.identity===identity);
          if(existing && queue.locked.has(existing.id)) throw new Error('该账号正在采集，请稍后再导入');
          return send(200, store.importExternal(b));
        } else if(req.url==='/api/collect') {
          const at=b.at ? new Date(b.at) : new Date();
          if(Number.isNaN(at.getTime())) throw new Error('采集时间无效');
          if(scheduler.running) return send(200,{accepted:false,skipped:'busy'});
          const due=scheduler.dueAccounts(at).map(account=>account.id);
          scheduler.tick(at).catch(()=>{});
          return send(200,{accepted:true,due});
        } else if(req.url==='/api/open') {
          if(!store.profiles().some(p=>p.id===b.profileId)) throw new Error('环境未纳管');
          await bitFactory().open(b.profileId);
        } else if(req.url==='/api/resume') store.resume(b.accountId,b.confirmed);
        else return send(404,{error:'接口不存在'});
        return send(200,{ok:true});
      }
      return send(404,{error:'接口不存在'});
    } catch(e) {send(400,{error:e.message});}
  });
  server.on('close', () => scheduler.stop());
  return {server,store,queue,scheduler};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {server,store}=makeApp();
  const port=Number(process.env.PORT || 8790);
  server.listen(port,'127.0.0.1',()=>console.log(`BT-MultiMedia http://127.0.0.1:${port}`));
  server.on('error',e=>{console.error(e.message);store.close();process.exitCode=1;});
}
