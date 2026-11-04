// Create or promote a platform staff user. Usage: npm run make-staff -- <email> <role> [password]
// Roles: super_admin | support | finance | moderator. Runs with the owner DB role. If the user does not exist a password is required.
import pg from 'pg';
import { config } from './config.js';
import { hashPassword } from './lib/security.js';

const [email, role, password] = process.argv.slice(2);
if (!email || !role) { console.error('Usage: npm run make-staff -- <email> <role> [password]'); process.exit(1); }
const c = new pg.Client({ connectionString: config.ownerDatabaseUrl });
await c.connect();
try {
  if (!(await c.query('SELECT 1 FROM platform_roles WHERE key=$1', [role])).rowCount) throw new Error(`unknown role "${role}"`);
  let u = (await c.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
  if (!u) {
    if (!password || password.length < 10) throw new Error('user does not exist: pass a password of at least 10 characters');
    u = (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) RETURNING id', [email, await hashPassword(password), email.split('@')[0]])).rows[0];
  }
  await c.query('INSERT INTO platform_staff(user_id,role_key) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET role_key=EXCLUDED.role_key', [u.id, role]);
  console.log(`${email} is now ${role}`);
} finally { await c.end(); }
