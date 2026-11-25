import http from 'node:http';

export function fault(code, message) { return Object.assign(new Error(message), { code }); }

// Local API/CDP requests use node:http directly, so system proxy settings cannot route them out.
export function localJson(url, body, token) {
  const u = new URL(url);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) throw fault('error', '仅支持本机 HTTP 接口');
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(u, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...(token ? { 'x-api-key': token } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => { text += part; if (text.length > 8_000_000) req.destroy(fault('error', '接口响应过大')); });
      res.on('end', () => { try { if (res.statusCode !== 200) throw fault('error', `本机接口 HTTP ${res.statusCode}`); resolve(JSON.parse(text)); } catch (e) { reject(e); } });
    });
    req.setTimeout(10_000, () => req.destroy(fault('error', '本机接口连接超时')));
    req.on('error', reject);
    req.end(data);
  });
}

export class BitBrowser {
  constructor(baseUrl = 'http://127.0.0.1:54345', { token = process.env.BIT_API_TOKEN } = {}) {
    const u = new URL(baseUrl); // Validate before making any request.
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw fault('error', '比特 API 必须是本机 HTTP 地址');
    this.baseUrl = u.origin; this.token = token;
  }
  async request(path, body = {}) {
    const r = await localJson(this.baseUrl + path, body, this.token);
    if (!r.success) throw fault('error', `比特 API：${String(r.msg || r.message || '请求失败').slice(0, 200)}`);
    return r.data;
  }
  async list() {
    const out = [];
    for (let page = 0; ; page++) {
      const d = await this.request('/browser/list', { page, pageSize: 100 });
      if (!Array.isArray(d?.list)) throw fault('error', '比特环境列表格式不兼容');
      out.push(...d.list.map(p => ({ id: p.id, name: p.name || p.id, seq: p.seq })));
      if (d.list.length < 100 || out.length >= d.totalNum) return out;
    }
  }
  async running() { return this.request('/browser/pids/all'); }
  async open(id) {
    if (!id || typeof id !== 'string') throw fault('error', '缺少环境 ID');
    await this.request('/browser/open', { id });
    return { id, opened: true };
  }
  async close(id) {
    if (!id || typeof id !== 'string') throw fault('error', '缺少环境 ID');
    await this.request('/browser/close', { id });
    return { id, closed: true };
  }
  async endpoint(id, snapshot = {}) {
    const running = snapshot.running ?? await this.running();
    if (!running?.[id]) throw fault('offline', '环境未运行，请先点击打开环境');
    // BitBrowser 7.2.0 /browser/ports: { [profileId]: debuggingPort }. Read-only, never /browser/open.
    const ports = snapshot.ports ?? await this.request('/browser/ports');
    const port = Number(ports?.[id]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fault('error', '当前比特版本未提供运行环境的调试端口');
    const version = await localJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new URL(version.webSocketDebuggerUrl);
    if (ws.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(ws.hostname) || Number(ws.port) !== port) throw fault('error', '比特返回了不匹配的调试连接');
    return { port, ws: ws.href };
  }
  async connect(id, snapshot) {
    return Cdp.connect((await this.endpoint(id, snapshot)).ws);
  }
}

export class Cdp {
  static async connect(url) {
    const c = new Cdp(new WebSocket(url));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { c.close(); reject(fault('error', '浏览器调试连接超时')); }, 10_000);
      c.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      c.ws.addEventListener('error', () => { clearTimeout(timer); reject(fault('error', '浏览器调试连接失败')); }, { once: true });
    });
    return c;
  }
  constructor(ws) {
    this.ws = ws; this.nextId = 0; this.pending = new Map(); this.sessions = new Map(); this.owned = new Set();
    ws.addEventListener('message', event => {
      let r; try { r = JSON.parse(event.data); } catch { return; }
      const p = this.pending.get(r.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(r.id);
      r.error ? p.reject(fault('error', r.error.message)) : p.resolve(r.result);
    });
    ws.addEventListener('close', () => this.failPending());
    ws.addEventListener('error', () => this.failPending());
  }
  failPending() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(fault('error', '浏览器调试连接中断')); } this.pending.clear(); }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(fault('error', `浏览器读取超时：${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async pages() { return (await this.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page'); }
  async create(url) { const { targetId } = await this.send('Target.createTarget', { url, background: true }); this.owned.add(targetId); return { targetId, url }; }
  async evaluate(page, expression) {
    const id = page.targetId;
    if (!this.sessions.has(id)) this.sessions.set(id, (await this.send('Target.attachToTarget', { targetId: id, flatten: true })).sessionId);
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.sessions.get(id));
    if (r.exceptionDetails) throw fault('error', '页面读取失败或页面结构已变化');
    return r.result?.value;
  }
  async closePage(page) {
    if (!this.owned.has(page.targetId)) throw fault('error', '不能关闭用户原有标签页');
    await this.send('Target.closeTarget', { targetId: page.targetId }); this.owned.delete(page.targetId);
  }
  close() { this.failPending(); this.ws.close(); }
}
