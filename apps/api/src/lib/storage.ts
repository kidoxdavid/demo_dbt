import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Object storage port. Local disk for development; an S3-compatible adapter implements the same interface in production. */
export interface Storage {
  put(ext: string, data: Buffer): Promise<string>;   // returns an unguessable key
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}
const KEY = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
export const isValidKey = (k: string) => KEY.test(k);

export function localStorageAdapter(dir: string): Storage {
  return {
    async put(ext, data) { await mkdir(dir, { recursive: true }); const key = `${randomBytes(16).toString('hex')}.${ext}`; await writeFile(join(dir, key), data); return key; },
    async get(key) { if (!isValidKey(key)) return null; try { return await readFile(join(dir, key)); } catch { return null; } },
    async remove(key) { if (isValidKey(key)) await rm(join(dir, key), { force: true }); },
  };
}

/** Identify an image by its bytes, never by the client-declared type or file name. */
export function sniffImage(b: Buffer): { type: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' } | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}
