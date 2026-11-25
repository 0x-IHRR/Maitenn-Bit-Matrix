import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('大屏首轮渲染异常显示失败，重试可恢复，后续刷新失败保留已显示内容',async()=>{
 const html=await readFile(new URL('../src/web/board.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('let rendered = false;'),html.indexOf("const tip = $('#tip');"));
 const screen={innerHTML:'加载中…'};let renderFails=true,fetchFails=false;
 const context=vm.createContext({document:{cookie:''},O:null,console:{error(){}},esc:String,$:()=>screen,
  fetch:async()=>{if(fetchFails)throw new Error('断线');return {ok:true,json:async()=>({episodes:[]})}},
  render:()=>{if(renderFails)throw new ReferenceError('缺少渲染依赖');screen.innerHTML='数据已显示';}});
 vm.runInContext(source,context);
 await vm.runInContext('load()',context);
 assert.match(screen.innerHTML,/页面加载失败/);assert.doesNotMatch(screen.innerHTML,/加载中/);
 renderFails=false;await vm.runInContext('load()',context);assert.equal(screen.innerHTML,'数据已显示');
 fetchFails=true;await vm.runInContext('load()',context);assert.equal(screen.innerHTML,'数据已显示');
});
