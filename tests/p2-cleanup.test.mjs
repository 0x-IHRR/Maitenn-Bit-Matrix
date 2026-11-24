import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readProjects } from '../src/matrix/importer.mjs';
import { isAbsolutePath } from '../src/matrix/paths.mjs';

const removed = [
  'vendor/maitian-publisher',
  'skills/maitian-publish',
  'src/hub.mjs',
  'src/make-publish.mjs',
  'src/plugin.mjs',
  'src/bridge.mjs',
  'src/checks.mjs',
  'src/driver.mjs',
  'src/chrome-shim.mjs',
  'src/init.mjs',
  'src/demo.mjs',
  'src/metrics.mjs',
  'src/followers.mjs',
  'src/board.mjs',
  'src/site.mjs',
  'src/learn.mjs',
  'src/review.mjs',
  'src/validate.mjs',
  'src/matrix/native-sync.mjs',
  'src/matrix/native-sync-worker.mjs',
  'src/matrix/site-browser.mjs',
];

test('发布引擎、知识站和取链接入口已从仓库移除', () => {
  for (const file of removed) assert.equal(fs.existsSync(file), false, file);
});

test('config.example.json 只保留只读监控配置', () => {
  const example = JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
  assert.equal(example.site, undefined);
  assert.equal(example.matrix.bitUrl, 'http://127.0.0.1:54345');
  assert.equal(example.matrix.timelineLimit, 20);
  assert.equal(example.matrix.scheduleEnabled, false);
  assert.deepEqual(example.matrix.collectHours, [9]);
  assert.equal(example.web.host, '127.0.0.1');
  assert.equal(example.web.port, 8790);
});

test('工程目录同时接受 macOS 与 Windows 绝对路径', async () => {
  assert.equal(isAbsolutePath('/Users/me/projects'), true);
  assert.equal(isAbsolutePath('C:\\Users\\me\\projects'), true);
  assert.equal(isAbsolutePath('\\\\server\\share\\projects'), true);
  assert.equal(isAbsolutePath('projects/relative'), false);
  await assert.rejects(readProjects('projects/relative', 'x'), /绝对/);
  await assert.rejects(readProjects('C:\\Users\\me\\maitian-missing', 'x'), error => !/绝对/.test(error.message));
});
