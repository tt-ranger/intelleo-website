import { load } from 'cheerio';
import { installationToken, githubHeaders } from './github-auth.mjs';
import { parseArticleText } from '../lib/articles.mjs';
import { hash } from './store.mjs';

const REQUIRED_CHECK = 'content-quality';
const BASE = 'main';

export function artifactPaths(artifact) {
  const { slug, markdown, hero, image, digest } = artifact;
  if (!/^[a-z0-9-]{10,80}$/.test(slug) || hero?.src !== `/images/editorial/${slug}.webp`
    || hash(markdown + image) !== digest || !artifact.facts?.pass || !artifact.editorial?.pass) {
    throw new Error('Draft lacks an intact fact-check and editorial verdict.');
  }
  return [
    [`src/content/blog/${slug}.md`, Buffer.from(markdown, 'utf8').toString('base64')],
    [`public${hero.src}`, image],
  ];
}

function branchFor(slot) {
  return `editorial/${slot.id.replace(/[^a-z0-9-]/g, '-')}`;
}

function createClient(repository, token, fetchImpl) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) throw new Error('Invalid GITHUB_REPOSITORY.');
  return async function api(path, { method = 'GET', data, acceptable = [] } = {}) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method, headers: githubHeaders(token), redirect: 'error',
      signal: AbortSignal.timeout(18000), ...(data && { body: JSON.stringify(data) }),
    });
    if (!response.ok && !acceptable.includes(response.status)) {
      await response.body?.cancel();
      throw new Error(`GitHub ${method} ${path.split('?')[0]} returned ${response.status}.`);
    }
    return { status: response.status, value: response.status === 204 ? null : await response.json() };
  };
}

async function requireProtection(api) {
  const { value: rules } = await api('/rules/branches/main');
  if (!rules.some(({ type, parameters }) => type === 'pull_request' && parameters?.required_approving_review_count === 0)
    || !rules.some(({ type, parameters }) => type === 'required_status_checks'
      && parameters.strict_required_status_checks_policy
      && parameters.required_status_checks.some(({ context }) => context === REQUIRED_CHECK))) {
    throw new Error('Protect main with required PRs and the strict content-quality check before live publishing.');
  }
}

async function branchHead(api, branch) {
  const { value, status } = await api(`/git/ref/heads/${branch}`, { acceptable: [404] });
  return status === 404 ? null : value.object.sha;
}

async function verifyFiles(api, pr, artifact) {
  const expected = artifactPaths(artifact);
  const { value: changes } = await api(`/pulls/${pr.number}/files?per_page=100`);
  const expectedStatus = artifact.correction ? 'modified' : 'added';
  const markdownPath = expected[0][0];
  if ((!artifact.correction && changes.length !== expected.length)
    || !changes.some((file) => file.filename === markdownPath)
    || changes.some((file) => file.status !== expectedStatus || !expected.some(([path]) => path === file.filename))) {
    throw new Error('Article PR includes an unexpected change.');
  }
  for (const [path, content] of expected) {
    const { value: blob } = await api(`/contents/${path}?ref=${pr.head.sha}`);
    if (blob.encoding !== 'base64' || blob.content.replace(/\s/g, '') !== content) {
      throw new Error('Article PR differs from the reviewed draft.');
    }
  }
}

async function openPr(api, repository, slot) {
  const artifact = slot.draft;
  const paths = artifactPaths(artifact);
  const branch = branchFor(slot);
  const main = await branchHead(api, BASE);
  if (!main) throw new Error('Publishing base branch is unavailable.');
  let head = await branchHead(api, branch);
  if (!head) {
    const { value: commit } = await api(`/git/commits/${main}`);
    const tree = [];
    for (const [path, content] of paths) {
      const { value: blob } = await api('/git/blobs', { method: 'POST', data: { content, encoding: 'base64' } });
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const { value: nextTree } = await api('/git/trees', { method: 'POST', data: { base_tree: commit.tree.sha, tree } });
    const { value: nextCommit } = await api('/git/commits', {
      method: 'POST', data: { message: `Publish ${artifact.slug}`, tree: nextTree.sha, parents: [main] },
    });
    await api('/git/refs', {
      method: 'POST', data: { ref: `refs/heads/${branch}`, sha: nextCommit.sha }, acceptable: [422],
    });
    head = await branchHead(api, branch);
    if (!head) throw new Error('Publishing branch could not be recovered.');
  }
  const owner = repository.split('/')[0];
  const { value: existing } = await api(`/pulls?state=all&base=${BASE}&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  let pr = existing[0];
  if (!pr) {
    const article = parseArticleText(artifact.markdown, artifact.slug);
    ({ value: pr } = await api('/pulls', {
      method: 'POST', data: {
        title: `Article: ${article.data.title}`,
        body: 'Prepared by the Intelleo editorial workflow. Automated checks verify the reviewed article and its image.',
        head: branch, base: BASE,
      },
    }));
  }
  if (pr.state === 'open') await verifyFiles(api, pr, artifact);
  return pr;
}

async function attemptMerge(api, slot) {
  const { value: pr } = await api(`/pulls/${slot.pr}`);
  if (pr.merged) return { merged: pr.merge_commit_sha };
  if (pr.state !== 'open') return { closed: true };
  if (pr.head.ref !== branchFor(slot) || pr.base.ref !== BASE) throw new Error('Article PR has an unexpected ref.');
  await requireProtection(api);
  const main = await branchHead(api, BASE);
  const base = await api(`/compare/${main}...${pr.head.sha}`);
  if (base.value.behind_by) {
    await verifyFiles(api, pr, slot.draft);
    await api(`/pulls/${slot.pr}/update-branch`, {
      method: 'PUT', data: { expected_head_sha: pr.head.sha }, acceptable: [403, 409, 422],
    });
    return { waiting: true };
  }
  await verifyFiles(api, pr, slot.draft);
  const { value: checks } = await api(`/commits/${pr.head.sha}/check-runs?check_name=${REQUIRED_CHECK}&filter=latest`);
  const check = checks.check_runs.find((candidate) => candidate.app?.slug === 'github-actions');
  if (!check || check.status !== 'completed') return { waiting: true };
  if (check.conclusion !== 'success') return { rejected: true };
  const { value: result, status } = await api(`/pulls/${slot.pr}/merge`, {
    method: 'PUT', data: { sha: pr.head.sha, merge_method: 'squash' }, acceptable: [405, 409],
  });
  return status === 200 && result.merged ? { merged: result.sha } : { waiting: true };
}

async function closePr(api, slot) {
  if (!slot.pr) return;
  const { value: pr } = await api(`/pulls/${slot.pr}`);
  if (pr.merged) return pr.merge_commit_sha;
  if (pr.state === 'open' && pr.head.ref === branchFor(slot)) {
    await api(`/pulls/${slot.pr}`, { method: 'PATCH', data: { state: 'closed' } });
  }
}

export async function verifyLive(artifact, { site = 'https://www.intelleo.in', fetchImpl = fetch } = {}) {
  const page = new URL(`/blog/${artifact.slug}`, site).href;
  const article = parseArticleText(artifact.markdown, artifact.slug);
  const targets = [page, new URL(artifact.hero.src, site).href, new URL('/blog', site).href, new URL('/rss.xml', site).href];
  try {
    const responses = await Promise.all(targets.map((url) =>
      fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(12000) })));
    if (responses.some((response) => !response.ok) || !responses[1].headers.get('content-type')?.includes('image/webp')) return false;
    const [html, image, index, rss] = await Promise.all([
      responses[0].text(), responses[1].arrayBuffer(), responses[2].text(), responses[3].text(),
    ]);
    const $ = load(html);
    const feed = load(rss, { xml: true });
    const featured = load(index);
    const canonical = $('link[rel="canonical"]').attr('href')?.replace(/\/$/, '');
    const revision = article.data.updatedDate;
    const liveRevision = $('meta[property="article:modified_time"]').attr('content')
      ?? [...$('script[type="application/ld+json"]')].map((node) => $(node).text()).join(' ');
    return canonical === page && $('h1').first().text() === article.data.title
      && (!revision || liveRevision.includes(new Date(revision).toISOString()))
      && $('figure.article-hero img').attr('src') === artifact.hero.src
      && Buffer.from(image).toString('base64') === artifact.image
      && featured(`a[href="/blog/${artifact.slug}"]`).length > 0
      && feed('item link').toArray().some((node) => feed(node).text().replace(/\/$/, '') === page);
  } catch {
    return false;
  }
}

export async function githubPublisher(env, fetchImpl = fetch) {
  const repository = env.GITHUB_REPOSITORY ?? 'tt-ranger/intelleo-website';
  const token = await installationToken(env, fetchImpl);
  const api = createClient(repository, token, fetchImpl);
  return {
    requireProtection: () => requireProtection(api),
    open: (slot) => openPr(api, repository, slot),
    merge: (slot) => attemptMerge(api, slot),
    close: (slot) => closePr(api, slot),
    verify: (artifact) => verifyLive(artifact, { fetchImpl, site: env.PUBLISH_SITE_URL }),
    async retryDeploy(sha) {
      const { value } = await api(`/actions/workflows/deploy.yml/runs?head_sha=${sha}&event=push&per_page=3`);
      const recent = value.workflow_runs[0];
      if (recent?.status !== 'completed' || !['failure', 'cancelled', 'timed_out'].includes(recent.conclusion)) return false;
      await api(`/actions/runs/${recent.id}/rerun-failed-jobs`, { method: 'POST' });
      return true;
    },
  };
}
