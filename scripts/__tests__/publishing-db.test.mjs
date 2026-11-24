import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations, reserveModel, reserveSearch, settleModel, saveSource, withLease } from '../publishing/store.mjs';
import { refreshWindow, tick } from '../publishing/pipeline.mjs';

export async function checkPostgres(db) {
  const day = '2099-01-01';
  const reservations = await Promise.all(Array.from({ length: 30 }, () => reserveModel(db, 'gpt-6-luna', 100000, day)));
  assert.equal(reservations.filter(Boolean).length, 20);
  await settleModel(db, reservations.find(Boolean), 10000, 'test-usage');
  const spent = await db.query('select model_micros from editorial.budgets where editorial_day = $1', [day]);
  assert.equal(spent.rows[0].model_micros, 1910000);

  const requests = await Promise.all(Array.from({ length: 16 }, () => reserveSearch(db, 'you', day)));
  assert.equal(requests.filter(Boolean).length, 12);
  assert.equal(await reserveSearch(db, 'duckduckgo', day), true);
  await assert.rejects(reserveSearch(db, 'brave', day), /Unsupported discovery provider/);

  const event = { id: 'test-event', title: 'Test event', keywords: ['test', 'event'] };
  const source = { url: 'https://example.com/test', title: 'Test source', publisher: 'Test',
    date: '2026-11-23T12:00:00Z', type: 'primary', hash: 'prior', excerpts: ['One supported fact.'] };
  await saveSource(db, source, event);
  await saveSource(db, { ...source, hash: 'newer' }, event);
  const records = await db.query('select content_hash from editorial.sources where url=$1', [source.url]);
  assert.deepEqual(records.rows.map(({ content_hash }) => content_hash), ['newer']);
  await db.query("update editorial.sources set excerpts='[]' where url=$1", [source.url]);

  await withLease(db, 'in-test', async () => {
    const competing = await withLease(db, 'in-test', () => assert.fail('A live lease was claimed twice.'));
    assert.equal(competing.busy, true);
    await db.query("update editorial.leases set until_at=now() - interval '1 min' where name='in-test'");
    assert.equal(await withLease(db, 'in-test', () => 'reclaimed'), 'reclaimed');
  });

  const first = Date.parse('2026-11-24T04:00:00Z');
  const second = Date.parse('2026-11-24T09:00:00Z');
  for (const now of [first, second, second]) {
    await db.query('insert into editorial.refreshes (id) values ($1) on conflict do nothing', [refreshWindow(now).id]);
    await tick(db, () => assert.fail('The empty source pool must make no model calls.'), { now, env: {} });
  }
  const daySlots = async () => (await db.query("select id, state from editorial.slots where editorial_day='2026-11-24' order by id")).rows;
  // Nothing opens before 14:30 IST; repeated ticks in the window are idempotent.
  assert.deepEqual(await daySlots(), [{ id: '2026-11-24-daily', state: 'new' }]);
  // An unfilled slot is marked missed once its window closes at midnight IST.
  const closed = Date.parse('2026-11-24T18:30:00Z');
  await db.query('insert into editorial.refreshes (id) values ($1) on conflict do nothing', [refreshWindow(closed).id]);
  await tick(db, () => assert.fail('The empty source pool must make no model calls.'), { now: closed, env: {} });
  assert.deepEqual(await daySlots(), [{ id: '2026-11-24-daily', state: 'missed' }]);
}

test('Postgres migration, transactional caps and lease recovery', { skip: !process.env.PUBLISH_TEST_DATABASE_URL }, async () => {
  const endpoint = new URL(process.env.PUBLISH_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(endpoint.hostname) && endpoint.pathname === '/editorial_test');
  const db = new pg.Pool({ connectionString: endpoint.href, max: 5 });
  try {
    await applyMigrations(db);
    await checkPostgres(db);
  } finally {
    await db.end();
  }
});
