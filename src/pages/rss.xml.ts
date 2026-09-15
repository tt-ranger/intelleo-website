import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getPublished } from '../lib/content';
import { SITE } from '../data/site';

export async function GET(context: APIContext) {
  const posts = await getPublished();
  return rss({
    title: 'Intelleo Insights',
    description: SITE.description,
    site: context.site ?? SITE.url,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.publishDate,
      link: `/blog/${p.id}`,
      categories: [p.data.cluster, ...p.data.tags],
    })),
    customData: '<language>en</language>',
  });
}
