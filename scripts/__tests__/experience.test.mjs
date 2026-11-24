import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachExperience, excerptsOf, loadExperience, plainText, relevantExperience, EXPERIENCE_KIND,
} from '../publishing/experience.mjs';
import { validateMarkdown, verifyEvidence } from '../publishing/article.mjs';

const entry = (slug, data, body = '') => ({ slug, data: { publishDate: '2026-10-01', ...data }, body });
const paragraph = 'We moved retrieval evaluation into CI and caught a recall regression of eleven points before release.';
const rag = entry('rag-eval-ci', { title: 'RAG evaluation in CI', cluster: 'software-for-ai', subjects: ['rag-systems'] },
  `## Context\n\n${paragraph}\n\n- a list item that should be ignored by the excerpt reader entirely\n\nShort.`);
const cluster = entry('vector-notes', { title: 'Vector store notes', cluster: 'software-for-ai', subjects: ['vector-databases'] },
  'Index rebuilds took four hours on the old cluster, so we switched to incremental upserts for every tenant.');
const other = entry('warehouse', { title: 'Warehouse migration', cluster: 'data', subjects: ['warehouse-design'] }, paragraph);
const external = [
  { id: 0, url: 'https://a.example/1', publisher: 'A', kind: 'primary', excerpts: ['Primary announcement text for the release.'] },
  { id: 1, url: 'https://b.example/2', publisher: 'B', kind: 'independent', excerpts: ['Independent coverage of the release.'] },
  { id: 2, url: 'https://c.example/3', publisher: 'C', kind: 'independent', excerpts: ['Further independent analysis here.'] },
];
const brief = { cluster: 'software-for-ai', subject: 'rag-systems', sources: external };

test('excerpts are plain prose paragraphs, skipping headings, lists and short lines', () => {
  assert.deepEqual(excerptsOf(rag.body), [paragraph]);
  assert.equal(plainText('See **the** [guide](https://x.example) `now`'), 'See the guide now');
  assert.deepEqual(excerptsOf(''), []);
});

test('relevance prefers subject over cluster and ignores other clusters', () => {
  assert.deepEqual(relevantExperience([cluster, other, rag], brief).map(({ slug }) => slug), ['rag-eval-ci', 'vector-notes']);
  assert.deepEqual(relevantExperience([other], brief), []);
});

test('attaching experience adds Intelleo sources and is idempotent', () => {
  const once = attachExperience(brief, [rag, cluster, other]);
  const own = once.sources.filter(({ kind }) => kind === EXPERIENCE_KIND);
  assert.deepEqual(own.map(({ url }) => url), [
    'https://www.intelleo.in/experience/rag-eval-ci', 'https://www.intelleo.in/experience/vector-notes',
  ]);
  assert.ok(own.every(({ id, publisher }) => id >= 1000 && publisher === 'Intelleo'));
  assert.deepEqual(attachExperience(once, [rag, cluster, other]), once);
  assert.deepEqual(attachExperience(brief, []).sources, external);
});

test('first-hand claims verify against Intelleo excerpts, but do not count as external citations', () => {
  const { sources } = attachExperience(brief, [rag]);
  const claims = [
    ...external.map(({ id, excerpts }) => ({ claim: excerpts[0], consequential: false, evidence: [{ sourceId: id, excerpt: excerpts[0] }] })),
    { claim: paragraph, consequential: false, evidence: [{ sourceId: 1000, excerpt: paragraph }] },
  ];
  assert.doesNotThrow(() => verifyEvidence({ claims }, sources));
  const own = 'https://www.intelleo.in/experience/rag-eval-ci';
  const body = (links) => links.map((url, i) => `See [source ${i}](${url}).`).join('\n\n');
  assert.doesNotThrow(() => validateMarkdown(body([...external.map(({ url }) => url), own]), sources, []));
  assert.throws(() => validateMarkdown(body([external[0].url, external[1].url, own]), sources, []), /external/);
});

test('loader reads published entries and skips templates and drafts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'experience-'));
  try {
    const file = (name, extra = '') => writeFileSync(join(dir, name),
      `---\ntitle: Entry\ncluster: data\nsubjects: [data-quality]\npublishDate: 2026-10-01\n${extra}---\n\n${paragraph}\n`);
    file('live.md');
    file('_template.md');
    file('pending.md', 'draft: true\n');
    assert.deepEqual(loadExperience(dir).map(({ slug }) => slug), ['live']);
    assert.deepEqual(loadExperience(join(dir, 'missing')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
