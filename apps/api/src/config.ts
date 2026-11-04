export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Runtime uses the restricted role (RLS applies). Migrations use the owner role.
  appDatabaseUrl: process.env.DATABASE_URL ?? 'postgres://eazy_app:app_pw@localhost:5432/eazystores',
  ownerDatabaseUrl: process.env.MIGRATION_DATABASE_URL ?? 'postgres://eazy_owner:owner_pw@localhost:5432/eazystores',
  sessionTtlHours: 24 * 14,
  secureCookies: process.env.NODE_ENV === 'production',
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
};
