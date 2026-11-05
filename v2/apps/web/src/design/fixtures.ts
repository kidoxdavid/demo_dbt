import type { CardData } from '../components/ui';
// Demo data that reproduces the approved screens (Part 2 section 5 of the brief). The real app reads the same values from the demo seed in the API.
export const HOME_CARDS: CardData[] = [
  { id: 'dusk', title: 'Dusk over the hills, A4 print', seller: 'Harper & Pine', price: '$38', chip: 'Limited', art: { kind: 'print', tone: 'warm' } },
  { id: 'cedar', title: 'Cedar & fig soy candle', seller: 'Ember Lane', price: '$26', chip: 'Handmade', art: { kind: 'candle', tone: 'sand' } },
  { id: 'planter', title: 'Geometric desk planter', seller: 'Layer Lab', price: '$24', art: { kind: 'print3d', tone: 'sky' } },
  { id: 'wave', title: 'Body wave bundle, 18 in', seller: 'Crown Hair Co.', price: '$118', was: '$140', art: { kind: 'hair', tone: 'stone' } },
];
export const CATEGORY_PILLS = ['All', 'Art', 'Pottery', 'Perfume', 'Hair', 'Toys', '3D printed', 'Candles'];
