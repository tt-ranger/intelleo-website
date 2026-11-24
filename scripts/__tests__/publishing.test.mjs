import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import sharp from 'sharp';
import { loadRegistry, parseArticleText } from '../lib/articles.mjs';
import { checkNewsFreshness, checkSubstance } from '../lib/checks.mjs';
import { currentSlot, refreshWindow } from '../publishing/pipeline.mjs';
import { canonicalUrl, extractPublisher, groupEvent, parseFeed, searchTasks } from '../publishing/sources.mjs';
import { duckDuckGoUrls } from '../publishing/duckduckgo.mjs';
import { qualifiesAsLead, reviewEditorial } from '../publishing/editorial.mjs';
import { MODELS, modelClient, object, boolean, BudgetExhausted } from '../publishing/models.mjs';
import { produceDraft, validateMarkdown, verifyEvidence, validEvent, redateArtifact } from '../publishing/article.mjs';
import { artifactPaths, githubPublisher, verifyLive } from '../publishing/github.mjs';

const now = Date.parse('2026-11-24T09:00:00Z');
const env = { LITELLM_URL: 'https://gateway.example.com/v1', LITELLM_KEY: 'fixture-key' };
const result = (id, model, data) => ({
  id, model, status: 'completed', usage: { input_tokens: 500, output_tokens: 200 },
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
});

test('editorial schedule has one daily IST slot and rotates search refreshes', () => {
  assert.equal(currentSlot('2026-11-24T08:59:59Z'), null);
  const daily = currentSlot('2026-11-24T09:00:00Z');
  assert.equal(daily.id, '2026-11-24-daily');
  assert.deepEqual(daily.formats, ['analysis', 'explainer', 'news']);
  assert.equal(daily.expiresAt.toISOString(), '2026-11-24T18:30:00.000Z');
  assert.equal(currentSlot('2026-11-24T14:00:00Z').id, '2026-11-24-daily');
  assert.equal(currentSlot('2026-11-24T18:30:00Z'), null);
  assert.equal(refreshWindow('2026-11-24T02:30:00Z').search, 0);
  assert.equal(refreshWindow('2026-11-24T06:30:00Z').search, 1);
  assert.equal(refreshWindow('2026-11-24T09:00:00Z').search, -1);
});

test('DuckDuckGo MCP accepts publisher links, ignores snippets and shares one session per refresh', async () => {
  const call = duckDuckGoUrls({
    structuredContent: { results: [{ url: 'https://example.org/a' }] },
    content: [{ type: 'text', text: '1. Sample\n   URL: https://example.org/a\n   Summary: ignore this text\n2. Another\n   URL: https://example.org/b\n3. Reference\n   URL: ref://token' }],
  });
  assert.deepEqual(call, ['https://example.org/a', 'https://example.org/b']);
  assert.deepEqual(duckDuckGoUrls({ structuredContent: { result: 'Results\nURL: https://example.org/c' } }), ['https://example.org/c']);
  assert.throws(() => duckDuckGoUrls({ isError: true }), /search error/);
  const providers = [];
  const db = { async query(_sql, args) { providers.push(args[1]); return { rowCount: providers.length < 3 ? 1 : 0 }; } };
  const requested = [];
  let sessions = 0;
  const tasks = searchTasks(db, 0, {
    now, env: {}, fetchImpl: async () => assert.fail('DuckDuckGo should not call a keyed search API.'),
    duckDuckGo: async (work) => {
      sessions++;
      return work(async (query) => {
        requested.push(query);
        return [`https://example.org/lead-${requested.length}`, `https://example.org/next-${requested.length}`];
      });
    },
  });
  const task = tasks.find(([provider]) => provider === 'duckduckgo')[1];
  assert.deepEqual((await task()).map(({ url }) => url), [
    'https://example.org/lead-1', 'https://example.org/lead-2',
    'https://example.org/next-1', 'https://example.org/next-2',
  ]);
  assert.equal(sessions, 1);
  assert.equal(requested.length, 2);
  assert.deepEqual(providers, ['duckduckgo', 'duckduckgo', 'duckduckgo']);
});

test('publisher extraction uses primary metadata and discards tracking and restricted pages', () => {
  assert.equal(canonicalUrl('https://news.example.org/a?utm_source=search&p=2#top'), 'https://news.example.org/a?p=2');
  for (const url of ['file:///tmp/a', 'http://127.0.0.1/', 'http://2130706433/', 'https://user:hunter@public.com', 'https://safe.org:123/a']) {
    assert.throws(() => canonicalUrl(url));
  }
  const markup = `<html><head>
      <link rel="canonical" href="/updates/test">
      <meta property="og:title" content="Team publishes a reproducible evaluation">
      <meta property="article:published_time" content="2026-11-23T12:00:00Z">
    </head><body><article><p>On November 23 the team published the first version of its evaluation guide and included the complete protocol.</p></article></body></html>`;
  const source = extractPublisher(markup, 'https://openai.com/updates/test?utm_campaign=x', {}, now);
  assert.equal(source.url, 'https://openai.com/updates/test');
  assert.equal(source.type, 'primary');
  assert.equal(source.date, '2026-11-23T12:00:00.000Z');
  assert.equal(source.excerpts.length, 1);
  assert.equal(extractPublisher(markup.replace('</head>', '<meta name="robots" content="noai"></head>'), 'https://openai.com/x', {}, now), null);
  assert.equal(extractPublisher(markup.replace('2026-11-23', '2026-12-01'), 'https://openai.com/x', {}, now).date, null);

  const xml = '<feed><entry><link rel="alternate" href="https://openai.com/article"/><published>2026-11-23</published><updated>2026-11-24</updated></entry></feed>';
  assert.deepEqual(parseFeed(xml, { primary: true }), [{ url: 'https://openai.com/article', date: '2026-11-23', primary: true }]);
  const event = groupEvent(source, []);
  assert.equal(groupEvent({ ...source, url: 'https://news.example.org/test' }, [event]).id, event.id);
});

test('Luna rejects weak evidence and treats evergreen freshness independently', () => {
  const row = { scores: { relevance: 4, authority: 3, evidence: 3, specificity: 4, freshness: 0, novelty: 3 }, evergreen: false, syndicated: false };
  assert.equal(qualifiesAsLead(row), false);
  assert.equal(qualifiesAsLead({ ...row, evergreen: true }), true);
  assert.equal(qualifiesAsLead({ ...row, evergreen: true, scores: { ...row.scores, evidence: 2 } }), false);
});

test('the LiteLLM client spends through its reservation and rejects a substituted model', async () => {
  const settlements = [];
  const fixture = (returnedModel) => modelClient(null, {
    env,
    reserve: async (_db, model, micros) => {
      assert.equal(model, MODELS.luna);
      assert.ok(micros > 50);
      return 'reservation';
    },
    settle: async (_db, ...args) => settlements.push(args),
    fetchImpl: async (url, request) => {
      assert.equal(url.href, 'https://gateway.example.com/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer fixture-key');
      assert.equal(JSON.parse(request.body).store, false);
      return new Response(JSON.stringify(result('gateway-request', returnedModel, { ready: true })), {
        headers: { 'x-litellm-response-cost': '0.00017' },
      });
    },
  });
  const params = { model: MODELS.luna, name: 'test', schema: object({ ready: boolean }), instructions: 'Respond.', data: null, maxOutput: 512 };
  assert.deepEqual(await fixture(MODELS.luna)(params), { ready: true });
  assert.deepEqual(settlements[0], ['reservation', 170, 'gateway-request']);
  await assert.rejects(fixture(MODELS.sol)(params), /unexpected model/);
  const capped = modelClient(null, { env, reserve: async () => null, fetchImpl: async () => assert.fail('network call without budget') });
  await assert.rejects(capped(params), BudgetExhausted);
});

const sources = [
  { id: 0, url: 'https://labs.example.org/evaluation', title: 'Evaluation guide published', publisher: 'Test Labs', kind: 'primary',
    date: '2026-11-24T07:00:00.000Z', excerpts: ['On November 24 the team published the evaluation guide and included the complete protocol.'] },
  { id: 1, url: 'https://review.example.org/reproduction', title: 'Independent protocol reproduction', publisher: 'Reviewer', kind: 'independent',
    date: '2026-11-24T08:00:00.000Z', excerpts: ['The independent reviewer reproduced the public protocol and documented the required configuration.'] },
  { id: 2, url: 'https://notes.example.org/measurement', title: 'Measurement setup details', publisher: 'Measurement Notes', kind: 'independent',
    date: '2026-11-24T08:15:00.000Z', excerpts: ['Compare outputs against the same reference examples and keep the complete measurement configuration fixed.'] },
];
const lead = sources[0];
const brief = {
  title: 'How does the new test guide work?', format: 'news', reader: 'ML practitioners',
  cluster: 'ml', subject: 'model-evaluation', eventId: 'idevent12345678', lead, sources,
  eventAt: '2026-11-24T07:00:00Z', dateEvidence: lead.excerpts[0],
  angle: 'Explain the reproduction protocol.',
};
const claims = sources.map(({ id, excerpts }) => ({ claim: excerpts[0], consequential: false, evidence: [{ sourceId: id, excerpt: excerpts[0] }] }));
const paragraphs = 'Set up an evaluation workspace with a controlled test corpus, then record configuration details near the experiment. ';
const copy = {
  title: 'How does the new test guide work?',
  description: 'The new guide outlines a reproducible approach for scoring model responses and documenting evaluation inputs.',
  answer: 'Start with the same reference examples and keep the measurement configuration fixed. Record the settings alongside the output so a second reviewer can reproduce the run.',
  body: `## What changed in the guide?\n\n${paragraphs.repeat(23)}\n\nSee the [guide](${sources[0].url}) and [reproduction](${sources[1].url}).\n\n## How should teams reproduce results?\n\n${paragraphs.repeat(23)}\n\nRead the [measurement notes](${sources[2].url}) and our [ML topic hub](/topics/ml).`,
  tags: ['evaluation'], claims,
  visual: { kind: 'diagram', title: 'Evaluation workflow', steps: ['Set up the reference', 'Record configuration'],
    alt: 'Two steps for setting up and documenting an evaluation workflow.', units: '', metrics: [] },
};
const goodEditorial = { scores: { answersQuestion: 4, substance: 3, originality: 3, clarity: 4 }, issues: [] };

test('news freshness uses the event and enforces format-specific length', () => {
  const draft = { data: { format: 'news', newsHook: { date: brief.eventAt } }, body: copy.body };
  assert.deepEqual(checkNewsFreshness(draft, { asOf: now }), []);
  assert.equal(checkNewsFreshness(draft, { asOf: '2026-11-28' })[0].code, 'stale-news-hook');
  assert.equal(checkNewsFreshness(draft, { asOf: '2026-11-23' })[0].code, 'future-news-hook');
  assert.deepEqual(checkSubstance(draft), []);
  assert.equal(checkSubstance({ ...draft, data: { format: 'analysis' } })[0].code, 'thin-content');
  assert.equal(validEvent(brief, lead, now), true);
  assert.equal(validEvent({ ...brief, dateEvidence: 'An entirely fabricated passage about dates.' }, lead, now), false);
});

test('verified inline evidence is required and drafts cannot add hidden HTML', () => {
  assert.doesNotThrow(() => validateMarkdown(copy.body, sources, ['/topics/ml']));
  assert.throws(() => validateMarkdown(copy.body + '\n\n<script>alert(0)</script>', sources, ['/topics/ml']), /HTML/);
  assert.throws(() => validateMarkdown(copy.body.replace(sources[0].url, 'https://unverified.example.org'), sources, ['/topics/ml']), /unverified/);
  assert.doesNotThrow(() => verifyEvidence(copy, sources));
  const unsupported = [{ ...claims[0], consequential: true }, ...claims.slice(1)];
  assert.throws(() => verifyEvidence({ ...copy, claims: unsupported }, sources), /independent corroboration/);
});

test('Sol writes, Terra fact-checks and edits, and a failed fact-check forces a new draft', async () => {
  const calls = [];
  let checked = 0;
  const run = async ({ model, name }) => {
    calls.push([model, name]);
    if (name === 'write_article') return copy;
    if (name === 'fact_check') return ++checked === 1 ? { pass: false, blockers: ['Verify the chronology.'] } : { pass: true, blockers: [] };
    assert.equal(name, 'editorial_review');
    return goodEditorial;
  };
  const artifact = await produceDraft(run, brief, { corpus: [], registry: loadRegistry(), now });
  assert.deepEqual(calls, [
    [MODELS.sol, 'write_article'], [MODELS.terra, 'fact_check'],
    [MODELS.sol, 'write_article'], [MODELS.terra, 'fact_check'], [MODELS.terra, 'editorial_review'],
  ]);
  const checkedArticle = parseArticleText(artifact.markdown, artifact.slug);
  assert.equal(checkedArticle.data.author, 'Intelleo Editorial');
  assert.equal(artifactPaths(artifact).length, 2);
  assert.throws(() => artifactPaths({ ...artifact, markdown: artifact.markdown + 'tamper' }), /intact/);
  const image = await sharp(Buffer.from(artifact.image, 'base64')).metadata();
  assert.deepEqual([image.format, image.width, image.height], ['webp', 1200, 630]);
  assert.notEqual(redateArtifact(artifact, now + 3600000).digest, artifact.digest);
  assert.equal((await reviewEditorial(async () => ({ ...goodEditorial, issues: ['Generic filler'] }), copy)).pass, false);

  const url = `https://www.intelleo.in/blog/${artifact.slug}`;
  const served = new Map([
    [url, new Response(`<link rel="canonical" href="${url}"><h1>${copy.title}</h1><figure class="article-hero"><img src="${artifact.hero.src}"></figure>`)],
    [`https://www.intelleo.in${artifact.hero.src}`, new Response(Buffer.from(artifact.image, 'base64'), { headers: { 'content-type': 'image/webp' } })],
    ['https://www.intelleo.in/blog', new Response(`<a href="/blog/${artifact.slug}">Article</a>`)],
    ['https://www.intelleo.in/rss.xml', new Response(`<rss><channel><item><link>${url}</link></item></channel></rss>`)],
  ]);
  assert.equal(await verifyLive(artifact, { fetchImpl: async (path) => served.get(path).clone() }), true);
  served.delete('https://www.intelleo.in/rss.xml');
  assert.equal(await verifyLive(artifact, { fetchImpl: async (path) => served.get(path)?.clone() ?? new Response('', { status: 404 }) }), false);
});

test('GitHub publishing waits for exact-head CI and refuses a changed article', async () => {
  const run = async ({ name }) => name === 'write_article' ? copy
    : name === 'fact_check' ? { pass: true, blockers: [] } : goodEditorial;
  const draft = await produceDraft(run, brief, { corpus: [], registry: loadRegistry(), now });
  const paths = artifactPaths(draft);
  const head = 'a'.repeat(40);
  const main = 'b'.repeat(40);
  const merged = 'c'.repeat(40);
  const slot = { id: '2026-11-24-morning', draft, pr: 7 };
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fixtureEnv = { PUBLISH_GITHUB_APP_ID: '1', PUBLISH_GITHUB_INSTALLATION_ID: '2', PUBLISH_GITHUB_APP_PRIVATE_KEY: key };
  let conclusion = null;
  let tamper = false;
  let mergeCalls = 0;
  const publisher = await githubPublisher(fixtureEnv, async (path, options) => {
    const url = new URL(path);
    const body = url.pathname.replace('/repos/tt-ranger/intelleo-website', '');
    const respond = (value) => Response.json(value);
    if (body.endsWith('/access_tokens')) return respond({ token: 'installation-token' });
    if (body === '/pulls/7') return respond({ state: 'open', number: 7, head: { ref: 'editorial/2026-11-24-morning', sha: head }, base: { ref: 'main' } });
    if (body === '/rules/branches/main') return respond([
      { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'content-quality' }] } },
    ]);
    if (body === '/git/ref/heads/main') return respond({ object: { sha: main } });
    if (body === `/compare/${main}...${head}`) return respond({ behind_by: 0 });
    if (body === '/pulls/7/files') return respond(paths.map(([filename]) => ({ filename, status: 'added' })));
    if (body.startsWith('/contents/')) {
      assert.equal(url.searchParams.get('ref'), head);
      const file = paths.find(([filename]) => body === `/contents/${filename}`);
      return respond({ encoding: 'base64', content: tamper ? 'dGFtcGVy' : file[1] });
    }
    if (body === `/commits/${head}/check-runs`) return respond({ check_runs: [
      { app: { slug: 'github-actions' }, status: conclusion ? 'completed' : 'in_progress', conclusion },
    ] });
    if (body === '/pulls/7/merge') {
      assert.equal(JSON.parse(options.body).sha, head);
      mergeCalls++;
      return respond({ merged: true, sha: merged });
    }
    assert.fail(`Unexpected fixture path: ${body}`);
  });
  assert.deepEqual(await publisher.merge(slot), { waiting: true });
  conclusion = 'failure';
  assert.deepEqual(await publisher.merge(slot), { rejected: true });
  assert.equal(mergeCalls, 0);
  conclusion = 'success';
  tamper = true;
  await assert.rejects(publisher.merge(slot), /differs from the reviewed draft/);
  tamper = false;
  assert.deepEqual(await publisher.merge(slot), { merged });
  assert.equal(mergeCalls, 1);
});
