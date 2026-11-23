export const SHANGHAI = 'Asia/Shanghai';

export function shanghaiDay(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: SHANGHAI }).format(date);
}
export function shanghaiHour(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: SHANGHAI, hour: '2-digit', hourCycle: 'h23' }).format(date));
  return hour === 24 ? 0 : hour;
}

export function monitorDefaults() {
  return { timelineLimit: 20, collectsPerDay: 1, collectHours: [9], concurrency: 1, intervalMinMinutes: 3, intervalMaxMinutes: 8, scheduleEnabled: false };
}

function intOf(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function parseMonitorSettings(raw = {}) {
  const defaults = monitorDefaults();
  const timelineLimit = intOf(raw.timelineLimit, defaults.timelineLimit);
  if (timelineLimit < 1 || timelineLimit > 50) throw new Error('时间线读取条数须为 1–50');
  const collectsPerDay = intOf(raw.collectsPerDay, defaults.collectsPerDay);
  if (![1, 2].includes(collectsPerDay)) throw new Error('每天采集次数只能是 1 或 2');
  const concurrency = intOf(raw.concurrency, defaults.concurrency);
  if (![1, 2].includes(concurrency)) throw new Error('并发只能是 1 或 2');
  const intervalMinMinutes = intOf(raw.intervalMinMinutes, defaults.intervalMinMinutes);
  const intervalMaxMinutes = intOf(raw.intervalMaxMinutes, defaults.intervalMaxMinutes);
  if (intervalMinMinutes < 1 || intervalMaxMinutes > 180 || intervalMaxMinutes < intervalMinMinutes) throw new Error('账号间隔须为 1–180 分钟，且最大值不小于最小值');
  const hours = [...new Set(String(raw.collectHours ?? defaults.collectHours.join(',')).split(/[,，\s]+/).filter(Boolean).map(Number))].sort((a, b) => a - b);
  if (hours.some(h => !Number.isInteger(h) || h < 0 || h > 23) || hours.length !== collectsPerDay) throw new Error('采集小时须为 0–23，个数与每天次数一致');
  const scheduleEnabled = raw.scheduleEnabled === true || raw.scheduleEnabled === 1 || raw.scheduleEnabled === '1';
  return { timelineLimit, collectsPerDay, collectHours: hours, concurrency, intervalMinMinutes, intervalMaxMinutes, scheduleEnabled };
}

export function readMonitorSettings(raw = {}) {
  try { return parseMonitorSettings(raw); }
  catch { return monitorDefaults(); }
}

export function randomIntervalMs(minMinutes, maxMinutes, rng = Math.random) {
  const min = Math.floor(Number(minMinutes) * 60_000);
  const max = Math.floor(Number(maxMinutes) * 60_000);
  if (!Number.isFinite(min) || min < 0) throw new Error('间隔无效');
  if (!Number.isFinite(max) || max < min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

// The latest scheduled hour that has already arrived today, if that slot has not run.
// Manual runs count toward the hard daily cap of 2 but do not consume a clock slot.
export function dueSlot(hours, runs, now = new Date()) {
  const day = shanghaiDay(now);
  const hour = shanghaiHour(now);
  const passed = [...hours].sort((a, b) => a - b).filter(h => h <= hour);
  if (!passed.length) return null;
  const slot = `${day}#${passed.at(-1)}`;
  // A run counts for this Shanghai day if it was stored that day or its slot is that day.
  // The slot date wins near midnight, when the wall clock and the scheduled day can differ.
  const today = (runs || []).filter(r => r.day === day || String(r.slot || '').startsWith(`${day}#`));
  if (today.length >= 2) return null;
  if (today.some(r => r.slot === slot)) return null;
  return slot;
}

export async function runPaced(items, { concurrency = 1, intervalMs = () => 0, sleep = defaultSleep, worker }) {
  const list = [...items];
  if (!list.length) return [];
  const lanes = Math.max(1, Math.min(2, Number(concurrency) || 1, list.length));
  let cursor = 0;
  const errors = [];
  async function lane(index) {
    if (index > 0) await sleep(intervalMs());
    while (cursor < list.length) {
      const item = list[cursor++];
      try { await worker(item); }
      catch (error) { errors.push(error); }
      if (cursor < list.length) await sleep(intervalMs());
    }
  }
  await Promise.all(Array.from({ length: lanes }, (_, index) => lane(index)));
  return errors;
}
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class CollectionScheduler {
  constructor({ store, queue, now = () => new Date(), sleep = defaultSleep, rng = Math.random } = {}) {
    this.store = store;
    this.queue = queue;
    this.now = now;
    this.sleep = sleep;
    this.rng = rng;
    this.timer = null;
    this.running = false;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, 60_000);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  settings() { return readMonitorSettings(this.store.settings()); }
  dueAccounts(now = this.now()) {
    const settings = this.settings();
    if (!settings.scheduleEnabled) return [];
    const runs = this.store.collectionRuns();
    return this.store.accounts().filter(account => {
      if (account.platform !== 'x' || account.enabled === false) return false;
      if (['paused', 'mismatch', 'login', 'collecting'].includes(account.status)) return false;
      if (account.group === 'benchmark') { /* public source, no browser */ }
      else if (!account.active || !account.profileId) return false;
      return !!dueSlot(settings.collectHours, runs.filter(run => run.accountId === account.id), now);
    });
  }
  async tick(now = this.now()) {
    if (this.running) return { skipped: 'busy', started: [] };
    const due = this.dueAccounts(now);
    if (!due.length) return { started: [] };
    this.running = true;
    const started = [];
    try {
      const settings = this.settings();
      await runPaced(due, {
        concurrency: settings.concurrency,
        intervalMs: () => randomIntervalMs(settings.intervalMinMinutes, settings.intervalMaxMinutes, this.rng),
        sleep: this.sleep,
        worker: async account => {
          const slot = dueSlot(settings.collectHours, this.store.collectionRuns().filter(run => run.accountId === account.id), this.now());
          if (!slot) return;
          started.push(account.id);
          await this.queue.collectAccount(account.id, { slot, kind: 'metrics' });
        },
      });
    } finally { this.running = false; }
    return { started };
  }
}
