// 原生页面的比特接入面板；本地轮询只读状态，不触发平台采集。
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const initialScope = window.MaitianProfileScope?.scope || scope();
  let state = {profiles:[],accounts:[],tasks:[],alerts:[],monitor:null}, discovered = [], error = '', pending = false, bitUrlDraft = null, scheduleDraft = null;
  let detecting = false, detectionResults = null, detectionError = '';
  const accountDrafts = new Map();
  const drafts = new Map();
  function scope() { try {const value=decodeURIComponent(document.cookie.match(/(?:^|; )bt_profile=([^;]*)/)?.[1] || 'matrix');return value==='legacy'?'matrix':value;} catch {return 'matrix';} }
  async function api(path, body) {
    if (scope() !== initialScope) throw new Error('查看范围已改变，请重新加载页面。');
    const r = await fetch('/api/bt/' + path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await r.json();
    if (scope() !== initialScope) throw new Error('查看范围已改变，请重新加载页面。');
    if (!r.ok || data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || r.status);
    return data;
  }
  const status = value => ({ready:'可更新',success:'已获取',identity:'待确认',pending:'待确认',unconfirmed:'待确认',login:'需要人工登录',paused:'采集暂停',risk:'采集暂停',mismatch:'账号不符',offline:'未运行',error:'采集失败',failed:'采集失败',collecting:'采集中',queued:'等待采集'}[value] || value || '待确认');
  const paused = a => ['paused','risk','mismatch'].includes(a.status);
  const stamp = at => at ? new Date(at).toLocaleString('zh-CN') : '尚未获取';
  function capture() {
    const bitUrl=document.querySelector('#bt-api-url');if(bitUrl && (bitUrlDraft!==null || bitUrl.value!==bitUrl.defaultValue))bitUrlDraft=bitUrl.value;
    document.querySelectorAll('[data-bt-account]').forEach(form => accountDrafts.set(form.dataset.btAccount,{notes:form.elements.notes.value,tags:form.elements.tags.value,displayName:form.elements.displayName.value,enabled:form.elements.enabled.checked,group:form.elements.group.value}));
    document.querySelectorAll('[data-bt-form]').forEach(form => drafts.set(form.dataset.btForm,{identity:form.elements.identity.value,projectPath:form.elements.projectPath.value,ownership:form.elements.ownership.checked}));
  }
  function selector() {
    const top = document.querySelector('.top');
    if (!top || top.querySelector('#bt-scope')) return;
    const label = document.createElement('label'); label.className='bt-scope';label.textContent='查看范围 ';
    const select = document.createElement('select');select.id='bt-scope';select.setAttribute('aria-label','查看账号与环境范围');
    select.innerHTML = '<option value="matrix">X 矩阵总览</option>' + state.profiles.map(p=>`<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('') + state.accounts.filter(a=>a.group==='benchmark' && a.active!==false).map(a=>`<option value="${esc('history:'+a.id)}">@${esc(a.identity)}（对标）</option>`).join('') + state.accounts.filter(a=>a.active===false).map(a=>`<option value="${esc('history:'+a.id)}">${esc(a.identity)}（历史账号）</option>`).join('');
    if (![...select.options].some(o=>o.value===initialScope)) select.add(new Option('当前范围不可用',initialScope));
    select.value=initialScope;label.append(select);(top.querySelector('.nav') || top.firstElementChild).after(label);
    select.addEventListener('change',()=>{
      capture(); document.cookie=`bt_profile=${encodeURIComponent(select.value)}; Path=/; SameSite=Strict; Max-Age=31536000`;
      document.body.classList.add('bt-switching');select.disabled=true;location.reload();
    });
  }
  const postCount = a => a.posts?.length ? `${a.posts.length} 条` : !a.lastSuccess || /时间线.*跳过|帖子与 Analytics 尚未获取/.test(a.reason || '') ? '未获取' : '0 条';
  const section = (title, note = '') => `<div class="sec"><h2>${esc(title)}</h2><span class="note">${esc(note)}</span></div>`;
  const field = (label, input) => `<div><label class="lab">${esc(label)}</label>${input}</div>`;
  const accountError = a => ['failed','error','login','paused','risk','mismatch'].includes(a.status);
  function accountFacts(a) {
    const fans=a.followers==null?'未获取':Number(a.followers).toLocaleString('zh-CN');
    return `<dl class="kv"><dt>粉丝</dt><dd>${esc(fans)}</dd><dt>帖子</dt><dd>${postCount(a)}</dd><dt>最近成功</dt><dd>${esc(stamp(a.lastSuccess))}</dd></dl>${a.reason?`<div class="fine${accountError(a)?' bt-error':''}">${esc(a.reason.replace('Analytics 页面结构对不上，本次没有写入后台指标','X Analytics 后台指标尚未获取，请确认账号访问权限'))}</div>`:''}`;
  }
  function accountHTML(a) {
    const archived = a.active === false;
    return `<div class="prow pl-row"><b>@${esc(a.identity)}</b><span class="st-chip ${archived?'idle':paused(a)?'failed':'idle'}"><i>${paused(a)?'!':'○'}</i>${archived?'历史账号':esc(status(a.status))}</span></div>${accountFacts(a)}<div class="btns">${archived?`<a class="btn" href="/p#/archive" data-bt-history="${esc(a.id)}">查看历史档案</a>`:`<button class="btn" data-bt-action="update-account" data-id="${esc(a.id)}" ${paused(a)?'disabled':''}>${a.status==='login'?'登录后重新检查':'更新数据'}</button>${paused(a)?`<button class="btn" data-bt-action="resume" data-id="${esc(a.id)}">确认验证并恢复</button>`:''}`}</div>`;
  }
  function detectionHTML() {
    const labels={connected:'已接入',existing:'已绑定',conflict:'绑定冲突',login:'需要登录',risk:'需要验证',unidentified:'身份未确认','no-tab':'没有 X 标签页',error:'检测失败'};
    return `<div id="bt-detection" role="status" aria-live="polite"><p class="fine">只检测已打开环境中的 X 标签页，不打开窗口、不替换已有绑定。</p>${detecting?'<p class="fine">正在检测并接入已打开账号，请稍候…</p>':''}${detectionError?`<p class="fine bt-error">${esc(detectionError)}</p>`:''}${detectionResults===null?'':`<div class="fine">${detecting?'上次检测结果':'检测结果'} · ${detectionResults.length} 个环境</div>${detectionResults.map(r=>`<div class="prow"><span><b>${esc(r.name||r.profileId)}</b>${r.identity?' · @'+esc(String(r.identity).replace(/^@/,'')):''}</span><span class="d">${esc(labels[r.status]||r.status)}${r.reason?' · '+esc(r.reason):''}</span></div>`).join('') || '<p class="fine">没有可检测的已打开 X 标签页。</p>'}`}</div>`;
  }
  function profileHTML(p) {
    const current=state.accounts.find(a=>a.profileId===p.id&&a.platform==='x'&&a.active!==false);
    const old=state.accounts.filter(a=>a.profileId===p.id&&a.platform==='x'&&a.active===false);
    const draft=drafts.get(p.id)||{identity:current?.identity||'',projectPath:current?.projectPath||'',ownership:false};
    const task=state.tasks.find(t=>t.profileId===p.id&&['queued','collecting','running'].includes(t.status));
    return `<div class="panel"><div class="ph"><h3>${esc(p.name||p.id)}</h3><span class="note"><span class="st-chip ${p.running?'published':'idle'}"><i>${p.running?'✓':'○'}</i>${p.running?'运行中':'未运行'}</span>${task?` · ${esc(status(task.status))}`:''}</span></div>${current?accountHTML(current):'<div class="site-off">尚未绑定 X 账号，可在下方填写并确认用户名。</div>'}<div class="btns"><button class="btn" data-bt-action="open" data-id="${esc(p.id)}">打开此环境</button><button class="btn" data-bt-action="update-profile" data-id="${esc(p.id)}">更新此环境</button></div><details class="bt-profile" ${draft.open?'open':''} data-profile-id="${esc(p.id)}"><summary><b>账号绑定</b><span>${current?'更换账号或关联工程':'绑定 X 用户名'}</span></summary><form data-bt-form="${esc(p.id)}"><div class="grid2">${field('X 用户名',`<input class="inp" name="identity" value="${esc(draft.identity)}" placeholder="your_handle" required>`)}${field('本工作台工程 / 发布记录（可选兼容工程）',`<input class="inp" name="projectPath" value="${esc(draft.projectPath)}" placeholder="需要关联时填写工程目录，默认留空">`)}</div><label class="swrow"><input class="switch" type="checkbox" name="ownership" ${draft.ownership?'checked':''}><span>确认工程归属 <small>目录中的 X 作品属于上述账号</small></span></label><div class="btns"><button class="btn pri" type="submit">确认绑定 / 更换并读取工程</button></div><div class="fine">更换账号保留原账号作品与统计；工程文件不会移动。</div></form>${old.length?`<div class="fine">历史账号</div>${old.map(accountHTML).join('')}`:''}</details></div>`;
  }
  function panelHTML() {
    return `${section('比特连接与接入','检测已打开账号，或手动选择环境')}
    <div class="sys-2col sys-itg"><div class="panel"><div class="ph"><h3>本机连接</h3><span class="note">Local API</span></div><form id="bt-settings-form"><label class="lab" for="bt-api-url">比特 Local API 地址</label><input class="inp" id="bt-api-url" name="bitUrl" type="url" value="${esc(bitUrlDraft ?? (state.settings?.bitUrl || 'http://127.0.0.1:54345'))}" placeholder="http://127.0.0.1:54345" required><div class="btns"><button class="btn pri" type="submit">保存连接</button><button class="btn" type="button" data-bt-action="refresh">刷新本地状态</button></div></form><div id="bt-error" class="fine bt-error" role="status">${esc(error||state.connectionError||'')}</div></div>
    <div class="panel"><div class="ph"><h3>账号接入</h3><span class="note">已打开的 X 标签页</span></div><div class="btns"><button class="btn pri" data-bt-action="detect" ${detecting?'disabled':''}>${detecting?'检测并接入中…':'检测并接入已打开账号'}</button><button class="btn" data-bt-action="discover">发现比特环境</button></div>${detectionHTML()}<div id="bt-discovered">${discovered.map(p=>`<div class="prow"><span>${esc(p.name||p.id)}</span><span class="d">${esc(p.id)}</span>${state.profiles.some(s=>s.id===p.id)?'<span class="st-chip idle"><i>✓</i>已纳管</span>':`<button class="btn" data-bt-action="manage" data-id="${esc(p.id)}">确认纳管</button>`}</div>`).join('')}</div></div></div>
    ${section('已纳管 Profile',`${state.profiles.length} 个环境`)}<div class="btns"><button class="btn" data-bt-action="update-all">更新已纳管环境</button></div>${(state.alerts||[]).length?`<div role="status">${state.alerts.map(a=>`<div class="fine bt-error">@${esc(a.identity)} ${esc(a.status)}：${esc(a.reason||'需要处理')}</div>`).join('')}</div>`:''}<div id="bt-managed" class="sys-2col sys-itg">${state.profiles.map(profileHTML).join('')||'<div class="panel"><div class="site-off">还没有纳管环境，请先检测账号或发现比特环境。</div></div>'}</div>`;
  }
  function monitorValue() {
    const saved=state.monitor||{};
    return scheduleDraft||{scheduleEnabled:!!saved.scheduleEnabled,collectsPerDay:saved.collectsPerDay||1,collectHours:(saved.collectHours||[9]).join(','),concurrency:saved.concurrency||1,timelineLimit:saved.timelineLimit||20,intervalMinMinutes:saved.intervalMinMinutes||3,intervalMaxMinutes:saved.intervalMaxMinutes||8};
  }
  function adminHTML() {
    const m=monitorValue(),accounts=state.accounts||[];
    return `${section('采集计划','每天最多 2 次 · 号间随机间隔')}<div class="sys-2col sys-itg"><div class="panel"><div class="ph"><h3>定时采集</h3><span class="note">Asia/Shanghai</span></div><form id="bt-schedule-form"><label class="swrow"><input class="switch" type="checkbox" name="scheduleEnabled" ${m.scheduleEnabled?'checked':''}><span>启用定时采集</span></label><div class="grid2">
    ${field('每天次数',`<select class="inp" name="collectsPerDay"><option value="1" ${String(m.collectsPerDay)==='1'?'selected':''}>1</option><option value="2" ${String(m.collectsPerDay)==='2'?'selected':''}>2</option></select>`)}${field('小时（如 9 或 9,21）',`<input class="inp" name="collectHours" value="${esc(m.collectHours)}" required>`)}${field('并发',`<select class="inp" name="concurrency"><option value="1" ${String(m.concurrency)==='1'?'selected':''}>串行</option><option value="2" ${String(m.concurrency)==='2'?'selected':''}>2</option></select>`)}${field('时间线条数',`<input class="inp" name="timelineLimit" type="number" min="1" max="50" value="${esc(m.timelineLimit)}" required>`)}${field('间隔最少（分钟）',`<input class="inp" name="intervalMinMinutes" type="number" min="1" max="180" value="${esc(m.intervalMinMinutes)}" required>`)}${field('间隔最多（分钟）',`<input class="inp" name="intervalMaxMinutes" type="number" min="1" max="180" value="${esc(m.intervalMaxMinutes)}" required>`)}</div><div class="btns"><button class="btn pri" type="submit">保存采集计划</button><button class="btn" type="button" data-bt-action="collect-now">采集到期账号</button></div></form></div>
    <div class="panel"><div class="ph"><h3>采集方式</h3></div><dl class="kv"><dt>自有账号</dt><dd>在比特窗口内只读采集</dd><dt>对标账号</dt><dd>通过公开接口读取，不打开比特</dd><dt>窗口管理</dt><dd>按需打开，只关闭本次打开的窗口</dd><dt>异常处理</dt><dd>登录页、验证码或限流会暂停该号，等待人工处理</dd></dl></div></div>
    ${section('账号管理','自有 / 对标 · 备注、标签、启停')}<div class="sys-2col sys-itg"><div class="panel"><div class="ph"><h3>添加对标账号</h3></div><form id="bt-benchmark-form"><div class="grid2">${field('对标用户名','<input class="inp" name="identity" placeholder="public_handle" required>')}${field('备注','<input class="inp" name="notes" placeholder="可选">')}${field('标签','<input class="inp" name="tags" placeholder="逗号分隔">')}</div><div class="btns"><button class="btn pri" type="submit">添加对标账号</button></div><div class="fine">对标账号只读 api.fxtwitter.com / api.vxtwitter.com，也可由外部 JSON 导入。</div></form></div></div><div id="bt-account-admin" class="sys-2col sys-itg">${accounts.map(accountHTMLAdmin).join('')||'<div class="panel"><div class="site-off">还没有账号。</div></div>'}</div>`;
  }
  function accountHTMLAdmin(a) {
    const draft=accountDrafts.get(a.id)||{notes:a.notes||'',tags:(a.tags||[]).join(','),displayName:a.displayName||'',enabled:a.enabled!==false,group:a.group||'owned'};
    return `<div class="panel"><div class="ph"><h3>@${esc(a.identity)}</h3><span class="note"><span class="st-chip idle"><i>○</i>${a.group==='benchmark'?'对标':'自有'} · ${a.enabled===false?'已停用':esc(status(a.status))}</span></span></div>${accountFacts(a)}<form data-bt-account="${esc(a.id)}"><div class="grid2">${field('显示名',`<input class="inp" name="displayName" value="${esc(draft.displayName)}">`)}${field('备注',`<input class="inp" name="notes" value="${esc(draft.notes)}">`)}${field('标签',`<input class="inp" name="tags" value="${esc(draft.tags)}">`)}${field('分组',`<select class="inp" name="group"><option value="owned" ${draft.group==='owned'?'selected':''}>自有</option><option value="benchmark" ${draft.group==='benchmark'?'selected':''}>对标</option></select>`)}</div><label class="swrow"><input class="switch" type="checkbox" name="enabled" ${draft.enabled?'checked':''}><span>启用采集</span></label><div class="btns"><button class="btn pri" type="submit">保存</button><button class="btn" type="button" data-bt-action="unbind-account" data-id="${esc(a.id)}">解绑</button><button class="btn" type="button" data-bt-action="delete-account" data-id="${esc(a.id)}">删除</button></div></form></div>`;
  }
  function panel(force=false) {
    if (location.hash !== '#/system') return;
    const app=document.querySelector('#app');if (!app)return;
    let panel=document.querySelector('#bt-profiles-panel');
    if (panel && !force) return;
    if (panel && panel.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) return;
    if (panel) capture();
    const opened=new Set([...document.querySelectorAll('.bt-profile[open]')].map(el=>el.dataset.profileId));
    if (!panel) {panel=document.createElement('section');panel.id='bt-profiles-panel';panel.className='';const lead=app.querySelector('.lead');if(lead)lead.after(panel);else app.append(panel);}
    panel.innerHTML=panelHTML()+adminHTML();
    panel.querySelectorAll('.bt-profile').forEach(el=>{if(opened.has(el.dataset.profileId))el.open=true;});
  }
  function mount() {selector();panel();}
  async function refresh(force=false) {
    if (pending || scope()!==initialScope) return;
    pending=true;
    try {const next=await api('state');state={profiles:[],accounts:[],tasks:[],...next};error='';}
    catch(e){error=e.message;}finally{pending=false;}
    const select=document.querySelector('#bt-scope');
    const ids=['matrix',...state.profiles.map(p=>p.id),...state.accounts.filter(a=>a.active===false).map(a=>'history:'+a.id)];
    if (select && !select.matches(':focus') && JSON.stringify([...select.options].map(o=>o.value))!==JSON.stringify(ids)) document.querySelector('.bt-scope')?.remove();
    selector();panel(force);
  }
  addEventListener('maitian:before-render',()=>{
    const opened=[...document.querySelectorAll('.bt-profile[open]')].map(el=>el.dataset.profileId);capture();
    opened.forEach(id=>{const draft=drafts.get(id);if(draft)draft.open=true;});
  });
  addEventListener('maitian:render',mount);
  function captureSchedule(form) {
    if (!form) return;
    scheduleDraft={scheduleEnabled:form.elements.scheduleEnabled.checked,collectsPerDay:form.elements.collectsPerDay.value,collectHours:form.elements.collectHours.value,concurrency:form.elements.concurrency.value,timelineLimit:form.elements.timelineLimit.value,intervalMinMinutes:form.elements.intervalMinMinutes.value,intervalMaxMinutes:form.elements.intervalMaxMinutes.value};
  }
  document.addEventListener('input',event=>{
    if(event.target.id==='bt-api-url')bitUrlDraft=event.target.value;
    const schedule=event.target.closest?.('#bt-schedule-form'); if(schedule) captureSchedule(schedule);
  });
  document.addEventListener('change',event=>{const schedule=event.target.closest?.('#bt-schedule-form'); if(schedule) captureSchedule(schedule);});
  document.addEventListener('submit',async event=>{
    if(event.target.id==='bt-schedule-form'){
      event.preventDefault();captureSchedule(event.target);const button=event.target.querySelector('button[type="submit"]');button.disabled=true;
      const d=scheduleDraft;
      try{await api('settings',{scheduleEnabled:d.scheduleEnabled,collectsPerDay:Number(d.collectsPerDay),collectHours:d.collectHours,concurrency:Number(d.concurrency),timelineLimit:Number(d.timelineLimit),intervalMinMinutes:Number(d.intervalMinMinutes),intervalMaxMinutes:Number(d.intervalMaxMinutes)});scheduleDraft=null;await refresh(true);}
      catch(e){error=e.message;const el=document.querySelector('#bt-error');if(el)el.textContent=error;}
      finally{button.disabled=false;}return;
    }
    if(event.target.id==='bt-benchmark-form'){
      event.preventDefault();const form=event.target;const button=form.querySelector('button');button.disabled=true;
      try{await api('accounts',{action:'create',group:'benchmark',platform:'x',identity:form.elements.identity.value,notes:form.elements.notes.value,tags:form.elements.tags.value});form.reset();error='对标账号已添加。';await refresh(true);}
      catch(e){error=e.message;const el=document.querySelector('#bt-error');if(el)el.textContent=error;}
      finally{button.disabled=false;}return;
    }
    const accountForm=event.target.closest('[data-bt-account]');
    if(accountForm){
      event.preventDefault();capture();const id=accountForm.dataset.btAccount;const d=accountDrafts.get(id);const button=accountForm.querySelector('button[type="submit"]');button.disabled=true;
      try{
        const current=state.accounts.find(a=>a.id===id);
        const patch={action:'update',id,notes:d.notes,tags:d.tags,displayName:d.displayName,enabled:d.enabled,group:d.group};
        if(d.group==='owned' && current?.group!=='owned'){
          const profileId=prompt('改为自有账号需要比特环境 ID');
          if(!profileId) return;
          patch.profileId=profileId.trim();
        }
        await api('accounts',patch);accountDrafts.delete(id);error='账号已保存。';await refresh(true);
      }catch(e){error=e.message;const el=document.querySelector('#bt-error');if(el)el.textContent=error;}
      finally{button.disabled=false;}return;
    }
    if(event.target.id==='bt-settings-form'){
      event.preventDefault();capture();const button=event.target.querySelector('button');button.disabled=true;
      try{await api('settings',{bitUrl:event.target.elements.bitUrl.value.trim(),maitianRoot:''});await refresh(true);}
      catch(e){error=e.message;const el=document.querySelector('#bt-error');if(el)el.textContent=error;}
      finally{button.disabled=false;}return;
    }
    const form=event.target.closest('[data-bt-form]');if(!form)return;
    event.preventDefault();capture();const d=drafts.get(form.dataset.btForm);
    try {
      if(d.projectPath.trim()&&!d.ownership)throw new Error('请确认工程内 X 作品的账号归属。');
      const current=state.accounts.find(a=>a.profileId===form.dataset.btForm&&a.platform==='x'&&a.active!==false);
      const message=current&&current.identity.replace(/^@/,'').toLowerCase()!==d.identity.replace(/^@/,'').toLowerCase()?`确认将 ${current.identity} 更换为 ${d.identity}？原账号作品与统计保留，新账号独立统计。`:`确认将 X 账号 ${d.identity} 绑定到此环境${d.projectPath?'，并读取已确认归属的工程':''}？`;
      if(!confirm(message))return;
      await api('bind',{profileId:form.dataset.btForm,platform:'x',identity:d.identity,projectPath:d.projectPath,confirmed:true});error='绑定与工程归属已保存。';await refresh(true);
    }catch(e){error=e.message;const el=document.querySelector('#bt-error');if(el)el.textContent=error;}
  });
  document.addEventListener('click',async event=>{
    const historyLink=event.target.closest('[data-bt-history]');
    if(historyLink){event.preventDefault();document.cookie=`bt_profile=${encodeURIComponent('history:'+historyLink.dataset.btHistory)}; Path=/; SameSite=Strict; Max-Age=31536000`;location.href=historyLink.href;return;}
    const b=event.target.closest('[data-bt-action]');if(!b||b.disabled)return;
    const action=b.dataset.btAction,id=b.dataset.id; b.disabled=true;
    try {
      if(action==='detect'){
        if(detecting)return;detecting=true;detectionError='';panel(true);
        try{const result=await api('detect',{confirmed:true});detectionResults=result.results||[];await refresh(true);}
        catch(e){detectionError=e.message;throw e;}
        finally{detecting=false;panel(true);}
      }
      else if(action==='discover'){const result=await api('discover');discovered=result.profiles||[];panel(true);}
      else if(action==='refresh')await refresh(true);
      else if(action==='manage'){if(!confirm('确认纳管此比特环境？此操作不会修改指纹配置或打开窗口。'))return;await api('profiles',{id});await refresh(true);}
      else if(action==='open'){await api('open',{profileId:id});await refresh(true);}
      else if(action==='update-profile'){await api('update',{profileIds:[id]});await refresh(true);}
      else if(action==='update-account'){await api('update',{accountIds:[id]});await refresh(true);}
      else if(action==='update-all'){await api('update',{profileIds:state.profiles.map(p=>p.id)});await refresh(true);}
      else if(action==='resume'){if(!confirm('确认已在比特环境完成平台验证并核对登录账号？恢复后仍需手动更新。'))return;await api('resume',{accountId:id,confirmed:true});await refresh(true);}
      else if(action==='collect-now'){await api('collect',{});error='已检查到期账号。';await refresh(true);}
      else if(action==='unbind-account'){if(!confirm('解绑后保留账号、帖子和历史，只解除与比特环境的对应。'))return;await api('accounts',{action:'unbind',id});await refresh(true);}
      else if(action==='delete-account'){if(!confirm('删除账号会同时删除它的帖子和采集历史，且不能恢复。'))return;await api('accounts',{action:'delete',id});await refresh(true);}
    }catch(e){error=e.message;const el=document.querySelector('#bt-error');if(el)el.textContent=error;}finally{b.disabled=false;}
  });
  mount();refresh(true);setInterval(()=>{if(!document.hidden)refresh(true);},8000);
})();
