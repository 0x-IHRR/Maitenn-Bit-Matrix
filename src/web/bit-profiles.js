// 原生页面的比特接入面板；本地轮询只读状态，不触发平台采集。
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const initialScope = window.MaitianProfileScope?.scope || scope();
  let state = {profiles:[],accounts:[],tasks:[]}, discovered = [], error = '', pending = false, bitUrlDraft = null;
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
    document.querySelectorAll('[data-bt-form]').forEach(form => drafts.set(form.dataset.btForm,{identity:form.elements.identity.value,projectPath:form.elements.projectPath.value,ownership:form.elements.ownership.checked}));
  }
  function selector() {
    const top = document.querySelector('.top');
    if (!top || top.querySelector('#bt-scope')) return;
    const label = document.createElement('label'); label.className='bt-scope';label.textContent='查看范围 ';
    const select = document.createElement('select');select.id='bt-scope';select.setAttribute('aria-label','查看账号与环境范围');
    select.innerHTML = '<option value="matrix">X 矩阵总览</option>' + state.profiles.map(p=>`<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('') + state.accounts.filter(a=>a.active===false).map(a=>`<option value="${esc('history:'+a.id)}">${esc(a.identity)}（历史账号）</option>`).join('');
    if (![...select.options].some(o=>o.value===initialScope)) select.add(new Option('当前范围不可用',initialScope));
    select.value=initialScope;label.append(select);(top.querySelector('.nav') || top.firstElementChild).after(label);
    select.addEventListener('change',()=>{
      capture(); document.cookie=`bt_profile=${encodeURIComponent(select.value)}; Path=/; SameSite=Strict; Max-Age=31536000`;
      document.body.classList.add('bt-switching');select.disabled=true;location.reload();
    });
  }
  function accountHTML(a) {
    const archived = a.active === false;
    const f = a.followers == null ? '未获取' : Number(a.followers).toLocaleString('zh-CN');
    return `<div class="bt-account"><div><b>${esc(a.identity)}</b> <span class="st-chip ${archived?'idle':paused(a)?'failed':'idle'}"><i>${paused(a)?'!':'○'}</i>${archived?'历史账号':esc(status(a.status))}</span><div class="fine">粉丝 ${esc(f)} · 粉丝获取 ${esc(stamp(a.followersLastSuccess))} · 作品 ${a.posts?.length||0} 条</div>${a.reason?`<div class="fine bt-error">${esc(a.reason)}</div>`:''}</div>${archived?`<a class="btn" href="/p#/archive" data-bt-history="${esc(a.id)}">查看历史档案</a>`:`<div class="btns"><button class="btn" data-bt-action="update-account" data-id="${esc(a.id)}" ${paused(a)?'disabled':''}>${a.status==='login'?'登录后重新检查':'更新数据'}</button>${paused(a)?`<button class="btn" data-bt-action="resume" data-id="${esc(a.id)}">确认验证并恢复</button>`:''}</div>`}</div>`;
  }
  function panelHTML() {
    return `<div class="ph"><h3>比特 Profile</h3><span class="note">手动更新 · 默认 2 个环境并行</span></div><p class="fine">选择上方查看范围，可查看 X 矩阵、单个比特环境及历史账号。数据与集成配置独立保存在本工作台。</p><form id="bt-settings-form" class="bt-connection"><label class="lab" for="bt-api-url">本机比特 Local API 地址<input class="inp" id="bt-api-url" name="bitUrl" type="url" value="${esc(bitUrlDraft ?? (state.settings?.bitUrl || 'http://127.0.0.1:54345'))}" placeholder="http://127.0.0.1:54345" required></label><button class="btn" type="submit">保存连接</button></form><div class="btns"><button class="btn" data-bt-action="discover">发现比特环境</button><button class="btn" data-bt-action="refresh">刷新本地状态</button><button class="btn" data-bt-action="update-all">更新已纳管环境</button></div><div id="bt-error" class="fine bt-error" role="status">${esc(error || state.connectionError || '')}</div><div id="bt-discovered">${discovered.map(p=>`<div class="prow"><span>${esc(p.name||p.id)}</span><span class="d">${esc(p.id)}</span>${state.profiles.some(s=>s.id===p.id)?'<span class="st-chip idle"><i>✓</i>已纳管</span>':`<button class="btn" data-bt-action="manage" data-id="${esc(p.id)}">确认纳管</button>`}</div>`).join('')}</div><div id="bt-managed">${state.profiles.map(p=>{
      const current = state.accounts.find(a=>a.profileId===p.id && a.platform==='x' && a.active!==false);
      const old = state.accounts.filter(a=>a.profileId===p.id && a.platform==='x' && a.active===false);
      const draft = drafts.get(p.id) || {identity:current?.identity||'',projectPath:current?.projectPath||'',ownership:false};
      const task=state.tasks.find(t=>t.profileId===p.id&&['queued','collecting','running'].includes(t.status));
      return `<details class="bt-profile" ${draft.open?'open':''} data-profile-id="${esc(p.id)}"><summary><b>${esc(p.name||p.id)}</b><span>${p.running?'运行中':'未运行'}${task?' · '+esc(status(task.status)):''}${current?' · '+esc(current.identity):' · 未绑定 X'}</span></summary><div class="btns"><button class="btn" data-bt-action="open" data-id="${esc(p.id)}">打开此环境</button><button class="btn" data-bt-action="update-profile" data-id="${esc(p.id)}">更新此环境</button></div>${current?accountHTML(current):'<p class="fine">填写并确认 X 用户名后可采集粉丝，无需先关联工程。</p>'}<form data-bt-form="${esc(p.id)}"><div class="bt-bind-fields"><label class="lab">X 用户名<input class="inp" name="identity" value="${esc(draft.identity)}" placeholder="your_handle" required></label><label class="lab">本工作台工程 / 发布记录（可选择兼容工程）<input class="inp" name="projectPath" value="${esc(draft.projectPath)}" placeholder="需要关联时填写工程目录，默认留空"></label></div><label class="bt-ownership"><input type="checkbox" name="ownership" ${draft.ownership?'checked':''}>若选择兼容工程，我确认读取该目录，且其中 X 作品归属上述账号。</label><p class="fine">更换账号后，原账号作品与统计留在原账号，新账号独立统计；工程文件不会移动。</p><button class="btn pri" type="submit">确认绑定 / 更换并读取工程</button></form>${old.length?`<div class="fine">历史账号（作品与数据归属保留）</div>${old.map(accountHTML).join('')}`:''}</details>`;
    }).join('') || '<div class="empty" style="min-height:70px">还没有纳管环境，点击“发现比特环境”后选择已有 Profile。</div>'}</div>`;
  }
  function panel(force=false) {
    if (location.hash !== '#/system') return;
    const app=document.querySelector('#app');if (!app)return;
    let panel=document.querySelector('#bt-profiles-panel');
    if (panel && !force) return;
    if (panel && panel.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) return;
    if (panel) capture();
    const opened=new Set([...document.querySelectorAll('.bt-profile[open]')].map(el=>el.dataset.profileId));
    if (!panel) {panel=document.createElement('section');panel.id='bt-profiles-panel';panel.className='panel';const lead=app.querySelector('.lead');if(lead)lead.after(panel);else app.append(panel);}
    panel.innerHTML=panelHTML();
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
  document.addEventListener('input',event=>{if(event.target.id==='bt-api-url')bitUrlDraft=event.target.value;});
  document.addEventListener('submit',async event=>{
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
      if(action==='discover'){const result=await api('discover');discovered=result.profiles||[];panel(true);}
      else if(action==='refresh')await refresh(true);
      else if(action==='manage'){if(!confirm('确认纳管此比特环境？此操作不会修改指纹配置或打开窗口。'))return;await api('profiles',{id});await refresh(true);}
      else if(action==='open'){await api('open',{profileId:id});await refresh(true);}
      else if(action==='update-profile'){await api('update',{profileIds:[id]});await refresh(true);}
      else if(action==='update-account'){await api('update',{accountIds:[id]});await refresh(true);}
      else if(action==='update-all'){await api('update',{profileIds:state.profiles.map(p=>p.id)});await refresh(true);}
      else if(action==='resume'){if(!confirm('确认已在比特环境完成平台验证并核对登录账号？恢复后仍需手动更新。'))return;await api('resume',{accountId:id,confirmed:true});await refresh(true);}
    }catch(e){error=e.message;const el=document.querySelector('#bt-error');if(el)el.textContent=error;}finally{b.disabled=false;}
  });
  mount();refresh(true);setInterval(()=>{if(!document.hidden)refresh(true);},8000);
})();
