// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://www.intelleo.in',
  trailingSlash: 'ignore',
  integrations: [
    sitemap({
      filter: (page) =>
        // /review is an internal dashboard.
        !page.includes('/review') &&
        // /blog/page/1 duplicates /blog; only paginated pages 2+ belong here.
        !/\/blog\/page\/1\/?$/.test(page),
    }),
  ],
  build: { format: 'directory' },
});
