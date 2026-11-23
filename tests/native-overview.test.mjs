import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/matrix/store.mjs';
import {nativeOverview} from '../src/matrix/native-overview.mjs';
import {makeApp} from '../src/matrix/server.mjs';

test('原生大屏按环境读取X数据，不触发平台取数，不混入其他平台或旧绑定',()=>{
  const store=new Store(':memory:');store.addProfile('one','一');store.addProfile('two','二');
  const bind=(profileId,platform,identity)=>store.bind({profileId,platform,identity,confirmed:true});
  const a=bind('one','x','first'),b=bind('two','x','second'),other=bind('one','instagram','elsewhere');
  store.saveResult(a,{identity:'first',followers:0});store.saveResult(b,{identity:'second',followers:5});store.saveResult(other,{identity:'elsewhere',followers:100});
  store.importPosts(a,[{sourceKey:'a',title:'同名作品',status:'已发布',metrics:{views:0},lastSuccess:'2026-11-21T12:00:00Z'}]);
  store.importPosts(b,[{sourceKey:'b',title:'同名作品',metrics:{},lastSuccess:null}]);
  const overview=nativeOverview(store,new Set(['one']),'');
  assert.equal(overview.scope.accountCount,2);assert.equal(overview.followers[0].total,5);
  assert.equal(overview.episodes.length,2);assert.notEqual(overview.episodes[0].id,overview.episodes[1].id);
  assert.equal(overview.episodes[0].views,0);assert.equal(overview.episodes[1].views,null);
  assert.equal(overview.episodes[0].tasks[0].state,'published');
  assert.equal(overview.episodes[0].inter,null);
  assert.match(overview.episodes[0].name,/@first/);
  assert.equal(nativeOverview(store,new Set(),'','one').followers[0].total,0);
  assert.throws(()=>nativeOverview(store,new Set(),'','unknown'),/未纳管/);
  bind('one','x','replacement');
  const after=nativeOverview(store,new Set(),'');
  assert.equal(after.episodes.length,1);assert.equal(after.followers.length,0);
  store.close();
});

test('原生大屏没有数据时保持未知与未检查状态，不伪造0或成功时间',()=>{
  const store=new Store(':memory:');store.addProfile('p','环境');
  store.bind({profileId:'p',platform:'x',identity:'first',confirmed:true});
  const overview=nativeOverview(store,new Set(),'接口尚未连接');
  assert.deepEqual(overview.followers,[]);assert.equal(overview.scope.lastSuccess,null);
  assert.equal(overview.health.platforms[0].state,'');assert.equal(overview.scope.connectionError,'接口尚未连接');
  store.close();
});

test('原生入口和环境切换接口可用，读取页面不触发采集或打开环境',async()=>{
  const store=new Store(':memory:');store.addProfile('one','一');store.addProfile('two','二');
  for(const [profileId,identity,n] of [['one','first',0],['two','second',5]]) {
    const id=store.bind({profileId,platform:'x',identity,confirmed:true});
    store.saveResult(id,{identity,followers:n});
  }
  let called=0;
  const app=makeApp({store,bitFactory:()=>({running:async()=>({one:1,two:2}),open:async()=>{called++;}}),collector:async()=>{called++;}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  try {
    const overview=await(await fetch(base+'/api/overview?profileId=one')).json();
    assert.equal(overview.scope.accountCount,1);assert.equal(overview.followers[0].total,0);
    assert.equal((await fetch(base+'/api/overview?profileId=unknown')).status,400);
    assert.equal(called,0);
  } finally {await new Promise(r=>app.server.close(r));store.close();}
});
