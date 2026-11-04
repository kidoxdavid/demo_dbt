export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Runtime uses the restricted role (RLS applies). Migrations use the owner role.
  appDatabaseUrl: process.env.DATABASE_URL ?? 'postgres://eazy_app:app_pw@localhost:5432/eazystores',
  ownerDatabaseUrl: process.env.MIGRATION_DATABASE_URL ?? 'postgres://eazy_owner:owner_pw@localhost:5432/eazystores',
  sessionTtlHours: 24 * 14,
  secureCookies: process.env.NODE_ENV === 'production',
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
};
// 'simulated' is the only provider implemented; it is NOT real payment processing.
export const paymentProvider = process.env.PAYMENT_PROVIDER ?? (process.env.NODE_ENV === 'production' ? 'none' : 'simulated');
export const reservationMinutes = Number(process.env.RESERVATION_MINUTES ?? 15);
// Origins allowed to make state-changing requests besides same-host. Set explicitly in production (the public web origin).
export const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173,http://127.0.0.1:5173'))
  .split(',').map(s => s.trim()).filter(Boolean);
export const uploadDir = process.env.UPLOAD_DIR ?? './uploads';
export const maxImageBytes = 5 * 1024 * 1024;
export const uploadRateLimitMax = Number(process.env.UPLOAD_RATE_LIMIT_MAX ?? 20);
// Public origin used to build share links and QR codes.
export const publicUrl = (process.env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, '');
// ---- Email ----
export const mailFrom = process.env.MAIL_FROM ?? 'EazyStores <no-reply@eazystores.local>';
export const smtpUrl = () => process.env.SMTP_URL;   // e.g. smtp://user:pass@smtp.example.com:587 ; when unset, mail is recorded but NOT sent ("simulated")
// Read at call time so tests can toggle them.
export const requireVerifiedEmail = () => (process.env.REQUIRE_EMAIL_VERIFICATION ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';
export const requireStaffMfa = () => (process.env.REQUIRE_STAFF_MFA ?? 'true') !== 'false';
export const mfaKeyHex = () => process.env.MFA_ENC_KEY ?? (process.env.NODE_ENV === 'production' ? '' : '0'.repeat(63) + '1');   // dev-only fallback; production must set a real 32-byte hex key
