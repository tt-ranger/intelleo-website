import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { FIGURE_KINDS, renderFigure, renderTitleCard, validateFigures, withUnits, wrap } from '../publishing/figures.mjs';
import { placeFigures, digestOf } from '../publishing/article.mjs';
import { availableShapes, recentShapes, SHAPES } from '../publishing/shapes.mjs';
import { illustrationClient, illustrationPrompt, toHero } from '../publishing/illustration.mjs';
import { modelClient, MODELS, object, boolean } from '../publishing/models.mjs';

const quote = 'The core build fell from 45 minutes to 12 minutes after the migration on 18 November 2026.';
const sources = [{ id: 0, publisher: 'P', kind: 'primary', excerpts: [quote] }];
const item = (label, extra = {}) => ({ label, detail: '', cells: [], value: 0, sourceId: -1, excerpt: '', ...extra });
const base = (kind, items, extra = {}) => ({
  kind, title: `A ${kind} figure`, caption: 'What the reader should take from this figure.',
  alt: 'Accessible description of the figure.', units: '', columns: [], axes: { x: '', y: '' }, items, ...extra,
});
const valid = {
  flow: base('flow', [item('First step'), item('Second step', { detail: 'With some detail' })]),
  decision: base('decision', [item('If the deadline holds', { detail: 'Keep batch' }), item('If it slips at peak', { detail: 'Stream' })]),
  comparison: base('comparison', [item('Latency', { cells: ['Hours', 'Seconds'] }), item('Cost', { cells: ['Low', 'High'] })], { columns: ['Batch', 'Stream'] }),
  timeline: base('timeline', [item('18 Nov 2026', { detail: 'Migration completed', sourceId: 0, excerpt: quote }), item('Later', { detail: 'Follow-up', sourceId: 0, excerpt: quote })]),
  quadrant: base('quadrant', ['TL', 'TR', 'BL', 'BR'].map((label) => item(`${label} cell`)), { axes: { x: 'Cost of error', y: 'Volume' } }),
  chart: base('chart', [item('Before', { value: 45, sourceId: 0, excerpt: quote }), item('After', { value: 12, sourceId: 0, excerpt: quote })], { units: 'minutes' }),
  stat: base('stat', [item('Build time after migration', { value: 12, sourceId: 0, excerpt: quote })], { units: 'min' }),
};

test('every figure kind validates and renders a 1200px WebP', async () => {
  for (const kind of FIGURE_KINDS) {
    assert.doesNotThrow(() => validateFigures([valid[kind]], sources), kind);
    const meta = await sharp(await renderFigure(valid[kind])).metadata();
    assert.deepEqual([meta.format, meta.width], ['webp', 1200], kind);
  }
});

test('figure sets are one to three figures of distinct kinds', () => {
  assert.throws(() => validateFigures([], sources), /one to three/);
  assert.throws(() => validateFigures([valid.flow, valid.chart, valid.stat, valid.decision], sources), /one to three/);
  assert.throws(() => validateFigures([valid.flow, valid.flow], sources), /different kind/);
  assert.doesNotThrow(() => validateFigures([valid.flow, valid.chart, valid.comparison], sources));
});

test('sourced figures must quote their values and dates', () => {
  const madeUp = { ...valid.chart, items: [valid.chart.items[0], { ...valid.chart.items[1], value: 13 }] };
  assert.throws(() => validateFigures([madeUp], sources), /appear in its quoted passage/);
  const unquoted = { ...valid.timeline, items: [{ ...valid.timeline.items[0], excerpt: 'Not in any source at all.' }, valid.timeline.items[1]] };
  assert.throws(() => validateFigures([unquoted], sources), /exact quote/);
});

test('shape rules are enforced per kind', () => {
  assert.throws(() => validateFigures([{ ...valid.quadrant, items: valid.quadrant.items.slice(0, 3) }], sources), /needs 4 items/);
  assert.throws(() => validateFigures([{ ...valid.comparison, items: [item('Latency', { cells: ['Hours'] }), valid.comparison.items[1]] }], sources), /one 1–48 character cell per column/);
  assert.throws(() => validateFigures([{ ...valid.chart, units: '' }], sources), /common unit/);
  assert.throws(() => validateFigures([{ ...valid.flow, caption: 'Too short' }], sources), /caption/);
});

test('units attach without a space only for symbols', () => {
  assert.equal(withUnits(10, '%'), '10%');
  assert.equal(withUnits(1500, 'ms'), '1,500 ms');
  assert.equal(withUnits(3, ''), '3');
});

test('wrap respects width and truncates with an ellipsis', () => {
  const lines = wrap('one two three four five six seven eight nine ten eleven twelve', 120, 20, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
});

test('title cards are 1200×630 and differ by seed', async () => {
  const card = (seed) => renderTitleCard({ title: 'Batch or streaming? Start with the deadline', label: 'Data · Explainer', cluster: 'data', seed });
  const [a, b] = await Promise.all([card('one'), card('two')]);
  const meta = await sharp(a).metadata();
  assert.deepEqual([meta.width, meta.height], [1200, 630]);
  assert.notDeepEqual(a, b);
});

test('figure markers are replaced in place and validated', () => {
  const figures = [valid.flow, valid.chart];
  const body = '## First?\n\nText.\n\n{{figure-1}}\n\n## Second?\n\nMore.\n\n{{figure-2}}';
  const placed = placeFigures(body, figures, 'some-slug');
  assert.match(placed, /!\[Accessible description of the figure\.\]\(\/images\/editorial\/some-slug-figure-1\.webp\)\n\n\*Figure 1: What the reader/);
  assert.match(placed, /some-slug-figure-2\.webp/);
  assert.throws(() => placeFigures('{{figure-1}}\n\n## First?\n\n{{figure-2}}', figures, 's'), /after the first section heading/);
  assert.throws(() => placeFigures('## A?\n\n{{figure-1}}\n\n{{figure-1}}', figures, 's'), /exactly once/);
  assert.throws(() => placeFigures('## A?\n\n{{figure-1}}', figures, 's'), /every figure/);
  assert.throws(() => placeFigures('## A?\n\nSee {{figure-1}} here.\n\n{{figure-2}}', figures, 's'), /line of its own/);
  assert.throws(() => placeFigures('## A?\n\n{{figure-3}}', figures, 's'), /exactly once/);
});

test('the digest covers every figure image', () => {
  const artifact = { markdown: 'm', image: 'h', figures: [{ src: '/a.webp', image: 'x' }] };
  assert.notEqual(digestOf(artifact), digestOf({ ...artifact, figures: [{ src: '/a.webp', image: 'y' }] }));
  assert.notEqual(digestOf(artifact), digestOf({ ...artifact, figures: [] }));
});

test('recently used shapes are avoided unless a format would be left without one', () => {
  const at = (shape, day) => ({ data: { shape, publishDate: `2026-11-${day}` } });
  const corpus = [at('comparison', 20), at('playbook', 22), at('decision-guide', 21), at('how-it-works', 10), { data: { publishDate: '2026-11-23' } }];
  assert.deepEqual(recentShapes(corpus), ['playbook', 'decision-guide', 'comparison']);
  const shapes = availableShapes(['analysis'], recentShapes(corpus));
  assert.ok(!shapes.includes('comparison') && !shapes.includes('decision-guide'));
  assert.ok(shapes.every((name) => SHAPES[name].formats.includes('analysis')));
  assert.deepEqual(availableShapes(['news'], ['what-changed']), ['what-changed']);
});

test('illustration prompts forbid text, people and brands', () => {
  const prompt = illustrationPrompt('  Layered   translucent planes  ');
  assert.match(prompt, /Layered translucent planes/);
  assert.match(prompt, /no text, letters, numbers, logos, people/i);
});

const png = async (width = 1344, height = 768) => sharp({ create: { width, height, channels: 3, background: '#123456' } }).png().toBuffer();

function illustrationHarness({ responses, checks }) {
  const settled = [];
  const calls = [];
  const run = async ({ name, images }) => {
    assert.equal(name, 'illustration_check');
    assert.match(images[0], /^data:image\/jpeg;base64,/);
    return checks.shift();
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return responses.shift()();
  };
  const client = illustrationClient(null, run, {
    env: { OPEN_ROUTER_API_KEY: 'k' }, fetchImpl, log: () => {},
    reserve: async () => `r${calls.length}`, settle: async (_db, id, micros) => settled.push([id, micros]),
  });
  return { client, settled, calls };
}
const clean = { text: false, logos: false, people: false, charts: false, border: false };
const ok = async (cost = 0.007) => Response.json({ data: [{ b64_json: (await png()).toString('base64') }], usage: { cost } });

test('an illustration that passes inspection becomes a 1200×630 WebP and settles the reported cost', async () => {
  const image = await ok();
  const { client, settled, calls } = illustrationHarness({ responses: [() => image], checks: [clean] });
  const result = await client('Streams of light converging into a calm reservoir.');
  const meta = await sharp(result.image).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 1200, 630]);
  assert.equal(result.model, 'recraft/recraft-v4.1-flash');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/images');
  assert.equal(calls[0].body.aspect_ratio, '16:9');
  assert.deepEqual(settled, [['r0', 7000]]);
});

test('an illustration with text is regenerated, and two failures fall back to nothing', async () => {
  const [a, b] = [await ok(), await ok()];
  const { client, settled } = illustrationHarness({ responses: [() => a, () => b], checks: [{ ...clean, text: true }, { ...clean, border: true }] });
  assert.equal(await client('Abstract geometric planes in teal and copper.'), null);
  assert.equal(settled.length, 2);
});

test('a provider error keeps the full reservation and falls back', async () => {
  const { client, settled } = illustrationHarness({
    responses: [() => Response.json({ error: 'down' }, { status: 500 }), () => Response.json({ error: 'down' }, { status: 500 })],
    checks: [],
  });
  assert.equal(await client('Abstract geometric planes in teal and copper.'), null);
  assert.deepEqual(settled.map(([, micros]) => micros), [150000, 150000]);
});

test('illustrations are off without a key, when disabled, or out of budget', async () => {
  const quiet = { log: () => {} };
  assert.equal(illustrationClient(null, null, { env: {}, ...quiet }), null);
  assert.equal(illustrationClient(null, null, { env: { ILLUSTRATION_PROVIDER: 'none', OPEN_ROUTER_API_KEY: 'k' } }), null);
  assert.throws(() => illustrationClient(null, null, { env: { ILLUSTRATION_PROVIDER: 'other' } }), /Unknown/);
  const broke = illustrationClient(null, null, {
    env: { OPEN_ROUTER_API_KEY: 'k' }, ...quiet, reserve: async () => null,
    fetchImpl: async () => assert.fail('no budget, no request'),
  });
  assert.equal(await broke('Abstract geometric planes in teal and copper.'), null);
});

test('the gateway provider uses its images endpoint and header-reported cost', async () => {
  const calls = [];
  const settled = [];
  const client = illustrationClient(null, async () => clean, {
    env: { ILLUSTRATION_PROVIDER: 'litellm', LITELLM_URL: 'https://gateway.example.com/v1', LITELLM_KEY: 'k' },
    log: () => {}, reserve: async () => 'r', settle: async (_db, _id, micros) => settled.push(micros),
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ data: [{ b64_json: (await png()).toString('base64') }] }),
        { headers: { 'x-litellm-response-cost': '0.067' } });
    },
  });
  assert.ok(await client('Abstract geometric planes in teal and copper.'));
  assert.deepEqual(calls, ['https://gateway.example.com/v1/images/generations']);
  assert.deepEqual(settled, [67000]);
});

test('toHero crops any aspect ratio to the hero size', async () => {
  const meta = await sharp(await toHero(await png(1024, 1024))).metadata();
  assert.deepEqual([meta.width, meta.height], [1200, 630]);
});

test('model requests can carry an inline image', async () => {
  let sent;
  const run = modelClient(null, {
    env: { LITELLM_URL: 'https://gateway.example.com/v1', LITELLM_KEY: 'k' },
    reserve: async () => 'r', settle: async () => {},
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return Response.json({ id: 'x', model: MODELS.luna, status: 'completed', usage: { input_tokens: 300, output_tokens: 20 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] });
    },
  });
  const params = { model: MODELS.luna, name: 'vision', schema: object({ ok: boolean }), instructions: 'Check.', data: { a: 1 }, maxOutput: 256 };
  assert.deepEqual(await run({ ...params, images: ['data:image/jpeg;base64,AAAA'] }), { ok: true });
  assert.deepEqual(sent.input[0].content.map(({ type }) => type), ['input_text', 'input_image']);
  await assert.rejects(run({ ...params, images: ['https://example.com/a.png'] }), /inline data URLs/);
});
