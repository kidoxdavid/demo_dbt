import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Content-Security-Policy for the website's pages: only our own scripts, styles (React sets inline style attributes), fonts, images and media. */
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

/** Where the built website lives: WEB_DIST, else ../web/dist next to the API when it exists. */
export function webDist(): string | null {
  const dir = process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  return existsSync(resolve(dir, 'index.html')) ? dir : null;
}

/**
 * Serve the built website from the same service as the API: one address, one cookie jar, no cross-site settings.
 * Hashed files under /assets are cached for a year; the page itself and the service worker are never cached so a release shows at once.
 * Unknown paths without a file extension get the page (the app's own router decides); unknown files and every /api path stay a plain 404.
 */
export async function registerWeb(app: FastifyInstance, dir: string) {
  await app.register(fastifyStatic, {
    root: dir, wildcard: true, index: ['index.html'], cacheControl: false,
    setHeaders: (res, path) => {
      if (/[\\/]assets[\\/]/.test(path)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      else if (/[\\/]fonts[\\/]/.test(path)) res.setHeader('cache-control', 'public, max-age=604800');
      else res.setHeader('cache-control', 'no-cache');
    },
  });
  app.addHook('onSend', async (req, reply) => { if (!req.url.startsWith('/api/') && req.url !== '/healthz' && req.url !== '/readyz' && req.url !== '/health') reply.header('content-security-policy', PAGE_CSP); });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && !path.startsWith('/api/') && !/\.[A-Za-z0-9]{1,8}$/.test(path)) return reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
}
