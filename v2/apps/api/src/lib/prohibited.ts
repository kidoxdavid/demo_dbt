/** First line of defence for the prohibited-items policy, applied when a seller publishes. A keyword list is NOT enough on its own: staff review the queue and take-down reports. */
const RULES: { re: RegExp; reason: string; message: string }[] = [
  { re: /\b(counterfeit|knock-?off|replica|fake (designer|brand|rolex|gucci|louis)|1:1 copy|bootleg)\b/i, reason: 'counterfeit', message: 'Counterfeits, replicas and knock-offs are not allowed.' },
  { re: /\b(firearm|handgun|pistol|rifle|ammunition|ammo|switchblade|brass knuckles|taser|silencer|suppressor)\b/i, reason: 'weapons', message: 'Weapons and ammunition cannot be sold here.' },
  { re: /\b(cocaine|heroin|meth(amphetamine)?|fentanyl|lsd|mdma|cannabis|marijuana|weed|vape|vaping|e-?cigarette|tobacco|cigar)\b/i, reason: 'regulated_goods', message: 'Drugs, vapes and tobacco are age-restricted or illegal and cannot be sold here.' },
  { re: /\b(stolen|hot goods|no questions asked)\b/i, reason: 'stolen', message: 'Stolen goods are not allowed.' },
  { re: /\b(explosive|fireworks?|detonator|gunpowder)\b/i, reason: 'hazardous', message: 'Explosives and fireworks cannot be shipped through the marketplace.' },
  { re: /\b(disney|marvel|pok[eé]mon|nintendo|mario kart|harry potter|hello kitty|star wars|barbie|lego|nike|adidas|gucci|louis vuitton|chanel|rolex|hermes|hermès|prada|yeezy)\b/i, reason: 'ip_infringement', message: 'Items using protected brands or licensed characters need the owner’s permission, so they cannot be listed.' },
];
export interface Prohibited { reason: string; message: string; match: string }
export function checkProhibited(...texts: (string | null | undefined)[]): Prohibited | null {
  const t = texts.filter(Boolean).join(' \n ');
  for (const r of RULES) { const m = r.re.exec(t); if (m) return { reason: r.reason, message: r.message, match: m[0] }; }
  return null;
}
