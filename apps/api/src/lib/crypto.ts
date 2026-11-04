import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mfaKeyHex } from '../config.js';

function key(): Buffer {
  const hex = mfaKeyHex();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('MFA_ENC_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  return Buffer.from(hex, 'hex');
}
/** AES-256-GCM. Output: base64(iv | tag | ciphertext). Used to protect TOTP secrets at rest. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function decrypt(enc: string): string {
  const b = Buffer.from(enc, 'base64'); const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
