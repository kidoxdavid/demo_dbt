// Recovery for a staff member (or seller) who lost both their authenticator and their recovery codes.
// Usage: npm run reset-mfa -- <email>      Requires database owner access, so it is an ops action, not something support can do in the app.
// Clears two-factor and signs the user out everywhere. Staff must enrol again at their next sign-in. Audited.
import pg from 'pg';
import { config } from './config.js';

const [email] = process.argv.slice(2);
if (!email) { console.error('Usage: npm run reset-mfa -- <email>'); process.exit(1); }
const c = new pg.Client({ connectionString: config.ownerDatabaseUrl });
await c.connect();
try {
  await c.query('BEGIN');
  await c.query(`SELECT set_config('app.platform_admin','on',true)`);
  const u = (await c.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
  if (!u) throw new Error(`no user with email ${email}`);
  await c.query(`UPDATE users SET mfa_secret_enc=NULL, mfa_enabled_at=NULL, mfa_recovery='[]', mfa_last_step=0 WHERE id=$1`, [u.id]);
  await c.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
  await c.query('DELETE FROM mfa_challenges WHERE user_id=$1', [u.id]);
  await c.query(`INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,reason) VALUES (NULL,'mfa.reset_by_operator','user',$1,'Reset from the command line by an operator with database access')`, [u.id]);
  await c.query('COMMIT');
  console.log(`Two-factor cleared for ${email}. They must set it up again at next sign-in.`);
} catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { await c.end(); }
