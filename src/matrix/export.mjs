import fs from 'node:fs';
import { isAbsolutePath } from './paths.mjs';

const KINDS = new Set(['all', 'accounts', 'posts', 'analytics']);
const COLUMNS = ['record_type', 'collected_at', 'account_id', 'identity', 'group', 'post_id', 'title', 'url', 'followers', 'views', 'likes', 'comments', 'favorites', 'shares', 'impressions', 'engagement_rate_percent', 'profile_visits', 'link_clicks', 'new_followers', 'note'];

function cell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function line(row) { return COLUMNS.map(key => cell(row[key])).join(','); }
function newestFollowers(history) {
  const point = [...(history || [])].reverse().find(item => item.analytics?.followerTrend?.length);
  const trend = point?.analytics?.followerTrend || [];
  return trend.length ? trend[trend.length - 1].value : null;
}

export function exportRows(store, kind = 'all') {
  if (!KINDS.has(kind)) throw new Error('未知导出类型');
  const rows = [];
  for (const account of store.accounts()) {
    const analytics = account.analytics || {};
    if (kind === 'all' || kind === 'accounts') rows.push({
      record_type: 'account', collected_at: account.lastSuccess || '', account_id: account.id, identity: account.identity, group: account.group,
      followers: account.followers, impressions: analytics.impressions, engagement_rate_percent: analytics.engagementRate,
      profile_visits: analytics.profileVisits, link_clicks: analytics.linkClicks, new_followers: newestFollowers(account.analyticsHistory),
      note: account.analyticsIssue?.text || account.reason || '',
    });
    if (kind === 'all' || kind === 'posts') for (const post of account.posts) rows.push({
      record_type: 'post', collected_at: post.lastSuccess || '', account_id: account.id, identity: account.identity, group: account.group,
      post_id: post.id, title: post.title || '', url: post.url || '', views: post.metrics?.views, likes: post.metrics?.likes,
      comments: post.metrics?.comments, favorites: post.metrics?.favorites, shares: post.metrics?.shares,
      impressions: post.analytics?.impressions, engagement_rate_percent: post.analytics?.engagementRate,
      profile_visits: post.analytics?.profileVisits, link_clicks: post.analytics?.linkClicks,
    });
    if (kind === 'all' || kind === 'analytics') {
      for (const sample of account.analyticsHistory || []) rows.push({
        record_type: 'analytics-account', collected_at: sample.at, account_id: account.id, identity: account.identity, group: account.group,
        impressions: sample.analytics?.impressions, engagement_rate_percent: sample.analytics?.engagementRate,
        profile_visits: sample.analytics?.profileVisits, link_clicks: sample.analytics?.linkClicks,
        new_followers: sample.analytics?.followerTrend?.at(-1)?.value, note: sample.issue?.text || '',
      });
      for (const sample of account.postSamples || []) if (sample.analytics) rows.push({
        record_type: 'analytics-post', collected_at: sample.at, account_id: account.id, identity: account.identity, group: account.group,
        post_id: sample.id, impressions: sample.analytics.impressions, engagement_rate_percent: sample.analytics.engagementRate,
        profile_visits: sample.analytics.profileVisits, link_clicks: sample.analytics.linkClicks,
      });
    }
  }
  return rows;
}

export function renderCsv(store, kind = 'all') {
  return [COLUMNS.join(','), ...exportRows(store, kind).map(line)].join('\r\n') + '\r\n';
}

export function writeExport(store, filePath, kind = 'all', write = fs.writeFileSync) {
  if (!isAbsolutePath(filePath)) throw new Error('导出路径须为绝对路径');
  const csv = `\uFEFF${renderCsv(store, kind)}`;
  write(filePath, csv);
  return { bytes: Buffer.byteLength(csv) };
}
