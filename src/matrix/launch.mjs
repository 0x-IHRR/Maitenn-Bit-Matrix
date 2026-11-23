import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function prepareWorkspace(root) {
const data=path.join(root,'data');
fs.mkdirSync(data,{recursive:true,mode:0o700});
const runtime=path.join(data,'config.json');
if(!fs.existsSync(runtime)) {
  fs.writeFileSync(runtime,JSON.stringify({
    name:'比特媒体矩阵',matrixWorkbench:true,rootPath:path.join(root,'projects'),keepAlive:[],disabled:[],
    web:{host:'127.0.0.1',port:8790,key:'',login:''},site:{enabled:false},telegram:{enabled:false}
  },null,2)+'\n',{mode:0o600});
}
return {runtime,dbPath:path.join(data,'workbench.db')};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {runtime,dbPath}=prepareWorkspace(root);
// These stores belong to this workbench. Never discover or import another running instance.
process.env.MAITIAN_CONFIG=runtime;
process.env.MAITIAN_DB=dbPath;
process.env.HUB_NO_WEB='1';
process.env.NO_PROXY=[process.env.NO_PROXY,'localhost','127.0.0.1','::1'].filter(Boolean).join(',');
await import('../followers.mjs');
const [{startWeb},{createMatrixExtension}]=await Promise.all([import('../web.mjs'),import('./web-extension.mjs')]);
const extension=createMatrixExtension();
const server=startWeb({extension});
server.on('close',()=>extension.close());

}
