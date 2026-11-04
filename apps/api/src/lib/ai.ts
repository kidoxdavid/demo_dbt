import { HttpError } from './errors.js';

/** Read lazily so the switch is the environment at call time. No key means the AI features are off, and say so. */
export const aiSettings = () => ({
  key: process.env.ANTHROPIC_API_KEY ?? '', model: process.env.AI_MODEL ?? 'claude-sonnet-5-5',
  baseUrl: (process.env.AI_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, ''),
  dailyLimit: Number(process.env.AI_DAILY_LIMIT ?? 40), timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 45_000),
});
export const aiConfigured = () => !!aiSettings().key;

/** Anthropic Messages API. One text answer back; `image` is already re-encoded by our own image pipeline. Anything the model says is untrusted text. */
export async function complete(a: { system: string; text: string; image?: { mediaType: 'image/webp'; data: Buffer }; maxTokens?: number }): Promise<{ text: string; model: string }> {
  const s = aiSettings(); if (!s.key) throw new HttpError(503, 'ai_not_configured');
  const content: unknown[] = [];
  if (a.image) content.push({ type: 'image', source: { type: 'base64', media_type: a.image.mediaType, data: a.image.data.toString('base64') } });
  content.push({ type: 'text', text: a.text });
  let res: Response;
  try {
    res = await fetch(`${s.baseUrl}/v1/messages`, { method: 'POST', signal: AbortSignal.timeout(s.timeoutMs),
      headers: { 'content-type': 'application/json', 'x-api-key': s.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: s.model, max_tokens: a.maxTokens ?? 1200, system: a.system, messages: [{ role: 'user', content }] }) });
  } catch { throw new HttpError(502, 'ai_unreachable'); }
  if (res.status === 429) throw new HttpError(503, 'ai_busy');
  if (!res.ok) throw new HttpError(502, 'ai_failed');
  const j: any = await res.json().catch(() => null);
  const text = Array.isArray(j?.content) ? j.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('') : '';
  if (!text) throw new HttpError(502, 'ai_empty');
  return { text, model: String(j.model ?? s.model) };
}

/** The first balanced JSON object in the model's reply (models sometimes wrap it in prose or code fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{'); if (start < 0) throw new HttpError(502, 'ai_bad_output');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { throw new HttpError(502, 'ai_bad_output'); } }
  }
  throw new HttpError(502, 'ai_bad_output');
}
/** Plain text only: no markup, no control characters. */
export const clean = (s: string, max: number) => Array.from(s.replace(/<[^>]*>/g, ' ')).filter(ch => { const n = ch.charCodeAt(0); return !(n < 32 && n !== 9 && n !== 10 && n !== 13) && n !== 127 && n !== 0x2028 && n !== 0x2029; }).join('').replace(/[ \t]+/g, ' ').trim().slice(0, max);

/** Phrases that read as factual claims a customer may rely on. If the seller did not write them, the draft is flagged so they are checked or removed. */
const CLAIMS: [RegExp, string][] = [
  [/\b(award[- ]winning|winner of|voted (the )?best)\b/i, 'award claim'], [/\b(#1|number one|best[- ]selling|world'?s best|best in canada)\b/i, 'ranking claim'],
  [/\b(organic|certified|fair[- ]trade|non-gmo|vegan|gluten[- ]free|hypoallergenic|nut[- ]free)\b/i, 'certification or ingredient claim'],
  [/\b(eco[- ]friendly|sustainabl[ey]|biodegradable|carbon[- ]neutral|zero[- ]waste|recycled)\b/i, 'environmental claim'],
  [/\b(guarantee[d]?|risk[- ]free|lifetime warranty|money[- ]back)\b/i, 'guarantee or warranty'], [/\b(clinically|dermatologist|doctor|medical|cures?|treats?|heals?)\b/i, 'health claim'],
  [/\b(made in canada|canadian[- ]made|locally made|hand[- ]?made|handcrafted|small[- ]batch)\b/i, 'origin or method claim'],
  [/\b(since \d{4}|\d+\+? years|family[- ]owned|third[- ]generation)\b/i, 'history claim'], [/\b\d+\s?%/i, 'percentage'], [/\b(free shipping|same[- ]day|next[- ]day|ships? (within|in) \d+)/i, 'shipping promise'],
];
export function flagClaims(output: string, sellerInput: string): { phrase: string; type: string }[] {
  const out: { phrase: string; type: string }[] = []; const given = sellerInput.toLowerCase();
  for (const [re, type] of CLAIMS) {
    const g = new RegExp(re.source, 'gi'); let m: RegExpExecArray | null;
    while ((m = g.exec(output))) if (!given.includes(m[0].toLowerCase()) && !out.some(o => o.phrase.toLowerCase() === m![0].toLowerCase())) out.push({ phrase: m[0], type });
  }
  return out;
}
