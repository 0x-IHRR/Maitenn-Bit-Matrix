import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolutePath } from './paths.mjs';

async function json(file, optional = false) {
  try { if ((await stat(file)).size > 4 * 1024 * 1024) throw new Error('工程记录文件过大'); return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
}
// Source files and the upstream database are read-only. No platform calls or hub commands.
export async function readProjects(projectPath, platform, maitianRoot = '') {
  if (!isAbsolutePath(projectPath || '')) throw new Error('请填写已有麦田工程的绝对目录');
  const root = await realpath(projectPath);
  const dirs = [];
  async function walk(dir, depth) {
    const entries = await readdir(dir, {withFileTypes:true});
    if (entries.some(e => e.isFile() && e.name === 'publish.json')) { dirs.push(dir); return; }
    if (depth < 3) for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) await walk(join(dir,e.name),depth+1);
  }
  await walk(root, 0);
  if (dirs.length > 500) throw new Error('请关联更具体的工程目录（最多500项）');
  let db;
  if (maitianRoot) {
    const dbPath = join(maitianRoot, 'data', 'hub.db');
    try { await stat(dbPath); db = new DatabaseSync(dbPath, {readOnly:true}); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error(`读取麦田数据库失败：${e.message}`); }
  }
  try {
    const posts = [];
    for (const dir of dirs) {
      const pj = await json(join(dir,'publish.json'));
      const p = pj.platforms?.[platform];
      if (!p) continue;
      const log = await json(join(dir,'发布记录.json'),true);
      const record = log?.platforms?.[platform];
      let task, metric,ep,metricsHistory=[],samples=[],logs=[];
      if (db && pj.id) {
        ep = db.prepare('SELECT * FROM episodes WHERE id=?').get(pj.id);
        if (ep && await realpath(ep.dir).catch(()=>'') === dir) {
          task = db.prepare('SELECT * FROM tasks WHERE episode_id=? AND platform=?').get(pj.id,platform);
          metric = db.prepare('SELECT * FROM metrics WHERE episode_id=? AND platform=? ORDER BY collected_at DESC LIMIT 1').get(pj.id,platform);
          metricsHistory=db.prepare('SELECT * FROM metrics WHERE episode_id=? AND platform=? ORDER BY day').all(pj.id,platform);
          samples=db.prepare('SELECT * FROM samples WHERE episode_id=? AND platform=? ORDER BY ts').all(pj.id,platform);
          logs=db.prepare('SELECT * FROM logs WHERE episode_id=? AND (platform=? OR platform=?) ORDER BY id DESC LIMIT 200').all(pj.id,platform,'');
        } else ep=null;
      }
      const metrics = {};
      if (metric) for (const k of ['views','likes','comments','favorites','shares']) metrics[k] = metric[k] ?? null;
      const entries=await readdir(dir);
      posts.push({sourceKey:`${dir}::${platform}`,projectPath:dir,episodeId:pj.id,episode:pj.episode??null,projectName:pj.name,nick:pj.nick,
        schedule:pj.schedule||null,createdAt:ep?.created_at||null,covers:pj.covers||{},durationSec:pj.durationSec||0,campaign:(JSON.stringify(pj.platforms||{}).match(/utm_campaign=([\w-]+)/)||[])[1]||'',
        copy:{title:p.title||p.shortTitle||'',body:p.desc||p.body||p.text||p.description||'',tags:p.tags||p.topics||[],covers:p.covers||[]},
        files:['成片.mp4','字幕.srt','发布素材.md','publish.json','发布记录.json'].filter(f=>entries.includes(f)),metricsHistory,samples,logs,
        sourceUpdatedAt:task?.updated_at||log?.updatedAt||null,title:p.title || pj.name || pj.id || dir,
        url:task?.url || record?.url || '', status:task?.state || record?.state || (p.skip ? '跳过':'已登记'),
        detail:task?.detail || record?.detail || '', metrics,lastSuccess:metric?.collected_at || null, source:metric ? '麦田本地记录':'麦田工程'});
    }
    return posts;
  } finally { db?.close(); }
}
