// Seeds six very different demo stores through the REAL API (signup, settings, products, image upload, publish).
// Product images are generated placeholder illustrations, NOT real photography. Dev only. Usage: node e2e/seed-demo.cjs
const { chromium } = require('playwright');
const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

const P = { // palettes: [background1, background2, product, accent]
  noir: ['#e9e4dc', '#cfc6b8', '#17120f', '#c9a24a'], rose: ['#f6e3e6', '#e8c3cb', '#d98ca0', '#ffffff'], amber: ['#f3e6cf', '#e2c593', '#b9792b', '#3b2412'],
  sage: ['#e3ebe4', '#c4d4c8', '#4f7a63', '#f4f1ea'], ink: ['#e4e6f3', '#c3c8e6', '#2c3a8c', '#ffffff'], sand: ['#f2ebe1', '#e0d3bf', '#d6c2a3', '#5a4632'],
  coral: ['#fde7df', '#f6c4b4', '#e2674a', '#fff'], mint: ['#e0f3ee', '#b8e1d6', '#2f9e86', '#fff'], night: ['#d9dbe3', '#b0b4c4', '#1b1d29', '#8fa2ff'],
  gold: ['#f6efe0', '#e8d6ab', '#c8993e', '#fff'], plum: ['#eee4f1', '#d6c2dd', '#6b3a7d', '#fff'], steel: ['#e6e8ea', '#c9cdd1', '#6f7a84', '#fff'],
  denim: ['#e3e9f2', '#c0cde0', '#3d5a85', '#fff'], olive: ['#e9ebdc', '#cdd2b0', '#6b7a3a', '#fff'], clay: ['#f4e4da', '#e3c2ad', '#b4654a', '#fff'],
};
const wrap = (c, inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800"><defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient>
  <linearGradient id="sh" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/></linearGradient>
  <pattern id="layers" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="3" fill="#000" opacity=".1"/></pattern></defs>
  <rect width="800" height="800" fill="url(#bg)"/><ellipse cx="400" cy="655" rx="200" ry="22" fill="#000" opacity=".16"/>${inner}</svg>`;
const sheen = d => `<path d="${d}" fill="url(#sh)"/>`;
const ART = {
  bottle: c => `<rect x="355" y="150" width="90" height="85" rx="10" fill="${c[3]}"/><rect x="372" y="232" width="56" height="60" fill="${c[2]}" opacity=".85"/><rect x="255" y="285" width="290" height="360" rx="34" fill="${c[2]}"/><rect x="300" y="400" width="200" height="130" rx="6" fill="#fff" opacity=".88"/><rect x="326" y="428" width="148" height="10" rx="5" fill="${c[2]}"/><rect x="346" y="452" width="108" height="7" rx="3" fill="${c[2]}" opacity=".5"/><rect x="346" y="472" width="108" height="7" rx="3" fill="${c[2]}" opacity=".5"/>${sheen('M255 319a34 34 0 0134-34h256v360H289a34 34 0 01-34-34z')}`,
  jar: c => `<rect x="235" y="320" width="330" height="95" rx="18" fill="${c[3]}"/><rect x="250" y="405" width="300" height="240" rx="40" fill="${c[2]}"/><rect x="310" y="470" width="180" height="100" rx="8" fill="#fff" opacity=".9"/><rect x="335" y="498" width="130" height="9" rx="4" fill="${c[2]}"/><rect x="355" y="522" width="90" height="7" rx="3" fill="${c[2]}" opacity=".45"/>${sheen('M250 445a40 40 0 0140-40h260v240H290a40 40 0 01-40-40z')}`,
  tube: c => `<rect x="352" y="170" width="96" height="48" rx="8" fill="${c[2]}" opacity=".7"/><path d="M335 215h130l22 345H313z" fill="${c[2]}"/><rect x="330" y="560" width="140" height="85" rx="14" fill="${c[3]}"/><rect x="350" y="330" width="100" height="110" rx="8" fill="#fff" opacity=".9"/><rect x="365" y="355" width="70" height="9" rx="4" fill="${c[2]}"/><rect x="372" y="378" width="56" height="7" rx="3" fill="${c[2]}" opacity=".45"/>`,
  dropper: c => `<ellipse cx="400" cy="195" rx="46" ry="58" fill="${c[3]}"/><rect x="350" y="240" width="100" height="60" rx="8" fill="${c[3]}" opacity=".9"/><rect x="290" y="295" width="220" height="350" rx="30" fill="${c[2]}" opacity=".92"/><rect x="330" y="410" width="140" height="120" rx="6" fill="#fff" opacity=".9"/><rect x="352" y="436" width="96" height="9" rx="4" fill="${c[2]}"/><rect x="364" y="460" width="72" height="7" rx="3" fill="${c[2]}" opacity=".45"/>${sheen('M290 325a30 30 0 0130-30h190v350H320a30 30 0 01-30-30z')}`,
  mug: c => `<path d="M520 400c85-10 110 90 20 125-25 10-40 8-40 8" fill="none" stroke="${c[2]}" stroke-width="30" stroke-linecap="round"/><path d="M250 320h270v250a75 75 0 01-75 75H325a75 75 0 01-75-75z" fill="${c[2]}"/><ellipse cx="385" cy="320" rx="135" ry="26" fill="${c[3]}" opacity=".5"/><ellipse cx="385" cy="320" rx="120" ry="20" fill="#3b2412" opacity=".75"/>${sheen('M250 320h270v250a75 75 0 01-75 75H325a75 75 0 01-75-75z')}`,
  candle: c => `<path d="M400 190c-26 40-22 74 0 88 22-14 26-48 0-88z" fill="#ffb347"/><path d="M400 215c-10 22-8 40 0 48 8-8 10-26 0-48z" fill="#fff3c4"/><rect x="396" y="270" width="8" height="45" fill="#2a2018"/><rect x="265" y="310" width="270" height="335" rx="30" fill="#fff" opacity=".5"/><rect x="275" y="330" width="250" height="305" rx="24" fill="${c[2]}"/><rect x="320" y="440" width="160" height="100" rx="6" fill="#fff" opacity=".9"/><rect x="342" y="468" width="116" height="9" rx="4" fill="${c[2]}"/><rect x="360" y="492" width="80" height="7" rx="3" fill="${c[2]}" opacity=".45"/>${sheen('M265 340a30 30 0 0130-30h240v335H295a30 30 0 01-30-30z')}`,
  ring: c => `<ellipse cx="400" cy="470" rx="150" ry="150" fill="none" stroke="${c[2]}" stroke-width="42"/><ellipse cx="400" cy="470" rx="150" ry="150" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="10" stroke-dasharray="120 400" transform="rotate(-130 400 470)"/><path d="M345 285l55-70 55 70-55 85z" fill="${c[3]}" opacity=".95"/><path d="M345 285h110l-55 85z" fill="#fff" opacity=".4"/><path d="M400 215l-25 70h50z" fill="#fff" opacity=".6"/>`,
  necklace: c => `<path d="M215 190C230 520 570 520 585 190" fill="none" stroke="${c[2]}" stroke-width="10" stroke-linecap="round"/><path d="M400 462v70" stroke="${c[2]}" stroke-width="8"/><circle cx="400" cy="570" r="62" fill="${c[2]}"/><circle cx="400" cy="570" r="40" fill="${c[3]}" opacity=".9"/><circle cx="385" cy="555" r="14" fill="#fff" opacity=".6"/>`,
  studs: c => `<circle cx="300" cy="400" r="95" fill="${c[2]}"/><circle cx="300" cy="400" r="62" fill="${c[3]}" opacity=".9"/><circle cx="500" cy="400" r="95" fill="${c[2]}"/><circle cx="500" cy="400" r="62" fill="${c[3]}" opacity=".9"/><circle cx="278" cy="378" r="16" fill="#fff" opacity=".6"/><circle cx="478" cy="378" r="16" fill="#fff" opacity=".6"/>`,
  tee: c => `<path d="M290 190l-150 80 55 100 65-35v320h280V335l65 35 55-100-150-80c-15 45-60 70-110 70s-95-25-110-70z" fill="${c[2]}"/><path d="M335 190c15 50 55 70 65 70s50-20 65-70" fill="none" stroke="#000" stroke-opacity=".2" stroke-width="10"/>${sheen('M290 190l-150 80 55 100 65-35v320h140V190z')}`,
  shirt: c => `<path d="M290 190l-150 80 55 100 65-35v320h280V335l65 35 55-100-150-80-45 40-45-40z" fill="${c[2]}"/><path d="M400 230v425" stroke="#000" stroke-opacity=".18" stroke-width="6"/>${[300, 380, 460, 540].map(y => `<circle cx="400" cy="${y}" r="9" fill="${c[3]}"/>`).join('')}<path d="M355 190l45 55 45-55" fill="${c[3]}" opacity=".25"/>`,
  scarf: c => `<path d="M170 250c120-70 200 70 320 0s140-30 150 20l-30 270c-110 60-200-60-320 0s-120 10-130-30z" fill="${c[2]}"/><path d="M170 300c120-70 200 70 320 0s140-30 150 20" fill="none" stroke="${c[3]}" stroke-width="12" opacity=".7"/><path d="M170 400c120-70 200 70 320 0s140-30 150 20" fill="none" stroke="${c[3]}" stroke-width="12" opacity=".7"/>`,
  cap: c => `<path d="M215 470c0-150 90-240 185-240s185 90 185 240z" fill="${c[2]}"/><path d="M215 470c-40 0-90 15-110 50 80 20 330 20 480 0z" fill="${c[2]}" opacity=".8"/><circle cx="400" cy="232" r="14" fill="${c[3]}"/>${sheen('M215 470c0-150 90-240 185-240v240z')}`,
  tote: c => `<path d="M290 270c0-120 220-120 220 0" fill="none" stroke="${c[2]}" stroke-width="26"/><rect x="215" y="270" width="370" height="380" rx="14" fill="${c[2]}"/><rect x="300" y="380" width="200" height="130" rx="8" fill="${c[3]}" opacity=".9"/><rect x="330" y="416" width="140" height="12" rx="6" fill="${c[2]}"/><rect x="350" y="446" width="100" height="9" rx="4" fill="${c[2]}" opacity=".5"/>`,
  case: c => `<rect x="270" y="130" width="260" height="520" rx="46" fill="${c[2]}"/><rect x="292" y="152" width="120" height="120" rx="26" fill="#000" opacity=".25"/><circle cx="330" cy="190" r="22" fill="#111"/><circle cx="376" cy="190" r="22" fill="#111"/><circle cx="352" cy="236" r="22" fill="#111"/><circle cx="330" cy="190" r="9" fill="${c[3]}" opacity=".6"/><circle cx="400" cy="460" r="38" fill="${c[3]}" opacity=".35"/>${sheen('M270 176a46 46 0 0146-46h214v520H316a46 46 0 01-46-46z')}`,
  charger: c => `<rect x="325" y="250" width="150" height="190" rx="22" fill="${c[2]}"/><rect x="355" y="190" width="14" height="66" fill="#9aa0a6"/><rect x="431" y="190" width="14" height="66" fill="#9aa0a6"/><path d="M400 440c0 140-170 70-170 190" fill="none" stroke="${c[2]}" stroke-width="16" stroke-linecap="round"/><rect x="215" y="620" width="40" height="38" rx="8" fill="${c[3]}" opacity=".9"/>${sheen('M325 272a22 22 0 0122-22h53v190h-75z')}`,
  earbuds: c => `<rect x="215" y="360" width="370" height="270" rx="70" fill="${c[2]}"/><path d="M215 480h370" stroke="#000" stroke-opacity=".25" stroke-width="5"/><circle cx="400" cy="440" r="11" fill="${c[3]}"/><g transform="translate(300 215) rotate(-14)"><ellipse cx="0" cy="40" rx="48" ry="62" fill="${c[2]}"/><rect x="-14" y="80" width="28" height="90" rx="14" fill="${c[2]}"/></g><g transform="translate(500 215) rotate(14)"><ellipse cx="0" cy="40" rx="48" ry="62" fill="${c[2]}"/><rect x="-14" y="80" width="28" height="90" rx="14" fill="${c[2]}"/></g>${sheen('M215 430a70 70 0 0170-70h115v270H285a70 70 0 01-70-70z')}`,
  stand: c => `<path d="M215 620L330 250h60l-45 150 240 90v130z" fill="${c[2]}"/><path d="M215 620L330 250h60l-45 150 240 90v130z" fill="url(#layers)"/><rect x="290" y="470" width="300" height="42" rx="10" fill="${c[3]}" opacity=".0"/><path d="M345 400l240 90v40L345 440z" fill="#000" opacity=".12"/>${sheen('M215 620L330 250h60l-45 150 240 90v130z')}`,
  organizer: c => `<rect x="190" y="330" width="420" height="300" rx="22" fill="${c[2]}"/><rect x="190" y="330" width="420" height="300" rx="22" fill="url(#layers)"/><rect x="215" y="355" width="170" height="250" rx="12" fill="#000" opacity=".28"/><rect x="405" y="355" width="180" height="110" rx="12" fill="#000" opacity=".28"/><rect x="405" y="485" width="180" height="120" rx="12" fill="#000" opacity=".28"/><rect x="262" y="200" width="22" height="170" rx="11" fill="${c[3]}"/><rect x="320" y="230" width="22" height="140" rx="11" fill="#e85d5d"/>`,
  planter: c => `<path d="M400 330c-110-60-170-10-150 70 60 10 130-10 150-70zM400 330c110-60 170-10 150 70-60 10-130-10-150-70zM400 330c-20-80 0-150 0-160 0 10 20 80 0 160z" fill="#4f9a62"/><path d="M270 400h260l-38 245H308z" fill="${c[2]}"/><path d="M270 400h260l-38 245H308z" fill="url(#layers)"/><rect x="255" y="385" width="290" height="36" rx="10" fill="${c[2]}"/>${sheen('M270 400h130v245H308z')}`,
  nameplate: c => `<rect x="190" y="330" width="420" height="190" rx="22" fill="${c[2]}"/><rect x="190" y="330" width="420" height="190" rx="22" fill="url(#layers)"/><text x="400" y="460" font-family="Inter,Helvetica,Arial" font-weight="800" font-size="104" fill="${c[3]}" text-anchor="middle" letter-spacing="6">MAYA</text><rect x="190" y="505" width="420" height="22" rx="10" fill="#000" opacity=".2"/>`,
  giftbox: c => `<rect x="215" y="330" width="370" height="310" rx="16" fill="${c[2]}"/><rect x="195" y="285" width="410" height="80" rx="14" fill="${c[3]}"/><rect x="368" y="285" width="64" height="355" fill="#fff" opacity=".85"/><path d="M400 285c-80-95-170-35-110 5 25 18 70 12 110-5zM400 285c80-95 170-35 110 5-25 18-70 12-110-5z" fill="#fff" opacity=".9"/>`,
  brushes: c => [0, 1, 2].map(i => `<g transform="translate(${290 + i * 110} 160) rotate(${(i - 1) * 6})"><rect x="-16" y="170" width="32" height="330" rx="16" fill="${c[2]}"/><rect x="-18" y="140" width="36" height="60" fill="#c9ccd1"/><path d="M-26 150c0-70 20-100 26-100s26 30 26 100z" fill="${c[3]}"/></g>`).join(''),
};
const art = (kind, pal) => wrap(P[pal], ART[kind](P[pal]));

const STORES = [
  { slug: 'maison-oud', name: 'Maison Oud', category: 'Fragrance', city: 'Calgary', region: 'AB', tagline: 'Small-batch fragrances, composed in Calgary.', theme: { accent: '#5b1a2b', hero: 'dark', layout: 'spacious' }, fee: 600,
    products: [
      { n: 'Oud Noir', b: 'Maison Oud', d: 'A smoky, resinous oud softened with amber and black pepper.', a: { family: 'Woody · Oriental', concentration: 'Eau de Parfum', gender: 'Unisex' }, art: ['bottle', 'noir', 'sand'], v: [['50 ml', 8500, 3200, 12], ['100 ml', 14500, 5200, 6]] },
      { n: 'Rose Water', b: 'Maison Oud', d: 'Fresh Damask rose with a touch of white musk.', a: { family: 'Floral', concentration: 'Eau de Toilette', gender: 'Women' }, art: ['bottle', 'rose', 'sand'], v: [['50 ml', 6500, 2400, 9], ['100 ml', 10500, 3900, 4]] },
      { n: 'Amber Musk', b: 'Maison Oud', d: 'Warm amber and vanilla over a soft, skin-like musk.', a: { family: 'Amber · Gourmand', concentration: 'Eau de Parfum', gender: 'Unisex' }, art: ['bottle', 'amber', 'noir'], v: [['50 ml', 7800, 2900, 8]] },
      { n: 'Santal Blanc', b: 'Maison Oud', d: 'Creamy sandalwood, cedar and a whisper of iris.', a: { family: 'Woody', concentration: 'Eau de Parfum', gender: 'Unisex' }, art: ['bottle', 'sage', 'sand'], v: [['50 ml', 9200, 3500, 0]] },
      { n: 'Vetiver Sport', b: 'Maison Oud', d: 'Crisp vetiver, grapefruit and sea salt.', a: { family: 'Fresh', concentration: 'Eau de Toilette', gender: 'Men' }, art: ['bottle', 'mint', 'night'], v: [['100 ml', 7200, 2600, 15]] },
      { n: 'Discovery Set', b: 'Maison Oud', d: 'Five 5 ml travel sprays of our bestsellers.', a: { pieces: 5, size_each: '5 ml' }, art: ['giftbox', 'gold', 'noir'], v: [['Set of 5', 4500, 1700, 20]] },
    ] },
  { slug: 'layerlab-3d', name: 'LayerLab 3D', category: '3D Printing', city: 'Edmonton', region: 'AB', tagline: 'Practical, made-to-order 3D printed goods.', theme: { accent: '#3347e0', hero: 'light', layout: 'grid' }, fee: 900,
    products: [
      { n: 'Angled Phone Stand', d: 'A sturdy stand for desks and nightstands. Printed on demand in your colour.', mto: true, a: { material: 'PLA+', layer_height: '0.2 mm', print_time: '3 hours', fits: 'Phones up to 7 in' }, art: ['stand', 'ink', 'ink'], v: [['Black', 1800, 450, 0], ['White', 1800, 450, 0], ['Blue', 1900, 480, 0]] },
      { n: 'Desk Organizer', d: 'Three compartments for pens, cards and cables.', mto: true, a: { material: 'PETG', print_time: '9 hours', dimensions: '180 × 120 × 70 mm' }, art: ['organizer', 'night', 'night'], v: [['Graphite', 3800, 900, 0], ['Forest', 3800, 900, 0]] },
      { n: 'Self-watering Planter', d: 'A two-part planter with a hidden reservoir.', mto: true, a: { material: 'PLA', print_time: '6 hours', capacity: '350 ml' }, art: ['planter', 'clay', 'clay'], v: [['Small', 2400, 600, 0], ['Large', 3600, 950, 0]] },
      { n: 'Desk Name Plate', d: 'Bold 3D-lettered plate for a desk or door. Printed to order in PLA.', mto: true, a: { material: 'PLA', production_time: '3 to 5 days' }, art: ['nameplate', 'night', 'plum'], v: [['Standard', 2800, 700, 0]] },
      { n: 'Cable Holder Set', d: 'Keep chargers tidy. Pack of four.', a: { material: 'TPU', pack: 4 }, art: ['organizer', 'steel', 'steel'], v: [['Pack of 4', 1200, 260, 40]] },
    ] },
  { slug: 'atelier-nova', name: 'Atelier Nova', category: 'Jewellery', city: 'Vancouver', region: 'BC', tagline: 'Handmade jewellery in recycled gold and silver.', theme: { accent: '#b0762f', hero: 'dark', layout: 'spacious' }, fee: 800,
    products: [
      { n: 'Solstice Ring', d: 'Hand-formed band with a bezel-set stone.', a: { metal: 'Recycled 14k gold vermeil', stone: 'Lab-grown sapphire', handmade: true }, art: ['ring', 'gold', 'gold'], v: [['Size 5', 14800, 5200, 3], ['Size 6', 14800, 5200, 4], ['Size 7', 14800, 5200, 2]] },
      { n: 'Halo Necklace', d: 'A delicate chain with a hammered pendant.', a: { metal: 'Sterling silver', chain_length: '45 cm', handmade: true }, art: ['necklace', 'steel', 'sand'], v: [['Silver', 9800, 3300, 7], ['Gold', 11800, 4100, 5]] },
      { n: 'Dot Studs', d: 'Minimal studs for every day.', a: { metal: 'Sterling silver', handmade: true }, art: ['studs', 'plum', 'gold'], v: [['Pair', 5400, 1500, 18]] },
      { n: 'Pearl Hoops', d: 'Freshwater pearl and gold hoops.', a: { metal: 'Gold vermeil', pearl: 'Freshwater' }, art: ['studs', 'gold', 'sand'], v: [['Pair', 8600, 2800, 6]] },
    ] },
  { slug: 'glow-bar', name: 'Glow Bar', category: 'Beauty', city: 'Toronto', region: 'ON', tagline: 'Skincare and beauty essentials, curated.', theme: { accent: '#d1456f', hero: 'light', layout: 'grid' }, fee: 500,
    products: [
      { n: 'Vitamin C Serum', b: 'Lumen', d: 'Brightening 15% vitamin C serum.', a: { skin_type: 'All', size: '30 ml', ingredients: 'Vitamin C, hyaluronic acid', expiry: '12 months after opening' }, art: ['dropper', 'amber', 'sand'], v: [['30 ml', 4200, 1400, 25]] },
      { n: 'Barrier Cleanser', b: 'Lumen', d: 'Gentle gel cleanser that respects your skin barrier.', a: { skin_type: 'Sensitive', size: '150 ml' }, art: ['tube', 'mint', 'sand'], v: [['150 ml', 2600, 800, 30]] },
      { n: 'Daily Sunscreen SPF 50', b: 'Solis', d: 'Lightweight, no white cast.', a: { spf: 50, size: '50 ml', skin_type: 'All' }, art: ['tube', 'coral', 'sand'], v: [['50 ml', 3200, 1000, 22]] },
      { n: 'Lip Tint', b: 'Petale', d: 'Buildable colour with a soft finish.', a: { finish: 'Satin' }, art: ['tube', 'rose', 'plum'], v: [['Rose', 1800, 500, 14], ['Berry', 1800, 500, 9], ['Coral', 1800, 500, 0]] },
      { n: 'Ceramide Moisturizer', b: 'Lumen', d: 'Rich cream for dry skin.', a: { skin_type: 'Dry', size: '50 ml' }, art: ['jar', 'sage', 'sand'], v: [['50 ml', 3800, 1200, 17]] },
      { n: 'Brush Set', b: 'Petale', d: 'Three essential face brushes.', a: { pieces: 3, bristles: 'Vegan' }, art: ['brushes', 'plum', 'rose'], v: [['Set of 3', 4900, 1500, 11]] },
    ] },
  { slug: 'corner-threads', name: 'Corner Threads', category: 'Fashion', city: 'Montreal', region: 'QC', tagline: 'Everyday pieces in natural fabrics.', theme: { accent: '#1f6f5c', hero: 'light', layout: 'spacious' }, fee: 700,
    products: [
      { n: 'Heavyweight Tee', d: 'Boxy tee in 100% organic cotton.', a: { fabric: 'Organic cotton', fit: 'Relaxed', care: 'Machine wash cold' }, art: ['tee', 'sage', 'sage'], v: [['S', 4200, 1400, 6], ['M', 4200, 1400, 10], ['L', 4200, 1400, 8], ['XL', 4200, 1400, 0]] },
      { n: 'Linen Shirt', d: 'Breathable linen button-up.', a: { fabric: 'Linen', fit: 'Regular', care: 'Wash cold, line dry' }, art: ['shirt', 'sand', 'sand'], v: [['S', 8900, 3000, 5], ['M', 8900, 3000, 7], ['L', 8900, 3000, 4]] },
      { n: 'Merino Scarf', d: 'Soft, warm and light.', a: { fabric: 'Merino wool', length: '180 cm' }, art: ['scarf', 'coral', 'clay'], v: [['One size', 6400, 2100, 12]] },
      { n: 'Everyday Cap', d: 'Washed cotton six-panel cap.', a: { fabric: 'Cotton twill', adjustable: true }, art: ['cap', 'denim', 'denim'], v: [['One size', 3200, 900, 20]] },
      { n: 'Canvas Tote', d: 'Heavy canvas tote with inner pocket.', a: { fabric: 'Canvas', capacity: '18 L' }, art: ['tote', 'olive', 'sand'], v: [['One size', 2800, 800, 25]] },
    ] },
  { slug: 'volt-mobile', name: 'Volt Mobile', category: 'Phone Accessories', city: 'Calgary', region: 'AB', tagline: 'Cases, chargers and cables that last.', theme: { accent: '#0b0b0c', hero: 'dark', layout: 'grid' }, fee: 500,
    products: [
      { n: 'Slim Phone Case', d: 'Shock-absorbing case with raised edges.', a: { material: 'TPU + PC', compatible_brands: 'iPhone, Samsung' }, art: ['case', 'night', 'night'], v: [['iPhone 15 · Black', 2400, 600, 14], ['iPhone 15 · Blue', 2400, 600, 8], ['Galaxy S24 · Black', 2400, 600, 6]] },
      { n: '65W GaN Charger', d: 'Compact fast charger for phone, tablet and laptop.', a: { output: '65 W', ports: '2× USB-C, 1× USB-A' }, art: ['charger', 'steel', 'steel'], v: [['White', 4900, 1700, 16]] },
      { n: 'Braided USB-C Cable', d: 'Tough braided cable, 2 m.', a: { length: '2 m', rating: '100 W' }, art: ['charger', 'coral', 'night'], v: [['2 m', 1800, 400, 40]] },
      { n: 'Wireless Earbuds', d: 'Active noise cancelling, 28-hour battery.', a: { battery: '28 h with case', bluetooth: '5.3' }, art: ['earbuds', 'night', 'night'], v: [['Black', 7900, 3100, 10], ['White', 7900, 3100, 0]] },
    ] },
];

async function call(path, { method = 'GET', body, cookie, raw, type } = {}) {
  const res = await fetch(API + path, { method, headers: { ...(cookie && { cookie }), ...(body && { 'content-type': 'application/json' }), ...(type && { 'content-type': type }) }, body: raw ?? (body && JSON.stringify(body)) });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  const render = async svg => { await page.setContent(`<body style="margin:0">${svg}</body>`); return page.screenshot({ type: 'jpeg', quality: 88 }); };
  for (const s of STORES) {
    const email = `demo-${s.slug}@eazystores.test`;
    const su = await call('/api/auth/signup', { method: 'POST', body: { email, password: 'demo-password-123', fullName: `${s.name} Owner`, businessName: s.name, storeSlug: s.slug } });
    if (su.res.status !== 201) { console.log(`skip ${s.slug}: ${su.data.error ?? su.res.status}`); continue; }
    const cookie = su.res.headers.getSetCookie()[0].split(';')[0];
    await call('/api/seller/business', { method: 'PATCH', cookie, body: { category: s.category, description: s.tagline, city: s.city, region: s.region, contactPhone: '403-555-0100', fulfilment: { pickup: true, delivery: true, shipping: false } } });
    await call('/api/seller/store', { method: 'PATCH', cookie, body: { tagline: s.tagline, deliveryFeeCents: s.fee, theme: s.theme } });
    for (const p of s.products) {
      const body = { name: p.n, description: p.d, brand: p.b, attributes: p.a, madeToOrder: !!p.mto, status: 'active', variants: p.v.map(([title, price, cost, stock]) => ({ title, priceCents: price, costCents: cost, stock })) };
      const r = await call('/api/seller/products', { method: 'POST', cookie, body });
      if (r.res.status !== 201) { console.log('product failed', p.n, r.data); continue; }
      for (const pal of [p.art[1], p.art[2]]) {
        const img = await render(art(p.art[0], pal));
        const up = await call(`/api/seller/products/${r.data.id}/images`, { method: 'POST', cookie, raw: img, type: 'image/jpeg' });
        if (up.res.status !== 201) console.log('image failed', p.n, up.data);
      }
    }
    const pub = await call('/api/seller/store/publish', { method: 'POST', cookie, body: {} });
    console.log(`${pub.res.status === 200 ? '✓' : '✗'} ${s.name} (${s.products.length} products)`);
  }
  await browser.close();
})();
