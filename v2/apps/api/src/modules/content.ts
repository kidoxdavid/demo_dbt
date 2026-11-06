import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, q, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { requirePerm } from '../guards.js';
import { SAMPLE_DATA, TEMPLATES, applyOverride, loadOverrides, placeholdersFor } from '../lib/outbox.js';
import { TEMPLATE_CATEGORY } from '../lib/notify.js';

const LABEL: Record<string, string> = { order_confirmation: 'Order confirmation (buyer)', seller_new_order: 'New order (maker)', order_shipped: 'Order shipped (buyer)', refund_issued: 'Refund issued (buyer)', review_request: 'Review request (buyer)', new_message: 'New message', new_review: 'New review (maker)', review_reply: 'Maker replied to a review (buyer)', order_cancelled: 'Order cancelled (buyer)' };
const clean = (max: number) => z.string().trim().max(max).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), 'invalid_characters');
const wording = z.object({ subject: clean(150).nullable().default(null), intro: clean(600).default(''), closing: clean(600).default('') }).strict();
const slugRe = z.string().regex(/^[a-z0-9-]{2,40}$/);

export function registerContent(app: FastifyInstance) {
  // ---- email wording: an optional new subject plus a line before and a line after the usual text. The facts in each email (amounts, dates, links) stay as built.
  app.get('/api/admin/emails', async req => {
    requirePerm(req, 'settings.write'); const o = await loadOverrides();
    return Object.keys(TEMPLATES).map(t => ({ template: t, label: LABEL[t] ?? t, transactional: !!TEMPLATE_CATEGORY[t]?.transactional, placeholders: placeholdersFor(t), subject: o.get(t)?.subject ?? null, intro: o.get(t)?.intro ?? '', closing: o.get(t)?.closing ?? '', customised: o.has(t), standard: TEMPLATES[t](SAMPLE_DATA).subject }));
  });
  const known = (t: string) => { if (!(t in TEMPLATES)) throw new HttpError(404, 'unknown_template'); return t; };
  app.post('/api/admin/emails/:template/preview', async req => {
    requirePerm(req, 'settings.write'); const t = known(z.object({ template: z.string().max(40) }).parse(req.params).template); const w = wording.parse(req.body);
    const m = applyOverride(TEMPLATES[t](SAMPLE_DATA), SAMPLE_DATA, w); return { subject: m.subject, body: m.body };
  });
  app.put('/api/admin/emails/:template', async req => {
    const u = requirePerm(req, 'settings.write'); const t = known(z.object({ template: z.string().max(40) }).parse(req.params).template); const w = wording.extend({ reason: z.string().trim().max(300).optional() }).parse(req.body);
    await tx(async c => {
      const prev = (await c.query('SELECT subject, intro, closing FROM email_overrides WHERE template=$1', [t])).rows[0] ?? null;
      await c.query(`INSERT INTO email_overrides(template,subject,intro,closing,updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (template) DO UPDATE SET subject=EXCLUDED.subject, intro=EXCLUDED.intro, closing=EXCLUDED.closing, updated_by=EXCLUDED.updated_by, updated_at=now()`, [t, w.subject || null, w.intro, w.closing, u.id]);
      await audit(c, { actor: u.id, area: 'admin', action: 'email.customise', entityType: 'email_template', entityId: t, prev, next: { subject: w.subject, intro: w.intro, closing: w.closing }, reason: w.reason, ip: req.ip });
    });
    return { ok: true };
  });
  app.delete('/api/admin/emails/:template', async req => {
    const u = requirePerm(req, 'settings.write'); const t = known(z.object({ template: z.string().max(40) }).parse(req.params).template);
    await tx(async c => { const prev = (await c.query('DELETE FROM email_overrides WHERE template=$1 RETURNING subject, intro, closing', [t])).rows[0]; if (prev) await audit(c, { actor: u.id, area: 'admin', action: 'email.reset', entityType: 'email_template', entityId: t, prev, ip: req.ip }); });
    return { ok: true };
  });

  // ---- pages (terms, privacy, returns, ...): visitors see only published ones
  app.get('/api/pages', async (_req, reply) => { reply.header('cache-control', 'no-cache'); return (await q(`SELECT slug, title FROM cms_pages WHERE published ORDER BY title`)).rows; });
  app.get('/api/pages/:slug', async (req, reply) => {
    reply.header('cache-control', 'no-cache'); const { slug } = z.object({ slug: slugRe }).parse(req.params);
    const p = (await q(`SELECT slug, title, body, updated_at AS "updatedAt" FROM cms_pages WHERE slug=$1 AND published`, [slug])).rows[0]; if (!p) throw new HttpError(404, 'not_found'); return p;
  });
  app.get('/api/admin/pages', async req => { requirePerm(req, 'settings.write'); return (await q(`SELECT slug, title, body, published, updated_at AS "updatedAt" FROM cms_pages ORDER BY title`)).rows; });
  app.put('/api/admin/pages/:slug', async req => {
    const u = requirePerm(req, 'settings.write'); const { slug } = z.object({ slug: slugRe }).parse(req.params);
    const b = z.object({ title: clean(100).pipe(z.string().min(1)), body: z.string().max(60000).refine(s => !/\u0000/.test(s), 'invalid_characters'), published: z.boolean(), reason: z.string().trim().max(300).optional() }).strict().parse(req.body);
    if (b.published && b.body.trim().length < 20) throw new HttpError(422, 'page_too_short');
    await tx(async c => {
      const prev = (await c.query('SELECT title, published, length(body) AS chars FROM cms_pages WHERE slug=$1', [slug])).rows[0] ?? null;
      await c.query(`INSERT INTO cms_pages(slug,title,body,published,updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body, published=EXCLUDED.published, updated_by=EXCLUDED.updated_by, updated_at=now()`, [slug, b.title, b.body, b.published, u.id]);
      await audit(c, { actor: u.id, area: 'admin', action: prev ? 'page.update' : 'page.create', entityType: 'page', entityId: slug, prev, next: { title: b.title, published: b.published, chars: b.body.length }, reason: b.reason, ip: req.ip });
    });
    return { ok: true };
  });
  app.delete('/api/admin/pages/:slug', async req => {
    const u = requirePerm(req, 'settings.write'); const { slug } = z.object({ slug: slugRe }).parse(req.params);
    await tx(async c => { const prev = (await c.query('DELETE FROM cms_pages WHERE slug=$1 RETURNING title, published', [slug])).rows[0]; if (!prev) throw new HttpError(404, 'not_found'); await audit(c, { actor: u.id, area: 'admin', action: 'page.delete', entityType: 'page', entityId: slug, prev, ip: req.ip }); });
    return { ok: true };
  });
}
