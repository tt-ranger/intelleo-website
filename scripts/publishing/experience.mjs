/**
 * Intelleo's first-hand experience as citable sources.
 *
 * Entries in src/content/experience are written by Intelleo (case studies,
 * benchmarks, field notes) and published at /experience/<slug>. The writer may
 * cite them for first-hand observations; without a matching entry it may not
 * claim any experience at all. They are local files, so they are attached to
 * a brief after the external sources are re-fetched, never fetched themselves.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, parseArticle } from '../lib/articles.mjs';

export const EXPERIENCE_DIR = join(ROOT, 'src/content/experience');
export const EXPERIENCE_KIND = 'intelleo';
const SITE_URL = 'https://www.intelleo.in';
// Above any index into the planner's ranked pool (at most 52 rows).
const FIRST_ID = 1000;
const MAX_PER_BRIEF = 2;
const MAX_EXCERPTS = 10;

/** Markdown paragraph -> plain sentence text that evidence quotes can match. */
export function plainText(markdown) {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function excerptsOf(body) {
  return body
    .replace(/```[\s\S]*?```/g, '\n\n')
    .split(/\n\s*\n/)
    .filter((block) => !/^\s*(#|\||[-*+] |\d+\. )/.test(block))
    .map(plainText)
    .filter((text) => text.length >= 40)
    .slice(0, MAX_EXCERPTS);
}

export function loadExperience(dir = EXPERIENCE_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md') && !file.startsWith('_'))
    .map((file) => parseArticle(join(dir, file)))
    .filter(({ data }) => data.draft !== true);
}

/** Best-matching entries for a brief: same subject first, then same cluster. */
export function relevantExperience(entries, { subject, cluster }) {
  const score = ({ data }) => ((data.subjects ?? []).includes(subject) ? 2 : 0) + (data.cluster === cluster ? 1 : 0);
  return entries
    .filter((entry) => score(entry) > 0)
    .sort((a, b) => score(b) - score(a) || new Date(b.data.publishDate) - new Date(a.data.publishDate))
    .slice(0, MAX_PER_BRIEF);
}

export function experienceSource(entry, id) {
  return {
    id, url: `${SITE_URL}/experience/${entry.slug}`, title: entry.data.title, publisher: 'Intelleo',
    kind: EXPERIENCE_KIND, date: new Date(entry.data.updatedDate ?? entry.data.publishDate).toISOString(),
    lead: false, event: null, excerpts: excerptsOf(entry.body),
  };
}

/** Replace any experience sources on a brief with the current matching entries. Idempotent. */
export function attachExperience(brief, entries = loadExperience()) {
  const external = brief.sources.filter(({ kind }) => kind !== EXPERIENCE_KIND);
  const own = relevantExperience(entries, brief)
    .map((entry, index) => experienceSource(entry, FIRST_ID + index))
    .filter(({ excerpts }) => excerpts.length > 0);
  return { ...brief, sources: [...external, ...own] };
}
