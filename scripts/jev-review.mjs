#!/usr/bin/env node
/**
 * Editorial review of a draft with Jev.
 *
 *   node scripts/jev-review.mjs src/content/blog/some-post.md
 *   node scripts/jev-review.mjs drafts/*.md --json
 *   node scripts/jev-review.mjs post.md --transport=gateway
 *
 * Exits non-zero if any article fails, so it can gate a publish. Unlike
 * quality-gate.mjs this costs money and needs the network, which is why it is
 * a separate command rather than another check inside the gate.
 */
import { parseArticle } from './lib/articles.mjs';
import { reviewArticle, DEFAULT_THRESHOLDS } from './lib/jev.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const transport = args.find((a) => a.startsWith('--transport='))?.split('=')[1];
const paths = args.filter((a) => !a.startsWith('--'));

if (paths.length === 0) {
  console.error('usage: node scripts/jev-review.mjs <article.md> [...] [--json] [--transport=openrouter|gateway]');
  process.exit(2);
}

const bar = (p) => '█'.repeat(Math.round(p * 20)).padEnd(20, '·');

function print(article, review) {
  const { answers, issues, pass, usage } = review;
  console.log(`\n${article.slug}`);
  console.log(`  answers the title  ${bar(answers.answersTheTitle.probability)} ${(answers.answersTheTitle.probability * 100).toFixed(0)}%`);
  console.log(`  evidence           ${bar(answers.evidence.score / 3)} ${answers.evidence.score.toFixed(2)} / 3`);
  console.log(`  generic filler     ${bar(answers.genericFiller.probability)} ${(answers.genericFiller.probability * 100).toFixed(0)}%`);
  console.log(`  intent             ${answers.intent.choice} (${(answers.intent.probabilities[answers.intent.choice] * 100).toFixed(0)}%)`);
  for (const i of issues) console.log(`  ${i.level === 'error' ? '✗' : '!'} ${i.code}: ${i.message}`);
  if (usage?.totalTokens) {
    const cost = usage.costUsd === undefined ? '' : `, $${usage.costUsd.toFixed(6)}`;
    console.log(`  ${usage.totalTokens} tokens${cost}`);
  }
  console.log(`  ${pass ? 'PASS' : 'FAIL'}`);
}

let failed = 0;
const out = [];

for (const path of paths) {
  const article = parseArticle(path);
  let review;
  try {
    review = await reviewArticle(article, { thresholds: DEFAULT_THRESHOLDS, ...(transport ? { transport } : {}) });
  } catch (e) {
    // A gateway failure is an operational problem, not an editorial verdict.
    // Print the message rather than a stack and exit 2 to keep it distinct
    // from a genuine review failure.
    console.error(`${article.slug}: ${e.message}`);
    process.exit(2);
  }
  if (!review.pass) failed += 1;
  if (asJson) out.push({ slug: article.slug, ...review });
  else print(article, review);
}

if (asJson) console.log(JSON.stringify(out, null, 2));
process.exit(failed > 0 ? 1 : 0);
