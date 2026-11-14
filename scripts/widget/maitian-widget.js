// 麦田 · iPhone 小组件（Scriptable）
// 用法：App Store 装 Scriptable → 新建脚本 → 粘贴本文件 → 桌面 / 锁屏添加 Scriptable 小组件，脚本选它。
// 支持：桌面小号 / 中号 / 大号，锁屏长条 / 圆形 / 单行。点小组件打开麦田。
// 麦田地址和小组件口令（config.web.widgetToken）：从麦田的 /widget 页面复制的版本已经填好。
const MAITIAN = '__MAITIAN_URL__';
const TOKEN = '__WIDGET_TOKEN__';

const C = {
  bg1: Color.dynamic(new Color('#f6efe0'), new Color('#211f1a')),
  bg2: Color.dynamic(new Color('#dfe8d6'), new Color('#1a1f1b')),
  ink: Color.dynamic(new Color('#1c1a16'), new Color('#f2eee6')),
  dim: Color.dynamic(new Color('#7a7160'), new Color('#a39b8b')),
  up: Color.dynamic(new Color('#2e8b3d'), new Color('#7ee0a0')),
  down: Color.dynamic(new Color('#c0392b'), new Color('#ff8a80')),
  gold: new Color('#F2B21B'),
};
const fmt = n => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const sign = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n || 0));
const money = n => '¥' + fmt(Math.round(n || 0));
const short = n => (n >= 1e4 ? (n / 1e4).toFixed(n >= 1e5 ? 0 : 1) + '万' : fmt(n));

// ───── 取数据（失败时用上一次的缓存） ─────
const fm = FileManager.local(), CACHE = fm.joinPath(fm.cacheDirectory(), 'maitian-widget.json');
let data = null, stale = false;
try {
  const r = new Request(`${MAITIAN}/api/widget?t=${encodeURIComponent(TOKEN)}`); r.timeoutInterval = 15;
  data = await r.loadJSON();
  if (!data || !data.fans) throw new Error(data && data.error || '没有数据');
  fm.writeString(CACHE, JSON.stringify(data));
} catch (e) {
  stale = true;
  try { data = JSON.parse(fm.readString(CACHE)); } catch { data = null; }
}

// ───── 麦苗（像素画） ─────
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
const deltaColor = n => (n > 0 ? C.up : n < 0 ? C.down : C.dim);
function header(w, small) {
  const h = w.addStack(); h.centerAlignContent();
  const img = h.addImage(maimiao(4)); img.imageSize = new Size(small ? 14 : 16, small ? 15 : 17);
  h.addSpacer(5); text(h, data.name || '麦田', small ? 13 : 14, C.ink);
  h.addSpacer();
  const t = new Date(data.now); text(h, (stale ? '⚠︎ ' : '') + `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`, 11, stale ? C.down : C.dim, 'medium');
}
function fansBlock(st, big) {
  text(st, '全平台粉丝', 11, C.dim, 'medium');
  text(st, fmt(data.fans.total), big ? 30 : 26, C.ink, 'heavy');
  const r = st.addStack(); r.centerAlignContent();
  text(r, '今日 ', 11, C.dim, 'medium'); text(r, sign(data.fans.today), 12, deltaColor(data.fans.today));
  r.addSpacer(6); text(r, '7天 ', 11, C.dim, 'medium'); text(r, sign(data.fans.week), 12, deltaColor(data.fans.week));
}
function latestLine(st, withTitle, age = withTitle) {
  if (!data.latest) return;
  if (withTitle) text(st, data.latest.title, 12, C.ink);
  const r = st.addStack(); r.centerAlignContent();
  if (!withTitle) text(r, '最新一期 ', 11, C.dim, 'medium'); text(r, fmt(data.latest.views), 12, C.ink); text(r, ' 播放', 11, C.dim, 'medium');
  if (age && data.latest.hours != null) { r.addSpacer(4); text(r, `· ${data.latest.hours < 48 ? data.latest.hours + ' 小时' : Math.round(data.latest.hours / 24) + ' 天'}`, 10, C.dim, 'medium'); }
}
function siteLine(st) {
  const s = data.site; if (!s) return;
  const r = st.addStack(); r.centerAlignContent();
  text(r, `${s.name} 7天 `, 11, C.dim, 'medium'); text(r, `注册 ${fmt(s.reg)}`, 11.5, C.ink);
  r.addSpacer(5); text(r, `会员 ${fmt(s.vip)}`, 11.5, C.ink); r.addSpacer(5); text(r, money(s.revenue), 11.5, C.gold);
}
function platformGrid(st, cols, size = 13) {
  const ps = data.platforms || [];
  for (let i = 0; i < ps.length; i += cols) {
    const row = st.addStack(); row.spacing = size < 13 ? 6 : 8;
    ps.slice(i, i + cols).forEach(p => {
      const c = row.addStack(); c.layoutVertically();
      text(c, p.name, 10, C.dim, 'medium');
      const v = c.addStack(); v.centerAlignContent(); text(v, short(p.total), size, C.ink); v.addSpacer(3); text(v, sign(p.today), 10, deltaColor(p.today));
    });
    if (i + cols < ps.length) st.addSpacer(5);
  }
}

// ───── 组装 ─────
const fam = config.widgetFamily || 'medium';
const w = new ListWidget();
w.url = MAITIAN;
w.refreshAfterDate = new Date(Date.now() + 20 * 60e3);

if (!data) {
  const g = new LinearGradient(); g.colors = [C.bg1, C.bg2]; g.locations = [0, 1]; w.backgroundGradient = g;
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
} else {
  const g = new LinearGradient(); g.colors = [C.bg1, C.bg2]; g.locations = [0, 1]; w.backgroundGradient = g;
  w.setPadding(14, 15, 13, 15);
  if (fam === 'small') {
    header(w, true); w.addSpacer(6); fansBlock(w, false); w.addSpacer(); latestLine(w, false);
    if (data.site) { w.addSpacer(2); const r = w.addStack(); text(r, `7天 ${money(data.site.revenue)} · 会员 ${fmt(data.site.vip)}`, 11, C.dim, 'medium'); }
  } else if (fam === 'medium') {
    header(w); w.addSpacer(6);
    const body = w.addStack();
    const left = body.addStack(); left.layoutVertically(); fansBlock(left, false); left.addSpacer(4); latestLine(left, false);
    body.addSpacer(12);
    const right = body.addStack(); right.layoutVertically(); platformGrid(right, 3, 12);
    w.addSpacer(); siteLine(w);
  } else {
    header(w); w.addSpacer(10); fansBlock(w, true); w.addSpacer(12);
    platformGrid(w, 3); w.addSpacer(14);
    text(w, '最新一期', 11, C.dim, 'medium'); w.addSpacer(2); latestLine(w, true);
    w.addSpacer(); siteLine(w);
  }
}

if (config.runsInWidget) Script.setWidget(w);
else await (fam === 'small' ? w.presentSmall() : fam === 'large' ? w.presentLarge() : w.presentMedium());
Script.complete();
