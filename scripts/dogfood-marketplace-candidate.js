function*(input) {
  const response = yield { op: 'request', resource: 'response_0', parameters: { query: input.query } };
  if (response.status !== 200 || typeof response.body !== 'string') throw Error('Search document unavailable');
  const nodes = yield { op: 'select', html: response.body, selector: 'a[aria-label][href*="/marketplace/item/"]' };
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 24) throw Error('Unexpected search cards');
  const output = [];
  for (const node of nodes) {
    const label = node.attributes['aria-label'];
    const href = node.attributes.href;
    if (typeof label !== 'string' || typeof href !== 'string') throw Error('Invalid card');
    let stem = label.replace(/, listing \d+$/, '');
    if (stem === label) throw Error('Missing listing ID');
    const locationMatch = /, ([^,]+), (NSW|ACT|VIC|QLD)$/.exec(stem);
    if (!locationMatch) throw Error('Unknown location shape');
    const location = locationMatch[1] + ', ' + locationMatch[2];
    stem = stem.slice(0, locationMatch.index);
    const previousMatch = /, reduced from AU\$([\d,.]+)$/.exec(stem);
    const previousPriceAud = previousMatch ? Number(previousMatch[1].replace(/,/g, '')) : null;
    if (previousMatch) stem = stem.slice(0, previousMatch.index);
    const priceMatch = /, (AU\$[\d,.]+|Free)$/.exec(stem);
    if (!priceMatch) throw Error('Unknown price shape');
    const priceAud = priceMatch[1] === 'Free' ? 0 : Number(priceMatch[1].slice(3).replace(/,/g, ''));
    const title = stem.slice(0, priceMatch.index).replace(/\s+/g, ' ').trim();
    if (!title || !Number.isFinite(priceAud) || (previousPriceAud !== null && !Number.isFinite(previousPriceAud))) throw Error('Invalid card values');
    const absolute = yield { op: 'url', base: 'https://www.facebook.com', relative: href };
    output.push({ title, priceAud, previousPriceAud, location, url: absolute.split('?')[0] });
  }
  return output;
}
