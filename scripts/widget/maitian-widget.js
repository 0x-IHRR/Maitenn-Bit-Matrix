// 麦田 · iPhone 小组件（Scriptable）
// 用法：App Store 装 Scriptable → 新建脚本 → 粘贴本文件 → 桌面 / 锁屏添加 Scriptable 小组件，脚本选它。
// 支持：桌面小号 / 中号 / 大号，锁屏长条 / 圆形 / 单行。点小组件打开麦田。
// 麦田地址和小组件口令（config.web.widgetToken）：从麦田的 /widget 页面复制的版本已经填好。
// 头像取 config.web.avatar，署名取 config.web.owner；封面是最新一期的。
const MAITIAN = '__MAITIAN_URL__';
const TOKEN = '__WIDGET_TOKEN__';

const C = {
  bg1: Color.dynamic(new Color('#f7f0e1'), new Color('#24211b')),
  bg2: Color.dynamic(new Color('#e2eadb'), new Color('#1b211c')),
  card: Color.dynamic(new Color('#ffffff', 0.72), new Color('#ffffff', 0.08)),
  ink: Color.dynamic(new Color('#1c1a16'), new Color('#f2eee6')),
  dim: Color.dynamic(new Color('#7a7160'), new Color('#a39b8b')),
  up: Color.dynamic(new Color('#2e8b3d'), new Color('#7ee0a0')),
  down: Color.dynamic(new Color('#c0392b'), new Color('#ff8a80')),
  gold: Color.dynamic(new Color('#c98b0b'), new Color('#F2B21B')),
  white: Color.white(), white70: new Color('#ffffff', 0.78), upW: new Color('#b6f5c5'),
};
const fmt = n => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const sign = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n || 0));
const money = n => '¥' + fmt(Math.round(n || 0));
const short = n => (n >= 1e4 ? (n / 1e4).toFixed(n >= 1e5 ? 0 : 1) + '万' : fmt(n));
const fam = config.widgetFamily || 'medium';
const LOCK = fam.startsWith('accessory');

// ───── 取数据和图片（失败时用上一次的缓存） ─────
const fm = FileManager.local(), dir = fm.cacheDirectory(), cache = n => fm.joinPath(dir, `maitian-${n}`);
const api = (p) => `${MAITIAN}${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(TOKEN)}`;
let data = null, stale = false;
try {
  const r = new Request(api('/api/widget')); r.timeoutInterval = 15;
  data = await r.loadJSON();
  if (!data || !data.fans) throw new Error(data && data.error || '没有数据');
  fm.writeString(cache('data.json'), JSON.stringify(data));
} catch (e) {
  stale = true;
  try { data = JSON.parse(fm.readString(cache('data.json'))); } catch { data = null; }
}
async function img(k, w = 400) {
  const f = cache(`${k}.jpg`);
  if (!stale) { try { const r = new Request(api(`/api/widget/img?k=${k}&w=${w}`)); r.timeoutInterval = 15; const i = await r.loadImage(); fm.writeImage(f, i); return i; } catch {} }
  try { return fm.fileExists(f) ? fm.readImage(f) : null; } catch { return null; }
}

// ───── 麦苗（像素画），没有头像时用它 ─────
function maimiao(px = 6) {
  const P = { B: '#F2B21B', D: '#C98B0B', L: '#5DBB46', S: '#3E8E2F', K: '#2A2622' };
  const rows = ['....L..LL...', '..LLL.LLLL..', '.LLL..L.LL..', '.....SS.....', '...BBBBBB...', '..BBBBBBBB..', '.BBKBBBBKBB.', '.BBKBBBBKBB.', '.BBBBBBBBBB.', '.BBBBBBBBBB.', '..DDDDDDDD..', '...D....D...', '...D....D...'];
  const ctx = new DrawContext(); ctx.size = new Size(12 * px, 13 * px); ctx.opaque = false; ctx.respectScreenScale = true;
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (P[c]) { ctx.setFillColor(new Color(P[c])); ctx.fillRect(new Rect(x * px, y * px, px, px)); } }));
  return ctx.getImage();
}

// ───── 小工具 ─────
function text(st, s, size, color = C.ink, weight = 'bold') {
  const t = st.addText(String(s));
  t.font = weight === 'bold' ? Font.boldRoundedSystemFont(size) : weight === 'heavy' ? Font.heavyRoundedSystemFont(size) : Font.mediumRoundedSystemFont(size);
  t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.6;
  return t;
}
const deltaColor = (n, onDark) => (n > 0 ? (onDark ? C.upW : C.up) : n < 0 ? C.down : onDark ? C.white70 : C.dim);
function avatarImg(st, size, ring) {
  const a = st.addImage(AVATAR || maimiao(6)); a.imageSize = new Size(size, size);
  if (AVATAR) { a.cornerRadius = size / 2; if (ring) { a.borderWidth = 2; a.borderColor = ring; } }
  return a;
}
function header(w, onDark) {
  const h = w.addStack(); h.centerAlignContent();
  avatarImg(h, 22, onDark ? C.white : new Color('#ffffff'));
  h.addSpacer(6);
  text(h, data.owner || data.name || '麦田', 13, onDark ? C.white : C.ink);
  if (data.owner) { h.addSpacer(4); text(h, '· ' + (data.name || '麦田'), 11, onDark ? C.white70 : C.dim, 'medium'); }
  h.addSpacer();
  const t = new Date(data.now); text(h, (stale ? '⚠︎ ' : '') + `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`, 11, stale ? C.down : onDark ? C.white70 : C.dim, 'medium');
}
function fansBlock(st, size, onDark) {
  text(st, '全平台粉丝', 11, onDark ? C.white70 : C.dim, 'medium');
  text(st, fmt(data.fans.total), size, onDark ? C.white : C.ink, 'heavy');
  const r = st.addStack(); r.centerAlignContent();
  text(r, '今日 ', 11, onDark ? C.white70 : C.dim, 'medium'); text(r, sign(data.fans.today), 12, deltaColor(data.fans.today, onDark));
  r.addSpacer(7); text(r, '7天 ', 11, onDark ? C.white70 : C.dim, 'medium'); text(r, sign(data.fans.week), 12, deltaColor(data.fans.week, onDark));
}
function siteRows(st) {
  const s = data.site; if (!s) return;
  text(st, `${s.name} · 近 7 天`, 10.5, C.dim, 'medium'); st.addSpacer(2);
  const r = st.addStack(); r.centerAlignContent();
  text(r, `注册 ${fmt(s.reg)}`, 12, C.ink); r.addSpacer(6); text(r, `会员 ${fmt(s.vip)}`, 12, C.ink); r.addSpacer(6); text(r, money(s.revenue), 12, C.gold);
}
function platformGrid(st, cols, size = 13) {
  const ps = data.platforms || [];
  for (let i = 0; i < ps.length; i += cols) {
    const row = st.addStack();
    ps.slice(i, i + cols).forEach((p, j) => {
      if (j) row.addSpacer();
      const c = row.addStack(); c.layoutVertically();
      text(c, p.name, 10, C.dim, 'medium');
      const v = c.addStack(); v.centerAlignContent(); text(v, short(p.total), size, C.ink); v.addSpacer(3); text(v, sign(p.today), 10, deltaColor(p.today));
    });
    if (i + cols < ps.length) st.addSpacer(6);
  }
}
function coverCard(st, cover, w, h) {
  const box = st.addStack(); box.layoutVertically();
  if (cover) { const i = box.addImage(cover); i.imageSize = new Size(w, h); i.cornerRadius = 10; i.applyFillingContentMode(); }
  box.addSpacer(5);
  const r = box.addStack(); r.centerAlignContent();
  text(r, '最新 ', 10.5, C.dim, 'medium'); text(r, fmt(data.latest.views), 12, C.ink); text(r, ' 播放', 10.5, C.dim, 'medium');
}
const bgGradient = () => { const g = new LinearGradient(); g.colors = [C.bg1, C.bg2]; g.locations = [0, 1]; return g; };

// ───── 组装 ─────
const w = new ListWidget();
w.url = MAITIAN;
w.refreshAfterDate = new Date(Date.now() + 20 * 60e3);
const AVATAR = data && data.avatar && !LOCK ? await img('avatar', 200) : null;
const COVER = data && data.latest && !LOCK && fam !== 'small' ? await img('4x3', 480) : null;

if (!data) {
  w.backgroundGradient = bgGradient();
  text(w, '🌾 连不上麦田', 14); w.addSpacer(4); text(w, '检查麦田地址和小组件口令', 11, C.dim, 'medium');
} else if (fam === 'accessoryInline') {
  w.addText(`🌾 ${fmt(data.fans.total)} 粉 ${sign(data.fans.today)}`);
} else if (fam === 'accessoryCircular') {
  w.addAccessoryWidgetBackground = true;
  const s = w.addStack(); s.layoutVertically(); s.centerAlignContent();
  const a = s.addText('今日'); a.font = Font.mediumSystemFont(10); a.centerAlignText();
  const b = s.addText(sign(data.fans.today)); b.font = Font.boldRoundedSystemFont(15); b.minimumScaleFactor = 0.5; b.centerAlignText();
} else if (fam === 'accessoryRectangular') {
  const l1 = w.addText(`🌾 ${fmt(data.fans.total)} 粉  ${sign(data.fans.today)}`); l1.font = Font.boldRoundedSystemFont(14); l1.minimumScaleFactor = 0.7;
  if (data.latest) { const l2 = w.addText(`最新一期 ${fmt(data.latest.views)} 播放`); l2.font = Font.mediumSystemFont(12); }
  if (data.site) { const l3 = w.addText(`7天 注册 ${fmt(data.site.reg)} · ${money(data.site.revenue)}`); l3.font = Font.mediumSystemFont(12); l3.minimumScaleFactor = 0.7; }
} else if (fam === 'small') {
  w.backgroundGradient = bgGradient(); w.setPadding(13, 14, 13, 14);
  const h = w.addStack(); h.centerAlignContent(); avatarImg(h, 30, new Color('#ffffff')); h.addSpacer(7);
  const who = h.addStack(); who.layoutVertically(); text(who, data.owner || data.name || '麦田', 12); text(who, stale ? '⚠︎ 旧数据' : (data.owner ? data.name || '麦田' : ''), 10, stale ? C.down : C.dim, 'medium');
  w.addSpacer();
  fansBlock(w, 26);
  if (data.site) { w.addSpacer(3); const r = w.addStack(); text(r, '7天 ', 10.5, C.dim, 'medium'); text(r, money(data.site.revenue), 11, C.gold); text(r, ` · 会员 ${fmt(data.site.vip)}`, 10.5, C.dim, 'medium'); }
} else if (fam === 'medium') {
  w.backgroundGradient = bgGradient(); w.setPadding(13, 15, 13, 15);
  header(w); w.addSpacer(8);
  const body = w.addStack();
  const left = body.addStack(); left.layoutVertically();
  fansBlock(left, 28); left.addSpacer(); siteRows(left);
  body.addSpacer();
  if (data.latest) coverCard(body, COVER, 124, 93);
} else {
  w.backgroundGradient = bgGradient(); w.setPadding(16, 16, 15, 16);
  header(w); w.addSpacer(12);
  fansBlock(w, 32); w.addSpacer(12);
  const grid = w.addStack(); grid.layoutVertically(); grid.backgroundColor = C.card; grid.cornerRadius = 14; grid.setPadding(10, 12, 10, 12);
  platformGrid(grid, 3); w.addSpacer(12);
  if (data.latest) {
    const r = w.addStack(); r.centerAlignContent();
    if (COVER) { const i = r.addImage(COVER); i.imageSize = new Size(112, 84); i.cornerRadius = 10; r.addSpacer(10); }
    const c = r.addStack(); c.layoutVertically();
    text(c, '最新一期', 10.5, C.dim, 'medium'); c.addSpacer(2);
    const t = c.addText(data.latest.title); t.font = Font.boldRoundedSystemFont(13); t.textColor = C.ink; t.lineLimit = 2;
    c.addSpacer(4);
    const v = c.addStack(); v.centerAlignContent(); text(v, fmt(data.latest.views), 15, C.ink, 'heavy'); text(v, ' 播放', 11, C.dim, 'medium');
    if (data.latest.hours != null) { v.addSpacer(6); text(v, data.latest.hours < 1 ? '刚发布' : data.latest.hours < 48 ? `${data.latest.hours} 小时` : `${Math.round(data.latest.hours / 24)} 天`, 10.5, C.dim, 'medium'); }
  }
  w.addSpacer(); siteRows(w);
}

if (config.runsInWidget) Script.setWidget(w);
else await (fam === 'small' ? w.presentSmall() : fam === 'large' ? w.presentLarge() : w.presentMedium());
Script.complete();
