import sharp from 'sharp';
import { HttpError } from './errors.js';

export interface ProcessedImage { main: Buffer; thumb?: Buffer; width: number; height: number }

/**
 * Every uploaded image is decoded and re-encoded, never stored as sent. That:
 *  - strips EXIF/GPS and other metadata (a seller's phone photo can carry their home address),
 *  - applies camera rotation before the metadata is dropped,
 *  - caps size (no 6000px originals on a phone), and creates a thumbnail for grids,
 *  - rejects files that only LOOK like images (a valid header with garbage after it fails to decode),
 *  - refuses decompression bombs (a tiny file that expands to a huge bitmap).
 */
export async function processImage(input: Buffer, opts: { thumb: boolean }): Promise<ProcessedImage> {
  try {
    const base = () => sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate();     // rotate() bakes in EXIF orientation
    const main = await base().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    const thumb = opts.thumb ? await base().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 76 }).toBuffer() : undefined;
    return { main: main.data, thumb, width: main.info.width, height: main.info.height };
  } catch {
    throw new HttpError(415, 'unsupported_image_type');
  }
}
