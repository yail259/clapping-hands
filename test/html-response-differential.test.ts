import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright-core";
import { assertHtmlValueResponseRecipe, decodeHtmlResponseBytes, extractHtmlResponseRows, HtmlResponseError,
  type HtmlResponseEncoding, type HtmlValueResponseRecipe } from "../src/html-response.js";

const executablePath = process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const recipe: HtmlValueResponseRecipe = { kind: "server-html-input-values-v1", encoding: "utf-8", region: "#results",
  item: "span:has(#calculatedAnnualDollarValue)", fields: [{ name: "amount", selector: "#calculatedAnnualDollarValue" }] };
function documentBytes(meta: string, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`<!doctype html><html><head><meta charset="${meta}"></head><body><main id="results"><span><input type="text" id="calculatedAnnualDollarValue" readonly value="`),
    value, Buffer.from('"></span></main></body></html>')]);
}

test("passive decoder matches Chrome's non-ASCII values for transport/meta conflicts and BOM overrides", async () => {
  const text = "Café € “";
  const windows = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x20, 0x93]);
  const utf8 = Buffer.from(text, "utf8");
  const cases: Array<{ type: string; bytes: Buffer; encoding: HtmlResponseEncoding }> = [
    { type: "text/html; charset=ISO-8859-1", bytes: documentBytes("utf-8", windows), encoding: "windows-1252" },
    { type: "text/html; charset=utf-8", bytes: documentBytes("iso-8859-1", utf8), encoding: "utf-8" },
    { type: "text/html; charset=ISO-8859-1", bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), documentBytes("iso-8859-1", utf8)]), encoding: "utf-8" },
    { type: "text/html; charset=utf-16le", bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), documentBytes("windows-1252", utf8)]), encoding: "utf-8" },
    { type: "text/html", bytes: documentBytes("iso-8859-1", windows), encoding: "windows-1252" },
    { type: "text/html", bytes: documentBytes("utf-8", utf8), encoding: "utf-8" },
  ];
  const served = Array(cases.length).fill(0) as number[];
  const server = createServer((request, response) => {
    const index = /^\/(\d+)$/.exec(request.url ?? "")?.[1];
    const item = index !== undefined ? cases[Number(index)] : undefined;
    if (!item) { response.writeHead(204); response.end(); return; }
    served[Number(index)]!++;
    response.writeHead(200, { "content-type": item.type, "cache-control": "no-store" }); response.end(item.bytes);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    for (const [index, item] of cases.entries()) {
      const response = await page.goto(`http://127.0.0.1:${address.port}/${index}`);
      assert.equal(response?.status(), 200);
      if (index === 0) {
        // Regression evidence for capture integration: the pinned Chromium/CDP
        // document-body API has already decoded these Windows-1252 bytes.
        const protocolBody = await response!.body();
        assert.notDeepEqual(protocolBody, item.bytes);
        // Expected UTF-8 is constructed from the fixture's known text, not the
        // host decoder whose Node/ICU compatibility this test is checking.
        assert.deepEqual(protocolBody, documentBytes("utf-8", utf8));
      }
      // Chromium CDP/Playwright may reencode document Response.body() as UTF-8.
      // The independent decoding oracle is the fixture's exact served bytes,
      // not a lossy browser-protocol reconstruction of the response.
      const decoded = decodeHtmlResponseBytes(item.bytes, response!.headers()["content-type"]!);
      assert.equal(decoded.encoding, item.encoding);
      assert.equal(await page.evaluate(() => document.characterSet.toLowerCase()), item.encoding);
      const browserValue = await page.locator("#calculatedAnnualDollarValue").inputValue();
      assert.equal(browserValue, text);
      assert.deepEqual(extractHtmlResponseRows(decoded.body, { ...recipe, encoding: decoded.encoding }), { rows: [{ amount: browserValue }] });
      assert.equal(await page.locator(recipe.region).locator(recipe.item).count(), 1);
    }
    assert.deepEqual(served, Array(cases.length).fill(1));
  } finally {
    try { await browser.close(); }
    finally { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); }
  }
});

test("bounded has selectors match Chrome's descendant selection and preserve exact cardinality refusal", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const markup = '<main id="results"><span class="wrapper"><i><input class="result" readonly value="0"></i></span><span class="wrapper"><input class="result" readonly value=" 42 "></span><span><input readonly value="decoy"></span></main>';
    await page.setContent(markup);
    for (const item of ["span:has(input.result)", 'span.wrapper:has(input.result[type="text"])', "span:has( input.result )"]) {
      const contract = { ...recipe, item, fields: [{ name: "amount", selector: "input.result" }] };
      assertHtmlValueResponseRecipe(contract);
      // The explicit type selector intentionally matches neither default-text attribute.
      const count = await page.locator("#results").locator(item).count();
      if (count === 0) {
        assert.throws(() => extractHtmlResponseRows(markup, contract), (error) => error instanceof HtmlResponseError && error.reason === "field-cardinality");
      } else {
        const values = await page.locator("#results").locator(item).locator("input.result").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
        assert.equal(count, 2);
        assert.deepEqual(extractHtmlResponseRows(markup, contract), { rows: values.map((amount) => ({ amount })) });
      }
    }
    const duplicate = '<main id="results"><span><input class="result" readonly value="1"><input class="result" readonly value="2"></span></main>';
    await page.setContent(duplicate);
    const contract = { ...recipe, item: "span:has(input.result)", fields: [{ name: "amount", selector: "input.result" }] };
    assert.equal(await page.locator("#results").locator(contract.item).locator("input.result").count(), 2);
    assert.throws(() => extractHtmlResponseRows(duplicate, contract), (error) => error instanceof HtmlResponseError && error.reason === "field-cardinality");
  } finally { await browser.close(); }
});
