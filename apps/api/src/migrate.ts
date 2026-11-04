import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log('applied', f);
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally { await c.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config } = await import('./config.js');
  await migrate(config.ownerDatabaseUrl);
}
