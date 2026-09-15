import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSubstance, checkSources, checkAnswerFirst, checkQuestionHeadings,
  checkInternalLinks, checkNewsFreshness, checkSubjectCap, checkClusterBalance,
  checkClaimShape, checkDuplication, checkRateLimit, similarity, MIN_WORDS,
} from '../lib/checks.mjs';
import { loadRegistry } from '../lib/articles.mjs';
import { keyTerms, extractText, checkSource } from '../link-check.mjs';

const registry = loadRegistry();
const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ');
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

const goodSources = [
  { url: 'https://a.example/1', title: 'Alpha Report', publisher: 'Alpha', date: daysAgo(30) },
  { url: 'https://b.example/2', title: 'Beta Study', publisher: 'Beta', date: daysAgo(60) },
  { url: 'https://c.example/3', title: 'Gamma Paper', publisher: 'Gamma', date: daysAgo(90) },
];

function article(overrides = {}, bodyOverride) {
  return {
    slug: 'test-article',
    path: '/tmp/test-article.md',
    body: bodyOverride ?? `
## What is the first question?
${words(700)}
[pillar](/topics/ml) and [sibling](/blog/existing-one) and [other](/blog/existing-two)
## How does the second part work?
${words(700)}
`,
    data: {
      title: 'A Reasonable Title For Testing',
      description: 'A description long enough to satisfy the schema requirements for testing purposes here.',
      answer: 'This is the first sentence of the answer. This is the second sentence that completes it.',
      cluster: 'ml',
      subject: 'model-evaluation',
      publishDate: new Date('2026-09-15'),
      tags: [],
      sources: goodSources,
      faq: [],
      originalData: false,
      draft: false,
      ...overrides,
    },
  };
}

const baseCtx = {
  registry,
  corpus: [],
  published: [],
  publishedSlugs: ['existing-one', 'existing-two'],
  subjectCounts: {},
  clusterCounts: {},
  total: 0,
};

const codes = (issues) => issues.map((i) => i.code);

describe('substance', () => {
  test('rejects a 400-word article', () => {
    const a = article({}, `## Is this thin?\n${words(400)}`);
    assert.ok(codes(checkSubstance(a)).includes('thin-content'));
  });
  test('accepts an article above the minimum', () => {
    assert.equal(checkSubstance(article()).length, 0);
  });
  test('minimum is 1200 words', () => assert.equal(MIN_WORDS, 1200));
});

describe('sources', () => {
  test('rejects fewer than three', () => {
    const a = article({ sources: goodSources.slice(0, 2) });
    assert.ok(codes(checkSources(a)).includes('few-sources'));
  });
  test('rejects a source with no date', () => {
    const a = article({ sources: [...goodSources.slice(1), { url: 'https://d.example', title: 'D', publisher: 'D' }] });
    assert.ok(codes(checkSources(a)).includes('source-no-date'));
  });
});

describe('answer-first', () => {
  test('rejects a missing answer', () => {
    assert.ok(codes(checkAnswerFirst(article({ answer: '' }))).includes('no-answer'));
  });
  test('accepts a two-sentence answer', () => {
    assert.equal(checkAnswerFirst(article()).length, 0);
  });
});

describe('question headings', () => {
  test('rejects when under half are questions', () => {
    const a = article({}, `## Statement one\n${words(700)}\n## Statement two\n${words(700)}`);
    assert.ok(codes(checkQuestionHeadings(a)).includes('headings-not-questions'));
  });
  test('accepts question-phrased headings', () => {
    assert.equal(checkQuestionHeadings(article()).length, 0);
  });
});

describe('internal links', () => {
  test('rejects a missing pillar link', () => {
    const a = article({}, `## Why?\n${words(700)}\n[x](/blog/existing-one) [y](/blog/existing-two)\n## How?\n${words(700)}`);
    assert.ok(codes(checkInternalLinks(a, baseCtx)).includes('no-pillar-link'));
  });
  test('rejects too few sibling links', () => {
    const a = article({}, `## Why?\n${words(700)}\n[p](/topics/ml)\n## How?\n${words(700)}`);
    assert.ok(codes(checkInternalLinks(a, baseCtx)).includes('few-internal-links'));
  });
  test('rejects a link to a non-existent article', () => {
    const a = article({}, `## Why?\n${words(700)}\n[p](/topics/ml) [bad](/blog/does-not-exist) [ok](/blog/existing-one)\n## How?\n${words(700)}`);
    assert.ok(codes(checkInternalLinks(a, baseCtx)).includes('broken-internal-link'));
  });
  test('does not demand siblings when the corpus is empty', () => {
    const a = article({}, `## Why?\n${words(700)}\n[p](/topics/ml)\n## How?\n${words(700)}`);
    assert.equal(codes(checkInternalLinks(a, { ...baseCtx, publishedSlugs: [] })).length, 0);
  });
  test('accepts a well-linked article', () => {
    assert.equal(checkInternalLinks(article(), baseCtx).length, 0);
  });
});

describe('news freshness', () => {
  test('rejects a hook older than 30 days', () => {
    const a = article({ newsHook: { headline: 'Old', url: 'https://x.example', date: daysAgo(45) } });
    assert.ok(codes(checkNewsFreshness(a, { maxAgeDays: 30 })).includes('stale-news-hook'));
  });
  test('accepts a recent hook', () => {
    const a = article({ newsHook: { headline: 'New', url: 'https://x.example', date: daysAgo(5) } });
    assert.equal(checkNewsFreshness(a, { maxAgeDays: 30 }).length, 0);
  });
  test('accepts no hook at all', () => {
    assert.equal(checkNewsFreshness(article(), { maxAgeDays: 30 }).length, 0);
  });
});

describe('subject cap', () => {
  test('rejects the 11th article in a subject', () => {
    const ctx = { ...baseCtx, subjectCounts: { 'model-evaluation': 10 } };
    assert.ok(codes(checkSubjectCap(article(), ctx)).includes('subject-at-cap'));
  });
  test('accepts the 10th', () => {
    const ctx = { ...baseCtx, subjectCounts: { 'model-evaluation': 9 } };
    assert.ok(!codes(checkSubjectCap(article(), ctx)).includes('subject-at-cap'));
  });
  test('warns as the cap approaches', () => {
    const ctx = { ...baseCtx, subjectCounts: { 'model-evaluation': 8 } };
    assert.ok(codes(checkSubjectCap(article(), ctx)).includes('subject-near-cap'));
  });
  test('rejects an unknown subject', () => {
    assert.ok(codes(checkSubjectCap(article({ subject: 'invented' }), baseCtx)).includes('unknown-subject'));
  });
  test('rejects a subject from the wrong cluster', () => {
    const a = article({ cluster: 'data', subject: 'model-evaluation' });
    assert.ok(codes(checkSubjectCap(a, baseCtx)).includes('subject-cluster-mismatch'));
  });
});

describe('cluster balance', () => {
  test('warns above the share ceiling', () => {
    const ctx = { clusterCounts: { ml: 8 }, total: 19, maxShare: 0.35 };
    assert.ok(codes(checkClusterBalance(article(), ctx)).includes('cluster-imbalance'));
  });
  test('stays quiet on a small corpus', () => {
    assert.equal(checkClusterBalance(article(), { clusterCounts: { ml: 3 }, total: 4, maxShare: 0.35 }).length, 0);
  });
});

describe('claim shape', () => {
  test('warns on a statistic with no date or source', () => {
    const a = article({}, '## Why?\nConversion improved by 40% after the change.\n## How?\ntext');
    assert.ok(codes(checkClaimShape(a)).includes('unsourced-stat'));
  });
  test('accepts a dated, sourced statistic', () => {
    const a = article({}, '## Why?\nA 2026 study found a 40% lift ([source](https://x.example/s)).\n## How?\ntext');
    assert.equal(checkClaimShape(a).length, 0);
  });
});

describe('duplication', () => {
  test('rejects a near-identical body', () => {
    const a = article();
    const dup = { ...article(), slug: 'other' };
    assert.ok(codes(checkDuplication(a, { corpus: [dup] })).includes('duplicate-topic'));
  });
  test('rejects an identical title', () => {
    const other = { slug: 'other', body: 'completely different words entirely here', data: { title: 'A Reasonable Title For Testing' } };
    assert.ok(codes(checkDuplication(article(), { corpus: [other] })).includes('duplicate-title'));
  });
  test('accepts distinct content', () => {
    const other = { slug: 'other', body: words(500) + ' unrelated vocabulary', data: { title: 'Totally Different' } };
    assert.equal(checkDuplication(article(), { corpus: [other] }).length, 0);
  });
  test('similarity is bounded 0..1', () => {
    assert.equal(similarity('a b c d e f', 'a b c d e f'), 1);
    assert.equal(similarity('a b c d e f', 'x y z p q r'), 0);
  });
});

describe('rate limit', () => {
  test('rejects a fifth article on the same day', () => {
    const published = Array.from({ length: 4 }, (_, i) => ({
      slug: `p${i}`, data: { publishDate: new Date('2026-09-15') },
    }));
    assert.ok(codes(checkRateLimit(article(), { published, maxPerDay: 4 })).includes('rate-limit'));
  });
  test('accepts a fourth', () => {
    const published = Array.from({ length: 3 }, (_, i) => ({
      slug: `p${i}`, data: { publishDate: new Date('2026-09-15') },
    }));
    assert.equal(checkRateLimit(article(), { published, maxPerDay: 4 }).length, 0);
  });
});

describe('citation verification', () => {
  test('extracts distinctive terms', () => {
    assert.deepEqual(keyTerms('The Complete 2026 Guide to Vector Databases'), ['vector', 'databases']);
  });
  test('strips scripts and tags', () => {
    assert.equal(extractText('<p>Hi <b>there</b></p><script>x()</script>').trim(), 'hi there');
  });
  test('flags a dead citation URL', async () => {
    const fetchImpl = async () => new Response('', { status: 404 });
    const r = await checkSource({ url: 'https://x.example/gone', title: 'Vector Databases' }, { fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'dead-citation');
  });
  test('flags a live URL that does not mention the cited topic', async () => {
    const fetchImpl = async () => new Response('<p>recipes for bread and cake</p>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
    const r = await checkSource({ url: 'https://x.example/ok', title: 'Vector Databases Benchmark' }, { fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'citation-mismatch');
  });
  test('accepts a live URL that does mention it', async () => {
    const fetchImpl = async () => new Response('<p>a benchmark of vector databases</p>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
    const r = await checkSource({ url: 'https://x.example/ok', title: 'Vector Databases Benchmark' }, { fetchImpl });
    assert.equal(r.ok, true);
  });
  test('accepts a non-HTML resource on existence alone', async () => {
    const fetchImpl = async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } });
    const r = await checkSource({ url: 'https://x.example/p.pdf', title: 'Anything At All' }, { fetchImpl });
    assert.equal(r.ok, true);
  });
});
