/**
 * AI hero illustrations. Abstract, text-free images only: they decorate, they
 * never carry information, so nothing in them needs fact-checking. Each one
 * is inspected by a vision model before use, and any failure falls back to a
 * code-drawn title card instead of failing the article.
 */
import sharp from 'sharp';
import { reserveModel, settleModel } from './store.mjs';
import { MODELS, object, boolean } from './models.mjs';

const PROVIDERS = {
  openrouter: { url: () => 'https://openrouter.ai/api/v1/images', key: (env) => env.OPEN_ROUTER_API_KEY, model: 'recraft/recraft-v4.1-flash' },
  litellm: {
    url: (env) => {
      const endpoint = new URL(env.LITELLM_URL);
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/images/generations`;
      return endpoint.href;
    },
    key: (env) => env.LITELLM_KEY, model: 'gemini-3.1-flash-image',
  },
};
// Reserved before each call and settled to the reported cost. Covers the dearest models tried ($0.13).
const MAX_IMAGE_MICROS = 150000;
const ATTEMPTS = 2;
const MAX_BYTES = 300000;

const STYLE = `Full-bleed abstract editorial illustration for a technology publication, filling the frame edge to edge with
no border, frame or margin. Deep navy background with copper and muted teal accents, geometric forms, soft gradients,
calm and minimal composition. Visual metaphor:`;
const FORBIDDEN = `Absolutely no text, letters, numbers, logos, people, faces, hands, screens, user interfaces, charts or diagrams.`;

export function illustrationPrompt(concept) {
  return `${STYLE} ${concept.replace(/\s+/g, ' ').trim()} ${FORBIDDEN}`;
}

const checkSchema = object({ text: boolean, logos: boolean, people: boolean, charts: boolean, border: boolean });

export async function inspectIllustration(run, image) {
  const preview = await sharp(image).resize(512).jpeg({ quality: 70 }).toBuffer();
  const verdict = await run({
    model: MODELS.luna, name: 'illustration_check', schema: checkSchema, maxOutput: 600,
    instructions: `Inspect the image. Report whether it contains any legible or pseudo text, letters or numbers; logos or brand
marks; human figures, faces or hands; charts, diagrams or user-interface screenshots; and a visible border or frame.`,
    data: { task: 'Check this illustration.' },
    images: [`data:image/jpeg;base64,${preview.toString('base64')}`],
  });
  return { ...verdict, pass: !Object.values(verdict).some(Boolean) };
}

/** 1200×630 WebP under the gate's size limit. */
export async function toHero(raw) {
  for (const quality of [82, 70, 58]) {
    const image = await sharp(raw).resize(1200, 630, { fit: 'cover', position: 'attention' }).webp({ quality }).toBuffer();
    if (image.length <= MAX_BYTES) return image;
  }
  throw new Error('Illustration could not be encoded under the size limit.');
}

/**
 * Returns `illustrate(concept) -> { image, model } | null`, or null when
 * illustrations are disabled or unconfigured.
 */
export function illustrationClient(db, run, {
  env = process.env, fetchImpl = fetch, reserve = reserveModel, settle = settleModel, log = console.log,
} = {}) {
  const name = env.ILLUSTRATION_PROVIDER ?? 'openrouter';
  if (name === 'none') return null;
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown ILLUSTRATION_PROVIDER "${name}".`);
  const key = provider.key(env);
  if (!key) {
    log(JSON.stringify({ illustration: 'disabled', reason: `${name} key is not set` }));
    return null;
  }
  const model = env.ILLUSTRATION_MODEL || provider.model;

  async function generate(concept) {
    const reservation = await reserve(db, model, MAX_IMAGE_MICROS);
    if (!reservation) return null;
    let cost = MAX_IMAGE_MICROS;
    try {
      const response = await fetchImpl(provider.url(env), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: illustrationPrompt(concept), n: 1, aspect_ratio: '16:9', usage: { include: true } }),
      });
      const body = await response.json().catch(() => ({}));
      const reported = Number(body.usage?.cost ?? response.headers.get('x-litellm-response-cost'));
      if (Number.isFinite(reported) && reported > 0) cost = Math.min(Math.ceil(reported * 1_000_000), MAX_IMAGE_MICROS);
      const encoded = body.data?.[0]?.b64_json;
      if (!response.ok || !encoded) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(encoded, 'base64');
    } finally {
      // Unknown cost keeps the full reservation, so spend is never under-counted.
      await settle(db, reservation, cost, null);
    }
  }

  return async function illustrate(concept) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const raw = await generate(concept);
        if (!raw) return null;
        const image = await toHero(raw);
        const check = await inspectIllustration(run, image);
        if (check.pass) return { image, model };
        log(JSON.stringify({ illustration: 'rejected', attempt, check }));
      } catch (error) {
        log(JSON.stringify({ illustration: 'failed', attempt, reason: error.message }));
      }
    }
    return null;
  };
}
