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
