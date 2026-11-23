export function siteBrowser(bit,profileId) {
  if(!profileId || profileId==='matrix' || profileId.startsWith('history:'))throw new Error('请先选择用于登录转化站点的比特 Profile');
  let client;
  return {
    async withTab(url,fn) {
      const target=new URL(url);if(!['http:','https:'].includes(target.protocol))throw new Error('站点地址须为 HTTP 或 HTTPS');
      client=await bit.connect(profileId);let page,created=false,completed=false;
      try {
        page=(await client.pages()).find(p=>{try{const u=new URL(p.url);return u.origin===target.origin&&u.pathname===target.pathname;}catch{return false;}});
        if(!page){page=await client.create(url);created=true;
          for(let i=0;i<20;i++){const ready=await client.evaluate(page,'({url:location.href,ready:document.readyState})');if(ready?.url!=='about:blank'&&ready?.ready==='complete')break;await new Promise(r=>setTimeout(r,500));}
        }
        const result=await fn(page);if(result==null)throw new Error('转化站点数据未获取，请在所选比特环境检查站点登录');
        completed=true;return result;
      } finally {if(created&&completed)await client.closePage(page);client.close();}
    },
    evaluate(page,expression){return client.evaluate(page,expression);}
  };
}
