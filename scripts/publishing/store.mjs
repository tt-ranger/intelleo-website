import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { editorialDay } from '../lib/articles.mjs';

export const hash = (value) => createHash('sha256').update(value).digest('hex');

export function connect(connectionString, certificate) {
  if (!connectionString) throw new Error('DB_CONNECTION_STRING is required.');
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DB_CONNECTION_STRING must be a Postgres URL.');
  const rootPath = url.searchParams.get('sslrootcert');
  let ca = certificate;
  if (!ca && rootPath && rootPath !== 'system') ca = readFileSync(rootPath, 'utf8');
  if (!ca && !rootPath && /^(?:db\.[a-z0-9]+\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$/i.test(url.hostname)) {
    // The public root CA used by Supabase Studio's SSL certificate download.
    const supabaseCA = new URL('../../infra/certificates/supabase-root-2021.crt', import.meta.url);
    ca = [...rootCertificates, readFileSync(supabaseCA, 'utf8')];
  }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  return new pg.Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(ca && { ca }) },
    max: 2,
    connectionTimeoutMillis: 7000,
    statement_timeout: 15000,
    application_name: 'intelleo-editorial',
  });
}

export async function applyMigrations(db) {
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  const files = readdirSync(directory).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
  await transaction(db, async (client) => {
    await client.query('select pg_advisory_xact_lock(74750318)');
    for (const file of files) {
      await client.query(readFileSync(new URL(file, directory), 'utf8'));
    }
  });
}

export async function transaction(db, work) {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function withLease(db, name, work) {
  const holder = randomUUID();
  const claim = await db.query(
    `insert into editorial.leases values ($1, $2, now() + interval '30 minutes')
     on conflict (name) do update set holder = excluded.holder, until_at = excluded.until_at
     where editorial.leases.until_at < now() returning holder`, [name, holder],
  );
  if (!claim.rowCount) return { busy: true };
  try {
    return await work();
  } finally {
    await db.query('delete from editorial.leases where name = $1 and holder = $2', [name, holder]);
  }
}

export async function reserveModel(db, model, micros, day = editorialDay()) {
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error('Invalid model reservation.');
  return transaction(db, async (client) => {
    await client.query('insert into editorial.budgets (editorial_day) values ($1) on conflict do nothing', [day]);
    const charge = await client.query(
      `update editorial.budgets set model_micros = model_micros + $2
       where editorial_day = $1 and model_micros + $2 <= 2000000 returning editorial_day`, [day, micros],
    );
    if (!charge.rowCount) return null;
    const id = randomUUID();
    await client.query(
      'insert into editorial.model_calls (id, editorial_day, model, reserved_micros) values ($1, $2, $3, $4)',
      [id, day, model, micros],
    );
    return id;
  });
}

export async function settleModel(db, id, micros, providerId) {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error('Invalid reported model spend.');
  return transaction(db, async (client) => {
    const result = await client.query(
      'select * from editorial.model_calls where id = $1 and charged_micros is null for update', [id],
    );
    const call = result.rows[0];
    if (!call) return;
    await client.query(
      'update editorial.model_calls set charged_micros = $2, provider_id = $3 where id = $1',
      [id, micros, providerId],
    );
    await client.query(
      'update editorial.budgets set model_micros = model_micros + $2 where editorial_day = $1',
      [call.editorial_day, micros - call.reserved_micros],
    );
  });
}

export async function reserveSearch(db, provider, day = editorialDay()) {
  if (provider !== 'duckduckgo' && provider !== 'you') throw new Error('Unsupported discovery provider.');
  const result = await db.query(
    `insert into editorial.search_calls (editorial_day, provider, used) values ($1, $2, 1)
     on conflict (editorial_day, provider) do update set used = editorial.search_calls.used + 1
     where editorial.search_calls.used < 12 returning used`, [day, provider],
  );
  return Boolean(result.rowCount);
}

export async function saveSource(db, source, event) {
  await transaction(db, async (client) => {
    await client.query(
      'insert into editorial.events (id, title, keywords) values ($1, $2, $3) on conflict do nothing',
      [event.id, event.title, event.keywords],
    );
    await client.query(
      `insert into editorial.sources (url, event_id, title, publisher, published_at, source_type, content_hash, excerpts)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (url) do update set event_id=excluded.event_id, title=excluded.title, publisher=excluded.publisher,
       published_at=excluded.published_at, source_type=excluded.source_type, content_hash=excluded.content_hash,
       excerpts=excluded.excerpts, fetched_at=now()`,
      [source.url, event.id, source.title, source.publisher, source.date,
        source.type, source.hash, JSON.stringify(source.excerpts)],
    );
  });
}

export async function expireSources(db) {
  await db.query("update editorial.sources set excerpts = '[]' where fetched_at < now() - interval '30 days' and excerpts <> '[]'");
  await db.query("delete from editorial.sources where fetched_at < now() - interval '90 days'");
  await db.query(`delete from editorial.events e where first_seen < now() - interval '90 days'
    and not exists (select 1 from editorial.sources s where s.event_id = e.id)`);
  await db.query("delete from editorial.assessments where assessed_at < now() - interval '90 days'");
  await db.query("delete from editorial.refreshes where finished_at < now() - interval '90 days'");
  await db.query("delete from editorial.reserve where created_at < now() - interval '14 days'");
  await db.query(`update editorial.slots set draft = null where updated_at < now() - interval '30 days'
    and state in ('qualified', 'missed') and draft is not null`);
}
