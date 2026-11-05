/** What a production server needs before it may start. Hard problems stop it with a clear list; warnings say what will not work. Pure on purpose, so it can be tested. */
export function checkProductionConfig(env: Record<string, string | undefined>) {
  const errors: string[] = []; const warnings: string[] = [];
  if (!env.DATABASE_URL) errors.push('DATABASE_URL is not set'); else if (/es2_pw|localhost.*eazystores2$/.test(env.DATABASE_URL)) errors.push('DATABASE_URL still points at the development database');
  if (!env.ALLOWED_ORIGINS) errors.push('ALLOWED_ORIGINS is not set (the website addresses allowed to make changes, comma separated)'); else if (env.ALLOWED_ORIGINS.split(',').some(o => !/^https:\/\//.test(o.trim()))) errors.push('ALLOWED_ORIGINS must all be https addresses');
  if (!env.PUBLIC_URL || !/^https:\/\//.test(env.PUBLIC_URL)) errors.push('PUBLIC_URL must be the https address of the website (used in emails and links)');
  for (const k of ['AD_SECRET', 'NOTIFY_SECRET', 'MOCK_WEBHOOK_SECRET']) { if (k === 'MOCK_WEBHOOK_SECRET') continue; const v = env[k]; if (!v) errors.push(`${k} is not set`); else if (v.length < 32) errors.push(`${k} must be at least 32 characters`); else if (/dev-only|change-?me|secret$/i.test(v)) errors.push(`${k} looks like a placeholder`); }
  if (!env.SMTP_URL) errors.push('SMTP_URL is not set, so no email can be sent'); if (!env.EMAIL_FROM) errors.push('EMAIL_FROM is not set');
  if (env.TRUST_PROXY !== 'true') warnings.push('TRUST_PROXY is not "true": behind a load balancer every visitor will look like one address, which weakens rate limits and ad click checks');
  if (!env.PAYMENT_PROVIDER || env.PAYMENT_PROVIDER === 'none') warnings.push('No payment provider is configured: checkout will answer "payments not configured"');
  if (env.PAYMENT_PROVIDER === 'mock') errors.push('PAYMENT_PROVIDER=mock must never be used in production');
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) warnings.push('VAPID keys are not set: web push is off (the inbox and email still work)');
  if (!env.UPLOAD_DIR) warnings.push('UPLOAD_DIR is not set: uploads use ./uploads, which must be on storage that survives restarts');
  return { errors, warnings };
}
