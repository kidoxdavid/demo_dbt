import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, tx } from './db.js';
import { seedReference } from './reference/seed.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Forward-only SQL migrations, each in its own transaction, recorded in schema_migrations. Then idempotent reference data. */
export async function runMigrations(log: (m: string) => void = () => {}) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name as string));
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await tx(async c => { await c.query(readFileSync(join(dir, f), 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); });
    log(`applied ${f}`);
  }
  await tx(seedReference);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations(m => console.log(m)).then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
}
