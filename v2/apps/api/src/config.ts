const env = process.env.NODE_ENV ?? 'development';
export const config = {
  env, production: env === 'production',
  port: Number(process.env.PORT ?? 3100),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://es2:es2_pw@localhost:5432/eazystores2',
  // Origins allowed to make state-changing requests besides same-host. Set explicitly in production.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? (env === 'production' ? '' : 'http://localhost:5180,http://127.0.0.1:5180')).split(',').map(s => s.trim()).filter(Boolean),
  secureCookies: env === 'production', sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 24 * 14),
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
};
