import { load } from 'cheerio';

// Narrow dogfood observer used to supply typed examples. The general compiler
// must infer its own paths, and held-out promotion needs independent UI evidence.
export type MarketplaceListing = {
  id: string;
  marketplace_listing_title: string;
  redacted_description: { text: string };
  listing_price: { formatted_amount_zeros_stripped?: string; formatted_amount?: string };
  attribute_data: Array<{ attribute_name?: string; label?: string }>;
  is_live?: boolean;
  is_sold?: boolean;
  is_pending?: boolean;
};

export function extractMarketplaceListing(html: string, id: string): MarketplaceListing {
  if (html.length > 5_000_000) throw new Error('Document too large.');
  const $ = load(html);
  const matches: MarketplaceListing[] = [];
  $('script[type="application/json"]').each((_index, element) => {
    const content = $(element).html() ?? '';
    if (!content.includes('redacted_description') || !content.includes(`"${id}"`)) return;
    let root: unknown;
    try { root = JSON.parse(content); } catch { return; }
    let visited = 0;
    const visit = (value: unknown, depth: number): void => {
      if (++visited > 30_000 || depth > 25 || !value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (object.id === id && typeof object.marketplace_listing_title === 'string' && 'redacted_description' in object)
        matches.push(object as MarketplaceListing);
      for (const child of Object.values(object)) visit(child, depth + 1);
    };
    visit(root, 0);
  });
  if (matches.length !== 1) throw new Error(`Expected one listing payload; found ${matches.length}.`);
  return matches[0]!;
}

export function marketplaceFields(listing: MarketplaceListing) {
  const title = listing.marketplace_listing_title?.trim();
  const description = listing.redacted_description?.text?.trim();
  const price = listing.listing_price?.formatted_amount_zeros_stripped
    ?? listing.listing_price?.formatted_amount;
  const conditions = listing.attribute_data?.filter(row => row.attribute_name === 'Condition') ?? [];
  const condition = conditions.length === 1 ? conditions[0]!.label?.trim() : undefined;
  if (!title || !description || !price || !condition || !/^(?:AU)?\$[\d,]+(?:\.\d{2})?$/.test(price))
    throw new Error('Required listing fields missing.');
  return { title, price, condition, description };
}
