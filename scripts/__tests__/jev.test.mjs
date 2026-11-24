import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseEnv, loadGatewayKey, loadOpenRouterKey, articleState, verdict, reviewArticle,
  toNativeQuestions, fromNativeAnswers, fromNativeUsage, openrouterEvaluator,
  EDITORIAL_QUESTIONS, DEFAULT_THRESHOLDS, TRANSPORTS, OPENROUTER_MODEL,
} from '../lib/jev.mjs';

/**
 * These run offline. The evaluator is injected everywhere, so no test in this
 * file spends a token — the live check at the bottom is opt-in.
 */

const article = (overrides = {}, bodyOverride) => ({
  slug: 'test-article',
  path: '/tmp/test-article.md',
  body: bodyOverride ?? '## What is it?\n\nSome body text about the subject.\n',
  data: {
    title: 'What Is Model Evaluation?',
    description: 'A description of the article.',
    answer: 'Model evaluation is the practice of scoring outputs against fixed criteria.',
    cluster: 'ml',
    subject: 'model-evaluation',
    sources: [{ title: 'Alpha Report', publisher: 'Alpha', url: 'https://a.example/1', date: new Date() }],
    ...overrides,
  },
});

/** A clean set of answers, in the exact shape Jev returns. */
const goodAnswers = () => ({
  answersTheTitle: { type: 'boolean', probability: 0.93 },
  evidence: { type: 'score', score: 2.6, probabilities: { 0: 0, 1: 0.05, 2: 0.3, 3: 0.65 } },
  intent: {
    type: 'choice',
    choice: 'informational',
    probabilities: { informational: 0.9, commercial: 0.07, transactional: 0.02, unclear: 0.01 },
  },
  genericFiller: { type: 'boolean', probability: 0.08 },
});

const stub = (answers, capture) => async (opts) => {
  capture?.push(opts);
  return { answers, usage: { inputTokens: 1200, outputTokens: 40, totalTokens: 1240 } };
};

const codes = (issues) => issues.map((i) => i.code);

describe('parseEnv', () => {
  test('reads a dash-named key, comments and quotes, with no trailing newline', () => {
    const env = parseEnv('# used for jev\nvercel-api-key=abc123\nQUOTED="x y"\n\nBARE=z');
    assert.equal(env['vercel-api-key'], 'abc123');
    assert.equal(env.QUOTED, 'x y');
    assert.equal(env.BARE, 'z');
  });

  test('empty input yields no keys', () => {
    assert.deepEqual(parseEnv(''), {});
  });
});

describe('loadGatewayKey', () => {
  const envFile = (contents) => {
    const path = join(mkdtempSync(join(tmpdir(), 'jev-')), '.env');
    writeFileSync(path, contents);
    return path;
  };

  test('reads vercel-api-key out of the file', () => {
    assert.equal(loadGatewayKey(envFile('vercel-api-key=sk-test')), 'sk-test');
  });

  test('an already-exported AI_GATEWAY_API_KEY wins over the file', () => {
    const before = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = 'from-env';
    try {
      assert.equal(loadGatewayKey(envFile('vercel-api-key=from-file')), 'from-env');
    } finally {
      if (before === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = before;
    }
  });

  test('throws a named error when the file has no key', () => {
    assert.throws(() => loadGatewayKey(envFile('PUBLIC_GA4_ID=G-X')), /no entry for any of/);
  });

  test('throws when the file does not exist', () => {
    assert.throws(() => loadGatewayKey('/nonexistent/.env'), /not readable/);
  });
});

describe('articleState', () => {
  test('carries the fields the questions refer to', () => {
    const s = articleState(article());
    assert.equal(s.title, 'What Is Model Evaluation?');
    assert.match(s.openingAnswer, /^Model evaluation is/);
    assert.equal(s.sources.length, 1);
    assert.equal(s.sources[0].publisher, 'Alpha');
    assert.ok(s.wordCount > 0);
  });

  test('truncates a body past the cap so long drafts stay inside the context window', () => {
    const s = articleState(article({}, 'x '.repeat(30_000)), { maxBodyChars: 100 });
    assert.ok(s.body.length < 200);
    assert.match(s.body, /truncated/);
  });

  test('missing frontmatter fields become empty strings, not undefined', () => {
    const s = articleState({ body: '', data: {} });
    assert.equal(s.title, '');
    assert.equal(s.openingAnswer, '');
    assert.deepEqual(s.sources, []);
  });

  test('sources are stripped to title, publisher and url', () => {
    const s = articleState(article());
    assert.deepEqual(Object.keys(s.sources[0]).sort(), ['publisher', 'title', 'url']);
  });
});

describe('verdict', () => {
  test('clean answers pass with no issues', () => {
    const v = verdict(goodAnswers());
    assert.equal(v.pass, true);
    assert.deepEqual(v.issues, []);
  });

  test('a buried answer fails answer-first', () => {
    const a = goodAnswers();
    a.answersTheTitle.probability = 0.2;
    const v = verdict(a);
    assert.equal(v.pass, false);
    assert.deepEqual(codes(v.issues), ['jev-not-answer-first']);
    assert.match(v.issues[0].message, /20%/);
  });

  test('thin evidence fails', () => {
    const a = goodAnswers();
    a.evidence.score = 1.1;
    assert.deepEqual(codes(verdict(a).issues), ['jev-weak-evidence']);
  });

  test('filler above the ceiling fails', () => {
    const a = goodAnswers();
    a.genericFiller.probability = 0.81;
    assert.deepEqual(codes(verdict(a).issues), ['jev-generic-filler']);
  });

  test('intent drift warns but still passes', () => {
    const a = goodAnswers();
    a.intent.choice = 'commercial';
    const v = verdict(a);
    assert.equal(v.pass, true);
    assert.deepEqual(codes(v.issues), ['jev-intent-drift']);
    assert.equal(v.issues[0].level, 'warn');
  });

  test('thresholds are overridable one at a time', () => {
    const a = goodAnswers();
    a.evidence.score = 2.6;
    assert.equal(verdict(a, { evidence: 2.9 }).pass, false);
    assert.equal(verdict(a, { evidence: 2.9 }).issues[0].code, 'jev-weak-evidence');
  });

  test('an answer set missing a question yields no issue for it', () => {
    const v = verdict({ intent: goodAnswers().intent });
    assert.deepEqual(v.issues, []);
    assert.equal(v.pass, true);
  });

  test('a boundary value exactly at the threshold passes', () => {
    const a = goodAnswers();
    a.answersTheTitle.probability = DEFAULT_THRESHOLDS.answersTheTitle;
    a.evidence.score = DEFAULT_THRESHOLDS.evidence;
    a.genericFiller.probability = DEFAULT_THRESHOLDS.genericFiller;
    assert.equal(verdict(a).pass, true);
  });
});

describe('reviewArticle', () => {
  test('sends one call with the model, state and every question', async () => {
    const calls = [];
    await reviewArticle(article(), { evaluate: stub(goodAnswers(), calls) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, OPENROUTER_MODEL);
    assert.deepEqual(Object.keys(calls[0].questions), Object.keys(EDITORIAL_QUESTIONS));
    assert.equal(calls[0].state.title, 'What Is Model Evaluation?');
  });

  test('returns the answers, usage and verdict together', async () => {
    const r = await reviewArticle(article(), { evaluate: stub(goodAnswers()) });
    assert.equal(r.pass, true);
    assert.equal(r.usage.totalTokens, 1240);
    assert.equal(r.answers.intent.choice, 'informational');
  });

  test('a failing answer set comes back as pass: false', async () => {
    const a = goodAnswers();
    a.genericFiller.probability = 0.95;
    const r = await reviewArticle(article(), { evaluate: stub(a) });
    assert.equal(r.pass, false);
    assert.deepEqual(codes(r.issues), ['jev-generic-filler']);
  });

  test('an evaluator error propagates rather than passing silently', async () => {
    const boom = async () => { throw new Error('gateway 429'); };
    await assert.rejects(() => reviewArticle(article(), { evaluate: boom }), /gateway 429/);
  });
});

describe('OpenRouter wire format', () => {
  test('a boolean question goes out as noul, other types untouched', () => {
    const native = toNativeQuestions(EDITORIAL_QUESTIONS);
    assert.equal(native.answersTheTitle.type, 'noul');
    assert.equal(native.genericFiller.type, 'noul');
    assert.equal(native.intent.type, 'choice');
    assert.equal(native.evidence.type, 'score');
  });

  test('translating questions keeps instructions and criteria intact', () => {
    const native = toNativeQuestions(EDITORIAL_QUESTIONS);
    assert.equal(native.answersTheTitle.instructions, EDITORIAL_QUESTIONS.answersTheTitle.instructions);
    assert.deepEqual(native.answersTheTitle.criteria, EDITORIAL_QUESTIONS.answersTheTitle.criteria);
  });

  test('a noul answer comes back as a boolean with a probability', () => {
    const out = fromNativeAnswers({ refunded: { type: 'noul', noul: 0.99 } });
    assert.deepEqual(out.refunded, { type: 'boolean', probability: 0.99 });
  });

  test('choice and score answers pass through untouched, extras included', () => {
    const native = {
      dept: { type: 'choice', choice: 'billing', probabilities: { billing: 0.96 }, confidence: 0.94 },
      sev: { type: 'score', score: 2.99, legend: { 0: 'Cosmetic' }, probabilities: { 3: 0.99 } },
    };
    const out = fromNativeAnswers(native);
    assert.deepEqual(out.dept, native.dept);
    assert.equal(out.sev.score, 2.99);
  });

  test('snake_case usage becomes camelCase with a derived total and cost', () => {
    const u = fromNativeUsage({ input_tokens: 435, output_tokens: 71, cost: 1.827e-5 });
    assert.deepEqual(u, { inputTokens: 435, outputTokens: 71, totalTokens: 506, costUsd: 1.827e-5 });
  });

  test('absent usage degrades to zeroes rather than NaN', () => {
    const u = fromNativeUsage(undefined);
    assert.equal(u.totalTokens, 0);
    assert.equal('costUsd' in u, false);
  });

  test('a round trip through both translations preserves the verdict', () => {
    const native = {
      answersTheTitle: { type: 'noul', noul: 0.93 },
      genericFiller: { type: 'noul', noul: 0.08 },
      evidence: { type: 'score', score: 2.6, probabilities: {} },
      intent: { type: 'choice', choice: 'informational', probabilities: {} },
    };
    assert.equal(verdict(fromNativeAnswers(native)).pass, true);
  });
});

describe('openrouterEvaluator', () => {
  const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

  test('posts the native payload and returns translated answers', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return okResponse({
        model: 'typesafe/jev-1.13-20260917',
        answers: { answersTheTitle: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 2, cost: 1e-6 },
        id: 'gen-dec-1',
        provider: 'TypeSafe',
      });
    };
    const run = openrouterEvaluator({ apiKey: 'sk-or-test', fetchImpl });
    const r = await run({
      model: OPENROUTER_MODEL,
      state: { title: 'x' },
      questions: { answersTheTitle: EDITORIAL_QUESTIONS.answersTheTitle },
    });

    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers.Authorization, 'Bearer sk-or-test');
    assert.equal(seen.body.model, OPENROUTER_MODEL);
    assert.equal(seen.body.questions.answersTheTitle.type, 'noul');
    assert.deepEqual(r.answers.answersTheTitle, { type: 'boolean', probability: 0.9 });
    assert.equal(r.usage.totalTokens, 12);
    assert.equal(r.response.provider, 'TypeSafe');
  });

  test('an HTTP error surfaces the provider message', async () => {
    const fetchImpl = async () => ({
      ok: false, status: 400, json: async () => ({ error: { message: 'bad discriminator' } }),
    });
    const run = openrouterEvaluator({ apiKey: 'sk-or-test', fetchImpl });
    await assert.rejects(() => run({ model: 'm', state: {}, questions: {} }), /Jev 400: bad discriminator/);
  });

  test('a 200 carrying an error body still throws', async () => {
    const fetchImpl = async () => okResponse({ error: { message: 'rate limited' } });
    const run = openrouterEvaluator({ apiKey: 'sk-or-test', fetchImpl });
    await assert.rejects(() => run({ model: 'm', state: {}, questions: {} }), /rate limited/);
  });
});

describe('transport selection', () => {
  test('each transport carries its own model id', () => {
    assert.equal(TRANSPORTS.openrouter.model, OPENROUTER_MODEL);
    assert.equal(TRANSPORTS.gateway.model, 'typesafe-ai/jev');
  });

  test('an unknown transport fails loudly and lists the valid ones', async () => {
    await assert.rejects(
      () => reviewArticle(article(), { transport: 'litellm' }),
      /Unknown transport 'litellm'.*openrouter, gateway/s,
    );
  });

  test('the gateway transport asks for the gateway model id', async () => {
    const calls = [];
    await reviewArticle(article(), { transport: 'gateway', evaluate: stub(goodAnswers(), calls) });
    assert.equal(calls[0].model, 'typesafe-ai/jev');
  });
});

describe('loadOpenRouterKey', () => {
  test('accepts either spelling of the key name', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jev-or-')), '.env');
    writeFileSync(path, 'OPEN_ROUTER_API_KEY=sk-or-underscored');
    assert.equal(loadOpenRouterKey(path), 'sk-or-underscored');
    writeFileSync(path, 'OPENROUTER_API_KEY=sk-or-plain');
    assert.equal(loadOpenRouterKey(path), 'sk-or-plain');
  });
});

/**
 * Opt-in live call: `JEV_LIVE=1 node --test scripts/__tests__/jev.test.mjs`.
 * Skipped by default so CI stays offline and free.
 */
describe('live gateway call', { skip: process.env.JEV_LIVE !== '1' }, () => {
  test('Jev returns typed answers for a real article', async () => {
    const r = await reviewArticle(article(), { transport: process.env.JEV_TRANSPORT ?? 'openrouter' });
    assert.equal(r.answers.answersTheTitle.type, 'boolean');
    assert.ok(r.answers.answersTheTitle.probability >= 0 && r.answers.answersTheTitle.probability <= 1);
    assert.ok(r.answers.evidence.score >= 0 && r.answers.evidence.score <= 3);
    assert.ok(Object.keys(EDITORIAL_QUESTIONS.intent.criteria).includes(r.answers.intent.choice));
  });
});
