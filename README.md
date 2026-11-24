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

The editorial workflow collects publisher feeds and public APIs hourly.
DuckDuckGo MCP and You.com provide four additional refreshes per day. Supabase
stores the canonical source records, evidence, model spend, and publishing state.

GPT-6 Luna screens sources. GPT-6.1 Terra prepares research briefs, fact-checks
drafts and runs the editorial review. GPT-6.2 Sol writes the articles, so the
fact-check always runs on a different model from the writer. The pipeline uses
LiteLLM for every model call.

There is one publication slot a day, from 14:30 IST. A missed day is logged,
not treated as a failure: a gap is cheaper than a weak article. A verified
draft opens a content-only PR. Once checks pass, the publisher merges it and
verifies that the article, image, blog listing, and RSS entry are live.

Articles may claim first-hand experience only from entries in
`src/content/experience/` (case studies, benchmarks, field notes published at
`/experience`). Matching entries are attached to each brief as `intelleo`
sources; see `_template.md` there. They do not count toward the three external
citations.

| Command | Purpose |
|---|---|
| `npm run publisher -- preflight` | Verify Supabase connectivity and structured output from all three LiteLLM routes |
| `npm run publisher -- tick` | Run the current editorial interval |
| `npm run review -- path/to/article.md` | Run the Luna editorial rubric |
| `npm run plan` | Generate local topic briefs (`--count 4`, `--json`, `--offline`) |
| `npm run gate` | Check articles (`--base <sha>`, `--offline`, `--json`) |
| `npm run test:gate` | Run the gate and publishing tests |
| `npm run build` | Build the static site |

### Set up the publishing workflow

1. Apply the Supabase migration with `DB_MIGRATION_CONNECTION_STRING` and
   `npm run publisher -- migrate`. Grant an application login `USAGE` on the
   `editorial` schema and `SELECT, INSERT, UPDATE, DELETE` on its tables. Use that
   login for `DB_CONNECTION_STRING`. Use the Supabase session pooler DSN if the
   runner requires IPv4. The publisher bundles the public Supabase CA for hosted
   Supabase database and pooler endpoints. Download a replacement from
   Database Settings under SSL Configuration if needed. Supply its PEM contents
   as `PUBLISH_DB_ROOT_CERT` or point the DSN's `sslrootcert` at a local file.
   Keep the migration credential outside Actions.
2. Set the Actions secrets `DB_CONNECTION_STRING`, `LITELLM_URL`, `LITELLM_KEY`,
   and `YOU_DOT_COM_API_KEY`. Scope the LiteLLM key to
   `gpt-6-luna`, `gpt-6.1-terra`, and `gpt-6.2-sol`. Set the
   `LITELLM_PRICE_MULTIPLIER` variable to cover any gateway markup. Run the
   **Editorial publishing** workflow with the `preflight` input.
3. Install a GitHub App on this repository with Contents, Pull requests, and
   Actions write access and Checks read access. Set its
   `PUBLISH_GITHUB_APP_PRIVATE_KEY` as an Actions secret and its
   `PUBLISH_GITHUB_APP_ID` and `PUBLISH_GITHUB_INSTALLATION_ID` as Actions
   variables. Protect `main` with required PRs and the strict
   `content-quality` status check. The publishing rule uses zero approvals and
   should apply to the App without a bypass.
4. Deploy the separate Cloudflare Worker in `infra/publishing-clock` using its
   Wrangler configuration. Set the same three GitHub App settings as Worker
   secrets. Run the seven-day trial with `PUBLISH_MODE=shadow` or leave that
   variable unset. Shadow runs validate with real sources, models, and the Astro
   build, then store their outcome privately. Setting `PUBLISH_MODE=live` enables
   merging after at least two drafts qualify on six of the previous seven days.
   Set it back to `shadow` to pause merges.

The run summary reports live or shadow output, missed slots, and model spend.
The publisher reserves spend before sending model requests and limits DuckDuckGo
and You.com to 12 queries each per IST day. DuckDuckGo uses a pinned MCP server
with no account or API key. GitHub Actions installs `uvx` to launch the server.
Install `uv` locally to run the same search step outside Actions.
When DuckDuckGo returns no links, discovery also tries GDELT.

## Content model

Articles live in `src/content/blog/*.md`. Frontmatter is validated by
`src/content/config.ts` — an invalid article fails the build, not just the gate.

Three axes govern what gets written:

- **`cluster`** — the domain: `ai`, `ml`, `data`, `software-for-ai`, `geo`
- **`subject`** — must exist in `src/data/subjects.yaml`, capped at 4 articles in a rolling 90-day window
- **`newsHook`** — optional recent item, must be ≤30 days old

The planner targets a diverse mix of topics and recent news. The quality gate
limits the site to one article per IST day. The `/review` dashboard shows
subject capacity for the rolling 90-day window.

## Quality gate

Publishing is autonomous, so the gate is the only thing between the agent and a
[scaled-content](https://developers.google.com/search/docs/essentials/spam-policies)
problem. It rejects short drafts (under 500 words for news and under 1,200 for longer
formats), fewer than three dated sources,
**dead or fabricated citations** (every source URL is fetched and checked for
topical match), missing answer-first summary, fewer than half question-phrased
H2s, missing pillar/sibling links, near-duplicate bodies or angles (title and
answer overlap within 90 days), subjects at cap, stale news hooks, and more than
one article per day.

Checks run on changed articles, so older news remains buildable. Automated
rejections stay in the private workflow. Local checks with `--quarantine` can
move rejected files into `drafts/` for display on `/review`.

## Trust and entity pages

`/about`, `/editorial` (how the automated workflow works and who is
accountable), `/editorial-policy` (sourcing, AI use, corrections),
`/corrections` (generated from articles with a `correction` field) and
`/experience`. The Organization schema links them as `publishingPrinciples`,
`correctionsPolicy` and `ethicsPolicy`. Add public profiles to `SITE.sameAs`
and `AUTHOR.sameAs` in `src/data/site.ts` as they go live.

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
