import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectAccounts,connectDetected} from '../src/matrix/detect.mjs';
import {Store} from '../src/matrix/store.mjs';
import {makeApp} from '../src/matrix/server.mjs';

function fixture(rows) {
  const calls={ports:0,closed:[],connected:[]};
  return {calls,bit:{
    list:async()=>rows.map(r=>({id:r.id,name:r.id})),
    running:async()=>Object.fromEntries(rows.filter(r=>!r.offline).map(r=>[r.id,123])),
    request:async path=>{assert.equal(path,'/browser/ports');calls.ports++;return {};},
    connect:async(id,cache)=>{
      assert.ok(cache.running);assert.ok(cache.ports);calls.connected.push(id);
      const row=rows.find(r=>r.id===id);
      if(row.error)throw new Error(row.error);
      return {pages:async()=>row.pages||[{targetId:'t',url:'https://x.com/home'}],
        evaluate:async(p,expression)=>{assert.doesNotMatch(expression,/\.click\(|fetch\(/);return row.data?.[p.targetId]||row.data||{identity:id,followers:null};},
        close:()=>calls.closed.push(id)};
    }
  }};
}

test('检测只读已打开的 X 页面，端口映射批量读取并复核，单号错误不阻断其他环境',async()=>{
 const f=fixture([{id:'one'},{id:'off',offline:true},{id:'bad',error:'连接失败'},{id:'two',pages:[{targetId:'x',url:'https://example.com/'}]}]);
 const r=await detectAccounts(f.bit);
 assert.deepEqual(r.map(x=>x.status),['detected','error','no-tab']);
 assert.deepEqual(f.calls.connected,['one','bad','two']);
 assert.deepEqual(f.calls.closed,['one','two']);assert.equal(f.calls.ports,2);
});

test('检测期间端口被其他窗口复用时拒绝接入',async()=>{
 const f=fixture([{id:'owner'}]);let reads=0;
 f.bit.request=async()=>({owner:++reads===1?10001:10002});
 const rows=await detectAccounts(f.bit);assert.equal(rows[0].status,'error');
 const s=new Store(':memory:');try{connectDetected(s,rows);assert.equal(s.accounts().length,0);}finally{s.close();}
});

test('多窗口重复账号、页面账号分歧及验证码均不自动绑定',async()=>{
 const f=fixture([{id:'a',data:{identity:'same'}},{id:'b',data:{identity:'SAME'}},
 {id:'c',pages:[{targetId:'t',url:'https://x.com/home'},{targetId:'u',url:'https://x.com/home'}],data:{t:{identity:'first'},u:{identity:'second'}}},
 {id:'risk',data:{identity:'risk',risk:'验证码'}},{id:'login',data:{login:true}}]);
 const r=await detectAccounts(f.bit);
 assert.deepEqual(r.map(x=>x.status),['conflict','conflict','conflict','risk','login']);
 const s=new Store(':memory:');try{connectDetected(s,r);assert.equal(s.accounts().length,0);}finally{s.close();}
});

test('接入幂等，真实零粉丝保留，其他旧账号及停用状态不会被改写',()=>{
 const s=new Store(':memory:');
 try{
  const row=()=>({profileId:'p',name:'P',identity:'owner',status:'detected',followers:0});
  const first=connectDetected(s,[row()])[0];assert.equal(first.status,'connected');
  assert.equal(s.account(first.accountId).followers,0);
  s.status(first.accountId,'paused','人工验证');
  assert.equal(connectDetected(s,[row()])[0].status,'existing');
  assert.equal(s.account(first.accountId).status,'paused');
  assert.equal(s.account(first.accountId).history.length,1);
  const conflict=connectDetected(s,[{...row(),identity:'other'}])[0];
  assert.equal(conflict.status,'conflict');assert.equal(s.accounts().length,1);
  s.unbind(first.accountId);
  assert.equal(connectDetected(s,[row()])[0].status,'conflict');
  assert.equal(s.account(first.accountId).active,false);assert.equal(s.account(first.accountId).status,'paused');
 }finally{s.close();}
});

test('检测失败和跨环境归属冲突不会留下空纳管环境',()=>{
 const s=new Store(':memory:');
 try{
  s.addProfile('p','P');s.bind({profileId:'p',platform:'x',identity:'owner',confirmed:true});
  const r=connectDetected(s,[{profileId:'q',name:'Q',identity:'owner',followers:null,status:'detected'}]);
  assert.equal(r[0].status,'conflict');assert.equal(s.profiles().length,1);
 }finally{s.close();}
});

test('重复检测不覆盖已有成功采集及后台指标',()=>{
 const s=new Store(':memory:');
 try{
  s.addProfile('p','P');const id=s.bind({profileId:'p',platform:'x',identity:'owner',confirmed:true});
  s.saveResult(id,{identity:'owner',followers:9,posts:[],analytics:{impressions:20}});
  const before=s.account(id).lastSuccess;
  connectDetected(s,[{profileId:'p',name:'P',status:'detected',identity:'owner',followers:10}]);
  assert.equal(s.account(id).followers,9);assert.equal(s.account(id).analytics.impressions,20);
  assert.equal(s.account(id).lastSuccess,before);
 }finally{s.close();}
});

test('检测到风控时暂停该环境旧绑定并保留已有数据',()=>{
 const s=new Store(':memory:');
 try{
  s.addProfile('p','P');const id=s.bind({profileId:'p',platform:'x',identity:'owner',confirmed:true});
  s.saveResult(id,{identity:'owner',followers:9,posts:[]});
  connectDetected(s,[{profileId:'p',status:'risk',reason:'验证码'},{profileId:'unknown',status:'risk',reason:'验证码'}]);
  assert.equal(s.account(id).status,'paused');assert.equal(s.account(id).followers,9);
  assert.equal(s.accounts().length,1);assert.equal(s.profiles().length,1);
 }finally{s.close();}
});

test('检测接入接口要求明确接入且禁止跨站；只读轮询不触发检测',async()=>{
 const s=new Store(':memory:');const f=fixture([{id:'owner'}]);
 const app=makeApp({store:s,bitFactory:()=>f.bit});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const post=(data,extra={})=>fetch(base+'/api/detect',{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(data)});
 try{
  assert.equal((await post({confirmed:true},{origin:'https://bad.example'})).status,403);
  assert.equal((await post({})).status,400);
  await fetch(base+'/api/state');assert.equal(f.calls.ports,0);
  const r=await(await post({confirmed:true})).json();assert.equal(r.results[0].status,'connected');
  assert.equal(s.accounts().length,1);
 }finally{await new Promise(r=>app.server.close(r));s.close();}
});
