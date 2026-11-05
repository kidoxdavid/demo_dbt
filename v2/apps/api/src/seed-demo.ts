// DEV ONLY. Seeds demo people so every area can be tried: one staff user per role and one buyer. Refuses to run in production.
// Shops, products and orders for the screen tests arrive with the catalogue phase (same fixed values as the design brief).
import { config } from './config.js';
import { pool, tx } from './db.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from './security.js';
if (config.production) { console.error('Refusing to seed demo data in production'); process.exit(1); }
await runMigrations();
const PASSWORD = 'demo-password-2026';
const people: [string, string, string | null][] = [['admin@eazystores.test', 'Admin Demo', 'admin'], ['support@eazystores.test', 'Support Demo', 'support'], ['finance@eazystores.test', 'Finance Demo', 'finance'],
  ['catalogue@eazystores.test', 'Catalogue Demo', 'catalogue'], ['marketing@eazystores.test', 'Marketing Demo', 'marketing'], ['buyer@eazystores.test', 'Maya Buyer', null]];
const hash = await hashPassword(PASSWORD);
await tx(async c => { for (const [email, name, role] of people) {
  const u = (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id', [email, hash, name])).rows[0];
  if (role) await c.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, role]); } });
console.log(`Demo people ready. Password for all: ${PASSWORD}\n${people.map(p => `  ${p[0]}  ${p[2] ?? 'buyer'}`).join('\n')}`); await pool.end();
