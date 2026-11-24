import fs from 'node:fs/promises';
import path from 'node:path';
import {makeApp} from './server.mjs';
import {nativeOverview} from './native-overview.mjs';
import {BitBrowser} from './browser.mjs';
import {collectAccount} from './collector.mjs';

const otherPlatforms=['bilibili','douyin','xhs','channels','youtube','instagram'];
const removedActions=new Set(['sync','board','mark','login','retry']);
const readActions=new Set(['metrics','followers','doctor','verify']);
const body=async req=>{let text='';for await(const c of req){text+=c;if(Buffer.byteLength(text)>65536)throw new Error('请求过大');}return JSON.parse(text||'{}');};
const selected=req=>{const value=decodeURIComponent((req.headers.cookie||'').match(/(?:^|;\s*)bt_profile=([^;]*)/)?.[1]||'matrix');return value==='legacy'?'matrix':value;};

export function createMatrixExtension(options={}) {
  const app=makeApp({...options,collector:options.collector|| (async(a,b)=>collectAccount(['followers','doctor'].includes(a.action)?{...a,posts:[]}:a,b))});
  const {store,queue}=app;
  const bit=()=>options.bitFactory?options.bitFactory():new BitBrowser(store.settings().bitUrl);
  async function overview(scope) {
    let running=new Set(),error='';
    try {running=new Set(Object.keys(await bit().running()));}catch(e){error=e.message;}
    const data=nativeOverview(store,running,error,scope==='matrix'?'':scope);
    data.health.platforms.push(...otherPlatforms.map(id=>({id,disabled:true,state:''})));
    data.health.metricsDay='';data.health.doctorDay='';
    data.siteOn=false;data.siteName='';data.siteLogo=false;
    data.site={days:[],channels:[],campaigns:[],campaignsOn:false};
    data.metrics=data.episodes.flatMap(e=>e.metrics||[]).map(m=>({...m,episode_id:m.episode_id||m.id}));
    data.actions=queue.tasks.filter(t=>scope==='matrix'||t.profileId===scope).map(t=>({type:t.kind,platform:'x',label:`X 采集 · ${t.profileId}`,startedAt:t.startedAt,endedAt:t.endedAt,done:!['queued','collecting'].includes(t.status),ok:t.status==='done',tail:t.reason}));
    data.feed=data.actions.filter(a=>a.done).map(a=>({ts:a.endedAt,nick:'',platform:'X',action:a.label,result:a.tail|| (a.ok?'完成':'失败')}));
    data.driver='BitBrowser';data.now=new Date().toISOString();
    return data;
  }
  async function asset(req,res,u,send,scope) {
    const data=await overview(scope),ep=data.episodes.find(e=>e.id===u.searchParams.get('id'));
    if(!ep?.dir)return send(res,404,'');
    const account=store.accounts().find(a=>a.id===ep.accountId);
    const post=account?.posts.find(p=>p.id===ep.id);
    const relative=u.pathname==='/shot'?'发布档案/x.jpg':post?.covers?.[u.searchParams.get('k')||'4x3']||Object.values(post?.covers||{})[0];
    if(!relative)return send(res,404,'');
    try {
      const base=await fs.realpath(ep.dir),file=await fs.realpath(path.resolve(base,relative));
      if(!file.startsWith(base+path.sep) || !/\.(?:png|jpe?g|svg|webp)$/i.test(file))return send(res,403,'');
      if((await fs.stat(file)).size>20*1024*1024)return send(res,400,'图片过大');
      return send(res,200,await fs.readFile(file),/\.svg$/i.test(file)?'image/svg+xml':/\.png$/i.test(file)?'image/png':/\.webp$/i.test(file)?'image/webp':'image/jpeg');
    } catch {return send(res,404,'');}
  }
  return {
    store,queue,
    close(){app.scheduler?.stop();store.close();},
    async handle(req,res,u,send) {
      if(u.pathname.startsWith('/api/bt/')) {
        req.url=req.url.replace(/^\/api\/bt\//,'/api/');
        app.server.emit('request',req,res);return true;
      }
      const scope=selected(req);
      const historical=scope.startsWith('history:')&&store.accounts().some(a=>a.id===scope.slice(8)&&a.platform==='x');
      if(scope!=='matrix'&&!historical&&!store.profiles().some(p=>p.id===scope)){send(res,400,{error:'所选比特环境未纳管，请重新选择'});return true;}
      if(historical && !['GET','HEAD'].includes(req.method)){send(res,403,{error:'历史账号仅供查看，不能采集或修改'});return true;}
      if(u.pathname==='/api/overview'){send(res,200,await overview(scope));return true;}
      if(u.pathname==='/api/episode') {
        const ep=(await overview(scope)).episodes.find(e=>e.id===u.searchParams.get('id'));
        send(res,ep?200:404,ep||{error:'当前环境没有这一期'});return true;
      }
      if(['/cover','/shot'].includes(u.pathname)){await asset(req,res,u,send,scope);return true;}
      if(u.pathname==='/api/integrations/site' || u.pathname==='/api/integrations/site/test'){send(res,404,{error:'知识站已移除'});return true;}
      if(u.pathname==='/api/platform-toggle'){send(res,400,{error:'当前工作台先接入 X，平台状态由账号配置管理'});return true;}
      if(u.pathname!=='/api/action' || req.method!=='POST')return false;
      if(!req.headers['content-type']?.startsWith('application/json')){send(res,415,{error:'需要 application/json'});return true;}
      const a=await body(req);
      if(removedActions.has(a.type)){send(res,400,{error:'该操作已移除。面板只读采集，不提供发布或知识站操作。'});return true;}
      if(a.platform && a.platform!=='x'){send(res,400,{error:'比特 Profile 当前只验证 X'});return true;}
      const accounts=store.accounts().filter(x=>x.active&&x.platform==='x'&&(scope==='matrix'||x.profileId===scope));
      if(a.id && !accounts.some(x=>x.posts.some(p=>p.id===a.id))){send(res,404,{error:'作品不属于当前环境'});return true;}
      if(!readActions.has(a.type)){send(res,400,{error:'该操作尚未接入比特 Profile'});return true;}
      const ids=accounts.filter(x=>!a.id||x.posts.some(p=>p.id===a.id)).map(x=>x.id);
      const result=queue.enqueue({accountIds:ids,kind:a.type,postIds:a.id?[a.id]:undefined});
      if(!result.queued.length){send(res,409,{error:'账号已暂停或已有采集任务，请在比特 Profile 面板查看状态'});return true;}
      send(res,200,{ok:true,...result});return true;
    }
  };
}
