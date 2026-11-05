// Usage: npm run make-staff -- you@example.com admin 'a-long-password'
// Creates the user if missing (needs the password) and grants a staff role. Refuses weak passwords.
import { audit, pool, tx } from './db.js';
import { hashPassword, passwordProblem } from './security.js';
import { STAFF_ROLES } from './permissions.js';
const [email, role, password] = process.argv.slice(2);
if (!email || !STAFF_ROLES.includes(role as any)) { console.error(`Usage: make-staff <email> <${STAFF_ROLES.join('|')}> [password]`); process.exit(1); }
await tx(async c => {
  let u = (await c.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()])).rows[0];
  if (!u) {
    if (!password) throw new Error('That user does not exist: pass a password to create it');
    const p = passwordProblem(password, email); if (p) throw new Error(`Weak password (${p})`);
    u = (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) RETURNING id', [email.toLowerCase(), await hashPassword(password), email.split('@')[0]])).rows[0];
  }
  await c.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, role]);
  await audit(c, { actor: u.id, area: 'admin', action: 'role.grant', entityType: 'user', entityId: u.id, next: { role }, reason: 'make-staff command' });
});
console.log(`${email} is now ${role}`); await pool.end();
