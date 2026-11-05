import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

const N = 16384;
const kdf = (pw: string, salt: Buffer, n: number) => new Promise<Buffer>((res, rej) => scrypt(pw, salt, 64, { N: n, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
export async function hashPassword(pw: string) { const salt = randomBytes(16); return `scrypt$${N}$${salt.toString('base64')}$${(await kdf(pw, salt, N)).toString('base64')}`; }
export async function verifyPassword(pw: string, stored: string) {
  const [alg, n, salt, hash] = stored.split('$'); if (alg !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64'); const got = await kdf(pw, Buffer.from(salt, 'base64'), Number(n)); return want.length === got.length && timingSafeEqual(want, got);
}
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const COMMON = new Set(['password1234', 'password12345', '1234567890', 'qwertyuiop', 'letmein1234', 'iloveyou123', 'welcome1234', 'admin12345', 'eazystores1']);
/** Plain-language password rules: long enough, not obviously common, not the email. */
export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < 10) return 'too_short'; if (pw.length > 200) return 'too_long';
  if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return 'too_common';
  const local = email.split('@')[0].toLowerCase(); if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'contains_email';
  return null;
}
