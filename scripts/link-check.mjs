/**
 * Verifies that cited sources actually exist and actually say something
 * related to what they are cited for.
 *
 * This is the highest-value check in the pipeline. Fabricated citations —
 * plausible titles attached to dead or unrelated URLs — are the signature
 * failure of machine-written content, and they destroy credibility with
 * readers and generative engines alike.
 */
const TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (compatible; IntelleoQualityGate/1.0; +https://www.intelleo.in)';

const STOPWORDS = new Set([
  'the','a','an','and','or','of','for','to','in','on','with','how','what','why','is','are',
  'complete','guide','best','practices','2024','2025','2026','your','you','it','that','this',
]);

/** Distinctive lowercase terms from a citation title. */
export function keyTerms(title, max = 6) {
  return [...new Set(
    title.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  )].slice(0, max);
}

export function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function checkSource(source, { fetchImpl = fetch } = {}) {
  const terms = keyTerms(source.title);
  try {
    const res = await fetchImpl(source.url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      return { url: source.url, ok: false, code: 'dead-citation', message: `HTTP ${res.status}` };
    }

    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) {
      // PDFs and similar resolve but cannot be term-checked; existence is enough.
      return { url: source.url, ok: true, note: `non-HTML (${type.split(';')[0]}), existence verified only` };
    }

    const text = extractText(await res.text());
    const matched = terms.filter((t) => text.includes(t));

    // Require a third of distinctive terms — tolerant of paraphrased titles,
    // strict enough to catch a URL that has nothing to do with the claim.
    if (terms.length > 0 && matched.length / terms.length < 0.34) {
      return {
        url: source.url,
        ok: false,
        code: 'citation-mismatch',
        message: `page does not mention the cited topic (matched ${matched.length}/${terms.length}: ${terms.join(', ')})`,
      };
    }
    return { url: source.url, ok: true, matched: matched.length, total: terms.length };
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || /timeout/i.test(e?.message ?? '');
    return {
      url: source.url,
      ok: false,
      code: timedOut ? 'citation-timeout' : 'dead-citation',
      message: timedOut ? `no response in ${TIMEOUT_MS / 1000}s` : (e?.message ?? 'fetch failed'),
    };
  }
}

export async function checkSources(sources, opts = {}) {
  return Promise.all(sources.map((s) => checkSource(s, opts)));
}

// CLI: node scripts/link-check.mjs <file.md ...>
if (import.meta.url === `file://${process.argv[1]}`) {
  const { parseArticle } = await import('./lib/articles.mjs');
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/link-check.mjs <file.md ...>');
    process.exit(2);
  }
  let failed = 0;
  for (const f of files) {
    const a = parseArticle(f);
    const results = await checkSources(a.data.sources ?? []);
    console.log(`\n${a.slug}`);
    for (const r of results) {
      if (r.ok) console.log(`  ok    ${r.url}${r.note ? ` — ${r.note}` : ''}`);
      else { failed++; console.log(`  FAIL  ${r.url}\n        ${r.code}: ${r.message}`); }
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}
