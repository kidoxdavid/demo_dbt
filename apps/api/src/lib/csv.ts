/** RFC 4180 CSV parser: quoted fields, escaped quotes, embedded newlines, CRLF, BOM. Throws on unterminated quotes. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = []; let row: string[] = []; let f = ''; let q = false; let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
      f += ch; i++; continue;
    }
    if (ch === '"' && f === '') { q = true; i++; continue; }
    if (ch === ',') { row.push(f); f = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(c => c.trim() !== '')) rows.push(row); row = []; i++; continue; }
    f += ch; i++;
  }
  if (q) throw new Error('unterminated_quote');
  if (f !== '' || row.length) { row.push(f); if (row.some(c => c.trim() !== '')) rows.push(row); }
  return rows;
}
