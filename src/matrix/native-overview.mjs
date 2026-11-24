import { validMetric } from './store.mjs';
import { healthIssues, reviewsForPost, weeklyReport } from './review.mjs';

const dayOf = value => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const latestTime = values => values.filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1) || null;
const stateNames={published:'已发布',scheduled:'已定时',planned:'计划中',failed:'异常'};
const nativeStates={'已发布':'published','已定时':'scheduled','计划中':'planned','异常':'failed','跳过':'skipped'};

// Adapt account-owned records for 麦田's native dashboard; never collect here.
export function nativeOverview(store, running, connectionError, profileId='') {
  const profiles=store.profiles();
  const historyId=profileId.startsWith('history:')?profileId.slice(8):null;
  const allAccounts=store.accounts();
  if(historyId && !allAccounts.some(a=>a.id===historyId&&a.platform==='x'))throw new Error('历史账号不存在');
  if(profileId && !historyId && !profiles.some(p=>p.id===profileId)) throw new Error('所选环境未纳管');
  const accounts=allAccounts.filter(a=>{
    if(a.platform!=='x' || a.enabled===false) return false;
    if(historyId) return a.id===historyId;
    if(a.group==='benchmark') return !profileId;
    return a.active && (!profileId || a.profileId===profileId);
  });
  const days=new Map();
  for(const a of accounts) {
    const seen=new Set();
    for(const sample of a.samples) {
      const day=dayOf(sample.at);
      if(seen.has(day))continue;
      seen.add(day);
      if(!days.has(day))days.set(day,new Map());
      days.get(day).set(a.id,sample.followers);
    }
  }
  const followers=[...days].filter(([,values])=>values.size===accounts.length).sort(([a],[b])=>a.localeCompare(b)).map(([day,values])=>({platform:'x',day,total:[...values.values()].reduce((a,b)=>a+b,0)}));
  const samples=[];
  const episodes=accounts.flatMap(a=>a.posts.map(p=>{
    const postSamples=a.postSamples.filter(s=>s.id===p.id);
    const older=[...a.posts].filter(other=>other.id!==p.id && Date.parse(other.createdAt||'0') < Date.parse(p.createdAt||'0'));
    const previous=older.sort((x,y)=>Date.parse(y.createdAt||'0')-Date.parse(x.createdAt||'0'))[0];
    const reviews=reviewsForPost({ post:p, samples:postSamples, previous: previous && { ...previous, samples:a.postSamples.filter(s=>s.id===previous.id) }, followerSamples:a.samples });
    const hasMetrics=Object.values(p.metrics||{}).some(validMetric);
    const metrics=hasMetrics?Object.fromEntries(['views','likes','comments','favorites','shares'].map(k=>[k,validMetric(p.metrics[k])?p.metrics[k]:null])):null;
    const interactions=metrics&&['likes','comments','favorites','shares'].map(k=>metrics[k]);
    const history=[...(p.metricsHistory||[]),...a.postSamples.filter(s=>s.id===p.id).map(s=>({day:s.at.slice(0,10),...(s.metrics||{})}))].map(m=>({...m,platform:'x',episode_id:p.id}));
    samples.push(...(p.samples||[]).map(s=>({...s,episode_id:p.id})),...a.postSamples.filter(s=>s.id===p.id).map(s=>({...s.metrics,ts:s.at.slice(0,16),episode_id:p.id,platform:'x'})));
    return {id:p.id,episode:p.episode??'',name:`@${a.identity} · ${p.projectName||p.title}`,nick:`@${a.identity} · ${p.nick||p.title}`,short:p.title,
      schedule:p.schedule||null,createdAt:p.createdAt||null,covers:Object.keys(p.covers||{}),views:metrics?.views??null,
      inter:interactions?.every(validMetric)?interactions.reduce((x,y)=>x+y,0):null,
      profileId:a.profileId,accountId:a.id,identity:a.identity,lastSuccess:p.lastSuccess||null,dir:p.projectPath,durationSec:p.durationSec||0,
      logs:p.logs||[],metrics:history,files:p.files||[],reviews,snapshotAt:null,campaign:p.campaign||'',
      accountAnalytics:a.analytics||null,analyticsIssue:a.analyticsIssue||null,
      tasks:[{platform:'x',name:'X',state:nativeStates[p.status]||p.status,stateCn:stateNames[p.status]||p.status||'已登记',url:p.url||'',detail:p.detail||'',updatedAt:p.lastSuccess||null,
        analytics:p.analytics||null,
        copy:p.copy||{title:p.title||'',body:'',tags:[],covers:[]},shot:false,m:(metrics||p.analytics)&&{...(metrics||{}),impressions:p.analytics?.impressions??null,engagementRate:p.analytics?.engagementRate??null,profileVisits:p.analytics?.profileVisits??null,linkClicks:p.analytics?.linkClicks??null,extra:p.extra||{},collectedAt:p.lastSuccess,metricTimes:p.metricTimes||{}}}]};
  }));
  const allReady=accounts.length>0&&accounts.every(a=>a.status==='ready');
  const paused=accounts.some(a=>['paused','mismatch','login','failed'].includes(a.status));
  const sumOf = key => { const values = accounts.map(a => a.analytics?.[key]).filter(validMetric); return values.length ? values.reduce((total, value) => total + value, 0) : null; };
  const analytics = { impressions: sumOf('impressions'), profileVisits: sumOf('profileVisits'), linkClicks: sumOf('linkClicks'), accounts: accounts.filter(a => a.group !== 'benchmark').map(a => ({ id: a.id, identity: a.identity, ...(a.analytics || {}), issue: a.analyticsIssue || null, history: a.analyticsHistory || [] })) };
  const issues=healthIssues({ accounts, connectionError });
  samples.sort((a,b)=>String(a.ts).localeCompare(String(b.ts)));
  return {name:'比特媒体矩阵',matrixReadOnly:!!historyId,episodes,followers,samples,analytics,actions:[],feed:[],siteOn:false,site:{days:[],channels:[],campaigns:[]},weekly:weeklyReport(accounts),
    health:{nas:false,chrome:profiles.some(p=>running.has(p.id)),issues,platforms:[{id:'x',disabled:false,state:paused?'out':allReady?'ok':'',reason:paused?'有账号需要处理':issues.find(issue=>issue.code==='bit')?.text||''}]},
    scope:{profiles,selectedProfileId:profileId,accountCount:accounts.length,availableAccountCount:accounts.filter(a=>validMetric(a.followers)).length,
      profileCount:profiles.length,runningCount:profiles.filter(p=>running.has(p.id)).length,
      lastSuccess:latestTime(accounts.flatMap(a=>[a.followersLastSuccess,...a.posts.map(p=>p.lastSuccess)])),connectionError}};
}
