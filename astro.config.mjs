// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const SITE = 'https://www.intelleo.in';

/**
 * URL -> last modified date for content pages, so crawlers can prioritise
 * new and corrected articles. Reads the same frontmatter Astro builds from.
 */
function contentDates() {
  const dates = new Map();
  for (const [dir, route] of [['src/content/blog', 'blog'], ['src/content/experience', 'experience']]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('_'))) {
      const front = readFileSync(`${dir}/${file}`, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const data = front ? parseYaml(front[1]) ?? {} : {};
      const date = new Date(data.updatedDate ?? data.publishDate);
      if (data.draft !== true && Number.isFinite(date.valueOf())) {
        dates.set(`${SITE}/${route}/${file.replace(/\.md$/, '')}/`, date.toISOString());
      }
    }
  }
  return dates;
}
const lastmod = contentDates();

export default defineConfig({
  site: SITE,
  trailingSlash: 'ignore',
  integrations: [
    sitemap({
      filter: (page) =>
        // /review is an internal dashboard.
        !page.includes('/review') &&
        // /admin is the CMS editor UI.
        !page.includes('/admin') &&
        // /blog/page/1 duplicates /blog; only paginated pages 2+ belong here.
        !/\/blog\/page\/1\/?$/.test(page),
      serialize: (item) => {
        const modified = lastmod.get(item.url);
        return modified ? { ...item, lastmod: modified } : item;
      },
    }),
  ],
  build: { format: 'directory' },
});
