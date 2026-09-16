import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/** Published posts, newest first. Drafts never reach the built site. */
export async function getPublished(): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.publishDate.valueOf() - a.data.publishDate.valueOf());
}

export async function getByCluster(cluster: string): Promise<Post[]> {
  return (await getPublished()).filter((p) => p.data.cluster === cluster);
}

/**
 * Related posts for the in-article block.
 *
 * Ranked so the cluster hub-and-spoke stays tight: same subject first
 * (closest topical match), then same cluster, then tag overlap.
 */
export async function getRelated(post: Post, limit = 3): Promise<Post[]> {
  const all = (await getPublished()).filter((p) => p.id !== post.id);
  const score = (p: Post) => {
    let s = 0;
    if (p.data.subject === post.data.subject) s += 100;
    if (p.data.cluster === post.data.cluster) s += 50;
    s += p.data.tags.filter((t) => post.data.tags.includes(t)).length * 5;
    return s;
  };
  return all
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.p.data.publishDate.valueOf() - a.p.data.publishDate.valueOf())
    .slice(0, limit)
    .map((x) => x.p);
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Rough word count from raw markdown body, used for reading time and the gate. */
export function wordCount(body: string): number {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>\[\]()`]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export function readingTime(body: string): number {
  return Math.max(1, Math.round(wordCount(body) / 225));
}
