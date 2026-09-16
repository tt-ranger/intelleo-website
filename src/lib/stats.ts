import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { getPublished, wordCount, type Post } from './content';

export interface SubjectStat {
  id: string;
  cluster: string;
  count: number;
  cap: number;
  /** 'ok' | 'near' (>=80% of cap) | 'full' */
  state: 'ok' | 'near' | 'full';
}

export interface Rejected {
  slug: string;
  reasons: string[];
}

function loadRegistry() {
  const reg = parseYaml(readFileSync('./src/data/subjects.yaml', 'utf8')) as {
    defaults?: { cap?: number };
    balance?: Record<string, number>;
    clusters: Record<string, { subjects: { id: string; cap?: number }[] }>;
  };
  const defaultCap = reg.defaults?.cap ?? 10;
  const subjects = Object.entries(reg.clusters).flatMap(([cluster, v]) =>
    v.subjects.map((s) => ({ id: s.id, cluster, cap: s.cap ?? defaultCap })),
  );
  return { subjects, balance: { maxClusterShare: 0.35, minNewsHookShare: 0.4, ...(reg.balance ?? {}) } };
}

/** Rejected drafts written by the quality gate's --quarantine mode. */
function readRejected(): Rejected[] {
  const dir = './drafts';
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.rejected.txt'))
    .map((f) => {
      const body = readFileSync(`${dir}/${f}`, 'utf8');
      return {
        slug: f.replace(/\.rejected\.txt$/, ''),
        reasons: body.split('\n').filter((l) => l.startsWith('[')),
      };
    });
}

export async function buildStats() {
  const registry = loadRegistry();
  const posts: Post[] = await getPublished();
  const total = posts.length;

  const counts: Record<string, number> = {};
  const clusters: Record<string, number> = {};
  for (const p of posts) {
    counts[p.data.subject] = (counts[p.data.subject] ?? 0) + 1;
    clusters[p.data.cluster] = (clusters[p.data.cluster] ?? 0) + 1;
  }

  const subjects: SubjectStat[] = registry.subjects
    .map((s) => {
      const count = counts[s.id] ?? 0;
      const ratio = count / s.cap;
      return { ...s, count, state: ratio >= 1 ? 'full' : ratio >= 0.8 ? 'near' : 'ok' } as SubjectStat;
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
  const sixMonthsAgo = Date.now() - 182 * 86_400_000;

  const rows = posts.map((p) => {
    const body = p.body ?? '';
    const last = (p.data.updatedDate ?? p.data.publishDate).valueOf();
    return {
      slug: p.id,
      title: p.data.title,
      cluster: p.data.cluster,
      subject: p.data.subject,
      publishDate: p.data.publishDate.toISOString().slice(0, 10),
      updatedDate: p.data.updatedDate?.toISOString().slice(0, 10) ?? '',
      words: wordCount(body),
      sources: p.data.sources.length,
      internalLinks: [...body.matchAll(/\]\((\/[^)\s]+)\)/g)].length,
      newsHook: Boolean(p.data.newsHook),
      originalData: p.data.originalData,
      stale: last < sixMonthsAgo,
    };
  });

  const clusterShare = Object.entries(clusters)
    .map(([id, count]) => ({ id, count, share: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);

  return {
    total,
    last30: posts.filter((p) => p.data.publishDate.valueOf() >= thirtyDaysAgo).length,
    subjects,
    subjectsAtCap: subjects.filter((s) => s.state === 'full').length,
    subjectsNearCap: subjects.filter((s) => s.state === 'near').length,
    headroom: subjects.reduce((n, s) => n + Math.max(0, s.cap - s.count), 0),
    clusterShare,
    clustersOverShare: clusterShare.filter((c) => total >= 10 && c.share > registry.balance.maxClusterShare),
    avgWords: total ? Math.round(rows.reduce((n, r) => n + r.words, 0) / total) : 0,
    newsHookShare: total ? rows.filter((r) => r.newsHook).length / total : 0,
    minNewsHookShare: registry.balance.minNewsHookShare,
    originalDataCount: rows.filter((r) => r.originalData).length,
    staleCount: rows.filter((r) => r.stale).length,
    rejected: readRejected(),
    rows,
  };
}
