import type { APIContext } from 'astro';
import { readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { CLUSTERS, CLUSTER_IDS, AUTHOR } from '../../data/site';

/**
 * Sveltia CMS config, generated rather than hand-maintained.
 *
 * The subject dropdown is built from src/data/subjects.yaml, so the CMS can
 * never offer a subject the content schema would reject. Hand-writing this
 * file would guarantee drift the first time a subject is added.
 */
export const prerender = true;

const registry = parseYaml(readFileSync('./src/data/subjects.yaml', 'utf8')) as {
  clusters: Record<string, { subjects: { id: string }[] }>;
};

const label = (s: string) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Grouped so the flat list stays navigable; the gate still enforces that the
// chosen subject belongs to the chosen cluster.
const subjectOptions = Object.entries(registry.clusters).flatMap(([cluster, v]) =>
  v.subjects.map((s) => ({
    label: `${CLUSTERS[cluster as keyof typeof CLUSTERS].label} — ${label(s.id)}`,
    value: s.id,
  })),
);

export async function GET(_context: APIContext) {
  const config = {
    backend: {
      name: 'github',
      repo: 'tt-ranger/intelleo-website',
      branch: 'main',
      // OAuth proxy. GitHub Pages cannot hold the client secret, so token
      // exchange happens in a free Cloudflare Worker. See README.
      base_url: import.meta.env.PUBLIC_CMS_AUTH_URL || 'https://intelleo-cms-auth.sandeep-sudheendra.workers.dev',
    },

    // Saves open a pull request instead of committing to main, so everything
    // written here passes the same quality gate as the agent's output.
    publish_mode: 'editorial_workflow',

    media_folder: 'public/images',
    public_folder: '/images',
    site_url: 'https://www.intelleo.in',
    display_url: 'https://www.intelleo.in',

    collections: [
      {
        name: 'blog',
        label: 'Articles',
        label_singular: 'Article',
        folder: 'src/content/blog',
        create: true,
        slug: '{{slug}}',
        extension: 'md',
        format: 'yaml-frontmatter',
        preview_path: 'blog/{{slug}}',
        summary: '{{title}}  ·  {{cluster}}/{{subject}}',
        sortable_fields: ['publishDate', 'title', 'cluster'],
        view_groups: [
          { label: 'Cluster', field: 'cluster' },
          { label: 'Subject', field: 'subject' },
        ],
        fields: [
          {
            name: 'title', label: 'Title', widget: 'string', required: true,
            pattern: ['^.{10,60}$', 'Must be 10-60 characters (Google truncates past ~60).'],
          },
          {
            name: 'description', label: 'Meta description', widget: 'text', required: true,
            pattern: ['^.{50,155}$', 'Must be 50-155 characters.'],
            hint: 'Shown in search results. Aim for a complete sentence.',
          },
          {
            name: 'answer', label: 'Answer-first summary', widget: 'text', required: true,
            pattern: ['^[\\s\\S]{120,400}$', 'Must be 120-400 characters.'],
            hint: '2-3 sentences directly answering the title question. This is the passage generative engines are most likely to lift and cite.',
          },
          {
            name: 'cluster', label: 'Cluster (domain)', widget: 'select', required: true,
            options: CLUSTER_IDS.map((id) => ({ label: CLUSTERS[id].label, value: id })),
          },
          {
            name: 'subject', label: 'Subject', widget: 'select', required: true,
            options: subjectOptions,
            hint: 'Must belong to the cluster above, and that subject must be under its 10-article cap. Both are enforced by the quality gate.',
          },
          { name: 'publishDate', label: 'Publish date', widget: 'datetime', date_format: 'YYYY-MM-DD', time_format: false, required: true },
          { name: 'updatedDate', label: 'Updated date', widget: 'datetime', date_format: 'YYYY-MM-DD', time_format: false, required: false },
          { name: 'author', label: 'Author', widget: 'string', default: AUTHOR.name, required: false },
          { name: 'tags', label: 'Tags', widget: 'list', required: false, default: [] },
          {
            name: 'sources', label: 'Sources', widget: 'list', required: true,
            label_singular: 'Source',
            summary: '{{fields.publisher}} — {{fields.title}}',
            hint: 'At least 3. Every URL is fetched by the quality gate and checked for topical match, so fabricated citations will fail the build.',
            fields: [
              { name: 'url', label: 'URL', widget: 'string', required: true, pattern: ['^https?://', 'Must be a full URL.'] },
              { name: 'title', label: 'Title', widget: 'string', required: true },
              { name: 'publisher', label: 'Publisher', widget: 'string', required: true },
              { name: 'date', label: 'Date', widget: 'datetime', date_format: 'YYYY-MM-DD', time_format: false, required: true },
            ],
          },
          {
            name: 'newsHook', label: 'News hook', widget: 'object', required: false, collapsed: true,
            hint: 'Optional. If set, the item must be no more than 30 days old.',
            fields: [
              { name: 'headline', label: 'Headline', widget: 'string', required: true },
              { name: 'url', label: 'URL', widget: 'string', required: true },
              { name: 'date', label: 'Date', widget: 'datetime', date_format: 'YYYY-MM-DD', time_format: false, required: true },
            ],
          },
          {
            name: 'faq', label: 'FAQ', widget: 'list', required: false, default: [],
            label_singular: 'Question',
            summary: '{{fields.question}}',
            hint: 'Emitted as FAQPage structured data.',
            fields: [
              { name: 'question', label: 'Question', widget: 'string', required: true },
              { name: 'answer', label: 'Answer', widget: 'text', required: true },
            ],
          },
          { name: 'originalData', label: 'Contains original data', widget: 'boolean', default: false, required: false, hint: 'First-hand benchmarks or project metrics — the most citable content type.' },
          { name: 'draft', label: 'Draft', widget: 'boolean', default: false, required: false },
          {
            name: 'body', label: 'Body', widget: 'markdown', required: true,
            hint: 'Minimum 1200 words. At least half of H2 headings must end in "?". Must link to the cluster pillar (/topics/...) and 2+ sibling articles.',
          },
        ],
      },
    ],
  };

  return new Response(toYaml(config, { lineWidth: 0 }), {
    headers: { 'content-type': 'text/yaml; charset=utf-8' },
  });
}
