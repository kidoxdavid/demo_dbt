import type { FastifyInstance } from 'fastify';
import { SETTINGS, allFlags, allSettings, type SettingKey } from '../settings.js';

/** What the storefront may read without signing in: public settings and feature flags (a missing flag is ON). */
export function registerPublicConfig(app: FastifyInstance) {
  app.get('/api/settings/public', async () => { const all = await allSettings(); return Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).filter(k => SETTINGS[k].public).map(k => [k, all[k]])); });
  app.get('/api/flags', async () => allFlags());
  /** Is this a practice site? True whenever payments are simulated or emails go nowhere, so screens can say so plainly. */
  app.get('/api/mode', async () => ({ testMode: process.env.NODE_ENV !== 'production' || !process.env.SMTP_URL || process.env.PAYMENT_PROVIDER === 'mock', payments: process.env.NODE_ENV === 'production' && process.env.PAYMENT_PROVIDER && process.env.PAYMENT_PROVIDER !== 'mock' ? 'live' : 'simulated', email: process.env.SMTP_URL ? 'sent' : 'not sent' }));
}
