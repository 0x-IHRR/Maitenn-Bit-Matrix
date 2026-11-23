import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/matrix/store.mjs';
import { readProjects } from '../src/matrix/importer.mjs';
import { makeApp } from '../src/matrix/server.mjs';

test('旧工程只读导入，未知归属不自动统计，重读仅接收更新的有效指标',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bt-import-'));
  const original=JSON.stringify({id:'episode1',name:'测试工程',platforms:{x:{title:'作品'}}});
  try {
    await writeFile(join(dir,'publish.json'),original);
    await writeFile(join(dir,'发布记录.json'),JSON.stringify({platforms:{x:{state:'已发布',url:'https://x.com/test/status/123'}}}));
    const records=await readProjects(dir,'x');
    const store=new Store(':memory:');store.addProfile('p','P');
    assert.equal(store.accounts().length,0);
    const id=store.bind({profileId:'p',platform:'x',identity:'test',confirmed:true});
    store.importPosts(id,records);
    assert.equal(store.account(id).posts[0].url,'https://x.com/test/status/123');
    store.importPosts(id,[{...records[0],metrics:{views:20,likes:0},lastSuccess:'2026-11-21T01:00:00Z'}]);
    assert.equal(store.account(id).posts[0].metrics.views,20);
    store.importPosts(id,[{...records[0],metrics:{views:3},lastSuccess:'2026-11-20T01:00:00Z'}]);
    assert.equal(store.account(id).posts[0].metrics.views,20);
    assert.equal(store.account(id).posts[0].metricTimes.likes,'2026-11-21T01:00:00Z');
    const postId=store.account(id).posts[0].id;
    store.saveResult(id,{identity:'test',followers:null,posts:[{id:postId,metrics:{likes:4}}]});
    store.importPosts(id,[{...records[0],metrics:{views:30},lastSuccess:'2026-11-21T02:00:00Z'}]);
    assert.equal(store.account(id).posts[0].metrics.views,30);
    assert.equal(store.account(id).posts[0].metrics.likes,4);
    const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(dir,'publish.json'),'utf8'),original);
    store.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('HTTP操作闭环、跨站阻断与明确暂停恢复',async()=>{
  const store=new Store(':memory:');
  const bit={list:async()=>[{id:'p0',name:'测试环境'}],running:async()=>({p0:123}),open:async()=>{throw new Error('测试不允许打开浏览器');}};
  let calls=0;
  const app=makeApp({store,bitFactory:()=>bit,collector:async a=>{calls++;throw Object.assign(new Error('明确限流'),{code:'risk'});}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  async function post(url,data,origin) {return fetch(base+url,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(data)});}
  try {
    assert.equal((await post('/api/profiles',{id:'p0'},'https://example.com')).status,403);
    assert.equal((await post('/api/profiles',{id:'absent'})).status,400);
    assert.equal((await post('/api/profiles',{id:'p0'})).status,200);
    const result=await (await post('/api/bind',{profileId:'p0',platform:'x',identity:'test',confirmed:true})).json();
    await post('/api/update',{accountIds:[result.accountId]});
    for(let i=0;i<20&&app.queue.active;i++)await new Promise(r=>setTimeout(r,5));
    await post('/api/update',{accountIds:[result.accountId]});
    assert.equal(calls,1);
    const state=await (await fetch(base+'/api/state')).json();
    assert.equal(state.accounts[0].status,'paused');assert.equal(state.accounts[0].followers,null);
    assert.equal((await post('/api/resume',{accountId:result.accountId,confirmed:false})).status,400);
    assert.equal((await post('/api/resume',{accountId:result.accountId,confirmed:true})).status,200);
    assert.equal((await post('/api/settings',{bitUrl:'https://example.com',maitianRoot:''})).status,400);
    assert.equal((await fetch(base+'/')).status,404);
  } finally {await new Promise(r=>app.server.close(r));store.close();}
});

test('更新仅重读已确认作品，新发现工程在显式确认前不自动归属',async()=>{
  const {mkdir}=await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'bt-owner-'));
  const store=new Store(':memory:');store.addProfile('p','P');
  const id=store.bind({profileId:'p',platform:'x',identity:'owner',projectPath:dir,confirmed:true});
  async function project(name) {const sub=join(dir,name);await mkdir(sub);await writeFile(join(sub,'publish.json'),JSON.stringify({id:name,name,platforms:{x:{title:name}}}));}
  await project('first');store.importPosts(id,await readProjects(dir,'x'));
  await project('unassigned');
  let received;
  const app=makeApp({store,bitFactory:()=>({running:async()=>({p:1}),open:async()=>{throw new Error('不应打开已运行的窗口');},close:async()=>{throw new Error('不应关闭用户已打开的窗口');}}),collector:async a=>{received=a.posts;return {identity:'owner',followers:3,posts:[]};}});
  try {
    app.queue.enqueue({accountIds:[id]});
    for(let i=0;i<200&&app.queue.active;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(received.length,1);assert.equal(store.account(id).posts.length,1);
    assert.equal(store.account(id).posts[0].title,'first');
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
