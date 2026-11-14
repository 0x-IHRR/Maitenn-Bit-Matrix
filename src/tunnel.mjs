// 麦田公网隧道：cloudflared quick tunnel → 拿到 https 地址 → 存 data/tunnel.json + 推飞书
import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path';
import { notify, config } from './feishu.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'data', 'tunnel.json');
const port = config.web?.port || 8787, key = config.web?.key;
const cf = spawn('/opt/homebrew/bin/cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--protocol', 'http2'], { stdio: ['ignore', 'pipe', 'pipe'] });
let sent = false;
const onData = async (buf) => {
  const s = buf.toString(); process.stdout.write(s);
  const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !sent) {
    sent = true;
    const url = `${m[0]}/?key=${key}`;
    let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')).url; } catch {}
    fs.writeFileSync(OUT, JSON.stringify({ url, base: m[0], at: new Date().toISOString() }, null, 2));
    if (prev !== url) await notify(`🌐 麦田远程地址（手机/电脑浏览器直接打开）：${url}`).catch(e => console.error(e.message));
  }
};
cf.stdout.on('data', onData); cf.stderr.on('data', onData);
cf.on('exit', (c) => { console.error('cloudflared 退出', c); process.exit(1); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { cf.kill(); process.exit(0); });
