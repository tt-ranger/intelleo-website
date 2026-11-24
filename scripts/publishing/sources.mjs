import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { parse } from 'yaml';
import { fetchPublic, publicUrl } from './public-fetch.mjs';
import { hash, reserveSearch, saveSource } from './store.mjs';
import { withDuckDuckGo } from './duckduckgo.mjs';

const HOUR = 3600000;
const QUERIES = [
  'AI model releases enterprise AI research announcements',
  'machine learning research model evaluation technical news',
  'data engineering database warehouse releases technology news',
  'developer tools open-source AI infrastructure releases news',
  'semiconductor cloud inference compute announcements',
  'AI search retrieval indexing web standards technology news',
];

const RELEASE_REPOS = ['vllm-project/vllm', 'huggingface/transformers', 'duckdb/duckdb', 'apache/iceberg', 'kubernetes/kubernetes', 'pytorch/pytorch'];
const PRIMARY_DOMAINS = ['openai.com', 'anthropic.com', 'huggingface.co', 'arxiv.org', 'developers.googleblog.com', 'research.google', 'nvidia.com', 'microsoft.com', 'aws.amazon.com', 'linuxfoundation.org', 'w3.org'];
const robotsByOrigin = new Map();

export function canonicalUrl(value) {
  const url = publicUrl(value);
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (/^utm_|^(fbclid|gclid|mc_cid|mc_eid|ref_src|trk)$/i.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  return url.href;
}

function dateOrNull(value, now = Date.now()) {
  const date = Date.parse(value);
  return Number.isFinite(date) && date <= now ? new Date(date).toISOString() : null;
}

async function publicText(url, accept) {
  const response = await fetchPublic(url, { accept });
  if (!response.ok) throw new Error(`Publisher HTTP ${response.status}.`);
  return response.text();
}

export function parseFeed(xml, source) {
  const $ = load(xml, { xml: true });
  return $('item, entry').toArray().slice(0, 12).map((item) => {
    const node = $(item);
    const links = node.children('link');
    const link = links.filter('[rel="alternate"]').first().attr('href') ?? links.first().attr('href') ?? links.first().text();
    const date = node.children('pubDate, published, dc\\:date').first().text();
    return { url: link, date, primary: source.primary ?? true };
  }).filter((row) => row.url);
}

async function rssSources() {
  const { feeds } = parse(readFileSync(new URL('../../src/data/feeds.yaml', import.meta.url), 'utf8'));
  return feeds
    .filter(({ publisher }) => publisher !== 'Hacker News')
    .map((source) => [source.publisher, async () => parseFeed(await publicText(source.url.replace(/^http:/, 'https:'), 'application/xml,text/xml'), source)]);
}

const hnBase = 'https://hacker-news.firebaseio.com/v0';
async function hackerNews() {
  const ids = JSON.parse(await publicText(`${hnBase}/topstories.json`, 'application/json'));
  const results = await Promise.allSettled(ids.slice(0, 12).map(async (id) => {
    if (!Number.isInteger(id)) return null;
    const item = JSON.parse(await publicText(`${hnBase}/item/${id}.json`, 'application/json'));
    return item?.url ? { url: item.url, primary: false } : null;
  }));
  return results.flatMap((row) => row.status === 'fulfilled' && row.value ? [row.value] : []);
}

async function releases(repo) {
  const data = JSON.parse(await publicText(`https://api.github.com/repos/${repo}/releases?per_page=3`, 'application/vnd.github+json'));
  return data.filter((release) => !release.draft && !release.prerelease && release.published_at)
    .map((release) => ({ url: release.html_url, date: release.published_at, primary: true }));
}

async function gdelt() {
  const endpoint = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  endpoint.search = new URLSearchParams({
    query: '("artificial intelligence" OR "data infrastructure" OR "semiconductor") sourcelang:english',
    mode: 'ArtList', format: 'json', timespan: '3d', maxrecords: '20',
  });
  const results = JSON.parse(await publicText(endpoint, 'application/json'));
  return (results.articles ?? []).map((item) => ({ url: item.url, primary: false }));
}

async function searchYou(query, key, now, fetchImpl) {
  const start = new Date(now - 72 * HOUR).toISOString().slice(0, 10);
  const end = new Date(now).toISOString().slice(0, 10);
  const response = await fetchImpl('https://ydc-index.io/v1/search', {
    method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ query, count: 12, freshness: `${start}to${end}` }),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`You.com HTTP ${response.status}.`);
  const result = await response.json();
  const entries = [...(result.results?.news ?? []), ...(result.results?.web ?? [])];
  return entries.map(({ url }) => ({ url, primary: false }));
}

export function searchTasks(db, searchWindow, { now, env, fetchImpl, duckDuckGo = withDuckDuckGo }) {
  const queries = QUERIES.slice((searchWindow % 2) * 3, (searchWindow % 2) * 3 + 3);
  const results = queries.map((query) => ['you', async () => {
    if (!env.YOU_DOT_COM_API_KEY) throw new Error('You.com is unconfigured.');
    if (!await reserveSearch(db, 'you')) return [];
    return searchYou(query, env.YOU_DOT_COM_API_KEY, now, fetchImpl);
  }]);
  results.push(['duckduckgo', () => duckDuckGo(async (search) => {
    const groups = [];
    for (const query of queries) {
      if (!await reserveSearch(db, 'duckduckgo')) break;
      groups.push(await search(query));
    }
    const urls = Array.from({ length: 8 }, (_, rank) => groups.map((matches) => matches[rank])).flat().filter(Boolean);
    return [...new Set(urls)].map((url) => ({ url, primary: false }));
  })]);
  return results;
}

async function allowedByRobots(url) {
  const { origin, pathname } = new URL(url);
  if (!robotsByOrigin.has(origin)) {
    robotsByOrigin.set(origin, fetchPublic(`${origin}/robots.txt`, { accept: 'text/plain', limit: 200000 })
      .then(async (response) => {
        if ([404, 410].includes(response.status)) return '';
        return response.ok ? response.text() : null;
      }).catch(() => null));
  }
  const text = await robotsByOrigin.get(origin);
  if (text === null) return false;
  const groups = [];
  let group;
  for (const line of text.split(/\r?\n/)) {
    const [key, ...parts] = line.split('#', 1)[0].trim().split(':');
    const value = parts.join(':').trim();
    if (key.toLowerCase() === 'user-agent') {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && /^(allow|disallow)$/i.test(key) && value) {
      group.rules.push({ allow: key.toLowerCase() === 'allow', value });
    }
  }
  const specific = groups.filter(({ agents }) => agents.includes('intelleoeditorial'));
  const rules = (specific.length ? specific : groups.filter(({ agents }) => agents.includes('*'))).flatMap(({ rules }) => rules);
  const matches = rules.filter(({ value }) => {
    const anchored = value.endsWith('$');
    const pattern = (anchored ? value.slice(0, -1) : value).split('*')
      .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('.*');
    return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(pathname);
  });
  matches.sort((a, b) => b.value.length - a.value.length || Number(b.allow) - Number(a.allow));
  return matches[0]?.allow ?? true;
}

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function articleMetadata($) {
  const documents = $('script[type="application/ld+json"]').toArray().flatMap((node) => {
    try {
      const parsed = JSON.parse($(node).text());
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
  return documents.flatMap((document) =>
    Array.isArray(document?.['@graph']) ? [...document['@graph'], document] : [document],
  ).find((document) => {
    const types = [document?.['@type']].flat();
    return types.some((type) => ['Article', 'NewsArticle', 'TechArticle', 'ScholarlyArticle', 'BlogPosting', 'Report'].includes(type));
  });
}

const RESTRICTED = /\b(noai|none|noindex|nosnippet|noarchive)\b|\bmax-snippet:\s*0\b/i;

export function extractPublisher(html, responseUrl, hint = {}, now = Date.now()) {
  const $ = load(html);
  const meta = (name) => $(
    `meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`,
  ).first().attr('content');
  const structured = articleMetadata($);
  if (structured?.isAccessibleForFree === false || structured?.isAccessibleForFree === 'false'
      || [meta('robots'), meta('intelleoeditorial')].some((item) => RESTRICTED.test(item ?? ''))) return null;
  const canonical = $('link[rel="canonical"]').first().attr('href');
  let url = canonicalUrl(responseUrl);
  if (canonical) {
    const resolved = new URL(canonical, url);
    if (resolved.origin === new URL(url).origin) url = canonicalUrl(resolved);
  }
  const host = new URL(url).hostname.replace(/^www\./, '');
  const title = compact(meta('og:title') ?? structured?.headline ?? $('h1').first().text()) || compact($('title').text());
  if (title.length < 10 || /^(access denied|just a moment|verify you are human|page not found)/i.test(title)) return null;
  const publisher = compact(meta('og:site_name') ?? structured?.publisher?.name) || host;
  const date = dateOrNull(
    meta('article:published_time') ?? meta('datePublished') ?? meta('citation_publication_date') ?? structured?.datePublished
      ?? $('article time[datetime], main time[datetime], relative-time[datetime]').first().attr('datetime')
      ?? (hint.primary ? hint.date : null), now,
  );
  $('script, style, nav, header, footer, aside, form, .sr-only, [hidden]').remove();
  const root = $('article').first().length ? $('article').first() : $('main, [role="main"]').first();
  const passages = (root.length ? root : $('body')).find('p, li, td, dd').toArray()
    .map((node) => compact($(node).text())).filter((line) => line.length > 70);
  const primary = hint.primary || PRIMARY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
    || (host === 'github.com' && /\/releases\/tag\//.test(new URL(url).pathname));
  if (!passages.length) return null;
  // Keep short publisher passages for source verification. Pages with an explicit
  // archiving/text restriction are filtered before this point.
  return {
    url, title: title.slice(0, 240), publisher: publisher.slice(0, 120), date,
    type: primary ? 'primary' : host === 'news.ycombinator.com' ? 'community' : 'independent',
    hash: hash(passages.join('\n').slice(0, 12000)),
    excerpts: [...new Set(passages)].slice(0, 10).map((line) => line.slice(0, 380)),
  };
}

export async function fetchPublisher(hint, now) {
  const url = canonicalUrl(hint.url);
  if (!await allowedByRobots(url)) return null;
  const response = await fetchPublic(url);
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')
      || RESTRICTED.test(response.headers.get('x-robots-tag') ?? '')) return null;
  if (new URL(response.url).origin !== new URL(url).origin && !await allowedByRobots(response.url)) return null;
  return extractPublisher(await response.text(), response.url, hint, now);
}

const STOP_WORDS = new Set(['about', 'after', 'could', 'first', 'their', 'these', 'using', 'which', 'would', 'release', 'launches', 'official', 'latest']);
function keywords(title) {
  return [...new Set(title.toLowerCase().match(/[a-z0-9][a-z0-9.-]{2,}/g) ?? [])]
    .filter((word) => !STOP_WORDS.has(word)).slice(0, 18).sort();
}

export function groupEvent(source, events) {
  const words = keywords(source.title);
  for (const event of events) {
    const shared = event.keywords.filter((word) => words.includes(word)).length;
    const union = new Set([...words, ...event.keywords]).size;
    if (shared >= 3 && shared / union >= 0.48) return event;
  }
  return { id: hash(words.join(' ') || source.url).slice(0, 32), title: source.title, keywords: words };
}

export async function ingestSources(db, { searchWindow, now = Date.now(), env = process.env, fetchImpl = fetch } = {}) {
  const tasks = [...await rssSources(), ['Hacker News', hackerNews],
    ...RELEASE_REPOS.map((repo) => [repo, () => releases(repo)])];
  if (searchWindow !== null && searchWindow !== undefined) {
    tasks.push(...searchTasks(db, searchWindow, { now, env, fetchImpl }));
  }
  const results = await Promise.allSettled(tasks.map(([, run]) => run()));
  const hints = new Map();
  const failures = new Set();
  function add(items) {
    for (const item of items) {
      try {
        const url = canonicalUrl(item.url);
        if (!hints.has(url) || item.primary) hints.set(url, { ...item, url });
      } catch { /* Ignore malformed or non-public discovery URLs. */ }
    }
  }
  results.forEach((result, index) => {
    if (result.status === 'rejected') failures.add(tasks[index][0]);
  });
  const duckDuckGoIndex = tasks.findIndex(([name]) => name === 'duckduckgo');
  const duckDuckGo = results[duckDuckGoIndex];
  if (duckDuckGo?.status === 'fulfilled' && !duckDuckGo.value.length) failures.add('duckduckgo');
  for (let rank = 0; rank < 8; rank++) {
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value[rank]) add([result.value[rank]]);
    }
  }
  if (failures.has('duckduckgo') || failures.has('you') || hints.size < 4) {
    try { add(await gdelt()); } catch { failures.add('GDELT'); }
  }
  const events = (await db.query(
    "select id, title, keywords from editorial.events where first_seen > now() - interval '10 days' order by first_seen desc limit 1500",
  )).rows;
  const current = await db.query(
    "select url, event_id from editorial.sources where url = any($1) and fetched_at > now() - interval '12 hours'", [[...hints.keys()]],
  );
  const recentlyFetched = new Set(current.rows.map(({ url }) => url));
  const queue = [...hints.values()].filter((item) => !recentlyFetched.has(item.url)).slice(0, 100);
  let saved = 0;
  for (let start = 0; start < queue.length; start += 10) {
    const pages = await Promise.allSettled(queue.slice(start, start + 10).map((hint) => fetchPublisher(hint, now)));
    for (const result of pages) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const source = result.value;
      const previous = await db.query('select event_id from editorial.sources where url = $1', [source.url]);
      const oldEvent = events.find((event) => event.id === previous.rows[0]?.event_id);
      const event = oldEvent ?? groupEvent(source, events);
      if (!events.some(({ id }) => id === event.id)) events.push(event);
      await saveSource(db, source, event);
      saved++;
    }
  }
  console.log(JSON.stringify({ discovery: hints.size, saved, providerFailures: [...failures] }));
  return { saved, failures: [...failures] };
}
