#!/usr/bin/env node
/**
 * Quality gate.
 *
 * Publishing is autonomous, so this is the only thing standing between the
 * writing agent and a scaled-content problem. Anything that fails is moved
 * out of the collection into drafts/ and never reaches the built site.
 *
 *   node scripts/quality-gate.mjs                  # check everything
 *   node scripts/quality-gate.mjs a.md b.md        # check specific files
 *   node scripts/quality-gate.mjs --quarantine     # move failures to drafts/
 *   node scripts/quality-gate.mjs --offline        # skip network citation checks
 *   node scripts/quality-gate.mjs --json           # machine-readable report
 */
import { renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  listPublished, listArticles, loadRegistry, parseArticle,
  subjectCounts, clusterCounts, BLOG_DIR, DRAFTS_DIR,
} from './lib/articles.mjs';
import { runPureChecks } from './lib/checks.mjs';
import { checkSources as verifyCitations } from './link-check.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const files = argv.filter((a) => !a.startsWith('--'));
const QUARANTINE = flags.has('--quarantine');
const OFFLINE = flags.has('--offline');
const JSON_OUT = flags.has('--json');

const registry = loadRegistry();
const targets = files.length ? files.map(parseArticle) : listArticles();
const targetSlugs = new Set(targets.map((t) => t.slug));

// Corpus = already-published articles that are not themselves under test.
const corpus = listPublished().filter((a) => !targetSlugs.has(a.slug));

const ctx = {
  registry,
  corpus,
  published: corpus,
  publishedSlugs: corpus.map((a) => a.slug),
  subjectCounts: subjectCounts(corpus),
  clusterCounts: clusterCounts(corpus),
  total: corpus.length,
};

const report = [];

for (const article of targets) {
  if (article.data.draft === true) {
    report.push({ slug: article.slug, skipped: 'draft', issues: [] });
    continue;
  }

  const issues = runPureChecks(article, ctx);

  if (!OFFLINE && Array.isArray(article.data.sources)) {
    const results = await verifyCitations(article.data.sources);
    for (const r of results) {
      if (!r.ok) issues.push({ level: 'error', code: r.code, message: `${r.url} — ${r.message}` });
    }
  }

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warn');
  report.push({ slug: article.slug, path: article.path, errors, warnings, passed: errors.length === 0 });

  // Accepted articles join the corpus, so same-run siblings see accurate
  // counts (a second article in a capped subject is caught immediately).
  if (errors.length === 0) {
    ctx.corpus.push(article);
    ctx.published.push(article);
    ctx.publishedSlugs.push(article.slug);
    ctx.subjectCounts[article.data.subject] = (ctx.subjectCounts[article.data.subject] ?? 0) + 1;
    ctx.clusterCounts[article.data.cluster] = (ctx.clusterCounts[article.data.cluster] ?? 0) + 1;
    ctx.total += 1;
  } else if (QUARANTINE && article.path.startsWith(BLOG_DIR)) {
    mkdirSync(DRAFTS_DIR, { recursive: true });
    const dest = join(DRAFTS_DIR, basename(article.path));
    renameSync(article.path, dest);
    writeFileSync(
      dest.replace(/\.md$/, '.rejected.txt'),
      `Quarantined ${new Date().toISOString()}\n\n` +
        errors.map((e) => `[${e.code}] ${e.message}`).join('\n') + '\n',
    );
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ report }, null, 2));
} else {
  const checked = report.filter((r) => !r.skipped);
  if (checked.length === 0) console.log('No articles to check.');
  for (const r of checked) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    console.log(`\n${mark}  ${r.slug}`);
    for (const e of r.errors) console.log(`   error  [${e.code}] ${e.message}`);
    for (const w of r.warnings) console.log(`   warn   [${w.code}] ${w.message}`);
  }
  const failed = checked.filter((r) => !r.passed).length;
  console.log(
    `\n${checked.length} checked · ${checked.length - failed} passed · ${failed} failed` +
      (QUARANTINE && failed ? ' (failures moved to drafts/)' : ''),
  );
}

process.exit(report.some((r) => r.errors?.length) ? 1 : 0);
