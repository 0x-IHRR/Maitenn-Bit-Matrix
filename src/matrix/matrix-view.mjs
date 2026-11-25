import { shanghaiDate } from './editorial.mjs';
import { validMetric } from './store.mjs';

const dayStamp = value => Date.parse(`${value}T12:00:00+08:00`);

export function matrixAccounts(accounts = []) {
  return accounts.filter(account => account.platform === 'x' && account.enabled !== false && (account.group === 'benchmark' || account.active));
}

export function growthOverDays(samples = [], days = 7, now = new Date()) {
  const byDay = new Map();
  for (const sample of [...samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!validMetric(sample.followers)) continue;
    const day = shanghaiDate(sample.at);
    if (day) byDay.set(day, sample.followers);
  }
  const today = shanghaiDate(now);
  const past = shanghaiDate(new Date(dayStamp(today) - days * 864e5));
  if (!byDay.has(today) || !byDay.has(past)) return null;
  return byDay.get(today) - byDay.get(past);
}

function metric(analytics, key) {
  return validMetric(analytics?.[key]) ? analytics[key] : null;
}

export function matrixRows(accounts = [], personas = [], now = new Date()) {
  const personaByAccount = new Map(personas.filter(persona => persona.accountId).map(persona => [persona.accountId, persona]));
  return matrixAccounts(accounts).map(account => {
    const persona = personaByAccount.get(account.id);
    const issue = account.analyticsIssue || null;
    const singleScope = account.group === 'benchmark' || !account.profileId || account.active === false ? `history:${account.id}` : account.profileId;
    return {
      id: account.id,
      identity: account.identity,
      displayName: account.displayName || '',
      group: account.group || 'owned',
      profileId: account.profileId || null,
      scope: singleScope,
      personaName: persona?.name || '',
      followers: validMetric(account.followers) ? account.followers : null,
      growth7: growthOverDays(account.samples, 7, now),
      impressions: metric(account.analytics, 'impressions'),
      engagementRate: metric(account.analytics, 'engagementRate'),
      profileVisits: metric(account.analytics, 'profileVisits'),
      linkClicks: metric(account.analytics, 'linkClicks'),
      lastSuccess: account.lastSuccess || null,
      gap: issue?.text || account.reason || (account.lastSuccess ? '' : '尚未采集'),
      series: [...(account.samples || [])].filter(sample => validMetric(sample.followers)).map(sample => ({ at: sample.at, followers: sample.followers })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    };
  }).sort((a, b) => Number(a.group === 'benchmark') - Number(b.group === 'benchmark') || a.identity.localeCompare(b.identity));
}
