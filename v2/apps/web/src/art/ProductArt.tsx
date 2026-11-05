import { useId } from 'react';
import { SHAPES } from './shapes';
import { TONES, type ArtKind, type Tone } from './tones';

/** Illustrated placeholder for a product without a photo (and for the demo seed). Same shapes and tones as the approved mockups. */
export function ProductArt({ kind, tone = 'warm', className }: { kind: ArtKind; tone?: Tone; className?: string }) {
  const id = 'g' + useId().replace(/[^a-zA-Z0-9]/g, ''); const [a, b] = TONES[tone];
  const html = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="200" height="200" fill="url(#${id})"/>${SHAPES[kind]}`;
  return <svg className={className} viewBox="0 0 200 200" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />;
}
