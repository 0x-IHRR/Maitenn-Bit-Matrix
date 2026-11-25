import {snapshot, normalizeIdentity, numberOf} from './collector.mjs';
import {runningIds} from './window.mjs';

// Only inspect existing tabs. Detection never opens a window or navigates a page.
export async function detectAccounts(bit) {
  const profiles = await bit.list();
  const running = await bit.running();
  const opened = profiles.filter(p => runningIds(running).has(p.id));
  const ports = opened.length ? await bit.request('/browser/ports') : {};
  const results = [];
  for (const p of opened) {
    const row = {profileId:p.id, name:p.name || p.id, status:'unidentified', reason:'无法识别当前登录账号'};
    let cdp;
    try {
      cdp = await bit.connect(p.id, {running, ports});
      const pages = (await cdp.pages()).filter(page => {
        try {const u=new URL(page.url);return u.protocol==='https:' && ['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname);} catch {return false;}
      });
      if (!pages.length) {row.status='no-tab';row.reason='没有已打开的 X 标签页';}
      const data=[];
      for (const page of pages) data.push(await cdp.evaluate(page, `(${snapshot.toString()})('x',null)`));
      const identities=[...new Set(data.filter(d=>d?.identity).map(d=>normalizeIdentity('x',d.identity)))];
      if (data.some(d=>d?.risk)) {row.status='risk';row.reason='页面要求验证或提示限流，请在比特中处理';}
      else if (identities.length>1) {row.status='conflict';row.reason='同一环境的 X 标签页显示不同登录账号，请先核对';}
      else if (data.some(d=>d?.login)) {row.status='login';row.reason='存在未登录的 X 页面，请先核对登录状态';}
      else if (identities.length===1) {
        row.identity=identities[0];row.status='detected';row.reason='已识别登录账号';
        row.followers=data.map(d=>numberOf(d?.followers)).find(n=>n!==null) ?? null;
      }
    } catch(e) {row.status='error';row.reason=e.message;}
    finally {cdp?.close();}
    results.push(row);
  }
  // A username seen in two windows needs an explicit ownership decision.
  for (const row of results.filter(r=>r.status==='detected')) {
    if (results.filter(r=>r.identity===row.identity).length>1) {row.status='conflict';row.reason='同一账号出现在多个环境，请手动选择归属';}
  }
  if (opened.length) {
    const latestRunning=await bit.running(), latestPorts=await bit.request('/browser/ports');
    for (const row of results) {
      if (!runningIds(latestRunning).has(row.profileId) || latestPorts[row.profileId]!==ports[row.profileId] ||
          (!Array.isArray(running) && JSON.stringify(latestRunning[row.profileId])!==JSON.stringify(running[row.profileId]))) {
        row.status='error';row.reason='检测期间环境或调试端口发生变化，请重新检测';
      }
    }
  }
  return results;
}

export function connectDetected(store, results) {
  for (const row of results.filter(r=>r.status==='risk')) {
    const current=store.accounts().find(a=>a.active && a.group==='owned' && a.platform==='x' && a.profileId===row.profileId);
    if (current) store.status(current.id,'paused',row.reason);
  }
  for (const row of results.filter(r=>r.status==='detected')) {
    try {
      const accounts=store.accounts();
      const current=accounts.find(a=>a.active && a.group==='owned' && a.platform==='x' && a.profileId===row.profileId);
      const known=accounts.find(a=>a.platform==='x' && a.identity===row.identity);
      if (current && current.identity!==row.identity) throw new Error('该环境已有其他账号绑定，请手动确认换号');
      if (known && (!known.active || known.group!=='owned' || known.profileId!==row.profileId)) throw new Error('该账号已有其他或历史归属，请手动确认');
      row.accountId=store.transaction(()=>{
        store.addProfile(row.profileId,row.name);
        return store.bind({profileId:row.profileId,platform:'x',identity:row.identity,confirmed:true});
      });
      row.status=current?'existing':'connected';row.reason=current?'账号已接入':'已接入账号';
      if (!current) store.status(row.accountId,'ready');
      if (row.followers!==null && !current?.lastSuccess && !['paused','mismatch'].includes(current?.status)) {
        store.saveResult(row.accountId,{identity:row.identity,followers:row.followers,posts:[],source:'自动检测：已有 X 主页',warnings:[{reason:'仅获取主页粉丝；帖子与 Analytics 尚未获取'}]});
      }
    } catch(e) {row.status='conflict';row.reason=e.message;}
  }
  return results;
}
