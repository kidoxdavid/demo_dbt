import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './migrate.js';
await runMigrations(m => console.log(m));
const app = await buildApp();
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`EAZYstores API on :${config.port}`);
