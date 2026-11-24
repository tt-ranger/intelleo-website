/**
 * Editorial review of a draft using Jev, TypeSafe's evaluation model.
 *
 * This is the judgement half of the quality gate. checks.mjs answers things a
 * regex can settle — word count, source count, heading shape. The questions
 * here are the ones it cannot: does the opening actually answer the title, is
 * the evidence specific, does the piece read like generic AI filler.
 *
 * Jev is an evaluation model, not a chat model: one call sends every question
 * against one shared state and returns typed answers with probabilities, so
 * the review is a data structure rather than prose to be re-parsed.
 *
 * Two routes reach it, behind one `evaluate`-shaped seam:
 *
 *   openrouter  POST /api/alpha/decisions, native wire format, plain fetch.
 *   gateway     Vercel AI Gateway via the AI SDK's experimental_evaluate.
 *
 * OpenRouter is the default because it is the one currently provisioned; the
 * Vercel gateway rejects our key until a card is on file. The LiteLLM proxy
 * lists the model but exposes no decisions route, so it is not an option.
 *
 * Questions are authored in the AI SDK's vocabulary (`boolean`) throughout,
 * and the OpenRouter transport translates to the native spelling (`noul`) on
 * the way out and back. That keeps one question set valid for both routes.
 *
 * Everything except the transports is pure, and `reviewArticle` takes its
 * evaluator by injection, so the unit tests run offline and cost nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wordCount, ROOT } from './articles.mjs';

export const MODEL = 'typesafe-ai/jev'; // Vercel AI Gateway's id for Jev.
export const OPENROUTER_MODEL = 'typesafe/jev-1.13';
export const OPENROUTER_URL = 'https://openrouter.ai/api/alpha/decisions';

/** Minimal dotenv parse: `k=v` lines, `#` comments, optional surrounding quotes. */
export function parseEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Read a key from the environment, falling back to .env.
 *
 * Needed because one of these keys is spelled `vercel-api-key`, which is not a
 * legal shell variable name and so can never arrive via the environment.
 */
export function loadKey(names, envPath = join(ROOT, '.env')) {
  const wanted = [].concat(names);
  for (const n of wanted) if (process.env[n]) return process.env[n];
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    throw new Error(`None of ${wanted.join(', ')} are set and ${envPath} is not readable.`);
  }
  const env = parseEnv(raw);
  for (const n of wanted) if (env[n]) return env[n];
  throw new Error(`${envPath} has no entry for any of: ${wanted.join(', ')}.`);
}

export const loadGatewayKey = (envPath) => loadKey(['AI_GATEWAY_API_KEY', 'vercel-api-key'], envPath);
export const loadOpenRouterKey = (envPath) => loadKey(['OPEN_ROUTER_API_KEY', 'OPENROUTER_API_KEY'], envPath);

/**
 * Questions are declared once, as data. `criteria` is what the model scores
 * against, so it carries the actual editorial standard — keep the wording
 * concrete enough that two editors would agree on it.
 */
export const EDITORIAL_QUESTIONS = {
  answersTheTitle: {
    type: 'boolean',
    instructions: 'Does the opening answer directly answer the question the title poses?',
    criteria: {
      true: 'A reader who stopped after the answer paragraph would have the answer.',
      false: 'The opening defines terms, sets context, or defers the answer to later sections.',
    },
  },
  evidence: {
    type: 'score',
    instructions: 'How specific and well-sourced are the claims in the body?',
    criteria: [
      'Generic assertions with no figures, dates, or named sources.',
      'Some specifics, but the load-bearing claims are unsupported.',
      'Most substantive claims carry a figure, date, or named source.',
      'Claims are consistently specific and attributed to the cited sources.',
    ],
  },
  intent: {
    type: 'choice',
    instructions: 'Which search intent does this article actually serve, judged by the body rather than the title?',
    criteria: {
      informational: 'Explains a concept or answers a question, no product pitch.',
      commercial: 'Compares or evaluates tools or vendors ahead of a purchase.',
      transactional: 'Pushes the reader toward signing up, buying, or booking.',
      unclear: 'Mixes intents or never settles on one.',
    },
  },
  genericFiller: {
    type: 'boolean',
    instructions: 'Does this read like generic AI filler — restating the obvious in confident, interchangeable prose?',
    criteria: {
      true: 'Padding, hedged truisms, or sections that could sit in any article on the topic.',
      false: 'Carries a specific point of view, examples, or detail tied to this subject.',
    },
  },
};

/**
 * Thresholds are separate from the questions so the bar can move without
 * touching the prompt — the review stays comparable across drafts.
 */
export const DEFAULT_THRESHOLDS = {
  answersTheTitle: 0.6, // P(true) at or above this passes.
  evidence: 2.0, // On the 0..3 scale above.
  genericFiller: 0.5, // P(true) at or below this passes.
  expectedIntent: 'informational',
};

/**
 * The state Jev scores. Send the article as structured fields rather than one
 * blob: the questions can then refer to "the opening answer" and "the body"
 * and mean something exact. The body is truncated because Jev's context is
 * 32k tokens and the gate already enforces a word-count floor separately.
 */
export function articleState(article, { maxBodyChars = 20_000 } = {}) {
  const body = article.body ?? '';
  return {
    title: article.data?.title ?? '',
    description: article.data?.description ?? '',
    openingAnswer: article.data?.answer ?? '',
    cluster: article.data?.cluster ?? '',
    subject: article.data?.subject ?? '',
    wordCount: wordCount(body),
    sources: (article.data?.sources ?? []).map((s) => ({
      title: s?.title ?? '',
      publisher: s?.publisher ?? '',
      url: s?.url ?? '',
    })),
    body: body.length > maxBodyChars ? `${body.slice(0, maxBodyChars)}\n…[truncated]` : body,
  };
}

const err = (code, message) => ({ level: 'error', code, message });
const warn = (code, message) => ({ level: 'warn', code, message });
const pct = (p) => `${Math.round(p * 100)}%`;

/**
 * Turn typed answers into the same { level, code, message } issues the rest of
 * the gate emits, so a Jev finding prints beside a word-count finding.
 *
 * Intent is advisory: the model reading a piece as commercial is worth seeing
 * but is not on its own grounds to block a publish.
 */
export function verdict(answers, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const issues = [];

  const answersTitle = answers.answersTheTitle?.probability;
  if (typeof answersTitle === 'number' && answersTitle < t.answersTheTitle) {
    issues.push(err('jev-not-answer-first',
      `P(opening answers the title) is ${pct(answersTitle)}; needs ${pct(t.answersTheTitle)}.`));
  }

  const evidence = answers.evidence?.score;
  if (typeof evidence === 'number' && evidence < t.evidence) {
    issues.push(err('jev-weak-evidence',
      `Evidence scored ${evidence.toFixed(2)} of 3; needs ${t.evidence.toFixed(2)}.`));
  }

  const filler = answers.genericFiller?.probability;
  if (typeof filler === 'number' && filler > t.genericFiller) {
    issues.push(err('jev-generic-filler',
      `P(generic AI filler) is ${pct(filler)}; ceiling is ${pct(t.genericFiller)}.`));
  }

  const intent = answers.intent?.choice;
  if (intent && intent !== t.expectedIntent) {
    issues.push(warn('jev-intent-drift',
      `Reads as ${intent} intent, not ${t.expectedIntent}.`));
  }

  return { pass: issues.every((i) => i.level !== 'error'), issues };
}

/**
 * TypeSafe's native wire format spells a boolean question `noul` and returns
 * its probability under that same key. The AI SDK's gateway provider hides
 * that; talking to OpenRouter directly does not, so translate at the edge and
 * keep one vocabulary everywhere above this line.
 */
export function toNativeQuestions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([id, q]) =>
    [id, q.type === 'boolean' ? { ...q, type: 'noul' } : q]));
}

/** Native answers back to the AI SDK shape the verdict logic reads. */
export function fromNativeAnswers(answers) {
  return Object.fromEntries(Object.entries(answers).map(([id, a]) =>
    [id, a.type === 'noul' ? { type: 'boolean', probability: a.noul } : a]));
}

/** Native usage is snake_case and reports cost rather than a token total. */
export function fromNativeUsage(usage = {}) {
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(usage.cost === undefined ? {} : { costUsd: usage.cost }),
  };
}

/**
 * OpenRouter transport. No SDK: the decisions endpoint is one POST, and the
 * AI SDK has no OpenRouter evaluation provider to use anyway.
 */
export function openrouterEvaluator({ apiKey, url = OPENROUTER_URL, fetchImpl = fetch } = {}) {
  return async ({ model, state, questions, abortSignal }) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey ?? loadOpenRouterKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, state, questions: toNativeQuestions(questions) }),
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    const body = await res.json();
    if (!res.ok || body.error) {
      throw new Error(`Jev ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
    }
    return {
      answers: fromNativeAnswers(body.answers),
      usage: fromNativeUsage(body.usage),
      response: { modelId: body.model, id: body.id, provider: body.provider },
    };
  };
}

/** Vercel AI Gateway transport, via the AI SDK. Imported lazily. */
export function gatewayEvaluator({ apiKey } = {}) {
  return async (opts) => {
    process.env.AI_GATEWAY_API_KEY = apiKey ?? loadGatewayKey();
    const { experimental_evaluate } = await import('ai');
    return experimental_evaluate(opts);
  };
}

export const TRANSPORTS = {
  openrouter: { model: OPENROUTER_MODEL, evaluator: openrouterEvaluator },
  gateway: { model: MODEL, evaluator: gatewayEvaluator },
};

/**
 * Run the review. `evaluate` is injected by the tests; otherwise `transport`
 * selects a route and the model id travels with it, so the two never drift
 * apart — the gateway and OpenRouter name the same model differently.
 */
export async function reviewArticle(article, {
  evaluate,
  transport = process.env.JEV_TRANSPORT ?? 'openrouter',
  questions = EDITORIAL_QUESTIONS,
  thresholds = DEFAULT_THRESHOLDS,
  apiKey,
  abortSignal,
} = {}) {
  const route = TRANSPORTS[transport];
  if (!route) {
    throw new Error(`Unknown transport '${transport}'. Try: ${Object.keys(TRANSPORTS).join(', ')}.`);
  }
  const run = evaluate ?? route.evaluator({ apiKey });

  const result = await run({
    model: route.model,
    state: articleState(article),
    questions,
    abortSignal,
  });

  return { answers: result.answers, usage: result.usage, ...verdict(result.answers, thresholds) };
}
