/** Parse a bounded sequence of guarded JSON records returned by a browser
 * request. This handles pretty-printed records; splitting on newlines loses
 * valid records when the JSON itself spans lines. No page code is evaluated. */
export function parseGuardedJsonSequence(text: string): unknown[] {
  if (!text || Buffer.byteLength(text, 'utf8') > 1_000_000) throw new Error('JSON sequence size refused.');
  const marker = 'for (;;);';
  const records: unknown[] = [];
  let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '')) index++;
    if (index === text.length) break;
    if (!text.startsWith(marker, index) || records.length >= 20) throw new Error('JSON sequence framing refused.');
    index += marker.length;
    while (/\s/.test(text[index] ?? '')) index++;
    const start = index, stack: string[] = [];
    let quoted = false, escaped = false;
    for (; index < text.length; index++) {
      const char = text[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) throw new Error('JSON sequence nesting refused.');
        if (stack.length === 0) { index++; break; }
      }
      if (index - start > 500_000 || stack.length > 100) throw new Error('JSON sequence record limit exceeded.');
    }
    if (stack.length || quoted || index === start) throw new Error('JSON sequence record incomplete.');
    let value: unknown;
    try { value = JSON.parse(text.slice(start, index)); }
    catch { throw new Error('JSON sequence record refused.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON sequence record shape refused.');
    records.push(value);
  }
  if (!records.length) throw new Error('JSON sequence empty.');
  return records;
}

/** Feed guarded JSON records into the existing structural projection learner.
 * Escaping '<' prevents a JSON value from terminating its synthetic script. */
export function guardedJsonAsInlineDocument(text: string): string {
  return jsonRecordsAsInlineDocument(parseGuardedJsonSequence(text));
}

/** Project a decoded guarded response without reconstructing network bytes. */
export function jsonRecordsAsInlineDocument(value: unknown): string {
  if (!Array.isArray(value) || !value.length || value.length > 20 || value.some(record =>
    !record || typeof record !== 'object' || Array.isArray(record))) throw new Error('JSON records refused.');
  const html=value.map(record => `<script type="application/json">${JSON.stringify(record).replace(/</g, '\\u003c')}</script>`).join('');
  if (Buffer.byteLength(html,'utf8') > 1_000_000) throw new Error('JSON records size refused.');
  return html;
}
