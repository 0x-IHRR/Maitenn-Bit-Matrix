import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bt-native-fixture-'));
const project=path.join(dir,'project');fs.mkdirSync(project);
const cfg=path.join(dir,'config.json');
fs.writeFileSync(cfg,JSON.stringify({rootPath:project,driver:'direct',chromePort:1,web:{port:0,host:'127.0.0.1',key:''},site:{enabled:false},keepAlive:[],disabled:[]}));
process.env.MAITIAN_CONFIG=cfg;process.env.MAITIAN_DB=path.join(dir,'hub.db');
const [{db,upsertEpisode,setTask,saveSnapshot},{Store},{createMatrixExtension},{startWeb},{readProjects}]=await Promise.all([
 import('../../src/db.mjs'),import('../../src/matrix/store.mjs'),import('../../src/matrix/web-extension.mjs'),import('../../src/web.mjs'),import('../../src/matrix/importer.mjs')
]);
const pj={id:'legacy-one',episode:1,name:'原生验收作品',schedule:new Date().toISOString(),covers:{'3x4':'cover.svg','4x3':'cover.svg'},platforms:{x:{title:'原生验收作品',body:'测试文案',tags:['验收']}}};
fs.writeFileSync(path.join(project,'publish.json'),JSON.stringify(pj));
fs.writeFileSync(path.join(project,'发布记录.json'),JSON.stringify({updatedAt:new Date().toISOString(),platforms:{x:{state:'已发布',url:'https://x.com/first/status/111'}}}));
fs.writeFileSync(path.join(project,'cover.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#0071e3"/></svg>');
upsertEpisode({id:pj.id,episode:1,name:pj.name,dir:project,schedule:pj.schedule});saveSnapshot(pj.id,pj);setTask(pj.id,'x','published','',{url:'https://x.com/first/status/111'});
const store=new Store(':memory:');store.addProfile('one','比特环境一');store.addProfile('two','比特环境二');
const a=store.bind({profileId:'one',platform:'x',identity:'first',confirmed:true});
const b=store.bind({profileId:'two',platform:'x',identity:'second',confirmed:true});
store.importPosts(a,await readProjects(project,'x'));
store.saveResult(a,{identity:'first',followers:0,posts:[{id:store.account(a).posts[0].id,metrics:{views:0,likes:0,comments:0,favorites:0,shares:0}}]});
store.saveResult(b,{identity:'second',followers:7,posts:[]});
let collections=0,opens=0;
const extension=createMatrixExtension({store,bitFactory:()=>({list:async()=>[{id:'one',name:'比特环境一'},{id:'two',name:'比特环境二'}],running:async()=>({one:1,two:2}),open:async()=>{opens++;}}),collector:async account=>{collections++;return {identity:account.identity,followers:account.identity==='first'?0:7,posts:[]};}});
const server=startWeb({extension});
server.on('listening',()=>{const result={port:server.address().port,project};if(process.send)process.send(result);else console.log(JSON.stringify(result));});
process.on('message',m=>{
  if(m==='stats')process.send?.({collections,opens});
  if(m==='replace'){store.bind({profileId:'one',platform:'x',identity:'replacement',confirmed:true});process.send?.({historicalAccountId:a});}
});
process.on('SIGTERM',()=>server.close(()=>{store.close();db.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(0);}));
