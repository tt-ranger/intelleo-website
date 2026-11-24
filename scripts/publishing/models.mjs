import Ajv from 'ajv';
import { reserveModel, settleModel } from './store.mjs';

export const MODELS = Object.freeze({ luna: 'gpt-6-luna', terra: 'gpt-6.1-terra', sol: 'gpt-6.2-sol' });
// Standard USD per million tokens, before any gateway-specific adjustment.
const STANDARD = Object.freeze({
  [MODELS.luna]: [0.10, 0.50],
  [MODELS.terra]: [1, 5],
  [MODELS.sol]: [2, 10],
});

export const text = { type: 'string' };
export const boolean = { type: 'boolean' };
export const integer = { type: 'integer' };
export const number = { type: 'number' };
export const list = (items) => ({ type: 'array', items });
export const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export class BudgetExhausted extends Error {}

// A 512px image costs a few hundred input tokens; this bound is deliberately generous.
const IMAGE_TOKEN_ALLOWANCE = 3000;

const validator = new Ajv({ allErrors: false });
const validators = new Map();

function endpointFor(value) {
  if (!value) throw new Error('LITELLM_URL is required.');
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('LITELLM_URL must be a private configuration value pointing to an HTTPS gateway.');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '');
  if (!endpoint.pathname.endsWith('/v1')) endpoint.pathname += '/v1';
  endpoint.pathname += '/responses';
  return endpoint;
}

function exactModel(actual, model) {
  const reported = typeof actual === 'string' ? actual.replace(/^openai\//, '') : '';
  return reported === model || (reported.startsWith(`${model}-`) && /^\d{4}-\d{2}-\d{2}$/.test(reported.slice(model.length + 1)));
}

export function modelClient(db, { env = process.env, fetchImpl = fetch, reserve = reserveModel, settle = settleModel } = {}) {
  const endpoint = endpointFor(env.LITELLM_URL);
  if (!env.LITELLM_KEY) throw new Error('LITELLM_KEY is required.');
  const adjustment = Number(env.LITELLM_PRICE_MULTIPLIER ?? '1.15');
  if (!Number.isFinite(adjustment) || adjustment < 1) throw new Error('Invalid LiteLLM reservation multiplier.');

  return async function run({ model, name, schema, instructions, data, maxOutput, images = [] }) {
    const rates = STANDARD[model];
    if (!rates) throw new Error('Model is outside the editorial allowlist.');
    if (images.length > 2 || images.some((url) => !/^data:image\/(jpeg|png|webp);base64,/.test(url) || url.length > 400000)) {
      throw new Error('Images must be at most two small inline data URLs.');
    }
    // Images go alongside the JSON data as Responses API input parts.
    const input = images.length
      ? [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(data) },
        ...images.map((image_url) => ({ type: 'input_image', image_url }))] }]
      : JSON.stringify(data);
    const payload = {
      model,
      service_tier: 'default',
      instructions,
      input,
      text: { format: { type: 'json_schema', name, strict: true, schema } },
      reasoning: { effort: 'low' },
      max_output_tokens: maxOutput,
      store: false,
    };
    const body = JSON.stringify(payload);
    const imageBytes = images.reduce((sum, url) => sum + url.length, 0);
    // Image bytes are not text tokens; each image is budgeted as a fixed token allowance instead.
    const bytes = Buffer.byteLength(body, 'utf8') - imageBytes + images.length * IMAGE_TOKEN_ALLOWANCE;
    if (bytes > 100000 || !Number.isInteger(maxOutput) || maxOutput < 128 || maxOutput > 12000) {
      throw new Error('Structured request is outside editorial token limits.');
    }
    // A UTF-8 byte bound intentionally overestimates input tokens. The
    // Responses API output cap includes reasoning tokens.
    const maximum = Math.ceil(((bytes + 1024) * rates[0] + maxOutput * rates[1]) * adjustment);
    const reservation = await reserve(db, model, maximum);
    if (!reservation) throw new BudgetExhausted('The daily model budget is exhausted.');

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { authorization: `Bearer ${env.LITELLM_KEY}`, 'content-type': 'application/json' },
        body,
      });
    } catch {
      // A timeout can still be billed. Keep the reservation.
      throw new Error(`${name}: LiteLLM did not return a response.`);
    }
    if (!response.ok) throw new Error(`${name}: LiteLLM HTTP ${response.status}.`);
    const result = await response.json();
    const price = response.headers.get('x-litellm-response-cost');
    const reportedCost = price?.trim() ? Number(price) : Number.NaN;
    const usage = result.usage;
    const cost = Number.isFinite(reportedCost) && reportedCost > 0
      ? Math.ceil(reportedCost * 1_000_000)
      : Number.isInteger(usage?.input_tokens) && Number.isInteger(usage?.output_tokens)
        && usage.input_tokens > 0 && usage.output_tokens > 0
        ? Math.ceil((usage.input_tokens * rates[0] + usage.output_tokens * rates[1]) * adjustment)
        : null;
    if (cost !== null) await settle(db, reservation, cost, result.id ?? null);
    if (cost === null || cost > maximum) throw new Error(`${name}: LiteLLM cost could not be bounded and confirmed.`);
    if (!exactModel(result.model, model)) throw new Error(`${name}: LiteLLM returned an unexpected model.`);
    if (result.status !== 'completed') throw new Error(`${name}: model response did not complete.`);
    const output = result.output?.flatMap((item) => item.type === 'message'
      ? item.content.filter((part) => part.type === 'output_text').map((part) => part.text) : []).join('');
    if (!output) throw new Error(`${name}: missing structured response.`);
    const value = JSON.parse(output);
    if (!validators.has(schema)) validators.set(schema, validator.compile(schema));
    if (!validators.get(schema)(value)) throw new Error(`${name}: invalid structured response.`);
    return value;
  };
}

const probeSchema = object({ ready: boolean });
export async function preflightModels(run) {
  for (const model of Object.values(MODELS)) {
    const probe = await run({
      model, name: 'editorial_preflight', schema: probeSchema, maxOutput: 512,
      instructions: 'Return ready=true using the provided schema.', data: null,
    });
    if (!probe.ready) throw new Error(`${model}: preflight failed.`);
    console.log(`${model}: structured output and usage verified.`);
  }
}
