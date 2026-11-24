#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { listPublished, listArticles, loadRegistry, parseArticle, parseArticleText, BLOG_DIR, DRAFTS_DIR } from './lib/articles.mjs';
import { runPureChecks } from './lib/checks.mjs';
import { articleContext } from './publishing/article.mjs';
import { checkSources as verifyCitations } from './link-check.mjs';
import { fetchPublic } from './publishing/public-fetch.mjs';

const argv = process.argv.slice(2);
const baseAt = argv.indexOf('--base');
const base = baseAt < 0 ? null : argv[baseAt + 1];
if (baseAt >= 0) {
  if (!/^[a-f0-9]{40}$/i.test(base ?? '')) throw new Error('--base must be a Git commit SHA.');
  argv.splice(baseAt, 2);
}
const files = argv.filter((argument) => !argument.startsWith('--'));
if (base && files.length) throw new Error('Use a base commit or an explicit list of files.');
const offline = argv.includes('--offline');
const json = argv.includes('--json');
const quarantine = argv.includes('--quarantine');
const trackedBlogDir = relative(process.cwd(), BLOG_DIR);
const changed = base ? execFileSync('git', [
  'diff', '--name-only', '--no-renames', '--diff-filter=AM', '-z', base, 'HEAD', '--', trackedBlogDir,
], { encoding: 'utf8' }).split('\0').filter((path) => path.endsWith('.md')) : null;

const registry = loadRegistry();
const targets = changed ? changed.map(parseArticle) : files.length ? files.map(parseArticle) : listArticles();
const targetSlugs = new Set(targets.map(({ slug }) => slug));
const corpus = listPublished().filter(({ slug }) => !targetSlugs.has(slug));
const report = [];

function existingArticle(article) {
  if (!base) return null;
  try {
    const raw = execFileSync('git', ['show', `${base}:${relative(process.cwd(), article.path)}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseArticleText(raw, article.path);
  } catch {
    return null;
  }
}

async function checkHero(article) {
  if (!article.data.automated) return [];
  const hero = article.data.hero;
  const expected = `/images/editorial/${article.slug}.webp`;
  try {
    if (hero?.src !== expected || typeof hero.alt !== 'string' || !hero.credit) throw new Error();
    const image = readFileSync(`public${expected}`);
    const metadata = await sharp(image).metadata();
    if (metadata.format !== 'webp' || metadata.width !== 1200 || metadata.height !== 630 || image.length > 300000) throw new Error();
    return [];
  } catch {
    return [{ level: 'error', code: 'invalid-hero', message: `Expected a valid 1200×630 WebP hero with alt text and provenance at ${expected}.` }];
  }
}

for (const article of targets) {
  if (article.data.draft === true) {
    report.push({ slug: article.slug, skipped: 'draft', errors: [], warnings: [] });
    continue;
  }
  const prior = existingArticle(article);
  const ctx = articleContext(corpus, registry);
  const hook = article.data.newsHook;
  if (hook && prior?.data.newsHook?.url === hook.url
      && new Date(prior.data.newsHook.date).valueOf() === new Date(hook.date).valueOf()) {
    ctx.asOf = new Date(prior.data.publishDate).valueOf();
  }
  const issues = [...runPureChecks(article, ctx), ...await checkHero(article)];
  if (!offline && Array.isArray(article.data.sources)) {
    for (const result of await verifyCitations(article.data.sources, { fetchImpl: fetchPublic })) {
      if (!result.ok) issues.push({ level: 'error', code: result.code, message: `${result.url} — ${result.message}` });
    }
  }
  const errors = issues.filter(({ level }) => level === 'error');
  const warnings = issues.filter(({ level }) => level === 'warn');
  report.push({ slug: article.slug, path: article.path, errors, warnings, passed: !errors.length });
  if (errors.length === 0) {
    corpus.push(article);
  } else if (quarantine && article.path.startsWith(`${BLOG_DIR}/`)) {
    mkdirSync(DRAFTS_DIR, { recursive: true });
    const destination = join(DRAFTS_DIR, basename(article.path));
    renameSync(article.path, destination);
    writeFileSync(destination.replace(/\.md$/, '.rejected.txt'),
      `Quarantined ${new Date().toISOString()}\n\n` + errors.map(({ code, message }) => `[${code}] ${message}`).join('\n') + '\n');
  }
}

if (json) {
  console.log(JSON.stringify({ report }, null, 2));
} else {
  const checked = report.filter((row) => !row.skipped);
  if (!checked.length) console.log('No changed articles to check.');
  for (const { slug, passed, errors, warnings } of checked) {
    console.log(`${passed ? 'PASS' : 'FAIL'} ${slug}`);
    for (const issue of [...errors, ...warnings]) console.log(`  ${issue.code}: ${issue.message}`);
  }
}
process.exitCode = report.some(({ errors }) => errors.length) ? 1 : 0;
