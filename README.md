# Intelleo website

Static site for [www.intelleo.in](https://www.intelleo.in), built with Astro and
deployed to GitHub Pages. Articles are Markdown files in the content collection;
an autonomous writing agent adds them, and a CI quality gate decides what ships.

## Quick start

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # -> dist/
```

## How publishing works

```
topic-planner  ──→  brief (domain × subject × recent news)
                          │
                    agent writes .md
                          │
                 quality gate (CI) ── fail ──→ drafts/ + reasons
                          │ pass
                   Astro build → GitHub Pages
```

| Command | Purpose |
|---|---|
| `npm run plan` | Generate article briefs (`--count 4`, `--json`, `--offline`) |
| `npm run gate` | Run the quality gate (`--quarantine`, `--offline`, `--json`) |
| `npm run test:gate` | Unit tests for the gate rules |
| `npm run build` | Build the static site |

## Content model

Articles live in `src/content/blog/*.md`. Frontmatter is validated by
`src/content/config.ts` — an invalid article fails the build, not just the gate.

Three axes govern what gets written:

- **`cluster`** — the domain: `ai`, `ml`, `data`, `software-for-ai`, `geo`
- **`subject`** — must exist in `src/data/subjects.yaml`, capped at 10 articles each
- **`newsHook`** — optional recent item, must be ≤30 days old

Balance rules (`src/data/subjects.yaml`): no subject over its cap, no cluster
above 35% of output, at least 40% of articles carrying a news hook, max 4/day.

**When subjects approach their caps, add new ones to `subjects.yaml`.** Current
capacity is 30 subjects × 10 = 300 articles. The `/review` dashboard shows
remaining headroom — running out is the expected throttle, not a bug.

## Quality gate

Publishing is autonomous, so the gate is the only thing between the agent and a
[scaled-content](https://developers.google.com/search/docs/essentials/spam-policies)
problem. It rejects: thin content (<1200 words), fewer than 3 dated sources,
**dead or fabricated citations** (every source URL is fetched and checked for
topical match), missing answer-first summary, fewer than half question-phrased
H2s, missing pillar/sibling links, near-duplicate topics, subjects at cap, stale
news hooks, and more than 4 articles per day.

Failures move to `drafts/` with a `.rejected.txt` explaining why, and surface on
`/review`.

## Content admin (`/admin`)

Sveltia CMS — a browser-based editor that reads and writes the Markdown files in
`src/content/blog` through the GitHub API. Rich text, media uploads, drafts.

**Saving opens a pull request, not a commit to `main`.** That routes anything
written here through the same quality gate as the writing agent, including live
citation verification. Merge the PR to publish.

The config at `/admin/config.yml` is *generated* from `src/data/subjects.yaml`
(see `src/pages/admin/config.yml.ts`), so the subject dropdown can never offer a
value the content schema would reject.

### One-time setup

GitHub Pages cannot hold an OAuth client secret, so token exchange needs a small
free proxy. Roughly 20 minutes.

**1. Create a GitHub OAuth app** — github.com/settings/developers → OAuth Apps →
New OAuth App:

| Field | Value |
|---|---|
| Application name | Intelleo CMS |
| Homepage URL | `https://www.intelleo.in` |
| Authorization callback URL | `https://<your-worker>.workers.dev/callback` |

Note the Client ID and generate a Client Secret.

**2. Deploy the auth worker** to the Cloudflare Workers free tier:

```bash
git clone https://github.com/sveltia/sveltia-cms-auth
cd sveltia-cms-auth && npm install && npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ALLOWED_DOMAINS   # www.intelleo.in
```

Then set the callback URL from step 1 to the deployed worker's `/callback`.

**3. Point the CMS at the worker.** Add a repository variable
`PUBLIC_CMS_AUTH_URL` (Settings → Secrets and variables → Actions → Variables)
set to `https://<your-worker>.workers.dev`, then redeploy. Until this is set the
config ships a `REPLACE-ME` placeholder and login will fail.

**4. Open** `https://www.intelleo.in/admin` and sign in with GitHub.

`/admin` is `noindex`, robots-disallowed and excluded from the sitemap. Write
access is enforced by GitHub repo permissions, not by the page.

## Review dashboard

`/review` — published articles with filters (date, cluster, subject, news hook,
original data, stale), subject quota bars, cluster balance, and rejected drafts.

`noindex` and excluded from the sitemap, but **GitHub Pages cannot authenticate**,
so it is reachable by anyone with the URL. It lists only already-public articles.

## Analytics

GA4 with Consent Mode v2 (denied by default) plus a consent banner, enabled by
setting `PUBLIC_GA4_ID`. Unset, no analytics renders at all. The `mailto:` CTA
fires a `contact_email_click` conversion.

## Deployment

`.github/workflows/deploy.yml` builds and deploys on push to `main`.
Requires Pages **Source: GitHub Actions** (not "Deploy from a branch").
`public/CNAME` preserves the custom domain.
