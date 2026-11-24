import { fault } from './browser.mjs';

export function runningIds(result) {
  if (!result) return new Set();
  if (Array.isArray(result)) return new Set(result.map(p => typeof p === 'string' ? p : p?.id).filter(Boolean));
  if (typeof result === 'object') return new Set(Object.keys(result));
  return new Set();
}

// Open a BitBrowser profile only when it is not already running, and close it
// only if this call opened it. Login, captcha, and mismatch leave the window
// up so the user can deal with it. Pre-opened windows are never closed.
export async function withOwnedWindow(bit, profileId, fn) {
  if (!profileId || typeof profileId !== 'string') throw fault('offline', '自有账号未绑定比特环境');
  const already = runningIds(await bit.running()).has(profileId);
  let opened = false;
  let preserve = false;
  try {
    if (!already) {
      await bit.open(profileId);
      opened = true;
    }
    return await fn();
  } catch (error) {
    if (['login', 'risk', 'mismatch'].includes(error.code)) preserve = true;
    throw error;
  } finally {
    if (opened && !preserve) await bit.close(profileId).catch(() => {});
  }
}
