#!/usr/bin/env node
/**
 * Topic planner — composes the next article brief as a deliberate
 * intersection of three axes:
 *
 *   domain  : cluster, weighted INVERSELY to its current share so no
 *             practice runs away with the output
 *   subject : a subject from subjects.yaml that is still under its cap
 *   news    : a recent item (<= newsHookMaxAgeDays) relevant to both
 *
 * The agent consumes the emitted brief. It does not choose its own topics,
 * which is what keeps the corpus balanced and the caps meaningful.
 *
 *   node scripts/topic-planner.mjs              # one brief, human-readable
 *   node scripts/topic-planner.mjs --count 4    # a day's worth
 *   node scripts/topic-planner.mjs --json
 *   node scripts/topic-planner.mjs --offline    # skip feeds (evergreen only)
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { listPublished, loadRegistry, subjectCounts, clusterCounts, daysSince } from './lib/articles.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const COUNT = parseInt(flag('--count', '1'), 10);
const JSON_OUT = argv.includes('--json');
const OFFLINE = argv.includes('--offline');

const registry = loadRegistry();
const published = listPublished();
const sCounts = subjectCounts(published);
const cCounts = clusterCounts(published);
const total = published.length;

const CLUSTER_TERMS = {
  ai: ['ai', 'artificial intelligence', 'llm', 'genai', 'agent', 'adoption', 'enterprise'],
  ml: ['machine learning', 'model', 'training', 'benchmark', 'fine-tune', 'evaluation', 'mlops'],
  data: ['data', 'pipeline', 'warehouse', 'etl', 'streaming', 'database', 'lakehouse'],
  'software-for-ai': ['rag', 'retrieval', 'vector', 'embedding', 'api', 'inference', 'serving', 'context'],
  geo: ['search', 'citation', 'crawler', 'seo', 'answer engine', 'index', 'ranking', 'schema'],
};

/** Minimal RSS/Atom item extraction — avoids pulling in an XML dependency. */
function parseFeed(xml, publisher) {
  const pick = (block, ...tags) => {
    for (const t of tags) {
      const m = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i'));
      if (m) return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
    }
    return '';
  };
  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return blocks
    .map((b) => {
      const link = pick(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '');
      const dateStr = pick(b, 'pubDate', 'published', 'updated', 'dc:date');
      const date = dateStr ? new Date(dateStr) : null;
      return {
        headline: pick(b, 'title'),
        summary: pick(b, 'description', 'summary').slice(0, 400),
        url: link,
        date,
        publisher,
      };
    })
    .filter((i) => i.headline && i.url && i.date && !Number.isNaN(i.date.valueOf()));
}

async function fetchNews() {
  if (OFFLINE) return [];
  const cfg = parseYaml(readFileSync('./src/data/feeds.yaml', 'utf8'));
  const maxAge = registry.balance.newsHookMaxAgeDays;
  const results = await Promise.allSettled(
    cfg.feeds.map(async (f) => {
      const res = await fetch(f.url, {
        headers: { 'user-agent': 'IntelleoTopicPlanner/1.0 (+https://www.intelleo.in)' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseFeed(await res.text(), f.publisher).map((i) => ({ ...i, clusters: f.clusters }));
    }),
  );
  return results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .filter((i) => daysSince(i.date) <= maxAge);
}

const words = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

function relevance(item, cluster, subject) {
  const hay = `${item.headline} ${item.summary}`.toLowerCase();
  let score = 0;
  if (item.clusters?.includes(cluster)) score += 3;
  for (const t of CLUSTER_TERMS[cluster] ?? []) if (hay.includes(t)) score += 2;
  for (const w of words(subject.replace(/-/g, ' '))) if (w.length > 3 && hay.includes(w)) score += 4;
  // Freshness bonus, linear over the allowed window.
  score += Math.max(0, registry.balance.newsHookMaxAgeDays - daysSince(item.date)) / 10;
  return score;
}

const news = await fetchNews();
const plans = [];
// Local counters so a multi-brief run does not propose the same subject twice.
const localSubject = { ...sCounts };
const localCluster = { ...cCounts };
let localTotal = total;
const usedNews = new Set();

for (let n = 0; n < COUNT; n++) {
  // Domain: inverse-share weighting, so under-represented clusters win.
  const clusterScores = registry.clusters
    .map((id) => {
      const headroom = registry.subjects
        .filter((s) => s.cluster === id)
        .reduce((acc, s) => acc + Math.max(0, s.cap - (localSubject[s.id] ?? 0)), 0);
      if (headroom === 0) return null;
      const share = localTotal ? (localCluster[id] ?? 0) / localTotal : 0;
      return { id, score: (1 - share) * 10 + headroom * 0.1, share, headroom };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (clusterScores.length === 0) {
    plans.push({ error: 'Every subject is at cap. Add subjects to src/data/subjects.yaml.' });
    break;
  }
  const cluster = clusterScores[0].id;

  // Subject: most headroom first within the chosen cluster.
  const subject = registry.subjects
    .filter((s) => s.cluster === cluster && (localSubject[s.id] ?? 0) < s.cap)
    .map((s) => ({ ...s, used: localSubject[s.id] ?? 0 }))
    .sort((a, b) => a.used - b.used || a.id.localeCompare(b.id))[0];

  // News: best-scoring unused item for this domain+subject.
  const candidate = news
    .filter((i) => !usedNews.has(i.url))
    .map((i) => ({ i, s: relevance(i, cluster, subject.id) }))
    .sort((a, b) => b.s - a.s)[0];
  const hook = candidate && candidate.s >= 6 ? candidate.i : null;
  if (hook) usedNews.add(hook.url);

  plans.push({
    cluster,
    subject: subject.id,
    subjectUsage: `${subject.used}/${subject.cap}`,
    clusterShare: `${Math.round((clusterScores[0].share ?? 0) * 100)}%`,
    newsHook: hook
      ? { headline: hook.headline, url: hook.url, date: hook.date.toISOString().slice(0, 10), publisher: hook.publisher }
      : null,
    angle: hook
      ? `Use "${hook.headline}" (${hook.publisher}) as the opening hook, then answer the ${subject.id.replace(/-/g, ' ')} question it raises.`
      : `Evergreen piece on ${subject.id.replace(/-/g, ' ')}. No sufficiently relevant recent item found — prefer first-hand project experience or original benchmark data.`,
    requirements: {
      minWords: 1200,
      minSources: 3,
      pillarLink: `/topics/${cluster}`,
      siblingLinks: published
        .filter((p) => p.data.cluster === cluster)
        .slice(0, 3)
        .map((p) => `/blog/${p.slug}`),
      questionHeadings: 'at least half of H2s must end in "?"',
      answerFirst: 'frontmatter `answer`: 2-3 sentences, 120-400 chars',
    },
  });

  localSubject[subject.id] = (localSubject[subject.id] ?? 0) + 1;
  localCluster[cluster] = (localCluster[cluster] ?? 0) + 1;
  localTotal += 1;
}

if (JSON_OUT) {
  console.log(JSON.stringify({ generated: new Date().toISOString(), newsItems: news.length, plans }, null, 2));
} else {
  console.log(`Topic planner — ${published.length} published, ${news.length} recent news items\n`);
  plans.forEach((p, i) => {
    if (p.error) return console.log(`  ${p.error}`);
    console.log(`Brief ${i + 1}`);
    console.log(`  cluster : ${p.cluster} (currently ${p.clusterShare} of output)`);
    console.log(`  subject : ${p.subject} [${p.subjectUsage}]`);
    console.log(`  news    : ${p.newsHook ? `${p.newsHook.headline} — ${p.newsHook.publisher}, ${p.newsHook.date}` : 'none (evergreen)'}`);
    console.log(`  angle   : ${p.angle}`);
    console.log(`  links   : pillar ${p.requirements.pillarLink}${p.requirements.siblingLinks.length ? `, siblings ${p.requirements.siblingLinks.join(', ')}` : ' (no siblings yet)'}\n`);
  });
}
