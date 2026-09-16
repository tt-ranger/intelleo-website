/**
 * Pure content checks — no network, no filesystem writes, so they are
 * directly unit-testable. Network checks live in link-check.mjs.
 *
 * Every function returns an array of { level, code, message }.
 * level: 'error' blocks publication, 'warn' is advisory.
 */
import { wordCount, daysSince } from './articles.mjs';

const err = (code, message) => ({ level: 'error', code, message });
const warn = (code, message) => ({ level: 'warn', code, message });

export const MIN_WORDS = 1200;
export const MIN_SOURCES = 3;
export const MIN_INTERNAL_LINKS = 2;
export const DUPLICATE_THRESHOLD = 0.85;

/** Strip fenced code so prose checks don't trip over sample code. */
function prose(body) {
  return body.replace(/```[\s\S]*?```/g, '\n');
}

export function checkSubstance(article) {
  const n = wordCount(article.body);
  return n < MIN_WORDS
    ? [err('thin-content', `${n} words; minimum is ${MIN_WORDS}. Thin content is the main scaled-content-abuse signal.`)]
    : [];
}

export function checkSources(article) {
  const out = [];
  const sources = article.data.sources ?? [];
  if (sources.length < MIN_SOURCES) {
    out.push(err('few-sources', `${sources.length} sources; minimum is ${MIN_SOURCES}.`));
  }
  sources.forEach((s, i) => {
    if (!s?.url || !/^https?:\/\//.test(s.url)) out.push(err('bad-source-url', `sources[${i}] has no valid URL.`));
    if (!s?.publisher) out.push(err('source-no-publisher', `sources[${i}] has no publisher.`));
    if (!s?.date) out.push(err('source-no-date', `sources[${i}] has no date.`));
  });
  return out;
}

export function checkAnswerFirst(article) {
  const a = (article.data.answer ?? '').trim();
  if (!a) return [err('no-answer', 'Missing `answer` — the answer-first summary is required.')];
  const sentences = a.split(/[.!?]+\s/).filter((s) => s.trim().length > 12);
  if (sentences.length < 2 || sentences.length > 4) {
    return [warn('answer-length', `answer has ${sentences.length} sentences; aim for 2-3.`)];
  }
  return [];
}

export function checkQuestionHeadings(article) {
  const h2s = prose(article.body).match(/^##\s+.+$/gm) ?? [];
  if (h2s.length < 2) return [err('too-few-sections', `${h2s.length} H2 sections; need at least 2.`)];
  const questions = h2s.filter((h) => h.trim().endsWith('?'));
  const ratio = questions.length / h2s.length;
  return ratio < 0.5
    ? [err('headings-not-questions', `${questions.length}/${h2s.length} H2s are questions; need at least half. Question headings match how people query engines.`)]
    : [];
}

export function checkInternalLinks(article, { publishedSlugs = [] } = {}) {
  const out = [];
  const links = [...prose(article.body).matchAll(/\]\((\/[^)\s]+)\)/g)].map((m) => m[1]);
  const pillar = `/topics/${article.data.cluster}`;

  if (!links.some((l) => l === pillar || l.startsWith(`${pillar}#`))) {
    out.push(err('no-pillar-link', `No link to the cluster pillar ${pillar}. Orphaned articles are not crawled or cited.`));
  }
  const articleLinks = links.filter((l) => l.startsWith('/blog/'));
  const valid = articleLinks.filter((l) => publishedSlugs.includes(l.replace(/^\/blog\//, '').replace(/\/$/, '')));
  const broken = articleLinks.filter((l) => !valid.includes(l));

  for (const b of broken) out.push(err('broken-internal-link', `Internal link ${b} does not resolve to a published article.`));

  // Only enforce sibling linking once there is something to link to.
  if (publishedSlugs.length >= MIN_INTERNAL_LINKS && valid.length < MIN_INTERNAL_LINKS) {
    out.push(err('few-internal-links', `${valid.length} in-body links to existing articles; need ${MIN_INTERNAL_LINKS}.`));
  }
  return out;
}

export function checkNewsFreshness(article, { maxAgeDays = 30 } = {}) {
  const hook = article.data.newsHook;
  if (!hook) return [];
  const age = daysSince(hook.date);
  if (Number.isNaN(age)) return [err('bad-news-date', 'newsHook.date is not a valid date.')];
  return age > maxAgeDays
    ? [err('stale-news-hook', `newsHook is ${Math.round(age)} days old; limit is ${maxAgeDays}.`)]
    : [];
}

export function checkSubjectCap(article, { registry, subjectCounts = {} }) {
  const meta = registry.byId[article.data.subject];
  if (!meta) {
    return [err('unknown-subject', `subject "${article.data.subject}" is not in subjects.yaml.`)];
  }
  if (meta.cluster !== article.data.cluster) {
    return [err('subject-cluster-mismatch', `subject "${article.data.subject}" belongs to cluster "${meta.cluster}", not "${article.data.cluster}".`)];
  }
  const current = subjectCounts[article.data.subject] ?? 0;
  if (current >= meta.cap) {
    return [err('subject-at-cap', `subject "${article.data.subject}" already has ${current}/${meta.cap} articles. Add a new subject to subjects.yaml instead.`)];
  }
  if (current + 1 >= meta.cap - 1) {
    return [warn('subject-near-cap', `subject "${article.data.subject}" will be at ${current + 1}/${meta.cap}. Plan replacements.`)];
  }
  return [];
}

export function checkClusterBalance(article, { clusterCounts = {}, total = 0, maxShare = 0.35 }) {
  const next = (clusterCounts[article.data.cluster] ?? 0) + 1;
  const nextTotal = total + 1;
  if (nextTotal < 10) return []; // share is meaningless on a tiny corpus
  const share = next / nextTotal;
  return share > maxShare
    ? [warn('cluster-imbalance', `cluster "${article.data.cluster}" would be ${(share * 100).toFixed(0)}% of output; target is under ${(maxShare * 100).toFixed(0)}%.`)]
    : [];
}

/**
 * Statistics must be attributable. A bare percentage with no year and no
 * nearby citation is the classic unverifiable AI-written claim.
 */
export function checkClaimShape(article) {
  const out = [];
  const text = prose(article.body);
  const lines = text.split(/\n/);
  lines.forEach((line, i) => {
    if (/^\s*[|>]/.test(line)) return; // tables and quotes carry their own context
    const hasStat = /\b\d+(\.\d+)?\s?%|\b\d+(\.\d+)?x\b/.test(line);
    if (!hasStat) return;
    const hasYear = /\b(19|20)\d{2}\b/.test(line);
    const hasLink = /\]\(https?:\/\//.test(line);
    if (!hasYear || !hasLink) {
      out.push(warn('unsourced-stat', `line ${i + 1}: statistic without ${!hasYear ? 'a date' : ''}${!hasYear && !hasLink ? ' and ' : ''}${!hasLink ? 'a source link' : ''}.`));
    }
  });
  return out;
}

/** Shingled Jaccard similarity — dependency-free near-duplicate detection. */
export function similarity(a, b, k = 5) {
  const shingles = (t) => {
    const w = t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const set = new Set();
    for (let i = 0; i + k <= w.length; i++) set.add(w.slice(i, i + k).join(' '));
    return set;
  };
  const A = shingles(a);
  const B = shingles(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return inter / (A.size + B.size - inter);
}

export function checkDuplication(article, { corpus = [] } = {}) {
  const out = [];
  for (const other of corpus) {
    if (other.slug === article.slug) continue;
    const s = similarity(article.body, other.body);
    if (s > DUPLICATE_THRESHOLD) {
      out.push(err('duplicate-topic', `${(s * 100).toFixed(0)}% similar to ${other.slug}; threshold is ${DUPLICATE_THRESHOLD * 100}%.`));
    }
    if (article.data.title.trim().toLowerCase() === other.data.title.trim().toLowerCase()) {
      out.push(err('duplicate-title', `title is identical to ${other.slug}.`));
    }
  }
  return out;
}

export function checkRateLimit(article, { published = [], maxPerDay = 4 }) {
  const day = new Date(article.data.publishDate).toISOString().slice(0, 10);
  const sameDay = published.filter(
    (p) => p.slug !== article.slug && new Date(p.data.publishDate).toISOString().slice(0, 10) === day,
  );
  return sameDay.length >= maxPerDay
    ? [err('rate-limit', `${sameDay.length} articles already published on ${day}; limit is ${maxPerDay}/day.`)]
    : [];
}

/** Run every pure check. Network citation checks are layered on by the CLI. */
export function runPureChecks(article, ctx) {
  return [
    ...checkSubstance(article),
    ...checkSources(article),
    ...checkAnswerFirst(article),
    ...checkQuestionHeadings(article),
    ...checkInternalLinks(article, ctx),
    ...checkNewsFreshness(article, { maxAgeDays: ctx.registry.balance.newsHookMaxAgeDays }),
    ...checkSubjectCap(article, ctx),
    ...checkClusterBalance(article, { ...ctx, maxShare: ctx.registry.balance.maxClusterShare }),
    ...checkClaimShape(article),
    ...checkDuplication(article, ctx),
    ...checkRateLimit(article, { ...ctx, maxPerDay: ctx.registry.balance.maxPerDay }),
  ];
}
