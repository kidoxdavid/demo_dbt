// DEV ONLY: adds a large synthetic catalogue (default 20,000 pieces from 300 shops) for load testing. Point DATABASE_URL at a scratch database, never a real one.
import { config } from './config.js';
import { pool, tx } from './db.js';
import { runMigrations } from './migrate.js';
import { seedLoadData } from './seed/loadData.js';
if (config.production) { console.error('Refusing to seed load data in production'); process.exit(1); }
await runMigrations(); const n = Number(process.argv[2] ?? 20000); const made = await tx(c => seedLoadData(c, n)); console.log(made ? `Created ${n} pieces.` : 'Load data already exists.'); await pool.end();
