export const TONES = {
  warm: ['#f1e7da', '#e3d2bd'], sand: ['#f3ecdf', '#e6dac4'], blush: ['#f4e4df', '#e8cdc4'], sage: ['#e5ece1', '#cfdcc8'],
  sky: ['#e3ecf2', '#cbdbe7'], butter: ['#f7efd2', '#ecdcaa'], stone: ['#ebe7e1', '#d9d3c9'], ink: ['#2a2521', '#1a1613'],
} as const;
export type Tone = keyof typeof TONES;
export type ArtKind = 'pottery' | 'perfume' | 'print' | 'toy' | 'print3d' | 'hair' | 'candle' | 'jewel' | 'planter' | 'scarf';
