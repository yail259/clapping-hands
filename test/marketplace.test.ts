import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalMarketplaceUrl,
  classifyFretEvidence,
  parseMarketplaceCard,
} from "../src/marketplace.js";

test("canonicalizes a Marketplace result URL", () => {
  assert.deepEqual(
    canonicalMarketplaceUrl("https://www.facebook.com/marketplace/item/1466531218861458/?ref=search"),
    {
      id: "1466531218861458",
      url: "https://www.facebook.com/marketplace/item/1466531218861458/",
    },
  );
});

test("parses price, previous price, title, and location", () => {
  const listing = parseMarketplaceCard({
    href: "/marketplace/item/1270939621739360/?ref=search",
    ariaLabel: null,
    text: "AU$3,600\nAU$4,000\n2020 PRS DW CE 24 Dustie Waring Signature\nSydney, NSW",
    imageUrl: "https://example.test/guitar.jpg",
    imageAlt: null,
  });

  assert.equal(listing?.title, "2020 PRS DW CE 24 Dustie Waring Signature");
  assert.equal(listing?.price, "AU$3,600");
  assert.equal(listing?.previousPrice, "AU$4,000");
  assert.equal(listing?.location, "Sydney, NSW");
  assert.equal(listing?.fretConfidence, "likely");
});

test("rejects a 24-inch neck false positive", () => {
  assert.equal(
    classifyFretEvidence("New 24 inch short scale Roasted Maple Guitar neck 21fret").confidence,
    "not-a-guitar",
  );
});

test("accepts an explicit 24-fret guitar", () => {
  assert.equal(classifyFretEvidence("Superstrat electric guitar - 24 frets").confidence, "exact");
});

test("does not mistake a centre-block guitar for a sanding block", () => {
  assert.equal(
    classifyFretEvidence("Gretsch G5622 Electromatic Centre Block guitar").confidence,
    "unknown",
  );
});

test("does not mistake a complete guitar mentioning its neck for a replacement neck", () => {
  assert.equal(
    classifyFretEvidence("Monterey Platinum Guitar with lacquered neck").confidence,
    "unknown",
  );
});

test("rejects a guitar kit as a complete guitar listing", () => {
  assert.equal(
    classifyFretEvidence("PRS Kit Hallow Electric Guitar Mahogany Body").confidence,
    "not-a-guitar",
  );
});

test("recognizes verified 24-fret model names", () => {
  const titles = [
    "Haze 6FFTAM Trans Amber Fanned-Fret 6-String Electric Guitar",
    "Caraya Headless HH Maple HHL Electric Guitar – Purple HL1APQTPU",
    "Schecter Blackjack ATX 7 string Electric Guitar",
    "1992 Jackson Fusion SX Professional MIJ",
    "Samick KRT-664 Prophet",
    "Fernandes Dragonfly Pro Electric Guitar",
    "Ibanez JS2410 Joe Satriani Signature",
    "Charvel Pro-Mod DK24 FR HH",
    "Schecter Hellraiser Hybrid PT",
    "Ibanez Jem 555 BK",
    "Sterling Majesty MAJ200",
    "Rebel Custom Guitars Prometheus Double Cutaway",
  ];

  for (const title of titles) {
    assert.equal(classifyFretEvidence(title).confidence, "likely", title);
  }
});
