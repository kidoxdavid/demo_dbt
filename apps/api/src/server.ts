import { buildApp } from './app.js';
import { config } from './config.js';
import { releaseExpiredReservations, cleanupOrphanUploads } from './modules/commerce.js';
const app = await buildApp();
setInterval(() => releaseExpiredReservations().catch(e => console.error('reservation sweep failed', e)), 60_000).unref();
setInterval(() => cleanupOrphanUploads().catch(e => console.error('upload cleanup failed', e)), 3_600_000).unref();
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`EazyStores API on :${config.port}`);
