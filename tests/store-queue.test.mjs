import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/matrix/store.mjs';
import { CollectionQueue } from '../src/matrix/queue.mjs';

function setup(count=1) {
  const store=new Store(':memory:');
  const ids=[];
  for(let i=0;i<count;i++) {store.addProfile(`p${i}`,`环境 ${i}`);ids.push(store.bind({profileId:`p${i}`,platform:'x',identity:`user${i}`,confirmed:true}));}
  return {store,ids};
}
async function done(q) {for(let n=0;n<200;n++){if(!q.active&&!q.pending.length)return;await new Promise(r=>setTimeout(r,5));}throw new Error('队列未完成');}
test('唯一绑定、换号后历史所有者与增长基线保留',()=>{
  const {store,ids}=setup(2);
  store.importPosts(ids[0],[{sourceKey:'project::x',title:'旧作品',metrics:{}}]);
  store.saveResult(ids[0],{identity:'user0',followers:0,posts:[],source:'existing'});
  assert.equal(store.account(ids[0]).followers,0);
  assert.throws(()=>store.bind({profileId:'p1',platform:'x',identity:'USER0',confirmed:true}),/已归属/);
  const newId=store.bind({profileId:'p0',platform:'x',identity:'replacement',confirmed:true});
  assert.equal(store.account(ids[0]).active,false);
  assert.equal(store.account(ids[0]).posts.length,1);
  assert.ok(store.account(ids[0]).history[0].endedAt);
  assert.equal(store.account(newId).growth,null);
  assert.throws(()=>store.importPosts(newId,[{sourceKey:'project::x'}]),/不能转移/);
  assert.throws(()=>store.saveResult(newId,{identity:'wrong',followers:10}),/不符/);
  store.close();
});
test('缺失字段不覆盖旧值、失败和本地读取不伪造成功时间',()=>{
  const {store,ids}=setup();const id=ids[0];
  store.importPosts(id,[{sourceKey:'project',metrics:{}}]);
  const post=store.account(id).posts[0];
  store.saveResult(id,{identity:'user0',followers:100,posts:[{id:post.id,metrics:{views:0,likes:3}}]});
  store.saveResult(id,{identity:'user0',followers:null,posts:[{id:post.id,metrics:{views:null,likes:4}}]});
  assert.equal(store.account(id).posts[0].metrics.views,0);
  assert.equal(store.account(id).followers,100);
  const time=store.account(id).lastSuccess;
  assert.throws(()=>store.saveResult(id,{identity:'user0',followers:null}),/没有获取/);
  assert.equal(store.account(id).lastSuccess,time);
  store.close();
});

test('原生取链接只更新归属明确的作品，本地重读不覆盖较新的链接',()=>{
  const {store,ids}=setup();const id=ids[0];
  store.importPosts(id,[{sourceKey:'project',title:'作品',url:'',status:'等待',metrics:{}}]);
  const post=store.account(id).posts[0];
  store.saveResult(id,{identity:'user0',followers:null,postUpdates:[{id:post.id,url:'https://x.com/user0/status/123',status:'已发布'}]});
  assert.equal(store.account(id).lastSuccess,null);
  store.importPosts(id,[{sourceKey:'project',title:'作品',url:'',status:'等待',metrics:{},sourceUpdatedAt:'2020-01-01T00:00:00Z'}]);
  assert.equal(store.account(id).posts[0].url,'https://x.com/user0/status/123');
  assert.throws(()=>store.markPost(id,post.id,{url:'https://example.com/private'}),/链接无效/);
  store.close();
});
test('10个以上环境、重开SQLite后恢复绑定和历史',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'bt-store-'));const file=join(dir,'state.db');
  try {
    let s=new Store(file);for(let i=0;i<11;i++)s.addProfile(`p${i}`,`P${i}`);
    const id=s.bind({profileId:'p0',platform:'instagram',identity:'account.one',confirmed:true});
    s.saveResult(id,{identity:'account.one',followers:12,posts:[]});s.close();
    s=new Store(file);assert.equal(s.profiles().length,11);assert.equal(s.account(id).followers,12);s.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('最多2个Profile并行，同账号互斥，单账号失败不阻塞其余任务',async()=>{
  const {store,ids}=setup(4);let active=0,max=0;const calls=[];
  const q=new CollectionQueue(store,async a=>{
    calls.push(a.id);max=Math.max(max,++active);await new Promise(r=>setTimeout(r,15));active--;
    if(a.id===ids[0])throw new Error('普通超时');return {identity:a.identity,followers:10,posts:[]};
  },()=>({}));
  q.enqueue({profileIds:['p0','p1','p2','p3']});q.enqueue({accountIds:ids});
  await done(q);assert.equal(max,2);assert.equal(calls.length,4);
  assert.equal(store.account(ids[0]).status,'failed');assert.equal(store.account(ids[3]).followers,10);store.close();
});
test('风控暂停阻断重复更新，仅人工确认可恢复；未运行环境不隐式打开',async()=>{
  const {store,ids}=setup(2);let calls=0;
  const q=new CollectionQueue(store,async a=>{calls++;throw Object.assign(new Error(a.profileId==='p0'?'验证码':'环境未运行'),{code:a.profileId==='p0'?'risk':'offline'});},()=>({}));
  q.enqueue({profileIds:['p0','p1']});await done(q);
  assert.equal(store.account(ids[0]).status,'paused');assert.equal(store.account(ids[1]).status,'offline');
  q.enqueue({accountIds:[ids[0]]});await done(q);assert.equal(calls,2);
  assert.throws(()=>store.resume(ids[0],false),/确认/);store.resume(ids[0],true);
  assert.equal(store.account(ids[0]).status,'pending');store.close();
});
