/**
 * Node-side article reader.
 *
 * The CI scripts run outside Astro, so they cannot use `astro:content`.
 * This parses the same markdown files directly and is the single source of
 * truth for counts used by the balance rules and the quality gate.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const ROOT = resolve(process.cwd());
export const BLOG_DIR = join(ROOT, 'src/content/blog');
export const DRAFTS_DIR = join(ROOT, 'drafts');
export const REGISTRY_PATH = join(ROOT, 'src/data/subjects.yaml');

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseArticle(inputPath) {
  // Resolve to absolute so paths given on the CLI compare correctly against
  // BLOG_DIR (quarantine depends on that check).
  const path = resolve(inputPath);
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(FRONTMATTER);
  if (!m) throw new Error(`${path}: missing YAML frontmatter`);
  let data;
  try {
    data = parseYaml(m[1]);
  } catch (e) {
    throw new Error(`${path}: frontmatter is not valid YAML — ${e.message}`);
  }
  return { path, slug: path.split('/').pop().replace(/\.md$/, ''), data: data ?? {}, body: m[2] ?? '' };
}

export function listArticles(dir = BLOG_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseArticle(join(dir, f)));
}

/** Published = present in the collection and not flagged draft. */
export function listPublished(dir = BLOG_DIR) {
  return listArticles(dir).filter((a) => a.data.draft !== true);
}

export function loadRegistry() {
  const reg = parseYaml(readFileSync(REGISTRY_PATH, 'utf8'));
  const cap = reg.defaults?.cap ?? 10;
  const subjects = [];
  for (const [cluster, v] of Object.entries(reg.clusters)) {
    for (const s of v.subjects) {
      subjects.push({ id: s.id, cluster, cap: s.cap ?? cap });
    }
  }
  return {
    balance: {
      maxClusterShare: 0.35,
      minNewsHookShare: 0.4,
      newsHookMaxAgeDays: 30,
      maxPerDay: 4,
      ...(reg.balance ?? {}),
    },
    defaults: { cap },
    subjects,
    clusters: Object.keys(reg.clusters),
    byId: Object.fromEntries(subjects.map((s) => [s.id, s])),
  };
}

export function wordCount(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\|.*\|$/gm, ' ')
    .replace(/[#*_>\[\]()`]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export function daysSince(date) {
  return (Date.now() - new Date(date).getTime()) / 86_400_000;
}

/** Subject -> published count. Drives cap enforcement and the /review bars. */
export function subjectCounts(articles) {
  const counts = {};
  for (const a of articles) counts[a.data.subject] = (counts[a.data.subject] ?? 0) + 1;
  return counts;
}

export function clusterCounts(articles) {
  const counts = {};
  for (const a of articles) counts[a.data.cluster] = (counts[a.data.cluster] ?? 0) + 1;
  return counts;
}
