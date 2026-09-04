import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { classifyFretEvidence, type MarketplaceListing } from "../src/marketplace.js";

type SearchResult = {
  query: string;
  location: string;
  radiusKm: number;
  sourceUrl: string;
  retrievedAt: string;
  authenticated: boolean;
  complete: boolean;
  totalListings: number;
  countsWhileScrolling: number[];
  listings: MarketplaceListing[];
  warnings: string[];
};

const projectRoot = resolve(import.meta.dirname, "..");
const inputPath = resolve(projectRoot, ".data/marketplace-24-fret-sydney.json");
const outputDir = process.env.CLAPPING_HANDS_EXPORT_DIR ?? resolve(projectRoot, "outputs");
const basename = "facebook-marketplace-sydney-24-fret-2026-09-04";

const result = JSON.parse(await readFile(inputPath, "utf8")) as SearchResult;
if (!result.authenticated || !result.complete) {
  throw new Error("Refusing to export an unauthenticated or incomplete Marketplace capture.");
}

const listings = result.listings.map((listing) => {
  const classification = classifyFretEvidence(listing.title);
  return {
    ...listing,
    fretConfidence: classification.confidence,
    evidence: classification.evidence,
  };
});

const priceNumber = (price: string | null) => {
  const parsed = Number(price?.replace(/[^0-9.]/g, "") ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
};
const candidates = listings
  .filter((listing) => listing.fretConfidence === "exact" || listing.fretConfidence === "likely")
  .sort((left, right) => priceNumber(left.price) - priceNumber(right.price) || left.title.localeCompare(right.title));

const mdEscape = (value: string | null) => (value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
const csvEscape = (value: string | number | boolean | null) => {
  const text = value === null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

const markdown = [
  "# Facebook Marketplace: 24-fret guitars near Sydney",
  "",
  `Retrieved: ${result.retrievedAt}`,
  "",
  `Authenticated: **${result.authenticated ? "yes" : "no"}**  `,
  `Enumeration complete: **${result.complete ? "yes" : "no"}**  `,
  `Unique cards retrieved: **${listings.length}**  `,
  `Scroll counts: ${result.countsWhileScrolling.join(" → ")}`,
  "",
  "“Likely” means the model name maps to a published 24-fret specification. Confirm the exact model, condition, and authenticity before buying.",
  "",
  `## Likely 24-fret matches (${candidates.length})`,
  "",
  "| Price | Listing | Location | Evidence |",
  "|---:|---|---|---|",
  ...candidates.map((listing) =>
    `| ${mdEscape(listing.price)} | [${mdEscape(listing.title)}](${listing.url}) | ${mdEscape(listing.location)} | ${mdEscape(listing.evidence.join(" "))} |`,
  ),
  "",
  `## All retrieved listing cards (${listings.length})`,
  "",
  "| # | Match | Price | Listing | Location |",
  "|---:|---|---:|---|---|",
  ...listings.map((listing, index) =>
    `| ${index + 1} | ${listing.fretConfidence} | ${mdEscape(listing.price)} | [${mdEscape(listing.title)}](${listing.url}) | ${mdEscape(listing.location)} |`,
  ),
  "",
  "## Specification sources used for model matching",
  "",
  "- [Haze/Caraya HL1APQTPU](https://www.hazeguitar.com.au/products/haze-tiger-purple-headless-electric-guitar-hh-solid-body-free-gig-bag-hl-1apq-tpu)",
  "- [Haze 6FFTAM](https://kookaburramusictree.com/products/4-4-haze-6f-fanned-frets-6-string-electric-guitar-trans-amber-free-gig-bag)",
  "- [Schecter 2010 catalog](https://www.schecterguitars.com/catalogs/files/2010_Catalog.pdf)",
  "- [Fernandes Dragonfly series](https://fernandesguitars.com/electric-guitars/)",
  "- [Rebel Prometheus Double Cutaway](https://www.rebelcustomguitars.com/prometheus-double-cutaway/)",
  "- [Ibanez JS series](https://www.ibanez.com/usa/products/model/js/)",
  "- [Charvel Pro-Mod DK24 FR HH](https://www.charvel.com/gear/shape/dk/pro-mod-dk24-hh-fr-m-mahogany-with-quilt-maple/2969431558)",
  "- [Sterling Majesty](https://sterlingbymusicman.com/products/majesty-maj200xfm-tiger-eye-guitar)",
  "",
  "Facebook search is fuzzy; unknown cards are retained so the export truly contains every card returned by the completed enumeration.",
  "",
].join("\n");

const csvHeader = ["id", "fretConfidence", "price", "previousPrice", "title", "location", "url", "evidence"];
const csv = [
  csvHeader.map(csvEscape).join(","),
  ...listings.map((listing) => [
    listing.id,
    listing.fretConfidence,
    listing.price,
    listing.previousPrice,
    listing.title,
    listing.location,
    listing.url,
    listing.evidence.join(" "),
  ].map(csvEscape).join(",")),
  "",
].join("\n");

const enrichedResult = {
  ...result,
  totalListings: listings.length,
  likely24FretListings: candidates.length,
  listings,
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDir, `${basename}.md`), markdown, "utf8"),
  writeFile(resolve(outputDir, `${basename}.csv`), csv, "utf8"),
  writeFile(resolve(outputDir, `${basename}.json`), `${JSON.stringify(enrichedResult, null, 2)}\n`, "utf8"),
]);

process.stdout.write(`${JSON.stringify({ outputDir, basename, total: listings.length, candidates: candidates.length })}\n`);
