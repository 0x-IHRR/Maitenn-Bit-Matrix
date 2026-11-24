import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareWorkspace} from '../src/matrix/launch.mjs';

test('独立初始化不会继承旧配置或旧数据库，并保留本项目自行配置的设置',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'matrix-boundary-'));fs.mkdirSync(path.join(root,'data'));
  try {
    fs.writeFileSync(path.join(root,'data/runtime-config.json'),JSON.stringify({telegram:{botToken:'OLD_INSTANCE'},rootPath:'/another/workbench'}));
    fs.writeFileSync(path.join(root,'data/hub.db'),'OLD_DATABASE');
    const own=prepareWorkspace(root),config=JSON.parse(fs.readFileSync(own.runtime,'utf8'));
    assert.equal(config.name,'比特媒体矩阵');assert.equal(config.telegram.botToken,undefined);assert.equal(config.site,undefined);assert.equal(config.matrix.bitUrl,'http://127.0.0.1:54345');
    assert.equal(own.dbPath,path.join(root,'data/workbench.db'));assert.equal(fs.existsSync(own.dbPath),false);
    assert.equal(fs.readFileSync(path.join(root,'data/hub.db'),'utf8'),'OLD_DATABASE');
    config.telegram={enabled:true,botToken:'OWN_CONFIG'};fs.writeFileSync(own.runtime,JSON.stringify(config));
    prepareWorkspace(root);assert.equal(JSON.parse(fs.readFileSync(own.runtime)).telegram.botToken,'OWN_CONFIG');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
