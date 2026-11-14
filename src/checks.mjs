// 发布前查重、填写后回读、自动提交。每个函数都失败即停，不硬来。
import { evaluate, withTab, sleep } from './driver.mjs';
import { SITE } from './site.mjs';

const firstLine = (t) => t.split('\n')[0].trim();

// X：定时列表和个人主页里有没有这条
export async function xExisting(text) {
  const first = firstLine(text);
  const scheduled = await withTab('https://x.com/compose/post/unsent/scheduled', async (id) => {
    let t = '';
    for (let i = 0; i < 10 && !t; i++) { await sleep(3000); t = await evaluate(id, `(document.querySelector('[role=dialog]')||{innerText:''}).innerText`); }
    return { has: t.includes(first), when: (t.match(/Will send on[^\n]*/) || [''])[0] };
  }, { wait: 2000 });
  if (scheduled.has) return { state: 'scheduled', detail: scheduled.when };
  const posted = await withTab('https://x.com/home', async (id) => {
    const me = await evaluate(id, `(document.querySelector('a[data-testid=AppTabBar_Profile_Link]')||{}).href||''`);
    if (!me) return null;
    await evaluate(id, `(location.href=${JSON.stringify(me)},1)`); await sleep(8000);
    return evaluate(id, `(()=>{const a=[...document.querySelectorAll('article')].find(a=>((a.querySelector('[data-testid=tweetText]')||{}).innerText||'').trim().startsWith(${JSON.stringify(first)}));if(!a)return null;const t=a.querySelector('time');return t&&t.parentElement.href})()`);
  });
  return posted ? { state: 'published', detail: posted, url: posted } : null;
}

// X：视频处理完后核对文案和定时，点一次 Schedule，再去定时列表确认
export async function xSubmit(tabId, text, scheduleIso) {
  const BOX = `document.querySelector('[data-testid=tweetTextarea_0]')`, BTN = `document.querySelector('[data-testid=tweetButton]')`;
  for (let i = 0; i < 180; i++) {   // 最多等 30 分钟（视频处理）
    const s = await evaluate(tabId, `(()=>{const b=${BTN};return {box:!!${BOX},dlg:/compose\\/post/.test(location.href),ok:!!b&&b.getAttribute('aria-disabled')!=='true'&&!b.disabled}})()`).catch(() => null);
    if (s && (!s.box || !s.dlg)) return { ok: false, reason: 'X 发帖框不见了（页面被关或跳走），要重建' };
    if (s && s.ok) break;
    if (i === 179) return { ok: false, reason: 'X 视频处理超过 30 分钟，按钮一直不可点' };
    await sleep(10000);
  }
  const got = await evaluate(tabId, `${BOX}.innerText`);
  if (got.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) return { ok: false, reason: 'X 发帖框里的文案和 publish.json 不一致' };
  if (scheduleIso) {
    const d = new Date(scheduleIso), tz = { timeZone: 'Asia/Shanghai' };
    const day = new Intl.DateTimeFormat('en-US', { ...tz, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
    const hm = new Intl.DateTimeFormat('en-US', { ...tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
    const sched = await evaluate(tabId, `(document.body.innerText.match(/Will send on[^\\n]*/)||[''])[0]`);
    if (!sched.includes(day) || !sched.includes(hm)) return { ok: false, reason: `X 定时不对：页面是「${sched || '没设'}」，应该是 ${day} ${hm}` };
    const label = await evaluate(tabId, `${BTN}.innerText.trim()`);
    if (label !== 'Schedule') return { ok: false, reason: `X 按钮是「${label}」不是 Schedule，没点` };
  }
  await evaluate(tabId, `${BTN}.click()`);
  await sleep(6000);
  const after = await xExisting(text);
  if (after) return { ok: true, ...after };
  return { ok: false, reason: 'X 点了提交，但定时列表和主页里都没找到这条，请人工看一眼（不要再点第二次）' };
}

// YouTube：Studio 列表里同标题的行
export async function ytRows(title) {
  return withTab('https://studio.youtube.com/', async (id) => {
    const url = await evaluate(id, `location.href`);
    const m = url.match(/channel\/([^/?]+)/); if (!m) return null;
    await evaluate(id, `(location.href='https://studio.youtube.com/channel/${m[1]}/videos/upload',1)`);
    // Studio 列表加载很慢：等到出现行（最多 60 秒），否则会误读成 0 条（2026-11-12 第 37 期）
    for (let i = 0; i < 12; i++) { await sleep(5000); if (await evaluate(id, `document.querySelectorAll('ytcp-video-row').length`).catch(() => 0)) break; }
    // 只取状态和日期，不要简介
    return evaluate(id, `[...document.querySelectorAll('ytcp-video-row')].filter(r=>r.innerText.includes(${JSON.stringify(title)})).map(r=>{const t=r.innerText.replace(/\\s+/g,' ');const st=(t.match(/已安排|定时|首播|公开|不公开|私享|草稿|待处理/g)||[]).join('/');const d=(t.match(/\\d{4}年\\d+月\\d+日/)||[''])[0];const a=r.querySelector('a[href*="/video/"]');return (st||'状态未知')+(d?' '+d:'')+(a?' https://youtu.be/'+a.href.split('/video/')[1].split('/')[0]:'')})`);
  }, { wait: 9000 });
}

// YouTube：上传对话框还开着、定时回读一致时，点一次「预定」
export async function ytSubmit(tabId, title, scheduleIso) {
  const D = `document.querySelector('ytcp-uploads-dialog')`;
  if (!await evaluate(tabId, `!!${D}`).catch(() => false)) {
    // 第 4 期（2026-11-13）：对话框关了但定时已经保存成「已排定时间」，先看 Studio 列表再下结论
    const rows = await ytRows(title).catch(() => null);
    if (rows && rows.length === 1 && /已安排|定时|首播/.test(rows[0]) && !/草稿|待处理/.test(rows[0])) return { ok: true, state: 'scheduled', detail: `${rows[0].replace(/ https:\S+/, '')}（上传对话框已关，Studio 列表核对）`, url: (rows[0].match(/https:\S+/) || [])[0] };
    return { ok: false, reason: `YouTube 上传对话框已经关了，Studio 里是「${rows ? rows.join(' / ') : '没读到'}」；是草稿的话要点「编辑草稿」重新设定时` };
  }
  if (scheduleIso) {
    const d = new Date(Date.parse(scheduleIso) + 8 * 3600e3), p = (n) => String(n).padStart(2, '0');
    const want = `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    const got = await evaluate(tabId, `(()=>{const a=document.querySelector('#datepicker-trigger');const i=document.querySelector('ytcp-visibility-scheduler input, ytcp-datetime-picker input');return (a?a.innerText.trim():'')+' '+(i?i.value:'')})()`);
    if (got !== want) return { ok: false, reason: `YouTube 定时不对：页面是「${got.trim() || '没设'}」，应该是 ${want}` };
  }
  const btn = await evaluate(tabId, `(()=>{const b=${D}.querySelector('#done-button');return b?b.innerText.trim()+'|'+(b.hasAttribute('disabled')||b.getAttribute('aria-disabled')==='true'):''})()`);
  const want = scheduleIso ? '预定' : '发布';
  if (btn !== `${want}|false`) return { ok: false, reason: `YouTube 提交按钮状态是「${btn}」，不是可点的「${want}」，没点` };
  await evaluate(tabId, `${D}.querySelector('#done-button').click()`);
  await sleep(8000);
  const text = await evaluate(tabId, `document.body.innerText`).catch(() => '');
  const link = (text.match(/https:\/\/youtu\.be\/[\w-]+/) || [''])[0];
  const rows = await ytRows(title).catch(() => null);
  if (rows && rows.length === 1 && /已安排|定时|公开|首播/.test(rows[0])) return { ok: true, state: scheduleIso ? 'scheduled' : 'published', detail: rows[0], url: link || undefined };
  return { ok: false, reason: `YouTube 点了「${want}」，但 Studio 里的状态没确认上（${rows ? rows.length + ' 条：' + rows.join(' / ') : '列表没读到'}），请人工看一眼，不要重复提交` };
}

// 知识站：同标题课程数量和状态
export async function zszCourses(title) {
  if (!SITE) return [];
  return withTab(SITE.admin, (id) => evaluate(id, `fetch(${JSON.stringify(SITE.coursesApi)},{credentials:'include'}).then(r=>r.json()).then(d=>(d.courses||[]).filter(c=>c.title===${JSON.stringify(title)}).map(c=>({id:c._id,vis:c.visibilityStatus,seriesId:c.seriesId})))`));
}

// 抖音：真正识别成话题的个数
// 编辑器类名会变，整页找 data-mention 节点并去重（2026-11-12 第 37 期旧选择器读成 0/5，实际 5/5）
export const douyinTopics = (tabId) => evaluate(tabId, `[...new Set([...document.querySelectorAll('[data-mention]')].map(e=>e.innerText.trim()).filter(Boolean))]`);
