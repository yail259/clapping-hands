export type RawMarketplaceCard = {
  href: string;
  ariaLabel: string | null;
  text: string;
  imageUrl: string | null;
  imageAlt: string | null;
};

export type FretConfidence = "exact" | "likely" | "unknown" | "not-a-guitar";

export type MarketplaceListing = {
  id: string;
  url: string;
  title: string;
  price: string | null;
  previousPrice: string | null;
  location: string | null;
  imageUrl: string | null;
  fretConfidence: FretConfidence;
  evidence: string[];
  rawText: string;
};

const PRICE = /^(?:AU\$|A\$|\$)\s*[\d,.]+(?:\.\d{2})?$|^Free$/i;
const LOCATION = /(?:,\s*(?:NSW|VIC|QLD|SA|WA|TAS|ACT|NT)|Australia)$/i;

export function canonicalMarketplaceUrl(href: string): { id: string; url: string } | null {
  const match = href.match(/\/marketplace\/item\/(\d+)/);
  if (!match?.[1]) return null;
  return {
    id: match[1],
    url: `https://www.facebook.com/marketplace/item/${match[1]}/`,
  };
}

function uniqueLines(text: string): string[] {
  const output: string[] = [];
  for (const value of text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (output.at(-1) !== value) output.push(value);
  }
  return output;
}

export function classifyFretEvidence(title: string): {
  confidence: FretConfidence;
  evidence: string[];
} {
  const normalized = title.replace(/[–—]/g, "-");
  const lower = normalized.toLowerCase();

  const partOrToolPatterns = [
    /\b24\s*inch\b.*\b(?:guitar\s+)?(?:neck|fretboard)\b/i,
    /\b(?:guitar\s+)?(?:neck|fretboard)\b.*\b(?:parts?|diy|replace(?:ment)?)\b/i,
    /\b(?:parts?|diy|replace(?:ment)?)\b.*\b(?:guitar\s+)?(?:neck|fretboard)\b/i,
    /\b(?:fret\s+)?sanding\s+blocks?\b/i,
    /\b(?:guitar\s+kit|kit\b.{0,40}\bguitar)\b/i,
  ];

  if (partOrToolPatterns.some((pattern) => pattern.test(normalized))) {
    return { confidence: "not-a-guitar", evidence: ["Title appears to describe a part or tool, not a complete guitar."] };
  }

  if (/\b24\s*[- ]?frets?\b/i.test(normalized)) {
    return { confidence: "exact", evidence: ["Title explicitly says 24 fret(s)."] };
  }

  const knownModelPatterns: Array<[RegExp, string]> = [
    [/\bPRS\b.*\b(?:Custom|CE|SE|S2|DW)\s*24\b/i, "PRS model name indicates a 24-fret variant."],
    [/\bIbanez\s+RG(?:320FM|421)\b/i, "This Ibanez RG model is commonly specified with 24 frets; verify the listing details."],
    [/\bYamaha\s+RGX721(?:DG)?\b/i, "This Yamaha RGX model is commonly specified with 24 frets; verify the listing details."],
    [/\b(?:Caraya|Haze)\b.*\bHL-?1APQ(?:TPU)?\b/i, "The Haze/Caraya HL1APQ model is specified with 24 frets."],
    [/\bHaze\s+6FFTAM\b/i, "The Haze 6FFTAM model is specified with 24 fanned frets."],
    [/\bSchecter\b.*\bBlackjack\s+ATX\b/i, "Schecter specifies the Blackjack ATX series with 24 X-Jumbo frets."],
    [/\bJackson\b.*\bFusion\s+SX\b/i, "The Jackson Fusion SX Professional is specified with 24 frets."],
    [/\bSamick\s+KRT[- ]?664\b/i, "The Samick KRT-664 is specified with 24 frets."],
    [/\bFernandes\s+Dragonfly\s+Pro\b/i, "The Fernandes Dragonfly Pro is specified with 24 frets."],
    [/\bIbanez\s+JS2410\b/i, "The Ibanez JS2410 is a 24-fret JS model."],
    [/\bCharvel\b.*\bDK24\b/i, "Charvel specifies the DK24 with 24 frets."],
    [/\bSchecter\b.*\bHellraiser\s+Hybrid\s+PT\b/i, "The Schecter Hellraiser Hybrid PT is specified with 24 frets."],
    [/\bIbanez\s+JEM\s*555\b/i, "The Ibanez JEM555 is specified with 24 frets."],
    [/\bSterling\b.*\bMajesty\s+MAJ200\b/i, "The Sterling Majesty MAJ200 is specified with 24 frets."],
    [/\bRebel\s+Custom\s+Guitars\b.*\bPrometheus\b/i, "Rebel Custom Guitars specifies the Prometheus Double Cutaway with 24 frets."],
  ];

  for (const [pattern, reason] of knownModelPatterns) {
    if (pattern.test(normalized)) return { confidence: "likely", evidence: [reason] };
  }

  if (/\b24\b/.test(lower)) {
    return { confidence: "unknown", evidence: ["Title contains 24, but does not establish fret count."] };
  }

  return { confidence: "unknown", evidence: ["Fret count is not established by the result card."] };
}

export function parseMarketplaceCard(card: RawMarketplaceCard): MarketplaceListing | null {
  const canonical = canonicalMarketplaceUrl(card.href);
  if (!canonical) return null;

  const lines = uniqueLines(card.text || card.ariaLabel || "");
  const priceIndexes = lines.flatMap((line, index) => PRICE.test(line) ? [index] : []);
  const price = priceIndexes.length > 0 ? lines[priceIndexes[0]!]! : null;
  const previousPrice = priceIndexes.length > 1 ? lines[priceIndexes[1]!]! : null;
  const location = [...lines].reverse().find((line) => LOCATION.test(line)) ?? null;
  const titleParts = lines.filter((line) => !PRICE.test(line) && line !== location);
  const title = titleParts.join(" ") || card.imageAlt || `Facebook Marketplace listing ${canonical.id}`;
  const classification = classifyFretEvidence(title);

  return {
    ...canonical,
    title,
    price,
    previousPrice,
    location,
    imageUrl: card.imageUrl,
    fretConfidence: classification.confidence,
    evidence: classification.evidence,
    rawText: card.text,
  };
}

export function deduplicateListings(cards: RawMarketplaceCard[]): MarketplaceListing[] {
  const listings = new Map<string, MarketplaceListing>();
  for (const card of cards) {
    const parsed = parseMarketplaceCard(card);
    if (parsed) listings.set(parsed.id, parsed);
  }
  return [...listings.values()];
}
