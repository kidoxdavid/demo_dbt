import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withTx, audit } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { hashPassword, verifyPassword, sha256, newToken } from '../lib/security.js';
import { issueToken, consumeToken } from '../lib/tokens.js';
import { enqueue, url } from '../lib/mail.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { base32Decode, newSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { config, requireStaffMfa } from '../config.js';

export const MFA_ISSUER = 'EazyStores';
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const rate = { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: '1 minute' } } };

/** Password reset, email verification and TOTP two-factor sign-in. */
export function registerAccount(app: FastifyInstance, deps: { authenticate: (r: FastifyRequest) => Promise<void>; createSession: (reply: FastifyReply, userId: string, mfa: boolean) => Promise<void> }) {
  const { authenticate } = deps;

  // ---------- Password reset ----------
  // Always answers the same way, so the form cannot be used to discover which emails have accounts.
  app.post('/api/auth/forgot', rate, async (req) => {
    const { email } = z.object({ email: z.string().email().max(254) }).parse(req.body);
    await withTx({ platform: true }, async c => {
      const u = (await c.query('SELECT id FROM users WHERE email=$1 AND disabled_at IS NULL', [email])).rows[0];
      if (!u) return;
      const raw = await issueToken(c, u.id, 'reset', 60);
      await enqueue(c, { to: email, template: 'reset_password', data: { url: url(`/reset?token=${raw}`) } });
      await audit(c, { actor: u.id, action: 'auth.reset_requested', entityType: 'user', entityId: u.id, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/api/auth/reset', rate, async (req) => {
    const b = z.object({ token: z.string().min(20).max(100), password: z.string().min(10).max(200) }).strict().parse(req.body);
    const pwHash = await hashPassword(b.password);
    const ok = await withTx({ platform: true }, async c => {
      const userId = await consumeToken(c, b.token, 'reset'); if (!userId) return false;
      await c.query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL WHERE id=$1', [userId, pwHash]);
      await c.query('DELETE FROM sessions WHERE user_id=$1', [userId]);          // everyone is signed out, including whoever knew the old password
      await c.query('DELETE FROM mfa_challenges WHERE user_id=$1', [userId]);
      const email = (await c.query('SELECT email FROM users WHERE id=$1', [userId])).rows[0].email;
      await enqueue(c, { to: email, template: 'password_changed', data: {} });
      await audit(c, { actor: userId, action: 'auth.password_reset', entityType: 'user', entityId: userId, ip: req.ip });
      return true;
    });
    if (!ok) throw new HttpError(400, 'invalid_or_expired_link');
    return { ok: true };       // two-factor is NOT bypassed: signing in still asks for a code
  });

  // ---------- Email verification ----------
  app.post('/api/auth/verify', rate, async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).strict().parse(req.body);
    const ok = await withTx({ platform: true }, async c => {
      const userId = await consumeToken(c, token, 'verify'); if (!userId) return false;
      await c.query('UPDATE users SET email_verified_at=coalesce(email_verified_at, now()) WHERE id=$1', [userId]);
      await audit(c, { actor: userId, action: 'auth.email_verified', entityType: 'user', entityId: userId, ip: req.ip });
      return true;
    });
    if (!ok) throw new HttpError(400, 'invalid_or_expired_link');
    return { ok: true };
  });

  app.post('/api/auth/resend-verification', rate, async (req) => {
    await authenticate(req);
    await withTx({ platform: true }, async c => {
      const u = (await c.query('SELECT email, email_verified_at FROM users WHERE id=$1', [req.user!.id])).rows[0];
      if (u.email_verified_at) return;
      const raw = await issueToken(c, req.user!.id, 'verify', 60 * 24);
      await enqueue(c, { to: u.email, template: 'verify_email', data: { url: url(`/verify?token=${raw}`) } });
    });
    return { ok: true };
  });

  // ---------- Two-factor (TOTP) ----------
  app.get('/api/auth/mfa/status', async (req) => {
    await authenticate(req);
    const u = (await withTx({ platform: true }, async c => (await c.query('SELECT mfa_enabled_at, jsonb_array_length(mfa_recovery) AS left FROM users WHERE id=$1', [req.user!.id])).rows[0]));
    return { enabled: !!u.mfa_enabled_at, recoveryCodesLeft: u.left as number };
  });

  app.post('/api/auth/mfa/setup', rate, async (req) => {
    await authenticate(req);
    const secret = newSecret();
    await withTx({ platform: true }, async c => {
      const u = (await c.query('SELECT mfa_enabled_at FROM users WHERE id=$1', [req.user!.id])).rows[0];
      if (u.mfa_enabled_at) throw new HttpError(409, 'mfa_already_enabled');
      await c.query('UPDATE users SET mfa_secret_enc=$2 WHERE id=$1', [req.user!.id, encrypt(secret)]);
    });
    const uri = otpauthUri(MFA_ISSUER, req.user!.email, secret);
    return { secret, otpauthUri: uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }) };
  });

  app.post('/api/auth/mfa/enable', rate, async (req) => {
    await authenticate(req);
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(req.body);
    const result = await withTx({ platform: true }, async c => {
      const u = (await c.query('SELECT mfa_secret_enc, mfa_enabled_at FROM users WHERE id=$1 FOR UPDATE', [req.user!.id])).rows[0];
      if (u.mfa_enabled_at) return { err: 'mfa_already_enabled' as const };
      if (!u.mfa_secret_enc) return { err: 'mfa_setup_first' as const };
      const step = verifyTotp(base32Decode(decrypt(u.mfa_secret_enc)), code, 0);
      if (step === null) return { err: 'invalid_code' as const };
      const codes = Array.from({ length: 10 }, () => { const r = randomBytes(8).toString('hex').slice(0, 10); return `${r.slice(0, 5)}-${r.slice(5)}`; });
      await c.query('UPDATE users SET mfa_enabled_at=now(), mfa_last_step=$2, mfa_recovery=$3 WHERE id=$1', [req.user!.id, step, JSON.stringify(codes.map(x => sha256(norm(x))))]);
      await c.query('UPDATE sessions SET mfa_at=now() WHERE id=$1', [req.user!.sid]);        // the session that enrolled counts as verified
      await audit(c, { actor: req.user!.id, action: 'mfa.enabled', entityType: 'user', entityId: req.user!.id, ip: req.ip });
      return { codes };
    });
    if (result.err) throw new HttpError(result.err === 'invalid_code' ? 401 : 409, result.err);
    return { recoveryCodes: result.codes!, note: 'Store these somewhere safe. Each works once, and they are not shown again.' };
  });

  app.post('/api/auth/mfa/disable', rate, async (req) => {
    await authenticate(req);
    const b = z.object({ password: z.string().min(1), code: z.string().regex(/^\d{6}$/) }).strict().parse(req.body);
    const result = await withTx({ platform: true }, async c => {
      const u = (await c.query('SELECT password_hash, mfa_secret_enc, mfa_enabled_at, mfa_last_step FROM users WHERE id=$1 FOR UPDATE', [req.user!.id])).rows[0];
      if (!u.mfa_enabled_at) return { err: 'mfa_not_enabled' as const };
      const staff = (await c.query('SELECT 1 FROM platform_staff WHERE user_id=$1', [req.user!.id])).rowCount;
      if (staff && requireStaffMfa()) return { err: 'mfa_required_for_staff' as const };
      if (!(await verifyPassword(b.password, u.password_hash))) return { err: 'invalid_credentials' as const };
      const step = verifyTotp(base32Decode(decrypt(u.mfa_secret_enc)), b.code, Number(u.mfa_last_step));
      if (step === null) return { err: 'invalid_code' as const };
      await c.query(`UPDATE users SET mfa_secret_enc=NULL, mfa_enabled_at=NULL, mfa_recovery='[]', mfa_last_step=0 WHERE id=$1`, [req.user!.id]);
      await audit(c, { actor: req.user!.id, action: 'mfa.disabled', entityType: 'user', entityId: req.user!.id, ip: req.ip });
      return { ok: true as const };
    });
    if (result.err) throw new HttpError(result.err === 'mfa_not_enabled' ? 409 : result.err === 'mfa_required_for_staff' ? 403 : 401, result.err);
    return { ok: true };
  });

  /** Second step of sign-in. Wrong guesses are counted and COMMITTED (never rolled back with an error), so the limit cannot be bypassed. */
  app.post('/api/auth/mfa/verify', rate, async (req, reply) => {
    const b = z.object({ challenge: z.string().min(20).max(100), code: z.string().max(12).optional(), recovery: z.string().max(40).optional() }).strict().parse(req.body);
    if (!b.code && !b.recovery) throw new HttpError(400, 'code_required');
    const r = await withTx({ platform: true }, async c => {
      const ch = (await c.query('SELECT * FROM mfa_challenges WHERE token_hash=$1 AND expires_at > now() FOR UPDATE', [sha256(b.challenge)])).rows[0];
      if (!ch) return { err: 'invalid_challenge' as const };
      if (ch.attempts >= 5) { await c.query('DELETE FROM mfa_challenges WHERE id=$1', [ch.id]); return { err: 'too_many_attempts' as const }; }
      const u = (await c.query('SELECT id, mfa_secret_enc, mfa_last_step, mfa_recovery FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE', [ch.user_id])).rows[0];
      let ok = false;
      if (u?.mfa_secret_enc && b.code) {
        const step = verifyTotp(base32Decode(decrypt(u.mfa_secret_enc)), b.code.trim(), Number(u.mfa_last_step));
        if (step !== null) { await c.query('UPDATE users SET mfa_last_step=$2 WHERE id=$1', [u.id, step]); ok = true; }
      } else if (u && b.recovery) {
        const h = sha256(norm(b.recovery)); const list: string[] = u.mfa_recovery;
        if (list.includes(h)) { await c.query('UPDATE users SET mfa_recovery=$2 WHERE id=$1', [u.id, JSON.stringify(list.filter(x => x !== h))]); ok = true;
          await audit(c, { actor: u.id, action: 'mfa.recovery_code_used', entityType: 'user', entityId: u.id, ip: req.ip }); }
      }
      if (!ok) { await c.query('UPDATE mfa_challenges SET attempts=attempts+1 WHERE id=$1', [ch.id]); return { err: 'invalid_code' as const }; }
      await c.query('DELETE FROM mfa_challenges WHERE id=$1', [ch.id]);
      return { userId: u.id as string };
    });
    if (r.err) throw new HttpError(r.err === 'too_many_attempts' ? 429 : 401, r.err);
    await deps.createSession(reply, r.userId!, true);
    return { ok: true };
  });
}

/** Used by the login route when the account has two-factor enabled. */
export async function createMfaChallenge(userId: string): Promise<string> {
  const token = newToken();
  await withTx({ platform: true }, c => c.query(`INSERT INTO mfa_challenges(user_id,token_hash,expires_at) VALUES ($1,$2, now() + interval '5 minutes')`, [userId, sha256(token)]));
  return token;
}
