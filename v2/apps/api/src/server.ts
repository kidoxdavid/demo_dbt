import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { runMigrations } from './migrate.js';
import { runJobs } from './lib/jobs.js';
import { errorFields, log } from './lib/log.js';
import { checkProductionConfig } from './lib/prod-check.js';

if (config.production) { const c = checkProductionConfig(process.env); for (const w of c.warnings) log('warn', w); if (c.errors.length) { for (const e of c.errors) log('fatal', `config: ${e}`); process.exit(1); } }
await runMigrations(m => log('info', m));
const app = await buildApp();

// Background jobs: one run at a time, and shutdown waits for the current one.
let running: Promise<unknown> | null = null;
const timer = setInterval(() => { if (running) return; running = runJobs().catch(e => log('error', 'jobs failed', errorFields(e))).finally(() => { running = null; }); }, 30_000);

await app.listen({ port: config.port, host: '0.0.0.0' });
log('info', `EAZYstores API on :${config.port}`, { env: config.env });

/** Stop taking new requests, let the ones in flight and the running job finish, close the database, then exit. A supervisor restarts us; nothing is cut off mid-order. */
let stopping = false;
async function shutdown(signal: string, code = 0) {
  if (stopping) return; stopping = true; log('info', `${signal}: shutting down`); const force = setTimeout(() => { log('error', 'shutdown took too long, forcing exit'); process.exit(1); }, 20_000); force.unref();
  clearInterval(timer);
  try { await app.close(); await running; await pool.end(); log('info', 'shutdown complete'); process.exit(code); } catch (e) { log('error', 'shutdown failed', errorFields(e)); process.exit(1); }
}
process.on('SIGTERM', () => void shutdown('SIGTERM')); process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', e => { log('fatal', 'unhandled rejection', errorFields(e)); void shutdown('unhandledRejection', 1); });
process.on('uncaughtException', e => { log('fatal', 'uncaught exception', errorFields(e)); void shutdown('uncaughtException', 1); });
