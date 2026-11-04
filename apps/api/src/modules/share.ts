import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { withTx } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { publicUrl } from '../config.js';

type TenantCtx = { tenantId: string; role: string; userId: string };
export const SOURCES = [
  { key: 'instagram', label: 'Instagram' }, { key: 'whatsapp', label: 'WhatsApp' }, { key: 'facebook', label: 'Facebook' },
  { key: 'tiktok', label: 'TikTok' }, { key: 'email', label: 'Email' }, { key: 'qr', label: 'QR code (in person)' },
];

/** EazyLink: shareable store/product links with a channel tag, plus QR codes. Tags let sellers see which channel sells. */
export function registerShare(app: FastifyInstance, deps: { tenantCtx: (r: FastifyRequest) => Promise<TenantCtx> }) {
  app.get('/api/seller/share', async (req) => {
    const t = await deps.tenantCtx(req);
    return withTx(t, async c => {
      const store = (await c.query('SELECT slug, name, status FROM stores WHERE tenant_id=$1', [t.tenantId])).rows[0];
      const products = (await c.query(`SELECT id, name FROM products WHERE status='active' ORDER BY created_at DESC LIMIT 200`)).rows;
      return { baseUrl: publicUrl, store: { ...store, path: `/store/${store.slug}` }, sources: SOURCES,
        products: products.map(p => ({ id: p.id, name: p.name, path: `/store/${store.slug}/p/${p.id}` })) };
    });
  });

  // QR codes only for this seller's own store or product pages (never an arbitrary URL, so the endpoint cannot be abused as a free QR service).
  app.get('/api/seller/qr', async (req, reply) => {
    const t = await deps.tenantCtx(req);
    const q = z.object({ path: z.string().max(120), src: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional() }).parse(req.query);
    const m = /^\/store\/([a-z0-9-]+)(?:\/p\/([0-9a-f-]{36}))?$/.exec(q.path);
    if (!m) throw new HttpError(400, 'invalid_path');
    await withTx(t, async c => {
      const own = (await c.query('SELECT slug FROM stores WHERE tenant_id=$1', [t.tenantId])).rows[0];
      if (!own || own.slug !== m[1]) throw new HttpError(403, 'not_your_store');
      if (m[2] && !(await c.query('SELECT 1 FROM products WHERE id=$1', [m[2]])).rowCount) throw new HttpError(404, 'not_found');
    });
    const url = `${publicUrl}${q.path}${q.src ? `?src=${q.src}` : ''}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#141414', light: '#ffffff' } });
    return reply.header('content-type', 'image/svg+xml').header('cache-control', 'private, max-age=300').header('x-content-type-options', 'nosniff').send(svg);
  });
}
