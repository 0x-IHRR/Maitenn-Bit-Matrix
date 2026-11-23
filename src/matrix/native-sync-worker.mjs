import { snapshot, checkIdentity, normalizeIdentity } from './collector.mjs';

// One account in one child process: driver/globalThis.chrome never crosses Profile boundaries.
export async function runNativeLinks({ platform, identity, projects }, driver, onFailure = () => {}) {
  let failure = null;
  function fail(error) {
    failure ||= error;
    onFailure(error);
    throw error;
  }
  try {
    const expected = normalizeIdentity(platform, identity);
    await driver.ensure();
    const chrome = globalThis.chrome;
    const create = chrome.tabs.create.bind(chrome.tabs), remove = chrome.tabs.remove.bind(chrome.tabs);
    const send = chrome.debugger.sendCommand.bind(chrome.debugger);
    const owned = new Set();
    async function inspect(tabId, requireIdentity = false) {
      if (!owned.has(tabId)) fail(Object.assign(new Error('取链接不能操作用户原有页面'), { code: 'error' }));
      const r = await send({ tabId }, 'Runtime.evaluate', { expression: `(${snapshot.toString()})(${JSON.stringify(platform)},null)`, returnByValue: true, awaitPromise: true });
      const data = r.result?.value;
      if (data?.risk || data?.login || data?.identity || requireIdentity) {
        try { checkIdentity(platform, expected, data); } catch (error) { fail(error); }
      }
    }
    chrome.tabs.create = async options => {
      if (failure) throw failure;
      const tab = await create(options); owned.add(tab.id); return tab;
    };
    chrome.tabs.remove = async ids => {
      for (const id of [].concat(ids)) {
        if (failure) throw failure; // Login/risk/identity pages remain open for manual inspection.
        await inspect(id, true);
        await remove(id); owned.delete(id);
      }
    };
    chrome.debugger.sendCommand = async (target, method, params = {}) => {
      if (failure) throw failure;
      if (!owned.has(target.tabId)) return fail(Object.assign(new Error('取链接不能操作用户原有页面'), { code: 'error' }));
      if (!['Runtime.evaluate', 'Emulation.setFocusEmulationEnabled'].includes(method)) return fail(Object.assign(new Error('取链接不允许执行填写或发布命令'), { code: 'error' }));
      if (method === 'Runtime.evaluate') await inspect(target.tabId, /location\.(?:href|assign|replace)\s*(?:=|\()/.test(params.expression || ''));
      return send(target, method, params);
    };
    const updates = [], warnings = [];
    for (const project of projects) {
      if (failure) throw failure;
      const result = (await driver.links({ data: project.data }, [platform]))?.[platform];
      if (failure) throw failure;
      if (result?.status === '未登录') fail(Object.assign(new Error('请在比特环境中人工登录后重新检查'), { code: 'login' }));
      if (!result?.status || ['未找到', '不支持', '页面没打开', '出错'].includes(result.status)) {
        warnings.push({ id: project.id, reason: `原生取链接：${result?.status || '没有返回结果'}${result?.note ? '；' + result.note : ''}` });
      } else updates.push({ id: project.id, status: result.status, url: result.url || '', note: result.note || '', time: result.time || '' });
    }
    await driver.close();
    return { updates, warnings };
  } catch (error) {
    try { await driver?.close(); } catch { /* Connection teardown never closes the Profile. */ }
    throw error;
  }
}

if (process.send) process.once('message', async input => {
  let reported = false;
  const report = error => { if (!reported) { reported = true; process.send({ error: { code: error.code || 'error', message: error.message } }); } };
  try {
    const result = await runNativeLinks(input, await import('../driver.mjs'), report);
    if (!reported) { reported = true; process.send(result); }
  } catch (error) { report(error); }
});
