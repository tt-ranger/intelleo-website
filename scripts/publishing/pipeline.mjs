import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { editorialDay, listPublished, loadRegistry, parseArticleText } from '../lib/articles.mjs';
import { runPureChecks } from '../lib/checks.mjs';
import { articleContext, planCandidates, produceDraft, redateArtifact, validEvent, verifyEvidence, verifyFactually } from './article.mjs';
import { scoreSources, scoredSources } from './editorial.mjs';
import { artifactPaths, githubPublisher } from './github.mjs';
import { ingestSources, fetchPublisher } from './sources.mjs';
import { expireSources, withLease, transaction } from './store.mjs';
import { BudgetExhausted } from './models.mjs';
import { findCorrection } from './corrections.mjs';
import { attachExperience, EXPERIENCE_KIND } from './experience.mjs';

const TIMEZONE = 'Asia/Kolkata';
// One article a day. A new domain earns trust through depth, not volume, and
// scaled-content signals are site-wide.
const SLOTS = [
  { hour: 14, name: 'daily', formats: ['analysis', 'explainer', 'news'], end: '24:00' },
];
const SEARCH_HOURS = [8, 12, 16, 20];
const HOUR = 3600000;

function localClock(value) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  return { hour: Number(parts.find(({ type }) => type === 'hour').value),
    minute: Number(parts.find(({ type }) => type === 'minute').value) };
}

function slotForDay(slot, day) {
  return { ...slot, day, id: `${day}-${slot.name}`, expiresAt: new Date(`${day}T${slot.end}:00+05:30`) };
}

export function currentSlot(now) {
  const { hour, minute } = localClock(now);
  const slot = SLOTS.filter((item) => hour > item.hour || (hour === item.hour && minute >= 30)).at(-1);
  if (!slot) return null;
  return slotForDay(slot, editorialDay(now));
}

export function refreshWindow(now) {
  const { hour } = localClock(now);
  const day = editorialDay(now);
  return { id: `${day}-hour-${hour}`, search: SEARCH_HOURS.indexOf(hour) };
}

async function publicationMode(db, env, now) {
  if (env.PUBLISH_MODE !== 'live') return 'shadow';
  const prior = await db.query("select value from editorial.settings where name='shadow-passed'");
  if (prior.rowCount) return 'live';
  const { rows: [outcome] } = await db.query(`
    select count(*) as days, count(*) filter (where qualified >= 2) as passing from (
      select editorial_day, count(*) filter (where state='qualified') as qualified
      from editorial.slots where mode='shadow' and editorial_day >= $1::date - 7
        and editorial_day < $1::date group by editorial_day
    ) previous
  `, [editorialDay(now)]);
  if (Number(outcome.days) < 7 || Number(outcome.passing) < 6) return 'shadow';
  await db.query("insert into editorial.settings values ('shadow-passed', $1) on conflict do nothing",
    [JSON.stringify({ date: editorialDay(now) })]);
  return 'live';
}

async function readySlot(db, slot, mode) {
  await db.query(`
    insert into editorial.slots (id, editorial_day, mode, state, expires_at)
    values ($1, $2, $3, 'new', $4) on conflict do nothing
  `, [slot.id, slot.day, mode, slot.expiresAt]);
  return (await db.query('select * from editorial.slots where id=$1', [slot.id])).rows[0];
}

async function changeState(db, slot, state, fields = {}) {
  const entries = Object.entries(fields);
  const statement = entries.map(([column], index) => `, ${column}=$${index + 3}`).join('');
  await db.query(`update editorial.slots set state=$2, updated_at=now()${statement} where id=$1`,
    [slot.id, state, ...entries.map(([, value]) => value)]);
  console.log(JSON.stringify({ slot: slot.id, state, reason: fields.reason }));
}

async function stageArticle(artifact) {
  const files = artifactPaths(artifact);
  if (files.some(([path]) => existsSync(path))) throw new Error('Shadow article would overwrite existing content.');
  const written = [];
  try {
    for (const [path, encoded] of files) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(encoded, 'base64'), { flag: 'wx' });
      written.push(path);
    }
    execFileSync(process.execPath, ['scripts/quality-gate.mjs', files[0][0]], { stdio: 'ignore', timeout: 90000 });
    execFileSync('npm', ['run', 'build'], { stdio: 'ignore', timeout: 120000 });
  } catch {
    throw new Error('The shadow article failed the citation gate or Astro build.');
  } finally {
    for (const path of written) rmSync(path, { force: true });
  }
}

async function refreshBriefSources(brief, now) {
  const external = brief.sources.filter(({ kind }) => kind !== EXPERIENCE_KIND);
  const fresh = await Promise.allSettled(external.map((source) =>
    fetchPublisher({ url: source.url, primary: source.kind === 'primary', date: source.date }, now)));
  if (fresh.some((item, index) => item.status !== 'fulfilled' || item.value?.url !== external[index].url)) return null;
  const sources = external.map((source, index) => ({ ...source, excerpts: fresh[index].value.excerpts }));
  const lead = sources.find(({ id }) => id === brief.lead.id);
  if (!lead || !validEvent(brief, lead, now)) return null;
  return attachExperience({ ...brief, sources, lead });
}

async function revalidateReserve(db, run, context, forbidden) {
  const { rows } = await db.query(`
    select * from editorial.reserve where used_at is null and created_at > now() - interval '14 days'
      and not (id = any($1)) order by created_at limit 3
  `, [[...forbidden]]);
  for (const row of rows) {
    const artifact = redateArtifact(row.draft, context.now);
    const article = parseArticleText(artifact.markdown, artifact.slug);
    const brief = await refreshBriefSources(artifact.evidence.brief, context.now);
    if (!brief) continue;
    const draft = { title: article.data.title, description: article.data.description, answer: article.data.answer,
      body: article.body, claims: artifact.evidence.claims, visual: artifact.evidence.visual };
    try { verifyEvidence(draft, brief.sources); } catch { continue; }
    if (runPureChecks(article, articleContext(context.corpus, context.registry, context.now)).some(({ level }) => level === 'error')) continue;
    const facts = await verifyFactually(run, draft, brief);
    if (facts.pass) return { ...artifact, facts, reserveId: row.id, evidence: { ...artifact.evidence, brief } };
  }
  return null;
}

async function prepare(db, run, slot, definition, now) {
  let sourceRows = await scoredSources(db);
  if (sourceRows.length < 6) {
    await scoreSources(db, run);
    sourceRows = await scoredSources(db);
  }
  const context = {
    corpus: listPublished(), registry: loadRegistry(), now,
    onRejection: ({ stage, attempt }) => console.log(JSON.stringify({ slot: slot.id, stage, attempt, rejected: true })),
  };
  const events = await db.query("select event_id from editorial.slots where state in ('qualified','opened','merged','published') and mode=$1 and event_id is not null", [slot.mode]);
  const forbidden = new Set([...events.rows.map(({ event_id }) => event_id), ...context.corpus.map(({ data }) => data.eventId)].filter(Boolean));
  const briefs = await planCandidates(run, { ...context, sources: sourceRows, formats: definition.formats, excludedEvents: [...forbidden] });
  for (const brief of briefs) {
    const current = await refreshBriefSources(brief, now);
    if (!current) continue;
    const artifact = await produceDraft(run, current, context);
    if (!artifact) continue;
    try {
      if (slot.mode === 'shadow') await stageArticle(artifact);
      return artifact;
    } catch (error) {
      console.log(JSON.stringify({ slot: slot.id, stage: 'shadow validation', reason: error.message }));
    }
  }
  const reserve = await revalidateReserve(db, run, context, forbidden);
  if (reserve && slot.mode === 'shadow') {
    try {
      await stageArticle(reserve);
    } catch (error) {
      console.log(JSON.stringify({ slot: slot.id, stage: 'shadow reserve validation', reason: error.message }));
      return null;
    }
  }
  return reserve;
}

async function refresh(db, run, now, env) {
  const window = refreshWindow(now);
  if ((await db.query('select 1 from editorial.refreshes where id=$1', [window.id])).rowCount) return;
  await ingestSources(db, { now, searchWindow: window.search < 0 ? null : window.search, env });
  await db.query('insert into editorial.refreshes (id) values ($1) on conflict do nothing', [window.id]);
  const scored = await scoreSources(db, run);
  console.log(JSON.stringify({ refresh: window.id, assessed: scored }));
  await expireSources(db);
}

async function refillReserve(db, run, now) {
  const day = editorialDay(now);
  const hour = localClock(now).hour;
  if (hour < 20) return;
  const key = `${day}-reserve`;
  if ((await db.query('select 1 from editorial.refreshes where id=$1', [key])).rowCount) return;
  const { rows } = await db.query(`
    select id from editorial.reserve where used_at is null and created_at > now() - interval '14 days'
  `);
  if (rows.length < 5) {
    const corpus = listPublished();
    const registry = loadRegistry();
    const sources = await scoredSources(db);
    const briefs = await planCandidates(run, { sources, corpus, registry, formats: ['explainer'], excludedEvents: rows.map(({ id }) => id), now });
    if (briefs.length) {
      const current = await refreshBriefSources(briefs[0], now);
      const draft = current ? await produceDraft(run, current, { corpus, registry, now }) : null;
      if (draft) await db.query('insert into editorial.reserve (id, cluster, draft) values ($1,$2,$3) on conflict do nothing',
        [draft.eventId, draft.cluster, draft]);
    }
  }
  await db.query('insert into editorial.refreshes (id) values ($1) on conflict do nothing', [key]);
}

async function scheduleCorrection(db, run, now) {
  if (localClock(now).hour < 21) return;
  const day = editorialDay(now);
  const id = `${day}-correction`;
  if ((await db.query('select 1 from editorial.refreshes where id=$1', [id])).rowCount) return;
  const artifact = await findCorrection(db, run, { corpus: listPublished(), registry: loadRegistry(), now });
  if (artifact) {
    const slot = await readySlot(db, { day, id, expiresAt: new Date(`${day}T23:59:59+05:30`) }, 'live');
    if (slot.state === 'new') {
      await changeState(db, slot, 'qualified', { cluster: artifact.cluster, event_id: artifact.eventId, slug: artifact.slug, draft: artifact });
    }
  }
  await db.query('insert into editorial.refreshes (id) values ($1) on conflict do nothing', [id]);
}

async function reportPreviousDay(db, now, env) {
  const day = editorialDay(now - 24 * HOUR);
  const key = `${day}-daily-report`;
  if ((await db.query('select 1 from editorial.refreshes where id=$1', [key])).rowCount) return;
  const { rows: [summary] } = await db.query(`
    select count(*) filter (where mode='live' and state='published' and id not like '%-correction')::int as live,
      count(*) filter (where mode='shadow' and state='qualified')::int as qualified,
      count(*) filter (where mode='live')::int as live_slots,
      count(*) filter (where state='missed')::int as missed,
      count(*) filter (where mode='live' and state in ('qualified','opened','merged','new'))::int as pending,
      coalesce((select model_micros from editorial.budgets where editorial_day=$1::date), 0)::int as model_micros
    from editorial.slots where editorial_day=$1::date
  `, [day]);
  if (summary.pending) return;
  await db.query('insert into editorial.refreshes (id) values ($1) on conflict do nothing', [key]);
  const message = `Editorial ${day} • ${summary.live} live • ${summary.qualified} qualified in shadow • ${summary.missed} missed • $${(summary.model_micros / 1e6).toFixed(4)} models`;
  console.log(message);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`);
  // A missed day is preferable to a weak article, so this is a notice, not a failure.
  if (summary.live_slots && summary.live < 1) {
    const notice = `Editorial ${day} published nothing: no draft cleared every check.`;
    console.log(notice);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${notice}\n`);
  }
}

async function advancePublication(db, github, now, { enabled }) {
  const { rows } = await db.query(`
    select * from editorial.slots where mode='live' and
      (state in ('opened','merged') or (state='qualified' and pr is null))
    order by editorial_day, expires_at
  `);
  for (const slot of rows) {
    if (slot.state === 'merged') {
      if (await github.verify(slot.draft)) {
        await changeState(db, slot, 'published', { reason: null });
        continue;
      }
      if (slot.deploy_retries < 2 && await github.retryDeploy(slot.merge_sha)) {
        await changeState(db, slot, 'merged', { deploy_retries: slot.deploy_retries + 1 });
      }
      if (now - new Date(slot.updated_at).valueOf() > 2 * HOUR) throw new Error('A merged article has not reached the live site.');
      return false;
    }
    if (now >= new Date(slot.expires_at).valueOf()) {
      const merged = await github.close(slot);
      await changeState(db, slot, merged ? 'merged' : 'missed', merged ? { merge_sha: merged } : { reason: 'Publishing window expired.' });
      if (merged) return false;
      continue;
    }
    if (!enabled) return false;
    if (slot.state === 'qualified') {
      const pr = await github.open(slot);
      if (pr.merged_at) {
        await changeState(db, slot, 'merged', { pr: pr.number, head: pr.head.sha, merge_sha: pr.merge_commit_sha });
      } else if (pr.state !== 'open') {
        await changeState(db, slot, 'missed', { pr: pr.number, reason: 'Article PR was closed.' });
      } else {
        await changeState(db, slot, 'opened', { pr: pr.number, head: pr.head.sha });
      }
      return false;
    }
    const result = await github.merge(slot);
    if (result.merged) {
      await changeState(db, slot, 'merged', { merge_sha: result.merged });
      return false;
    }
    if (result.closed || result.rejected) {
      if (result.rejected) {
        const racedMerge = await github.close(slot);
        if (racedMerge) {
          await changeState(db, slot, 'merged', { merge_sha: racedMerge });
          return false;
        }
      }
      await changeState(db, slot, 'missed', { reason: result.rejected ? 'Required CI failed.' : 'Article PR was closed.' });
      continue;
    }
    return false;
  }
  return true;
}

export async function tick(db, run, { now = Date.now(), env = process.env } = {}) {
  return withLease(db, 'editorial-tick', async () => {
    const mode = await publicationMode(db, env, now);
    const hasLive = (await db.query("select 1 from editorial.slots where mode='live' and state in ('qualified','opened','merged') limit 1")).rowCount;
    const github = mode === 'live' || hasLive ? await githubPublisher(env) : null;
    if (mode === 'live') await github.requireProtection();
    const ready = github ? await advancePublication(db, github, now, { enabled: mode === 'live' }) : true;
    const definition = currentSlot(now);
    for (const slot of SLOTS.map((item) => slotForDay(item, editorialDay(now)))) {
      if (slot.expiresAt.valueOf() <= now) await readySlot(db, slot, mode);
    }
    let pendingError;
    if (ready && definition && now < definition.expiresAt.valueOf()) {
      const slot = await readySlot(db, definition, mode);
      if (slot.state === 'new') {
        try {
          const artifact = await prepare(db, run, slot, definition, now);
          if (artifact) {
            await transaction(db, async (client) => {
              await changeState(client, slot, 'qualified', { cluster: artifact.cluster, event_id: artifact.eventId, slug: artifact.slug, draft: artifact });
              if (artifact.format === 'news') {
                await client.query('update editorial.events set event_at=$2 where id=$1',
                  [artifact.eventId, artifact.evidence.brief.eventAt]);
              }
              if (artifact.reserveId) await client.query('update editorial.reserve set used_at=now() where id=$1', [artifact.reserveId]);
            });
            if (github && slot.mode === 'live') await advancePublication(db, github, Date.now(), { enabled: true });
          } else {
            // Another refresh during the same slot may provide enough evidence.
            console.log(JSON.stringify({ slot: slot.id, state: 'new', reason: 'No candidate qualified in this run.' }));
          }
        } catch (error) {
          if (error instanceof BudgetExhausted) await changeState(db, slot, 'missed', { reason: 'The daily model budget is exhausted.' });
          else pendingError = error;
        }
      }
    }
    const expired = await db.query(`
      update editorial.slots set state='missed', reason='No draft qualified during the window.', updated_at=now()
       where state='new' and expires_at <= $1 returning id
    `, [new Date(now)]);
    for (const { id } of expired.rows) console.log(JSON.stringify({ slot: id, state: 'missed', reason: 'No draft qualified during the window.' }));
    try {
      await refresh(db, run, now, env);
      if (mode === 'live' && ready) await scheduleCorrection(db, run, now);
      await refillReserve(db, run, now);
    } catch (error) {
      if (error instanceof BudgetExhausted) console.log('Intake stopped at the daily model budget.');
      else pendingError ??= error;
    }
    await reportPreviousDay(db, now, env);
    if (pendingError) throw pendingError;
  });
}
