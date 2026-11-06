import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, q } from '../db.js';
import { HttpError } from '../errors.js';
import { requireFlag } from '../settings.js';
import { cartFor } from '../lib/cartStore.js';
import { priceCart } from '../lib/cart.js';
import { DEFAULT_PROFILE, POSTAL, deliveryWindow, shippingCents, type Profile } from '../lib/shipping.js';
import { now as clockNow } from '../lib/clock.js';
import { VISIBLE } from '../lib/cards.js';

const view = (cart: Awaited<ReturnType<typeof priceCart>>) => ({
  count: cart.count, itemsCents: cart.itemsCents, shippingCents: cart.shippingCents, totalCents: cart.itemsCents + cart.shippingCents, taxNote: 'GST is added at checkout', blocked: cart.blocked,
  sellers: cart.groups.map(g => ({ sellerId: g.sellerId, shop: g.shop, itemsCents: g.itemsCents, shippingCents: g.shippingCents, freeShipping: g.freeShipping, eta: g.eta, gift: g.gift,
    lines: g.lines.map(l => ({ id: l.itemId, variantId: l.variantId, productId: l.productId, title: l.title, variant: l.variantLabel, quantity: l.quantity, unitCents: l.unitCents, compareAtCents: l.compareAtCents, lineCents: l.lineCents, image: l.image, art: l.art, issue: l.issue, available: l.available, oneOfAKind: l.oneOfAKind, personalisation: l.personalisation })) })) });

export function registerCart(app: FastifyInstance) {
  app.get('/api/cart', async (req, reply) => { const id = await cartFor(req, reply, false); if (!id) return view(await priceCartEmpty()); return view(await priceCart(pool, id)); });
  const priceCartEmpty = async () => ({ groups: [], itemsCents: 0, shippingCents: 0, taxCents: 0, totalCents: 0, count: 0, blocked: false });

  /** Add to basket. Checks the same rules checkout will, so a buyer finds out now, not at the till. Adding the same variant again adds to its quantity. */
  app.post('/api/cart/items', async (req, reply) => {
    const b = z.object({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(20).default(1), personalisation: z.record(z.string().max(60), z.string().max(500)).default({}) }).strict().parse(req.body);
    const v = (await q(`SELECT v.id, v.tracks_stock, v.stock_on_hand - v.stock_reserved AS avail, p.one_of_a_kind, p.personalisation AS fields FROM variants v JOIN products p ON p.id=v.product_id JOIN shops s ON s.id=p.shop_id JOIN sellers se ON se.id=p.seller_id
      WHERE v.id=$1 AND v.status='active' AND ${VISIBLE}`, [b.variantId])).rows[0]; if (!v) throw new HttpError(404, 'not_found');
    if ((await q('SELECT 1 FROM variants x JOIN products p ON p.id=x.product_id JOIN shops s ON s.id=p.shop_id WHERE x.id=$1 AND s.vacation_mode', [b.variantId])).rowCount) throw new HttpError(409, 'shop_on_vacation');
    for (const f of v.fields as { label: string; required: boolean; maxLength?: number }[]) { const val = b.personalisation[f.label]; if (f.required && !val?.trim()) throw new HttpError(422, 'personalisation_required', { field: f.label }); if (val && f.maxLength && val.length > f.maxLength) throw new HttpError(422, 'personalisation_too_long', { field: f.label }); }
    const cartId = (await cartFor(req, reply))!; const have = (await q('SELECT quantity FROM cart_items WHERE cart_id=$1 AND variant_id=$2', [cartId, b.variantId])).rows[0]?.quantity ?? 0; const want = have + b.quantity;
    if (v.one_of_a_kind && have > 0) throw new HttpError(409, 'already_in_basket');
    if (want > 20) throw new HttpError(422, 'quantity_limit'); if (v.tracks_stock && want > v.avail) throw new HttpError(409, 'out_of_stock', { available: Math.max(0, v.avail) });
    await q(`INSERT INTO cart_items(cart_id,variant_id,quantity,personalisation) VALUES ($1,$2,$3,$4) ON CONFLICT (cart_id,variant_id) DO UPDATE SET quantity=EXCLUDED.quantity, personalisation=EXCLUDED.personalisation`, [cartId, b.variantId, want, JSON.stringify(b.personalisation)]);
    await q('UPDATE carts SET updated_at=now() WHERE id=$1', [cartId]); return reply.code(201).send(view(await priceCart(pool, cartId)));
  });
  app.patch('/api/cart/items/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const b = z.object({ quantity: z.number().int().min(1).max(20) }).strict().parse(req.body); const cartId = await cartFor(req, reply, false); if (!cartId) throw new HttpError(404, 'not_found');
    const it = (await q(`SELECT ci.id, v.tracks_stock, v.stock_on_hand - v.stock_reserved AS avail, p.one_of_a_kind FROM cart_items ci JOIN variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id WHERE ci.id=$1 AND ci.cart_id=$2`, [id, cartId])).rows[0]; if (!it) throw new HttpError(404, 'not_found');
    if (it.one_of_a_kind && b.quantity > 1) throw new HttpError(409, 'one_of_a_kind_single'); if (it.tracks_stock && b.quantity > it.avail) throw new HttpError(409, 'out_of_stock', { available: Math.max(0, it.avail) });
    await q('UPDATE cart_items SET quantity=$2 WHERE id=$1', [id, b.quantity]); return view(await priceCart(pool, cartId));
  });
  app.delete('/api/cart/items/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const cartId = await cartFor(req, reply, false); if (!cartId) throw new HttpError(404, 'not_found');
    if (!(await q('DELETE FROM cart_items WHERE id=$1 AND cart_id=$2', [id, cartId])).rowCount) throw new HttpError(404, 'not_found'); return view(await priceCart(pool, cartId));
  });
  /** "This is a gift" and its message, per maker. */
  app.put('/api/cart/gift/:sellerId', async (req, reply) => {
    await requireFlag('gift_options');
    const { sellerId } = z.object({ sellerId: z.string().uuid() }).parse(req.params); const b = z.object({ isGift: z.boolean(), message: z.string().trim().max(300).default('') }).strict().parse(req.body); const cartId = await cartFor(req, reply, false); if (!cartId) throw new HttpError(404, 'not_found');
    if (!(await q('SELECT 1 FROM cart_items ci JOIN variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id WHERE ci.cart_id=$1 AND p.seller_id=$2', [cartId, sellerId])).rowCount) throw new HttpError(404, 'not_found');
    await q(`INSERT INTO cart_gifts(cart_id,seller_id,is_gift,message) VALUES ($1,$2,$3,$4) ON CONFLICT (cart_id,seller_id) DO UPDATE SET is_gift=EXCLUDED.is_gift, message=EXCLUDED.message`, [cartId, sellerId, b.isGift, b.message || null]); return view(await priceCart(pool, cartId));
  });

  /** Shipping cost and delivery window for ONE product to a postal code (the product page card: "Ships in 2-3 days, arrives Nov 12-16, $9.00 to T2N"). */
  app.get('/api/products/:id/shipping', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const { postal } = z.object({ postal: z.string().trim().max(10) }).parse(req.query);
    if (!POSTAL.test(postal) && !/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]$/i.test(postal)) throw new HttpError(422, 'invalid_postal_code');
    const p = (await pool.query(`SELECT p.seller_id, p.shipping_profile_id, v.price_cents, v.weight_g, s.processing_days_min, s.processing_days_max FROM products p JOIN shops s ON s.id=p.shop_id JOIN sellers se ON se.id=p.seller_id
      JOIN LATERAL (SELECT price_cents, weight_g FROM variants WHERE product_id=p.id AND status='active' ORDER BY price_cents LIMIT 1) v ON true WHERE p.id=$1 AND ${VISIBLE}`, [id])).rows[0]; if (!p) throw new HttpError(404, 'not_found');
    const prof = ((await pool.query('SELECT * FROM shipping_profiles WHERE seller_id=$1 AND (id=$2 OR is_default) ORDER BY (id=$2) DESC NULLS LAST LIMIT 1', [p.seller_id, p.shipping_profile_id])).rows[0] ?? DEFAULT_PROFILE) as Profile;
    const w = deliveryWindow(clockNow(), { min: p.processing_days_min, max: p.processing_days_max }, prof); const cents = shippingCents(prof, [{ quantity: 1, weightG: p.weight_g ?? 0 }], p.price_cents);
    return { postal: postal.toUpperCase().slice(0, 3), shippingCents: cents, free: cents === 0, shipsInDays: { min: p.processing_days_min, max: p.processing_days_max }, arrives: { min: w.min, max: w.max }, freeOverCents: prof.free_over_cents };
  });
}
