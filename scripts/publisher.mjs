#!/usr/bin/env node
import { parseArticle } from './lib/articles.mjs';
import { applyMigrations, connect } from './publishing/store.mjs';
import { modelClient, preflightModels } from './publishing/models.mjs';
import { reviewEditorial } from './publishing/editorial.mjs';
import { tick } from './publishing/pipeline.mjs';

const [command = 'tick', ...args] = process.argv.slice(2);
const supported = new Set(['tick', 'migrate', 'preflight', 'review']);
const certificate = process.env.PUBLISH_DB_ROOT_CERT?.replace(/\\n/g, '\n');
let db;
try {
  if (!supported.has(command)) throw new Error('Usage: publisher tick | migrate | preflight | review <article.md> [...]');
  if (command === 'review' && !args.length) throw new Error('Pass one or more Markdown articles to review.');
  if (command === 'migrate' && !process.env.DB_MIGRATION_CONNECTION_STRING) {
    throw new Error('Set DB_MIGRATION_CONNECTION_STRING to an administrator connection for the migration.');
  }
  db = connect(command === 'migrate' ? process.env.DB_MIGRATION_CONNECTION_STRING : process.env.DB_CONNECTION_STRING, certificate);
  if (command === 'migrate') {
    await applyMigrations(db);
    console.log('Supabase editorial schema is ready.');
  } else {
    const run = modelClient(db);
    if (command === 'preflight') {
      await db.query('select 1 from editorial.budgets limit 1');
      await preflightModels(run);
    } else if (command === 'review') {
      for (const path of args) {
        const { slug, data, body } = parseArticle(path);
        const result = await reviewEditorial(run, { ...data, body });
        console.log(JSON.stringify({ slug, ...result }, null, 2));
        if (!result.pass) process.exitCode = 1;
      }
    } else {
      await tick(db, run);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db?.end();
}
