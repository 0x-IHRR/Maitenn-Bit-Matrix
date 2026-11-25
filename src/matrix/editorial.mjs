// Persona cards and content items. Status changes are manual records only.
// This module never opens a browser, never calls BitBrowser, and never posts.

export const ITEM_STATUSES = ['draft', 'pending', 'approved', 'published'];
export const ITEM_LABELS = { draft: '草稿', pending: '待批准', approved: '已批准', published: '已发布' };
const TRANSITIONS = {
  submit: { draft: 'pending' },
  approve: { pending: 'approved' },
  mark: { approved: 'published' },
  return: { pending: 'draft', approved: 'draft', published: 'draft' },
};

const text = (value, max, label) => {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${label}须为文本`);
  return value.trim().slice(0, max);
};

export function shanghaiDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

export function calendarWindow(now = new Date()) {
  const today = shanghaiDate(now);
  const [year, month, day] = today.split('-').map(Number);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(now);
  const offset = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday];
  const start = Date.UTC(year, month - 1, day - offset - 7);
  const days = Array.from({ length: 28 }, (_, index) => {
    const key = new Date(start + index * 864e5).toISOString().slice(0, 10);
    return { key, past: key < today, today: key === today };
  });
  return { today, days };
}

export function buildCalendar({ now = new Date(), posts = [], items = [] } = {}) {
  const window = calendarWindow(now);
  const cells = new Map(window.days.map(day => [day.key, { ...day, posts: [], items: [] }]));
  const unscheduledPosts = [];
  const unscheduledItems = [];
  const outsideItems = [];
  for (const post of posts) {
    const key = post.createdAt ? shanghaiDate(post.createdAt) : null;
    if (!post.createdAt || !key) unscheduledPosts.push(post);
    else if (cells.has(key)) cells.get(key).posts.push(post);
  }
  for (const item of items) {
    if (!item.planDate) unscheduledItems.push(item);
    else if (cells.has(item.planDate)) cells.get(item.planDate).items.push(item);
    else outsideItems.push(item);
  }
  return { today: window.today, days: window.days.map(day => cells.get(day.key)), unscheduledPosts, unscheduledItems, outsideItems };
}

export function canonicalStatusUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('帖子链接须为 x.com 或 twitter.com 的状态链接'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) {
    throw new Error('帖子链接须为 x.com 或 twitter.com 的状态链接');
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})\/?$/);
  if (!match || url.username || url.password) throw new Error('帖子链接须为 x.com 或 twitter.com 的状态链接');
  return `https://x.com/${match[1].toLowerCase()}/status/${match[2]}`;
}

export function statusIdFromUrl(value) {
  try { return canonicalStatusUrl(value).match(/\/status\/(\d+)$/)[1]; }
  catch { return null; }
}

export function applyTransition(from, action) {
  const to = TRANSITIONS[action]?.[from];
  if (!to) throw new Error(`不能从「${ITEM_LABELS[from] || from}」这样变更`);
  return to;
}

function columnOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('栏目格式不对');
  const name = text(value.name ?? value.title, 40, '栏目名');
  if (!name) throw new Error('栏目需要名称');
  const examples = value.examples ?? value.example;
  const exampleText = Array.isArray(examples) ? examples.map(item => text(String(item), 120, '栏目例子')).filter(Boolean).join('；') : examples;
  return {
    name,
    purpose: text(value.purpose ?? value.goal, 200, '栏目目的'),
    frequency: text(value.frequency ?? value.cadence ?? value.rhythm, 40, '栏目频率'),
    examples: text(exampleText, 500, '栏目例子'),
  };
}

export function normalizePersona(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('人设格式不对');
  const name = text(raw.name ?? raw.displayName, 40, '显示名');
  if (!name) throw new Error('人设需要显示名');
  const columns = raw.columns ?? raw.sections ?? [];
  if (!Array.isArray(columns)) throw new Error('栏目须为数组');
  if (columns.length > 30) throw new Error('栏目过多');
  return {
    name,
    positioning: text(raw.positioning ?? raw.tagline ?? raw.oneLiner, 160, '一句话定位'),
    tone: text(raw.tone ?? raw.voice, 160, '语气'),
    taboos: text(raw.taboos ?? raw.avoid, 300, '禁忌'),
    audience: text(raw.audience ?? raw.reader, 160, '目标读者'),
    columns: columns.map(columnOf),
    identity: raw.identity == null || raw.identity === '' ? '' : text(String(raw.identity), 20, '账号'),
  };
}

export function parsePersonaDocument(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error('人设 JSON 是空的');
    try { data = JSON.parse(trimmed); }
    catch { throw new Error('人设 JSON 无法解析'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('人设文件须为对象');
  const list = data.personas ?? data.cards ?? data.persona ?? (data.name || data.displayName ? [data] : null);
  const cards = Array.isArray(list) ? list : list ? [list] : null;
  if (!cards?.length) throw new Error('人设文件里没有可导入的卡片');
  if (cards.length > 50) throw new Error('一次最多导入 50 张人设卡');
  return cards.map(normalizePersona);
}

export function normalizeItemDraft(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('内容条目格式不对');
  const title = text(raw.title, 120, '标题');
  if (!title) throw new Error('请填写标题');
  const planDate = raw.planDate == null || raw.planDate === '' ? null : String(raw.planDate);
  if (planDate && !/^\d{4}-\d{2}-\d{2}$/.test(planDate)) throw new Error('计划日期格式应为 YYYY-MM-DD');
  return {
    title,
    personaId: raw.personaId || null,
    accountId: raw.accountId || null,
    columnName: text(raw.columnName, 40, '栏目'),
    planDate,
    note: text(raw.note, 2000, '备注'),
  };
}

export function matchItem(item, accounts) {
  const id = item.postUrl ? statusIdFromUrl(item.postUrl) : null;
  if (!id) return null;
  for (const account of accounts) {
    const post = (account.posts || []).find(candidate => {
      const key = candidate.sourceKey || candidate.source_key || '';
      return key === `x:status:${id}` || statusIdFromUrl(candidate.url || '') === id;
    });
    if (!post) continue;
    const views = post.metrics && Number.isFinite(post.metrics.views) ? post.metrics.views : null;
    return { postId: post.id, accountId: account.id, identity: account.identity, title: post.title || '', views };
  }
  return null;
}
