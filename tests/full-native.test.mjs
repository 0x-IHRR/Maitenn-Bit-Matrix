import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';

test('完整麦田原生页面与比特范围共用服务，档案、封面和数据按账号隔离',async()=>{
  const child=fork(new URL('./fixtures/full-native-server.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,PORT:'0'}});
  let errors='';child.stderr.on('data',d=>errors+=d);
  const message=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors||'原生服务未响应')),10000);child.once('message',m=>{clearTimeout(timer);resolve(m);});});
  try {
    const {port}=await message();const base=`http://127.0.0.1:${port}`;
    const get=(url,scope='matrix')=>fetch(base+url,{headers:{cookie:'bt_profile='+scope}});
    const home=await(await get('/')).text(),pages=await(await get('/p')).text(),js=await(await get('/static/mt.js')).text();
    assert.match(home,/\/static\/bit-profiles.js/);assert.match(pages,/vTraffic/);assert.match(pages,/vCalendar/);assert.match(pages,/vConvert/);assert.match(pages,/vArchive/);assert.match(pages,/vSystem/);
    for(const text of ['大屏','流量','日历','转化','档案','系统'])assert.ok(js.includes(text));
    assert.match(pages,/tg-token/);
    const matrix=await(await get('/api/overview')).json();assert.equal(matrix.followers[0].total,7);assert.ok(matrix.episodes.every(e=>e.id!=='legacy-one'));assert.equal((await(await get('/api/overview','legacy')).json()).followers[0].total,7);
    const one=await(await get('/api/overview','one')).json();assert.equal(one.followers[0].total,0);assert.equal(one.episodes.length,1);assert.equal(one.episodes[0].covers.length,2);
    const id=one.episodes[0].id;
    const episode=await(await get('/api/episode?id='+id,'one')).json();assert.equal(episode.tasks[0].copy.body,'测试文案');assert.equal(episode.tasks[0].m.views,0);
    assert.equal((await get('/cover?id='+id+'&k=3x4','one')).status,200);
    assert.equal((await get('/api/episode?id='+id,'two')).status,404);
    assert.equal((await get('/cover?id='+id+'&k=3x4','two')).status,404);
    assert.equal((await get('/api/overview','two')).status,200);assert.equal((await get('/api/overview','unknown')).status,400);
    assert.equal((await get('/api/bt/state')).status,200);
    const denied=await fetch(base+'/api/bt/update',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:'{}'});assert.equal(denied.status,403);
    const stats=message();child.send('stats');assert.deepEqual(await stats,{collections:0,opens:0});
    for(const scope of ['two','legacy']) {
      const stale=await fetch(base+'/api/action',{method:'POST',headers:{cookie:'bt_profile='+scope,'x-maitian-profile':'one','content-type':'application/json'},body:JSON.stringify({type:'followers'})});
      assert.equal(stale.status,409);
    }
    const replaced=message();child.send('replace');const {historicalAccountId}=await replaced;
    const historical='history:'+historicalAccountId;
    const archived=await(await get('/api/overview',historical)).json();
    assert.equal(archived.matrixReadOnly,true);assert.equal(archived.episodes.length,1);
    assert.equal((await get('/api/episode?id='+id,historical)).status,200);
    assert.equal((await get('/cover?id='+id+'&k=3x4',historical)).status,200);
    const blocked=await fetch(base+'/api/action',{method:'POST',headers:{cookie:'bt_profile='+historical,'x-maitian-profile':historical,'content-type':'application/json'},body:JSON.stringify({type:'metrics',id})});
    assert.equal(blocked.status,403);
    const statsAfter=message();child.send('stats');assert.deepEqual(await statsAfter,{collections:0,opens:0});
    const imported=await fetch(base+'/api/bt/external-import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identity:'importcheck',followers:3,source:'grok-bot',posts:[{id:'4234567890123456789',text:'导入',metrics:{views:1,likes:0,replies:0,reposts:0,bookmarks:0}}]})});
    assert.equal(imported.status,200);
    assert.equal((await imported.json()).created,true);
    assert.equal((await fetch(base+'/api/bt/external-import',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
  } finally {const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
});
