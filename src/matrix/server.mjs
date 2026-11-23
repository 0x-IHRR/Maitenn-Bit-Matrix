import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, identityOf } from './store.mjs';
import { readProjects } from './importer.mjs';
import { CollectionQueue } from './queue.mjs';
import { BitBrowser } from './browser.mjs';
import { collectAccount } from './collector.mjs';
import { nativeOverview } from './native-overview.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export function makeApp({store=new Store(join(root,'data','matrix.db')), bitFactory, collector=collectAccount}={}) {
  bitFactory ||= () => new BitBrowser(store.settings().bitUrl);
  const queue = new CollectionQueue(store,collector,bitFactory,2,async account=>{
    const paths=new Set([account.projectPath,...account.posts.map(p=>p.projectPath)].filter(Boolean));
    const records=[];
    for(const path of paths) records.push(...await readProjects(path,account.platform,store.settings().maitianRoot));
    const owned=new Set(account.posts.map(p=>p.sourceKey));
    store.importPosts(account.id,records.filter(p=>owned.has(p.sourceKey)));
  });
  let running = new Set(), connectionError='尚未检查比特接口';
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
          return send(200,{settings:store.settings(),profiles:store.profiles().map(p=>({...p,running:running.has(p.id)})),accounts:store.accounts(),tasks:queue.tasks,connectionError});
        }
        if(req.method==='GET' && req.url==='/api/discover') {
          const profiles=await bitFactory().list();await refreshRunning();
          return send(200,{profiles:profiles.map(p=>({id:p.id,name:p.name || p.remark || p.id,running:running.has(p.id)}))});
        }
        if(req.method!=='POST') return send(404,{error:'接口不存在'});
        if(!req.headers['content-type']?.startsWith('application/json')) return send(415,{error:'需要 application/json'});
        const b=await body(req);
        if(req.url==='/api/settings') {
          const u=new URL(b.bitUrl);
          if(u.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password || u.pathname!=='/' || u.search || u.hash) throw new Error('比特地址须为本机 HTTP 接口');
          if(b.maitianRoot && !b.maitianRoot.startsWith('/')) throw new Error('麦田目录须为绝对路径');
          if(queue.active || queue.pending.length) throw new Error('采集执行中，请稍后修改连接配置');
          store.setSettings({bitUrl:u.origin,maitianRoot:String(b.maitianRoot || '')});
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
        else if(req.url==='/api/open') {
          if(!store.profiles().some(p=>p.id===b.profileId)) throw new Error('环境未纳管');
          await bitFactory().open(b.profileId);
        } else if(req.url==='/api/resume') store.resume(b.accountId,b.confirmed);
        else return send(404,{error:'接口不存在'});
        return send(200,{ok:true});
      }
      return send(404,{error:'接口不存在'});
    } catch(e) {send(400,{error:e.message});}
  });
  return {server,store,queue};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {server,store}=makeApp();
  const port=Number(process.env.PORT || 8790);
  server.listen(port,'127.0.0.1',()=>console.log(`BT-MultiMedia http://127.0.0.1:${port}`));
  server.on('error',e=>{console.error(e.message);store.close();process.exitCode=1;});
}
