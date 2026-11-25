// 人设、内容日历、审批。只改本地记录，不打开撰写页，不调用比特开窗。
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LABELS = { draft: '草稿', pending: '待批准', approved: '已批准', published: '已发布' };
  const CHIPS = { draft: 'planned', pending: 'filled', approved: 'scheduled', published: 'published' };
  const CAL = { draft: 'plan', pending: 'todo', approved: 'sch', published: 'ok' };
  const readOnly = () => String(window.MaitianProfileScope?.scope || '').startsWith('history:');
  const sec = (title, note = '') => `<div class="sec"><h2>${esc(title)}</h2><span class="note">${note}</span></div>`;
  const field = (label, input) => `<div><label class="lab">${esc(label)}</label>${input}</div>`;
  const personaName = (O, id) => (O.personas || []).find(p => p.id === id)?.name || '';
  const accountLabel = account => account ? `@${account.identity}${account.displayName ? ' · ' + account.displayName : ''}` : '';
  const rosterOf = O => O.roster || [];
  const accountById = (O, id) => rosterOf(O).find(account => account.id === id);

  function accountOptions(O, selected) {
    return `<option value="">暂不绑定</option>${rosterOf(O).map(account => `<option value="${esc(account.id)}"${account.id === selected ? ' selected' : ''}>${esc(accountLabel(account))} · ${account.group === 'benchmark' ? '对标' : '自有'}${account.active === false ? ' · 历史' : ''}</option>`).join('')}`;
  }
  function personaOptions(O, selected) {
    return `<option value="">不指定人设</option>${(O.personas || []).map(persona => `<option value="${esc(persona.id)}"${persona.id === selected ? ' selected' : ''}>${esc(persona.name)}</option>`).join('')}`;
  }
  function columnFields(column = {}) {
    return `<div class="grid2" data-column>${field('栏目名', `<input class="inp" name="columnName" value="${esc(column.name || '')}" placeholder="栏目名">`)}${field('建议频率', `<input class="inp" name="columnFrequency" value="${esc(column.frequency || '')}" placeholder="例如每周 3 次">`)}${field('目的', `<input class="inp" name="columnPurpose" value="${esc(column.purpose || '')}">`)}${field('例子', `<input class="inp" name="columnExamples" value="${esc(column.examples || '')}">`)}</div>`;
  }
  function personaForm(O, persona) {
    const columns = persona?.columns?.length ? persona.columns : [{}];
    return `<form data-persona-form="${esc(persona?.id || '')}">${persona ? '' : '<div class="ph"><h3>新建人设</h3><span class="note">先不绑定也可以</span></div>'}
      <div class="grid2">${field('显示名', `<input class="inp" name="name" value="${esc(persona?.name || '')}" required>`)}${field('绑定账号', `<select class="inp" name="accountId">${accountOptions(O, persona?.accountId || '')}</select>`)}${field('一句话定位', `<input class="inp" name="positioning" value="${esc(persona?.positioning || '')}">`)}${field('语气', `<input class="inp" name="tone" value="${esc(persona?.tone || '')}">`)}${field('禁忌', `<input class="inp" name="taboos" value="${esc(persona?.taboos || '')}">`)}${field('目标读者', `<input class="inp" name="audience" value="${esc(persona?.audience || '')}">`)}</div>
      <div class="fine">栏目</div><div data-columns>${columns.map(columnFields).join('')}</div>
      <div class="btns"><button class="btn" type="button" data-ed="add-column">添加栏目</button><button class="btn pri" type="submit">${persona ? '保存人设' : '创建人设'}</button>${persona ? `<button class="btn" type="button" data-ed="delete-persona" data-id="${esc(persona.id)}">删除人设</button>` : ''}</div>
      ${persona ? `<div class="fine">来源 ${persona.source === 'import' ? '导入' : '手工'}${persona.sourceLabel ? ' · ' + esc(persona.sourceLabel) : ''}</div>` : ''}</form>`;
  }

  function personas(O) {
    const list = O.personas || [];
    const locked = readOnly() ? '<p class="fine">历史账号只读，人设不能在这里修改。</p>' : '';
    return `<div class="h1">人设</div><p class="lead">人设和栏目可以导入或手改，再绑到已经接入的账号。有多少个账号就列多少个，没有人设的账号可以先空着。</p>${locked}
      ${readOnly() ? '' : `<div class="sys-2col sys-itg"><div class="panel">${personaForm(O, null)}</div>
        <div class="panel"><div class="ph"><h3>导入 JSON</h3><span class="note">通用结构，可扩展字段</span></div>
          <form data-import-form><label class="lab">人设 JSON</label><textarea class="inp" name="document" rows="8" placeholder='{"personas":[{"name":"栏目号","positioning":"一句话","columns":[{"name":"早报","frequency":"每天"}]}]}'></textarea>
          <div class="grid2">${field('或选择文件', '<input class="inp" name="file" type="file" accept="application/json,.json">')}${field('或本机绝对路径', '<input class="inp" name="path" placeholder="macOS /Users/… 或 Windows C:\\…">')}</div>
          <div class="btns"><button class="btn pri" type="submit">导入人设</button></div>
          <div class="fine">坏的 JSON 会整份拒绝。文件里的账号名只有在已经接入时才会绑定，不会新建账号。</div></form></div></div>`}
      ${sec('已有人设', `${list.length} 张`)}
      <div class="sys-2col sys-itg">${list.map(persona => {
        const account = accountById(O, persona.accountId);
        return `<div class="panel"><div class="ph"><h3>${esc(persona.name)}</h3><span class="note">${account ? esc(accountLabel(account)) : '暂未绑定账号'}</span></div>
          <dl class="kv"><dt>定位</dt><dd>${esc(persona.positioning || '未写')}</dd><dt>语气</dt><dd>${esc(persona.tone || '未写')}</dd><dt>禁忌</dt><dd>${esc(persona.taboos || '未写')}</dd><dt>读者</dt><dd>${esc(persona.audience || '未写')}</dd></dl>
          ${persona.columns?.length ? `<div class="fine">栏目</div>${persona.columns.map(column => `<div class="prow"><span><b>${esc(column.name)}</b>${column.frequency ? ' · ' + esc(column.frequency) : ''}</span><span class="d">${esc(column.purpose || column.examples || '')}</span></div>`).join('')}` : '<div class="fine">还没有栏目</div>'}
          ${readOnly() ? '' : `<details><summary><b>编辑</b><span>字段、栏目和绑定</span></summary>${personaForm(O, persona)}</details>`}</div>`;
      }).join('') || '<div class="panel"><div class="site-off">还没有人设。</div></div>'}</div>`;
  }

  function itemLine(item, O) {
    const persona = personaName(O, item.personaId);
    const account = accountById(O, item.accountId);
    const who = [persona, account ? accountLabel(account) : ''].filter(Boolean).join(' · ') || '未指定账号';
    return { who, persona, account };
  }
  function calendar(O) {
    const data = O.calendar || { days: [], unscheduledPosts: [], unscheduledItems: [] };
    const head = '一二三四五六日'.split('').map(day => `<div>周${day}</div>`).join('');
    const cells = (data.days || []).map(day => {
      const date = day.key.slice(5).replace('-', '/');
      const posts = (day.posts || []).map(post => `<a class="cal-e seen" href="#/ep/${encodeURIComponent(post.id)}"><div><b>${esc(post.personaName || (post.identity ? '@' + post.identity : '已采集'))}</b><span><i></i>${esc(post.title || '帖子')}</span></div></a>`).join('');
      const items = (day.items || []).map(item => {
        const line = itemLine(item, O);
        return `<a class="cal-e ${CAL[item.status] || 'plan'}" href="#/approval"><div><b>${esc(line.who)}</b><span><i></i>${LABELS[item.status] || ''} · ${esc(item.title)}</span></div></a>`;
      }).join('');
      return `<div class="cal-d${day.today ? ' today' : ''}${day.past ? ' past' : ''}"><div class="cal-n">${date}${day.today ? '<span>今天</span>' : ''}</div>${posts}${items}</div>`;
    }).join('');
    const outside = (data.outsideItems || []).map(item => `<div class="prow"><span>${esc(itemLine(item, O).who)} · ${esc(item.title)}</span><span class="d">${esc(item.planDate || '')} · 不在这 28 天里</span></div>`).join('');
    const loosePosts = (data.unscheduledPosts || []).map(post => `<div class="prow"><span>${esc(post.personaName || (post.identity ? '@' + post.identity : '已采集'))} · ${esc(post.title || '帖子')}</span><a href="#/ep/${encodeURIComponent(post.id)}">打开档案</a></div>`).join('');
    const looseItems = (data.unscheduledItems || []).map(item => `<div class="prow"><span>${esc(itemLine(item, O).who)} · ${esc(item.title)}</span><span class="st-chip ${CHIPS[item.status] || 'planned'}"><i>○</i>${LABELS[item.status] || ''}</span></div>`).join('');
    return `<div class="h1">日历</div><p class="lead">上周到未来两周。已采集的帖子按创建时间落格，只链到档案。计划按状态着色，格子里是账号或人设。没有创建时间或计划日的放在未排期。</p>
      <div class="panel cal"><div class="cal-h">${head}</div><div class="cal-g">${cells}</div></div>
      <div class="cal-lg"><span><i class="seen"></i>已采集</span><span><i class="plan"></i>草稿</span><span><i class="todo"></i>待批准</span><span><i class="sch"></i>已批准</span><span><i class="ok"></i>已记下已发布</span></div>
      ${sec('未排期', '没有创建时间的帖子，或没有计划日的条目')}
      <div class="panel">${loosePosts || looseItems || outside ? loosePosts + looseItems + outside : '<div class="site-off">没有未排期的内容。</div>'}</div>`;
  }

  function approval(O) {
    const items = O.contentItems || [];
    const locked = readOnly();
    const groups = [['pending', '待批准', true], ['draft', '草稿', false], ['approved', '已批准', false], ['published', '已记下已发布', false]];
    const card = item => {
      const line = itemLine(item, O);
      const matched = item.matched ? `<div class="fine">已对上采集记录${item.matched.views == null ? '，播放尚未获取' : `，播放 ${Number(item.matched.views).toLocaleString('zh-CN')}`} · <a href="#/ep/${encodeURIComponent(item.matched.postId)}">打开档案</a></div>` : (item.postUrl ? '<div class="fine">链接已记下，采集记录里还没有这条帖。</div>' : '');
      let controls = '';
      if (!locked && item.status === 'draft') controls = `<div class="btns"><button class="btn pri" type="button" data-ed="transition" data-id="${esc(item.id)}" data-action="submit">提交审批</button><button class="btn" type="button" data-ed="delete-item" data-id="${esc(item.id)}">删除草稿</button></div>`;
      if (!locked && item.status === 'pending') controls = `<div class="btns"><button class="btn pri" type="button" data-ed="transition" data-id="${esc(item.id)}" data-action="approve">标记已批准</button></div>${field('退回原因', `<input class="inp" data-reason="${esc(item.id)}" placeholder="退回时必填">`)}<div class="btns"><button class="btn" type="button" data-ed="transition" data-id="${esc(item.id)}" data-action="return">退回草稿</button></div>`;
      if (!locked && item.status === 'approved') controls = `${field('帖子链接（可选）', `<input class="inp" data-url="${esc(item.id)}" placeholder="https://x.com/用户名/status/数字">`)}<div class="btns"><button class="btn pri" type="button" data-ed="transition" data-id="${esc(item.id)}" data-action="mark">记为已发布</button></div>${field('退回原因', `<input class="inp" data-reason="${esc(item.id)}" placeholder="退回时必填">`)}<div class="btns"><button class="btn" type="button" data-ed="transition" data-id="${esc(item.id)}" data-action="return">退回草稿</button></div>`;
      if (!locked && item.status === 'published') controls = `${item.postUrl ? `<div class="fine"><a href="${esc(item.postUrl)}" target="_blank" rel="noopener">${esc(item.postUrl)}</a></div>` : ''}${field('退回原因', `<input class="inp" data-reason="${esc(item.id)}" placeholder="退回时必填">`)}<div class="btns"><button class="btn" type="button" data-ed="transition" data-id="${esc(item.id)}" data-action="return">退回草稿</button></div>`;
      return `<div class="prow" style="align-items:flex-start"><span><b>${esc(item.title)}</b><span class="d">${esc(line.who)}${item.columnName ? ' · ' + esc(item.columnName) : ''}${item.planDate ? ' · ' + esc(item.planDate) : ' · 未排期'}</span>${item.returnReason && item.status === 'draft' ? `<span class="d">退回：${esc(item.returnReason)}</span>` : ''}${matched}</span><span class="st-chip ${CHIPS[item.status] || 'planned'}"><i>○</i>${LABELS[item.status] || ''}</span></div>${controls}`;
    };
    const form = locked ? '' : `<div class="panel"><div class="ph"><h3>新的草稿</h3><span class="note">保存后仍是草稿</span></div><form data-item-form><div class="grid2">${field('标题', '<input class="inp" name="title" required>')}${field('人设', `<select class="inp" name="personaId">${personaOptions(O, '')}</select>`)}${field('账号', `<select class="inp" name="accountId">${accountOptions(O, '')}</select>`)}${field('栏目', '<input class="inp" name="columnName" placeholder="可从人设栏目里选一个名字">')}${field('计划日', '<input class="inp" name="planDate" type="date">')}${field('备注', '<input class="inp" name="note">')}</div><div class="btns"><button class="btn pri" type="submit">保存草稿</button></div><div class="fine">不指定账号时，会沿用人设已经绑定的账号。批准和记为已发布都只改这条记录，不会打开窗口或发帖。</div></form></div>`;
    return `<div class="h1">审批</div><p class="lead">草稿提交后待批准，再由人标记已批准、记为已发布。可以退回并写原因。这里没有自动发出、定时或打开撰写页。</p>
      ${locked ? '<p class="fine">历史账号只读。</p>' : ''}
      ${form}
      ${sec('条目', `${items.length} 条`)}
      <div class="panel">${groups.map(([status, label, open]) => {
        const rows = items.filter(item => item.status === status);
        if (!rows.length) return '';
        return `<details ${open ? 'open' : ''}><summary><b>${label}</b><span>${rows.length} 条</span></summary>${rows.map(card).join('')}</details>`;
      }).join('') || '<div class="site-off">还没有内容条目。</div>'}</div>`;
  }

  async function post(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '没成功');
    return data;
  }
  function columnsFrom(form) {
    return [...form.querySelectorAll('[data-column]')].map(row => ({
      name: row.querySelector('[name=columnName]')?.value || '',
      purpose: row.querySelector('[name=columnPurpose]')?.value || '',
      frequency: row.querySelector('[name=columnFrequency]')?.value || '',
      examples: row.querySelector('[name=columnExamples]')?.value || '',
    })).filter(column => column.name || column.purpose || column.frequency || column.examples);
  }
  function reload() { document.dispatchEvent(new Event('editorial:reload')); }
  function note(message) { if (typeof window.toast === 'function') window.note(message); else window.alert(message); }

  document.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-ed]');
    if (!button) return;
    if (button.dataset.ed === 'add-column') {
      event.preventDefault();
      button.closest('form')?.querySelector('[data-columns]')?.insertAdjacentHTML('beforeend', columnFields());
      return;
    }
    if (readOnly()) { note('历史账号只读'); return; }
    button.disabled = true;
    try {
      if (button.dataset.ed === 'delete-persona') {
        if (!confirm('删除这张人设？已关联的草稿会保留，只是不再指向它。')) return;
        await post('/api/bt/personas', { action: 'delete', id: button.dataset.id });
      } else if (button.dataset.ed === 'delete-item') {
        await post('/api/bt/items', { action: 'delete', id: button.dataset.id });
      } else if (button.dataset.ed === 'transition') {
        const id = button.dataset.id;
        const reason = document.querySelector(`[data-reason="${CSS.escape(id)}"]`)?.value || '';
        const postUrl = document.querySelector(`[data-url="${CSS.escape(id)}"]`)?.value || '';
        await post('/api/bt/items/transition', { id, action: button.dataset.action, reason, postUrl });
      }
      reload();
    } catch (error) { note(error.message); }
    finally { button.disabled = false; }
  });
  document.addEventListener('change', async event => {
    const input = event.target;
    if (input?.name !== 'file' || !input.closest('[data-import-form]')) return;
    const file = input.files?.[0];
    if (!file) return;
    input.closest('form').querySelector('[name=document]').value = await file.text();
  });
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (form.matches?.('[data-persona-form]')) {
      event.preventDefault();
      if (readOnly()) return;
      const columns = columnsFrom(form);
      if (columns.some(column => !column.name)) { note('栏目需要名称'); return; }
      const value = name => form.querySelector(`[name="${name}"]`)?.value ?? '';
      const body = { id: form.dataset.personaForm || undefined, name: value('name'), positioning: value('positioning'), tone: value('tone'), taboos: value('taboos'), audience: value('audience'), accountId: value('accountId') || null, columns };
      try { await post('/api/bt/personas', body); reload(); }
      catch (error) { note(error.message); }
    } else if (form.matches?.('[data-import-form]')) {
      event.preventDefault();
      if (readOnly()) return;
      const raw = (form.querySelector('[name=document]')?.value || '').trim();
      const path = (form.querySelector('[name=path]')?.value || '').trim();
      try {
        if (raw) {
          let document;
          try { document = JSON.parse(raw); }
          catch { throw new Error('人设 JSON 无法解析'); }
          await post('/api/bt/personas/import', { document });
        } else if (path) await post('/api/bt/personas/import', { path });
        else throw new Error('没有人设内容');
        reload();
      } catch (error) { note(error.message); }
    } else if (form.matches?.('[data-item-form]')) {
      event.preventDefault();
      if (readOnly()) return;
      const value = name => form.querySelector(`[name="${name}"]`)?.value ?? '';
      const body = { title: value('title'), personaId: value('personaId') || null, accountId: value('accountId') || null, columnName: value('columnName'), planDate: value('planDate') || null, note: value('note') };
      try { await post('/api/bt/items', body); reload(); }
      catch (error) { note(error.message); }
    }
  });

  function num(value, suffix = '') {
    if (value == null) return '<span style="color:var(--t3)">未获取</span>';
    return `${esc(Number(value).toLocaleString('zh-CN'))}${suffix}`;
  }
  function delta(value) {
    if (value == null) return num(null);
    return esc((value > 0 ? '+' : '') + Number(value).toLocaleString('zh-CN'));
  }
  function stamp(value) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time)) return '<span style="color:var(--t3)">未获取</span>';
    const date = new Date(time);
    return esc(`${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
  }
  function matrix(O) {
    const rows = O.matrix || [];
    if (!rows.length) return `<div class="h1">矩阵</div><p class="lead">已接入的自有号和对标号放在一张表里。这一页只读已有快照，不发起采集，也不打开窗口。</p><div class="panel"><div class="site-off">还没有接入账号。到系统页检测已打开的账号，或添加对标号。</div></div>`;
    const body = rows.map(row => `<tr data-matrix-scope="${esc(row.scope)}" tabindex="0"><td><b>@${esc(row.identity)}</b>${row.displayName ? `<div class="fine">${esc(row.displayName)}</div>` : ''}</td><td>${row.personaName ? esc(row.personaName) : '<span style="color:var(--t3)">未绑定</span>'}</td><td><span class="st-chip idle"><i>○</i>${row.group === 'benchmark' ? '对标' : '自有'}</span></td><td class="n">${num(row.followers)}</td><td class="n">${delta(row.growth7)}</td><td class="n">${num(row.impressions)}</td><td class="n">${num(row.engagementRate, row.engagementRate == null ? '' : '%')}</td><td class="n">${num(row.profileVisits)}</td><td class="n">${num(row.linkClicks)}</td><td>${stamp(row.lastSuccess)}</td><td>${row.gap ? esc(row.gap) : '<span style="color:var(--t3)">–</span>'}</td></tr>`).join('');
    return `<div class="h1">矩阵</div><p class="lead">已接入多少个号就列多少个。点一行进入这个号现有的单号范围。空着的指标是未获取，不会用 0 填上。Analytics 没有权限时，粉丝数仍保留。</p>
      ${sec('账号对照', `${rows.length} 个号 · 只读已有快照`)}
      <div class="panel"><div class="tw"><table><thead><tr><th>账号</th><th>人设</th><th>分组</th><th class="n">粉丝</th><th class="n">近 7 天</th><th class="n">曝光</th><th class="n">互动率</th><th class="n">主页访问</th><th class="n">链接点击</th><th>最近成功</th><th>缺口</th></tr></thead><tbody>${body}</tbody></table></div><div class="fine">这一页不发起采集，也不打开比特窗口。</div></div>
      ${sec('粉丝走势', '各号已有快照，至少两次才画线')}
      <div class="panel"><div class="chartbox" id="c-matrix"></div></div>`;
  }
  function drawMatrix(O) {
    const el = document.querySelector('#c-matrix');
    if (!el) return;
    const colors = ['#0071e3', '#1f9d4c', '#0a66d1', '#c76a00', '#d70015', '#00a1d6', '#ff2442'];
    const series = (O.matrix || []).map(row => ({
      name: row.personaName || `@${row.identity}`,
      pts: (row.series || []).map(point => [Date.parse(point.at), point.followers]).filter(point => Number.isFinite(point[0]) && point[1] != null),
    })).filter(row => row.pts.length >= 2);
    const width = el.clientWidth, height = el.clientHeight || 260;
    const points = series.flatMap(row => row.pts);
    const span = points.length ? Math.max(...points.map(point => point[0])) - Math.min(...points.map(point => point[0])) : 0;
    if (!series.length || width < 60 || span < 3600e3) {
      el.innerHTML = '<div class="empty">采样还不够。一个号至少有两次粉丝记录，并且隔了几小时，这里才会画出对比。</div>';
      return;
    }
    const left = 52, right = 88, top = 14, bottom = 22;
    const x0 = Math.min(...points.map(point => point[0])), x1 = Math.max(...points.map(point => point[0]));
    const peak = Math.max(...points.map(point => point[1]), 1);
    const step = Math.pow(10, Math.floor(Math.log10(peak)));
    const unit = peak / step;
    const scale = (unit <= 1 ? 1 : unit <= 1.5 ? 1.5 : unit <= 2 ? 2 : unit <= 3 ? 3 : unit <= 4 ? 4 : unit <= 5 ? 5 : unit <= 7.5 ? 7.5 : 10) * step;
    const X = time => left + (time - x0) / (x1 - x0) * (width - left - right);
    const Y = value => top + (height - top - bottom) - value / scale * (height - top - bottom);
    let svg = `<svg width="${width}" height="${height}">`;
    for (const tick of [0, scale / 2, scale]) svg += `<line x1="${left}" x2="${width - right}" y1="${Y(tick)}" y2="${Y(tick)}" stroke="rgba(0,0,0,.07)"/><text x="${left - 6}" y="${Y(tick) + 4}" text-anchor="end">${tick >= 10000 ? tick / 10000 + '万' : Math.round(tick)}</text>`;
    series.forEach((row, index) => {
      const color = colors[index % colors.length];
      const last = row.pts[row.pts.length - 1];
      svg += `<polyline points="${row.pts.map(point => `${X(point[0]).toFixed(1)},${Y(point[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="2"/><text x="${(X(last[0]) + 8).toFixed(1)}" y="${(Y(last[1]) + 4).toFixed(1)}" style="fill:var(--t2)">${esc(row.name)}</text>`;
    });
    el.innerHTML = svg + '</svg>';
  }
  document.addEventListener('click', event => {
    const row = event.target.closest?.('[data-matrix-scope]');
    if (!row) return;
    document.cookie = `bt_profile=${encodeURIComponent(row.dataset.matrixScope)}; Path=/; SameSite=Strict; Max-Age=31536000`;
    location.href = '/';
  });

  window.Editorial = { personas, calendar, approval, matrix, drawMatrix };
})();
