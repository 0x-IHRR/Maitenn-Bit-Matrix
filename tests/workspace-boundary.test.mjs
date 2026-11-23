import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareWorkspace} from '../src/matrix/launch.mjs';
import {siteBrowser} from '../src/matrix/site-browser.mjs';

test('独立初始化不会继承旧配置或旧数据库，并保留本项目自行配置的设置',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'matrix-boundary-'));fs.mkdirSync(path.join(root,'data'));
  try {
    fs.writeFileSync(path.join(root,'data/runtime-config.json'),JSON.stringify({telegram:{botToken:'OLD_INSTANCE'},rootPath:'/another/workbench'}));
    fs.writeFileSync(path.join(root,'data/hub.db'),'OLD_DATABASE');
    const own=prepareWorkspace(root),config=JSON.parse(fs.readFileSync(own.runtime,'utf8'));
    assert.equal(config.name,'比特媒体矩阵');assert.equal(config.telegram.botToken,undefined);assert.equal(config.site.enabled,false);
    assert.equal(own.dbPath,path.join(root,'data/workbench.db'));assert.equal(fs.existsSync(own.dbPath),false);
    assert.equal(fs.readFileSync(path.join(root,'data/hub.db'),'utf8'),'OLD_DATABASE');
    config.telegram={enabled:true,botToken:'OWN_CONFIG'};fs.writeFileSync(own.runtime,JSON.stringify(config));
    prepareWorkspace(root);assert.equal(JSON.parse(fs.readFileSync(own.runtime)).telegram.botToken,'OWN_CONFIG');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('转化数据也使用明确选择的比特环境，原有页面保持不变',async()=>{
  let connects=0,closes=0,created=0;
  const page={targetId:'existing',url:'https://site.test/admin'};
  const bit={connect:async id=>{assert.equal(id,'profile');connects++;return {pages:async()=>[page],evaluate:async()=>({reg:[]}),create:async()=>{created++;},closePage:async()=>{closes++;},close(){}};}};
  assert.throws(()=>siteBrowser(bit,'matrix'),/选择/);
  const browser=siteBrowser(bit,'profile');await browser.withTab(page.url,p=>browser.evaluate(p,'read'));
  assert.equal(connects,1);assert.equal(created,0);assert.equal(closes,0);
});
