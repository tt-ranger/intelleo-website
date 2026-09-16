import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Subject registry is the single source of truth for the subject-matter axis.
 * Loading it here means an article naming an unknown subject fails the BUILD,
 * not just the quality gate — the agent cannot invent taxonomy.
 */
const registry = parseYaml(readFileSync('./src/data/subjects.yaml', 'utf8')) as {
  clusters: Record<string, { subjects: { id: string }[] }>;
};

const SUBJECTS_BY_CLUSTER = Object.fromEntries(
  Object.entries(registry.clusters).map(([cluster, v]) => [cluster, v.subjects.map((s) => s.id)]),
) as Record<string, string[]>;

const ALL_SUBJECTS = Object.values(SUBJECTS_BY_CLUSTER).flat();

const source = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  publisher: z.string().min(1),
  // Every claim needs a dated source — enforced structurally, not by convention.
  date: z.coerce.date(),
});

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z
    .object({
      // 60/155 are the practical truncation points in Google's SERP.
      title: z.string().min(10).max(60),
      description: z.string().min(50).max(155),

      /**
       * Answer-first summary: a direct answer to the title question, rendered
       * above the body and emitted as schema `abstract`. Structural rather
       * than a prose convention, so generative engines get one clean,
       * self-contained chunk to lift and the gate can verify it exists.
       */
      answer: z.string().min(120).max(400),

      cluster: z.enum(['ai', 'ml', 'data', 'software-for-ai', 'geo']),
      subject: z.string().refine((s) => ALL_SUBJECTS.includes(s), {
        message: `subject must be declared in src/data/subjects.yaml. Known: ${ALL_SUBJECTS.join(', ')}`,
      }),

      publishDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      author: z.string().default('Sandeep Katti'),
      tags: z.array(z.string()).default([]),

      // Minimum three dated sources. Citation density is the strongest
      // documented lever on generative-engine visibility.
      sources: z.array(source).min(3, 'at least 3 dated sources are required'),

      // Recency axis. Freshness is checked against newsHookMaxAgeDays by the gate.
      newsHook: z
        .object({
          headline: z.string().min(1),
          url: z.string().url(),
          date: z.coerce.date(),
        })
        .optional(),

      faq: z
        .array(z.object({ question: z.string().min(1), answer: z.string().min(1) }))
        .default([]),

      /** First-hand benchmark or project metric — the most citable content type. */
      originalData: z.boolean().default(false),
      draft: z.boolean().default(false),
    })
    .superRefine((data, ctx) => {
      const allowed = SUBJECTS_BY_CLUSTER[data.cluster] ?? [];
      if (!allowed.includes(data.subject)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subject'],
          message: `subject "${data.subject}" does not belong to cluster "${data.cluster}". Allowed: ${allowed.join(', ')}`,
        });
      }
      if (data.updatedDate && data.updatedDate < data.publishDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['updatedDate'],
          message: 'updatedDate cannot precede publishDate',
        });
      }
    }),
});

export const collections = { blog };
export { SUBJECTS_BY_CLUSTER, ALL_SUBJECTS };
