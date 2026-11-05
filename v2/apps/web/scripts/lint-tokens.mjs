// Fails when a raw hex colour appears outside src/styles/tokens.css and src/art/. Components must use var(--token).
import { readdirSync, readFileSync, statSync } from 'node:fs'; import { join, relative } from 'node:path';
const root = new URL('../src', import.meta.url).pathname; const bad = [];
const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(f)) check(p); } };
function check(p) { const rel = relative(root, p); if (rel === 'styles/tokens.css' || rel.startsWith('art/') || rel.startsWith('design/fixtures')) return;
  readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/#[0-9a-fA-F]{3,8}\b/.test(l) && !/^\s*(\/\/|\/\*)/.test(l)) bad.push(`${rel}:${i + 1}: ${l.trim().slice(0, 90)}`); }); }
walk(root); if (bad.length) { console.error('Raw hex colours outside tokens:\n' + bad.join('\n')); process.exit(1); } console.log('lint:tokens ok');
