import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool, q } from '../src/db.js';
import { enqueue, processOutbox, type Sender } from '../src/lib/outbox.js';
import { ck, login } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ authRateLimitMax: 1_000_000 }); });
afterAll(async () => { await app.close(); await pool.end(); });
afterEach(async () => { await q('DELETE FROM email_overrides'); await q('DELETE FROM cms_pages'); await q(`DELETE FROM app_settings WHERE key='portal_branding'`); });

const adm = (cookie: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), ...ck('admin', cookie) });
const sendOne = async (to: string, template: any, data: object) => { const out: any[] = []; const sender: Sender = async m => { out.push(m); }; await enqueue(pool, to, template, data); await processOutbox(sender, 5000); return out.find(m => m.to === to); };

describe('email wording', () => {
  it('lists every email; a preview shows the new wording; the sent email carries it, while the facts stay as built', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const list = (await adm(admin.cookie, 'GET', '/api/admin/emails')).json(); expect(list.length).toBeGreaterThanOrEqual(9); const t = list.find((x: any) => x.template === 'order_shipped'); expect(t.placeholders).toContain('shop'); expect(t.customised).toBe(false);
    const words = { subject: 'Good news from {shop}: order #{number} is on its way', intro: 'Hello from the EAZYstores team.', closing: 'Thank you for buying handmade.' };
    const pv = (await adm(admin.cookie, 'POST', '/api/admin/emails/order_shipped/preview', words)).json(); expect(pv.subject).toBe('Good news from Clay & Ember: order #10234 is on its way'); expect(pv.body.startsWith('Hello from the EAZYstores team.')).toBe(true); expect(pv.body).toContain('Tracking number: AB123456789CA'); expect(pv.body.endsWith('Thank you for buying handmade.')).toBe(true);
    expect((await adm(admin.cookie, 'PUT', '/api/admin/emails/order_shipped', { ...words, reason: 'brand voice' })).statusCode).toBe(200);
    const m = await sendOne('wording@t.test', 'order_shipped', { number: 77, shop: 'Wick & Wax', carrier: 'UPS', trackingNumber: 'ZZ99', url: 'https://x.test/o' });
    expect(m.subject).toBe('Good news from Wick & Wax: order #77 is on its way'); expect(m.body).toContain('Hello from the EAZYstores team.'); expect(m.body).toContain('Tracking number: ZZ99'); expect(m.html).toContain('Thank you for buying handmade.');
    expect((await adm(admin.cookie, 'GET', '/api/admin/emails')).json().find((x: any) => x.template === 'order_shipped').customised).toBe(true);
    await adm(admin.cookie, 'DELETE', '/api/admin/emails/order_shipped'); const plain = await sendOne('plain@t.test', 'order_shipped', { number: 78, shop: 'Wick & Wax', carrier: 'UPS', trackingNumber: 'ZZ98', url: 'https://x.test/o' }); expect(plain.subject).toBe('Your order #78 from Wick & Wax has shipped'); expect(plain.body).not.toContain('EAZYstores team');
    expect((await q(`SELECT action FROM audit_log WHERE entity_type='email_template' ORDER BY id`)).rows.map(r => r.action)).toEqual(['email.customise', 'email.reset']);
  });
  it('a subject can never carry a line break (no header injection), unknown placeholders vanish, lists are never pasted in, and only admin may edit', async () => {
    const admin = await login(app, 'admin', { role: 'admin' });
    await adm(admin.cookie, 'PUT', '/api/admin/emails/order_cancelled', { subject: 'Hi {number}\r\nBcc: evil@x.test {nope} {lines}', intro: '', closing: '' });
    const m = await sendOne('inject@t.test', 'order_cancelled', { number: 5, lines: [{ title: 'x' }] }); expect(m.subject).toBe('Hi 5 Bcc: evil@x.test'); expect(m.subject).not.toMatch(/[\r\n]/);
    expect((await adm(admin.cookie, 'PUT', '/api/admin/emails/order_cancelled', { subject: 'x'.repeat(200), intro: '', closing: '' })).statusCode).toBe(400);
    expect((await adm(admin.cookie, 'PUT', '/api/admin/emails/not_real', { subject: null, intro: '', closing: '' })).statusCode).toBe(404);
    const support = await login(app, 'support', { role: 'support' }); expect((await app.inject({ method: 'GET', url: '/api/admin/emails', ...ck('support', support.cookie) })).statusCode).toBe(401);
  });
});

describe('pages', () => {
  it('a page is invisible until published; visitors see only published ones; unpublishing hides it again; every change is audited', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const body = 'We keep what you tell us private.\n\n## What we collect\nYour name, email and address, to deliver your order.';
    expect((await adm(admin.cookie, 'PUT', '/api/admin/pages/privacy', { title: 'Privacy policy', body, published: false })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/pages/privacy' })).statusCode).toBe(404); expect((await app.inject({ method: 'GET', url: '/api/pages' })).json()).toEqual([]);
    expect((await adm(admin.cookie, 'PUT', '/api/admin/pages/privacy', { title: 'Privacy policy', body: 'short', published: true })).statusCode).toBe(422);
    await adm(admin.cookie, 'PUT', '/api/admin/pages/privacy', { title: 'Privacy policy', body, published: true });
    expect((await app.inject({ method: 'GET', url: '/api/pages' })).json()).toEqual([{ slug: 'privacy', title: 'Privacy policy' }]); const page = (await app.inject({ method: 'GET', url: '/api/pages/privacy' })).json(); expect(page.body).toBe(body);
    await adm(admin.cookie, 'PUT', '/api/admin/pages/privacy', { title: 'Privacy policy', body, published: false }); expect((await app.inject({ method: 'GET', url: '/api/pages/privacy' })).statusCode).toBe(404);
    expect((await adm(admin.cookie, 'PUT', '/api/admin/pages/Bad_Slug', { title: 'x', body, published: false })).statusCode).toBe(400);
    expect((await adm(admin.cookie, 'DELETE', '/api/admin/pages/privacy')).statusCode).toBe(200); expect((await q(`SELECT action FROM audit_log WHERE entity_type='page' ORDER BY id`)).rows.map(r => r.action)).toEqual(['page.create', 'page.update', 'page.update', 'page.delete']);
  });
});

describe('portal names and looks', () => {
  it('start as the defaults, are public, can be changed by admin, and are validated', async () => {
    const admin = await login(app, 'admin', { role: 'admin' }); const pub = async () => (await app.inject({ method: 'GET', url: '/api/settings/public' })).json().portal_branding;
    expect(await pub()).toMatchObject({ studio: { word: 'studio', look: 'atelier' }, admin: { word: 'admin' } });
    const next = { ...(await pub()), studio: { word: 'makers', look: 'sage' } }; expect((await adm(admin.cookie, 'PUT', '/api/admin/settings/portal_branding', { value: next })).statusCode).toBe(200); expect((await pub()).studio).toEqual({ word: 'makers', look: 'sage' });
    expect((await adm(admin.cookie, 'PUT', '/api/admin/settings/portal_branding', { value: { ...next, studio: { word: '', look: 'sage' } } })).statusCode).toBe(400); expect((await adm(admin.cookie, 'PUT', '/api/admin/settings/portal_branding', { value: { ...next, studio: { word: 'ok', look: 'neon' } } })).statusCode).toBe(400);
  });
});
