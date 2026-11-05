import { processOutbox } from './outbox.js';
import { processPush } from './push.js';
import { releaseExpiredReservations } from './orders.js';
/** Background work, safe to run from several processes. Called on a timer by the server and directly by tests. */
export const runJobs = async () => ({ released: await releaseExpiredReservations(), emails: await processOutbox(), push: await processPush() });
