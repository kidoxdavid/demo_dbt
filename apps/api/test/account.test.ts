import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SMTPServer } from 'smtp-server';
import { buildApp } from '../src/app.js';
import { pool } from '../src/lib/db.js';
import { base32Decode, base32Encode, hotp, totp, totpStep, verifyTotp } from '../src/lib/totp.js';
import { encrypt, decrypt } from '../src/lib/crypto.js';
import { processOutbox, resetTransportForTests, enqueue } from '../src/lib/mail.js';
import { withTx } from '../src/lib/db.js';
import { owner, oq, ck, kit } from './helpers.js';

let app: FastifyInstance; const k = kit(() => app);
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); await owner.end(); });
afterEach(() => { delete process.env.SMTP_URL; process.env.REQUIRE_STAFF_MFA = 'false'; delete process.env.REQUIRE_EMAIL_VERIFICATION; resetTransportForTests(); });

const PW = 'correct-horse-battery';
const outbox = async (to: string, template?: string) => (await oq(`SELECT * FROM email_outbox WHERE to_email=$1 ${template ? 'AND template=$2' : ''} ORDER BY created_at`, template ? [to, template] : [to])).rows;
const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)![0];
const tokenIn = (text: string) => new URL(linkIn(text)).searchParams.get('token')!;
const post = (url: string, payload: object, cookie?: string) => app.inject({ method: 'POST', url, payload, ...(cookie ? ck(cookie) : {}) });
const signup = async (n: string) => {
  const r = await post('/api/auth/signup', { email: `${n}@a.test`, password: PW, fullName: n, businessName: `${n} Biz`, storeSlug: `${n}-acct` });
  return { cookie: r.cookies.find(c => c.name === 'eazy_sid')!.value, email: `${n}@a.test` };
};

describe('TOTP (RFC 6238) and crypto primitives', () => {
  const rfc = Buffer.from('12345678901234567890');
  it('matches the official RFC 6238 SHA-1 test vectors', () => {
    const v: [number, string][] = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
    for (const [t, code] of v) expect(hotp(rfc, Math.floor(t / 30), 8)).toBe(code);
    expect(totp(rfc, 59_000)).toBe('287082');
  });
  it('base32 round-trips and rejects junk', () => {
    expect(base32Decode(base32Encode(rfc)).equals(rfc)).toBe(true);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(() => base32Decode('not*base32')).toThrow();
  });
  it('accepts one step of drift, refuses older codes and refuses replays', () => {
    const now = 1_700_000_000_000; const step = totpStep(now);
    expect(verifyTotp(rfc, hotp(rfc, step), 0, now)).toBe(step);
    expect(verifyTotp(rfc, hotp(rfc, step - 1), 0, now)).toBe(step - 1);
    expect(verifyTotp(rfc, hotp(rfc, step + 1), 0, now)).toBe(step + 1);
    expect(verifyTotp(rfc, hotp(rfc, step - 2), 0, now)).toBeNull();
    expect(verifyTotp(rfc, hotp(rfc, step), step, now)).toBeNull();          // already used
    expect(verifyTotp(rfc, '12345', 0, now)).toBeNull(); expect(verifyTotp(rfc, 'abcdef', 0, now)).toBeNull();
  });
  it('AES-GCM round-trips and detects tampering', () => {
    const enc = encrypt('JBSWY3DPEHPK3PXP'); expect(enc).not.toContain('JBSWY3DP'); expect(decrypt(enc)).toBe('JBSWY3DPEHPK3PXP');
    const b = Buffer.from(enc, 'base64'); b[b.length - 1] ^= 1;
    expect(() => decrypt(b.toString('base64'))).toThrow();
  });
});

describe('email outbox and transport', () => {
  it('escapes HTML, blocks header injection, and records simulated mail when no SMTP is configured', async () => {
    await withTx({ platform: true }, c => enqueue(c, { to: 'victim@x.test', template: 'order_new', data: { number: 7, customerName: '<script>alert(1)</script>\r\nBcc: evil@x.test', currency: 'CAD', total: 1000, items: [{ name: '<b>Bold</b>', qty: 1, unit: 1000 }], url: 'https://x.test' } }));
    const m = (await outbox('victim@x.test'))[0];
    expect(m.html_body).not.toContain('<script>'); expect(m.html_body).toContain('&lt;script&gt;'); expect(m.html_body).not.toContain('<b>Bold</b>');
    expect(m.subject).not.toMatch(/[\r\n]/);
    const r = await processOutbox(1000); expect(r.simulated).toBeGreaterThanOrEqual(1);
    expect((await outbox('victim@x.test'))[0].status).toBe('simulated');
  });
  it('really delivers over SMTP to a server, and marks the message sent', async () => {
    const received: string[] = [];
    const server = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, _s, cb) { let d = ''; stream.on('data', x => { d += x; }); stream.on('end', () => { received.push(d); cb(); }); } });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    process.env.SMTP_URL = `smtp://127.0.0.1:${(server.server.address() as any).port}`; resetTransportForTests();
    await withTx({ platform: true }, c => enqueue(c, { to: 'real@x.test', template: 'verify_email', data: { url: 'https://example.test/verify?token=abc' } }));
    const r = await processOutbox(1000); expect(r.sent).toBeGreaterThanOrEqual(1);
    await new Promise<void>(r2 => server.close(() => r2()));
    const qp = (x: string) => x.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));   // undo quoted-printable
    expect(qp(received.join('\n'))).toContain('https://example.test/verify?token=abc'); expect(received.join('\n')).toMatch(/Subject: Confirm your email/);
    expect((await outbox('real@x.test'))[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });
  it('retries with backoff and finally gives up instead of retrying forever', async () => {
    process.env.SMTP_URL = 'smtp://127.0.0.1:1'; resetTransportForTests();      // nothing listens on port 1
    await withTx({ platform: true }, c => enqueue(c, { to: 'dead@x.test', template: 'password_changed', data: {} }));
    for (let i = 1; i <= 5; i++) {
      await oq(`UPDATE email_outbox SET next_attempt_at = now() - interval '1 second' WHERE to_email='dead@x.test'`);
      await processOutbox(1000); const m = (await outbox('dead@x.test'))[0];
      expect(m.attempts).toBe(i); expect(m.last_error).toBeTruthy();
      expect(m.status).toBe(i < 5 ? 'pending' : 'failed');
    }
    const before = (await outbox('dead@x.test'))[0].attempts; await processOutbox(1000); expect((await outbox('dead@x.test'))[0].attempts).toBe(before);
  });
});

describe('emails sent by the business flows', () => {
  it('sends confirmation to the customer and a new-order notice to the seller, including tax lines, with no internal data', async () => {
    const s = await k.seller('em1'); await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(s.cookie), payload: { region: 'ON', taxFederal: true } });
    const p = await k.product(s.cookie, { name: 'Candle', variants: [{ priceCents: 2000, costCents: 777, stock: 9 }] });
    const o = await k.paidOrder(s, p.variantId, 1, { email: 'buyer-em1@x.test', name: 'Bea Buyer' });
    const conf = (await outbox('buyer-em1@x.test', 'order_confirmation'))[0];
    expect(conf.subject).toBe(`Order #${(await oq('SELECT number FROM orders WHERE id=$1', [o.orderId])).rows[0].number} confirmed`);
    expect(conf.text_body).toContain('Candle'); expect(conf.text_body).toContain('HST'); expect(conf.text_body).toContain(`/order/${o.token}`);
    expect(conf.text_body + conf.html_body).not.toMatch(/\$7\.77|\bcost\b/i);                      // the seller's cost must never leak to a customer
    const seller = (await outbox('em1@k.test', 'order_new'))[0]; expect(seller.text_body).toContain('Bea Buyer'); expect(seller.text_body).toContain('/dashboard/orders');
  });
  it('emails the customer when the order is ready/shipped/completed, and when refunded, without exposing the internal refund reason', async () => {
    const s = await k.seller('em2'); const p = await k.product(s.cookie); const o = await k.paidOrder(s, p.variantId, 1, { email: 'buyer-em2@x.test' });
    const go = (status: string) => app.inject({ method: 'POST', url: `/api/seller/orders/${o.orderId}/status`, ...ck(s.cookie), payload: { status } });
    await go('processing'); await go('shipped'); await go('completed');
    const st = await outbox('buyer-em2@x.test', 'order_status'); expect(st.map(m => m.subject.replace(/#\d+/, '#N'))).toEqual(['Order #N is on its way', 'Order #N is complete']);
    await app.inject({ method: 'POST', url: `/api/seller/orders/${o.orderId}/refunds`, ...ck(s.cookie), payload: { amountCents: 500, reason: 'Internal note: customer was rude' } });
    const rf = (await outbox('buyer-em2@x.test', 'refund_issued'))[0]; expect(rf.text_body).toContain('$5.00'); expect(rf.text_body + rf.html_body).not.toContain('rude');
  });
  it('warns the seller once when stock crosses the low-stock threshold', async () => {
    const s = await k.seller('em3'); const p = await k.product(s.cookie, { name: 'Soap', variants: [{ priceCents: 500, stock: 4, lowStockThreshold: 3 }] });
    await k.paidOrder(s, p.variantId, 2);                       // 4 -> 2: crosses 3
    await k.paidOrder(s, p.variantId, 1);                       // 2 -> 1: already low, no second warning
    const low = await outbox('em3@k.test', 'low_stock'); expect(low).toHaveLength(1); expect(low[0].text_body).toContain('Soap');
  });
  it('rolls back with the event: a failed checkout queues nothing', async () => {
    const s = await k.seller('em4'); const p = await k.product(s.cookie, { variants: [{ priceCents: 500, stock: 1 }] });
    const before = (await oq('SELECT count(*)::int n FROM email_outbox')).rows[0].n;
    await k.checkout(s.slug, p.variantId, 5);                   // out of stock
    expect((await oq('SELECT count(*)::int n FROM email_outbox')).rows[0].n).toBe(before);
  });
});

describe('email verification', () => {
  it('sends a link at signup, the link works once, and an expired or forged link is refused', async () => {
    const u = await signup('ev1'); const m = (await outbox(u.email, 'verify_email'))[0]; const token = tokenIn(m.text_body);
    expect((await app.inject({ method: 'GET', url: '/api/me', ...ck(u.cookie) })).json().emailVerified).toBe(false);
    expect((await post('/api/auth/verify', { token })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', ...ck(u.cookie) })).json().emailVerified).toBe(true);
    expect((await post('/api/auth/verify', { token })).statusCode).toBe(400);                  // single use
    expect((await post('/api/auth/verify', { token: 'x'.repeat(40) })).statusCode).toBe(400);
    const u2 = await signup('ev2'); const t2 = tokenIn((await outbox(u2.email, 'verify_email'))[0].text_body);
    await oq(`UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE user_id=(SELECT id FROM users WHERE email=$1)`, [u2.email]);
    expect((await post('/api/auth/verify', { token: t2 })).statusCode).toBe(400);
  });
  it('blocks publishing until the email is verified (when required), and a resend invalidates the older link', async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
    const u = await signup('ev3'); await app.inject({ method: 'PATCH', url: '/api/seller/business', ...ck(u.cookie), payload: { category: 'x', description: 'y' } });
    const blocked = await post('/api/seller/store/publish', {}, u.cookie); expect(blocked.statusCode).toBe(403); expect(blocked.json().error).toBe('email_not_verified');
    const first = tokenIn((await outbox(u.email, 'verify_email'))[0].text_body);
    expect((await post('/api/auth/resend-verification', {}, u.cookie)).statusCode).toBe(200);
    const emails = await outbox(u.email, 'verify_email'); expect(emails).toHaveLength(2);
    expect((await post('/api/auth/verify', { token: first })).statusCode).toBe(400);            // superseded
    expect((await post('/api/auth/verify', { token: tokenIn(emails[1].text_body) })).statusCode).toBe(200);
    expect((await post('/api/seller/store/publish', {}, u.cookie)).statusCode).toBe(200);
    expect((await post('/api/auth/resend-verification', {}, u.cookie)).statusCode).toBe(200);   // already verified: quietly nothing
    expect(await outbox(u.email, 'verify_email')).toHaveLength(2);
  });
});

describe('password reset', () => {
  it('does not reveal whether an email has an account', async () => {
    const before = (await oq('SELECT count(*)::int n FROM email_outbox')).rows[0].n;
    const r = await post('/api/auth/forgot', { email: 'nobody-here@a.test' });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ ok: true });
    expect((await oq('SELECT count(*)::int n FROM email_outbox')).rows[0].n).toBe(before);
    expect((await post('/api/auth/forgot', { email: 'not-an-email' })).statusCode).toBe(400);
  });
  it('resets once, signs out every session, locks nothing out, and tells the owner', async () => {
    const u = await signup('pr1');
    expect((await post('/api/auth/forgot', { email: u.email })).statusCode).toBe(200);
    const mail = (await outbox(u.email, 'reset_password'))[0]; const token = tokenIn(mail.text_body);
    expect(mail.text_body).toMatch(/expires in 60 minutes/);
    expect((await post('/api/auth/reset', { token, password: 'short' })).statusCode).toBe(400);
    expect((await post('/api/auth/reset', { token, password: 'a-brand-new-password' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', ...ck(u.cookie) })).statusCode).toBe(401);           // old session is dead
    expect((await post('/api/auth/login', { email: u.email, password: PW })).statusCode).toBe(401);
    expect((await post('/api/auth/login', { email: u.email, password: 'a-brand-new-password' })).statusCode).toBe(200);
    expect((await post('/api/auth/reset', { token, password: 'another-password-1' })).statusCode).toBe(400);        // single use
    expect(await outbox(u.email, 'password_changed')).toHaveLength(1);
  });
  it('newest link wins, expired links fail, and two simultaneous uses of one link have one winner', async () => {
    const u = await signup('pr2');
    await post('/api/auth/forgot', { email: u.email }); await post('/api/auth/forgot', { email: u.email });
    const [old, fresh] = (await outbox(u.email, 'reset_password')).map(m => tokenIn(m.text_body));
    expect((await post('/api/auth/reset', { token: old, password: 'a-brand-new-password' })).statusCode).toBe(400);
    const rs = await Promise.all([post('/api/auth/reset', { token: fresh, password: 'first-new-password-1' }), post('/api/auth/reset', { token: fresh, password: 'second-new-password-2' })]);
    expect(rs.map(r => r.statusCode).sort()).toEqual([200, 400]);
    await post('/api/auth/forgot', { email: u.email }); const t3 = tokenIn((await outbox(u.email, 'reset_password')).at(-1)!.text_body);
    await oq(`UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE user_id=(SELECT id FROM users WHERE email=$1)`, [u.email]);
    expect((await post('/api/auth/reset', { token: t3, password: 'late-new-password-1' })).statusCode).toBe(400);
  });
});

describe('two-factor sign-in', () => {
  async function enroll(n: string) {
    const u = await signup(n);
    const setup = (await post('/api/auth/mfa/setup', {}, u.cookie)).json();
    const secret = base32Decode(setup.secret);
    const en = await post('/api/auth/mfa/enable', { code: totp(secret) }, u.cookie);
    return { ...u, secret, setup, enable: en };
  }
  const login = (email: string) => post('/api/auth/login', { email, password: PW });
  const hasSession = (r: any) => r.cookies.some((c: any) => c.name === 'eazy_sid');

  it('enrols with a real code, stores the secret encrypted, and returns single-use recovery codes once', async () => {
    const u = await signup('mf1');
    const setup = (await post('/api/auth/mfa/setup', {}, u.cookie)).json();
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\/EazyStores:/); expect(setup.qrSvg).toContain('<svg');
    expect((await post('/api/auth/mfa/enable', { code: '000000' }, u.cookie)).statusCode).toBe(401);
    const en = await post('/api/auth/mfa/enable', { code: totp(base32Decode(setup.secret)) }, u.cookie);
    expect(en.statusCode).toBe(200); expect(en.json().recoveryCodes).toHaveLength(10);
    const row = (await oq('SELECT mfa_secret_enc, mfa_recovery FROM users WHERE email=$1', [u.email])).rows[0];
    expect(row.mfa_secret_enc).not.toContain(setup.secret); expect(JSON.stringify(row.mfa_recovery)).not.toContain(en.json().recoveryCodes[0]);
    expect((await post('/api/auth/mfa/setup', {}, u.cookie)).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/auth/mfa/status', ...ck(u.cookie) })).json()).toEqual({ enabled: true, recoveryCodesLeft: 10 });
  });
  it('login then requires a code: no session until it is verified; replayed codes are refused', async () => {
    const u = await enroll('mf2');
    const l1 = await login(u.email); expect(l1.json()).toMatchObject({ mfaRequired: true }); expect(hasSession(l1)).toBe(false);
    const ch = l1.json().challenge;
    expect((await post('/api/auth/mfa/verify', { challenge: ch, code: '000000' })).statusCode).toBe(401);
    // enrolment consumed the current step, so the next valid code is the following step (still inside the drift window)
    const next = hotp(u.secret, totpStep() + 1);
    const ok = await post('/api/auth/mfa/verify', { challenge: ch, code: next }); expect(ok.statusCode).toBe(200); expect(hasSession(ok)).toBe(true);
    const cookie = ok.cookies.find(c => c.name === 'eazy_sid')!.value;
    expect((await app.inject({ method: 'GET', url: '/api/me', ...ck(cookie) })).statusCode).toBe(200);
    expect((await post('/api/auth/mfa/verify', { challenge: ch, code: next })).statusCode).toBe(401);          // challenge is spent
    const l2 = await login(u.email); expect((await post('/api/auth/mfa/verify', { challenge: l2.json().challenge, code: next })).statusCode).toBe(401); // same code, new challenge: replay
  });
  it('five wrong guesses kill the challenge, even if the sixth is right; wrong challenges are refused', async () => {
    const u = await enroll('mf3'); const ch = (await login(u.email)).json().challenge;
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/mfa/verify', { challenge: ch, code: '111111' })).statusCode).toBe(401);
    const r = await post('/api/auth/mfa/verify', { challenge: ch, code: hotp(u.secret, totpStep() + 1) });
    expect(r.statusCode).toBe(429); expect(hasSession(r)).toBe(false);
    expect((await post('/api/auth/mfa/verify', { challenge: 'z'.repeat(40), code: '123456' })).statusCode).toBe(401);
    expect((await post('/api/auth/mfa/verify', { challenge: ch })).statusCode).toBe(400);
  });
  it('recovery codes work exactly once', async () => {
    const u = await enroll('mf4'); const code = u.enable.json().recoveryCodes[3] as string;
    const a = await post('/api/auth/mfa/verify', { challenge: (await login(u.email)).json().challenge, recovery: code.toUpperCase() });
    expect(a.statusCode).toBe(200); expect(hasSession(a)).toBe(true);
    expect((await post('/api/auth/mfa/verify', { challenge: (await login(u.email)).json().challenge, recovery: code })).statusCode).toBe(401);
    const cookie = a.cookies.find(c => c.name === 'eazy_sid')!.value;
    expect((await app.inject({ method: 'GET', url: '/api/auth/mfa/status', ...ck(cookie) })).json().recoveryCodesLeft).toBe(9);
  });
  it('a password reset does not bypass two-factor', async () => {
    const u = await enroll('mf5'); await post('/api/auth/forgot', { email: u.email });
    await post('/api/auth/reset', { token: tokenIn((await outbox(u.email, 'reset_password'))[0].text_body), password: 'a-brand-new-password' });
    const r = await post('/api/auth/login', { email: u.email, password: 'a-brand-new-password' });
    expect(r.json().mfaRequired).toBe(true); expect(hasSession(r)).toBe(false);
  });
  it('disabling needs the password and a current code', async () => {
    const u = await enroll('mf6');                                        // the enrolling session is already verified
    const code = hotp(u.secret, totpStep() + 1);                          // the next step: newer than the one enrolment used
    expect((await post('/api/auth/mfa/disable', { password: 'wrong-password-1', code }, u.cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/mfa/disable', { password: PW, code: '000000' }, u.cookie)).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth/mfa/status', ...ck(u.cookie) })).json().enabled).toBe(true);
    expect((await post('/api/auth/mfa/disable', { password: PW, code }, u.cookie)).statusCode).toBe(200);
    expect(hasSession(await login(u.email))).toBe(true);                  // plain password sign-in works again
    expect((await oq('SELECT mfa_secret_enc, mfa_enabled_at FROM users WHERE email=$1', [u.email])).rows[0]).toEqual({ mfa_secret_enc: null, mfa_enabled_at: null });
  });

  describe('platform staff must use two-factor', () => {
    it('blocks admin actions until enrolled and verified; other sessions of an enrolled account stay locked out', async () => {
      process.env.REQUIRE_STAFF_MFA = 'true';
      const u = await signup('mf7'); await oq('INSERT INTO platform_staff(user_id,role_key) VALUES ((SELECT id FROM users WHERE email=$1),$2)', [u.email, 'super_admin']);
      const other = (await login(u.email)).cookies.find(c => c.name === 'eazy_sid')!.value;             // a second session, created before enrolment
      const overview = (cookie: string) => app.inject({ method: 'GET', url: '/api/admin/overview', ...ck(cookie) });
      const r1 = await overview(u.cookie); expect(r1.statusCode).toBe(403); expect(r1.json().error).toBe('mfa_setup_required');
      const me0 = (await app.inject({ method: 'GET', url: '/api/admin/me', ...ck(u.cookie) })).json();
      expect(me0).toMatchObject({ role: 'super_admin', mfaEnabled: false, mfaSatisfied: false, permissions: [] });
      const secret = base32Decode((await post('/api/auth/mfa/setup', {}, u.cookie)).json().secret);
      expect((await post('/api/auth/mfa/enable', { code: totp(secret) }, u.cookie)).statusCode).toBe(200);
      expect((await overview(u.cookie)).statusCode).toBe(200);                                         // the enrolling session counts as verified
      const r2 = await overview(other); expect(r2.statusCode).toBe(403); expect(r2.json().error).toBe('mfa_required');   // pre-existing session does not
      const fresh = await login(u.email); expect(hasSession(fresh)).toBe(false);
      const v = await post('/api/auth/mfa/verify', { challenge: fresh.json().challenge, code: hotp(secret, totpStep() + 1) });
      expect((await overview(v.cookies.find(c => c.name === 'eazy_sid')!.value)).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/admin/me', ...ck(u.cookie) })).json()).toMatchObject({ mfaSatisfied: true });
    });
    it('staff cannot switch two-factor off', async () => {
      process.env.REQUIRE_STAFF_MFA = 'true';
      const u = await signup('mf8'); await oq('INSERT INTO platform_staff(user_id,role_key) VALUES ((SELECT id FROM users WHERE email=$1),$2)', [u.email, 'support']);
      const secret = base32Decode((await post('/api/auth/mfa/setup', {}, u.cookie)).json().secret); await post('/api/auth/mfa/enable', { code: totp(secret) }, u.cookie);
      const r = await post('/api/auth/mfa/disable', { password: PW, code: hotp(secret, totpStep() + 1) }, u.cookie);
      expect(r.statusCode).toBe(403); expect(r.json().error).toBe('mfa_required_for_staff');
    });
  });
});
