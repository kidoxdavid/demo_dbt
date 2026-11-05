import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { pool, type Client } from '../db.js';
import { HttpError } from '../errors.js';

/** What a file REALLY is, decided by its first bytes (never by the name or the declared type). */
export function sniff(b: Buffer): { kind: 'image' | 'video'; type: string } | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', type: 'jpeg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', type: 'png' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { kind: 'image', type: 'webp' };
  if (b.toString('latin1', 4, 8) === 'ftyp') return { kind: 'video', type: 'mp4' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', type: 'webm' };
  return null;
}

export const IMAGE_WIDTHS = [320, 640, 1280] as const;
/** Decode, fix orientation, strip all metadata (including GPS), cap size, and make three WebP sizes plus a tiny blur-up placeholder. */
export async function processImage(input: Buffer) {
  let base: sharp.Sharp; let meta: sharp.Metadata;
  try { base = sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' }); meta = await base.metadata(); } catch { throw new HttpError(415, 'unreadable_image'); }
  if (!meta.width || !meta.height) throw new HttpError(415, 'unreadable_image');
  const out: { label: string; data: Buffer; width: number; height: number }[] = [];
  try {
    for (const w of IMAGE_WIDTHS) {
      const r = await sharp(input, { limitInputPixels: 40_000_000 }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });   // output carries no EXIF
      out.push({ label: `w${w}`, data: r.data, width: r.info.width, height: r.info.height });
    }
    const tiny = await sharp(input, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
    return { files: out, width: out[out.length - 1].width, height: out[out.length - 1].height, blur: `data:image/webp;base64,${tiny.toString('base64')}` };
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(415, 'unreadable_image'); }
}

const run = (cmd: string, args: string[], timeoutMs = 120_000) => new Promise<{ code: number; out: string }>((res, rej) => {
  const p = spawn(cmd, args); let out = ''; const t = setTimeout(() => { p.kill('SIGKILL'); rej(new HttpError(422, 'video_too_slow')); }, timeoutMs);
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('error', e => { clearTimeout(t); rej(e); }); p.on('close', code => { clearTimeout(t); res({ code: code ?? 1, out }); });
});

/** Convert to a web-friendly MP4 (H.264, yuv420p, at most 1280 wide, faststart) and make a poster frame. Needs ffmpeg on the server. */
export async function processVideo(input: Buffer, ext: string) {
  const dir = join(tmpdir(), `es-vid-${randomUUID()}`); await mkdir(dir, { recursive: true });
  try {
    const src = join(dir, `in.${ext}`), dst = join(dir, 'out.mp4'), pst = join(dir, 'poster.png'); await writeFile(src, input);
    const probe = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src]); if (probe.code !== 0) throw new HttpError(415, 'unreadable_video');
    let info: any; try { info = JSON.parse(probe.out); } catch { throw new HttpError(415, 'unreadable_video'); }
    const dur = Number(info.format?.duration ?? 0); if (!(dur > 0) || !info.streams?.some((s: any) => s.codec_type === 'video')) throw new HttpError(415, 'unreadable_video');
    if (dur > config.maxVideoSeconds) throw new HttpError(422, `video_too_long:${config.maxVideoSeconds}`);
    const enc = await run('ffmpeg', ['-y', '-i', src, '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', dst]);
    if (enc.code !== 0) throw new HttpError(415, 'unreadable_video');
    await run('ffmpeg', ['-y', '-ss', String(Math.min(0.5, dur / 2)), '-i', dst, '-frames:v', '1', pst]);
    const mp4 = await readFile(dst); const poster = await sharp(await readFile(pst)).resize({ width: 640, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    const v = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', dst])).out.trim().split(',').map(Number);
    return { mp4, poster, duration: dur, width: v[0] || null, height: v[1] || null };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const EXT: Record<string, string> = { 'image/webp': 'webp', 'video/mp4': 'mp4' };
async function toDisk(id: string, label: string, mime: string, data: Buffer) { const d = join(config.uploadDir, id); await mkdir(d, { recursive: true }); await writeFile(join(d, `${label}.${EXT[mime] ?? 'bin'}`), data); }

export interface StoredMedia { id: string; kind: 'image' | 'video'; width: number | null; height: number | null; duration: number | null; blur: string | null }
/** Validate, process and store an upload (database copy + disk copy). One transaction: nothing is left half-saved. */
export async function storeUpload(c: Client, o: { sellerId: string; userId: string; buf: Buffer; name?: string }): Promise<StoredMedia> {
  const s = sniff(o.buf); if (!s) throw new HttpError(415, 'unsupported_media_type');
  if (s.kind === 'image' && o.buf.length > config.maxImageBytes) throw new HttpError(413, 'image_too_large');
  if (s.kind === 'video' && o.buf.length > config.maxVideoBytes) throw new HttpError(413, 'video_too_large');
  const id = randomUUID(); const files: { label: string; mime: string; data: Buffer }[] = []; let width: number | null = null, height: number | null = null, duration: number | null = null, blur: string | null = null;
  if (s.kind === 'image') { const r = await processImage(o.buf); r.files.forEach(f => files.push({ label: f.label, mime: 'image/webp', data: f.data })); width = r.width; height = r.height; blur = r.blur; }
  else { const r = await processVideo(o.buf, s.type); files.push({ label: 'video', mime: 'video/mp4', data: r.mp4 }, { label: 'poster', mime: 'image/webp', data: r.poster }); width = r.width; height = r.height; duration = r.duration; }
  await c.query('INSERT INTO media(id,seller_id,kind,original_name,bytes,width,height,duration_s,blur,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, o.sellerId, s.kind, o.name?.slice(0, 120) ?? null, o.buf.length, width, height, duration, blur, o.userId]);
  for (const f of files) { await c.query('INSERT INTO media_files(media_id,label,mime,bytes,data) VALUES ($1,$2,$3,$4,$5)', [id, f.label, f.mime, f.data.length, f.data]); await toDisk(id, f.label, f.mime, f.data); }
  return { id, kind: s.kind, width, height, duration, blur };
}

/** Disk first (fast), then the database; a missing disk copy is written back so a fresh server or volume heals itself. */
export async function readMedia(id: string, label: string): Promise<{ data: Buffer; mime: string } | null> {
  const row = (await pool.query('SELECT mime, data FROM media_files WHERE media_id=$1 AND label=$2', [id, label])).rows[0]; if (!row) return null;
  try { return { data: await readFile(join(config.uploadDir, id, `${label}.${EXT[row.mime] ?? 'bin'}`)), mime: row.mime }; }
  catch { await toDisk(id, label, row.mime, row.data).catch(() => {}); return { data: row.data as Buffer, mime: row.mime }; }
}
export const mediaUrl = (id: string | null | undefined, label = 'w640') => (id ? `/api/media/${id}/${label}` : null);
