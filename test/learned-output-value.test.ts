import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chromium, type Page } from "playwright-core";
import { ExtractionFailure, extractLearnedOutput, outputRecipeSchema, previewLearnedOutput, type OutputRecipe } from "../src/learned-output.js";

const PRIVATE = "fixture-private-source-value-never-report-on-refusal";
const recipe: OutputRecipe = { region: "#results", item: ".row", fields: [
  { name: "amount", selector: ".result", source: "value", line: null },
] };

async function fixture(t: TestContext): Promise<Page> {
  const browser = await chromium.launch({
    executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await content(page, '<input class="result" type="text" readonly value="42">');
  return page;
}

async function content(page: Page, control: string, wrapper = "") {
  await page.setContent(`<style>#results { min-height:100px; } .row { min-height:40px; } input { width:180px; height:24px; }</style>
    <main id="results"><article class="row" ${wrapper}>${control}</article></main>`);
}

async function refused(page: Page, expected: "field-value" | "field-cardinality" = "field-value") {
  await assert.rejects(extractLearnedOutput(page, recipe), (error: unknown) => {
    assert.ok(error instanceof ExtractionFailure);
    assert.equal(error.issue.code, expected);
    assert.equal(error.issue.field, "amount");
    assert.doesNotMatch(String(error) + JSON.stringify(error), /fixture-private|https?:|value=/);
    return true;
  });
  const preview = await previewLearnedOutput(page, recipe);
  assert.equal(preview.valid, false);
  assert.deepEqual(preview.samples, []);
  assert.doesNotMatch(JSON.stringify(preview), /fixture-private|https?:|value=/);
}

test("value recipe requires line:null without changing existing text/href recipes", () => {
  assert.deepEqual(outputRecipeSchema.parse(recipe), recipe);
  for (const line of [0, 1, 30]) {
    assert.equal(outputRecipeSchema.safeParse({ ...recipe, fields: [{ ...recipe.fields[0], line }] }).success, false);
  }
  assert.equal(outputRecipeSchema.safeParse({ ...recipe, fields: [{ ...recipe.fields[0], source: "text", line: 0 }] }).success, true);
  assert.equal(outputRecipeSchema.safeParse({ ...recipe, fields: [{ ...recipe.fields[0], source: "href" }] }).success, true);
});

test("value extraction reads live native text/number values, not stale attributes, without coercion", async (t) => {
  const page = await fixture(t);
  for (const type of ["text", "number"]) {
    for (const mode of ["readonly", "disabled"]) {
      await content(page, `<input class="result" type="${type}" ${mode} value="999">`);
      await page.locator(".result").evaluate((element) => { (element as HTMLInputElement).value = "0"; });
      assert.equal(await page.locator(".result").getAttribute("value"), "999");
      assert.deepEqual(await extractLearnedOutput(page, recipe), { rows: [{ amount: "0" }], completeness: "visible-results-only", modelCalls: 0 });
    }
  }
  for (const value of ["  12.50  ", "   ", "-001.50", "A\tB", "é"]) {
    await content(page, '<input class="result" type="text" readonly value="stale">');
    await page.locator(".result").evaluate((element, current) => { (element as HTMLInputElement).value = current; }, value);
    assert.deepEqual((await extractLearnedOutput(page, recipe)).rows, [{ amount: value }]);
  }
});

test("value extraction rejects read-only and type drift instead of leaking replacement controls", async (t) => {
  const page = await fixture(t);
  for (const control of [
    `<input class="result" type="text" value="${PRIVATE}">`,
    ...["password", "hidden", "email", "tel", "search", "url", "checkbox", "radio", "range", "date", "file", "unknown-widget-type", ""].map((type) =>
      `<input class="result" type="${type}" readonly value="${PRIVATE}">`),
    `<textarea class="result" readonly>${PRIVATE}</textarea>`,
    `<select class="result" disabled><option>${PRIVATE}</option></select>`,
    `<div class="result" readonly value="${PRIVATE}">${PRIVATE}</div>`,
  ]) {
    await content(page, control); await refused(page);
  }
  await content(page, '<input class="result" type="text" readonly value="42">');
  assert.deepEqual((await extractLearnedOutput(page, recipe)).rows, [{ amount: "42" }]);
  await page.locator(".result").evaluate((element, current) => { const input = element as HTMLInputElement; input.readOnly = false; input.value = current; }, PRIVATE);
  await refused(page);
});

test("value extraction refuses hidden, inert and transparent targets and ancestors", async (t) => {
  const page = await fixture(t);
  for (const attributes of [
    "hidden", "inert", 'aria-hidden="true"',
    'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"',
  ]) {
    await content(page, `<input class="result" type="text" readonly ${attributes} value="${PRIVATE}">`);
    await refused(page);
  }
  for (const attributes of ["inert", 'aria-hidden="true"', 'style="opacity:0"']) {
    await content(page, `<div ${attributes}><input class="result" type="text" readonly value="${PRIVATE}"></div>`);
    await refused(page);
  }
});

test("value extraction refuses sensitive metadata/autocomplete drift and does not return source values", async (t) => {
  const page = await fixture(t);
  for (const attributes of [
    'autocomplete="current-password"', 'autocomplete="new-password"', 'autocomplete="one-time-code"',
    'autocomplete="section-checkout billing cc-number"', 'autocomplete="email"',
    'name="password"', 'id="sessionToken"', 'aria-label="Password"', 'placeholder="secret"',
  ]) {
    await content(page, `<input class="result" type="text" readonly ${attributes} value="${PRIVATE}">`);
    await refused(page);
  }
  await content(page, '<input class="result" type="text" readonly value="42">');
  assert.deepEqual((await extractLearnedOutput(page, recipe)).rows, [{ amount: "42" }]);
  await page.locator(".result").evaluate((element) => { element.setAttribute("autocomplete", "one-time-code"); });
  await refused(page);
});

test("value extraction refuses unsafe form autocomplete even when the input overrides it", async (t) => {
  const page = await fixture(t);
  for (const autocomplete of ["on", "unknown-category", "section-checkout billing cc-number", "", "email"]) {
    await content(page, `<form autocomplete="${autocomplete}"><input class="result" type="text" readonly autocomplete="off" value="${PRIVATE}"></form>`);
    await refused(page);
  }
  await content(page, '<form autocomplete="off"><input class="result" type="text" readonly autocomplete="off" value="42"></form>');
  assert.deepEqual((await extractLearnedOutput(page, recipe)).rows, [{ amount: "42" }]);
});

test("value extraction checks personal identifiers in associated labels, aria descriptions and form metadata", async (t) => {
  const page = await fixture(t);
  for (const markup of [
    `<label for="calculation">Full name</label><input id="calculation" class="result" readonly value="${PRIVATE}">`,
    `<label for="calculation">Date of birth</label><input id="calculation" class="result" readonly value="${PRIVATE}">`,
    `<span id="meaning">Account routing number</span><input class="result" readonly aria-describedby="meaning" value="${PRIVATE}">`,
    `<span id="meaning">Contact email</span><input class="result" readonly aria-labelledby="meaning" value="${PRIVATE}">`,
    `<input class="result" readonly aria-describedby="absent-description" value="${PRIVATE}">`,
    `<input class="result" name="firstName" readonly value="${PRIVATE}">`,
    `<input class="result" name="givenName" readonly value="${PRIVATE}">`,
    `<form name="userAccount"><input class="result" readonly value="${PRIVATE}"></form>`,
  ]) {
    await content(page, markup); await refused(page);
  }
});

test("value extraction cannot escape hidden or inert ancestry through a shadow host", async (t) => {
  const page = await fixture(t);
  for (const attributes of ["hidden", "inert", 'aria-hidden="true"', 'style="opacity:0"', 'style="display:none"']) {
    await content(page, `<div id="host" ${attributes}></div>`);
    await page.locator("#host").evaluate((host, value) => {
      const input = document.createElement("input"); input.className = "result"; input.readOnly = true; input.value = value;
      host.attachShadow({ mode: "open" }).append(input);
    }, PRIVATE);
    await refused(page);
  }
  await content(page, '<div id="host"></div>');
  await page.locator("#host").evaluate((host) => {
    const input = document.createElement("input"); input.className = "result"; input.readOnly = true; input.value = "42";
    host.attachShadow({ mode: "open" }).append(input);
  });
  assert.deepEqual((await extractLearnedOutput(page, recipe)).rows, [{ amount: "42" }]);
});

test("an element-owned readonly getter cannot authorize an editable input", async (t) => {
  const page = await fixture(t);
  await content(page, `<input class="result" type="text" value="${PRIVATE}">`);
  await page.locator(".result").evaluate((input) => { Object.defineProperty(input, "readOnly", { get() { return true; } }); });
  await refused(page);
});

test("value-read evaluation exceptions become fixed nonleaking refusal", async (t) => {
  const page = await fixture(t);
  await page.locator(".result").evaluate((input) => {
    Object.defineProperty(input, "labels", { get() { throw new Error("fixture-private-evaluation-failure"); } });
  });
  await refused(page);
});

test("value extraction enforces unique targets and exact nonempty bounded values", async (t) => {
  const page = await fixture(t);
  await content(page, '<input class="result" type="text" readonly value="42"><input class="result" type="text" readonly value="43">');
  await refused(page, "field-cardinality");
  await content(page, '<span>Changed layout</span>'); await refused(page, "field-cardinality");
  for (const value of ["", PRIVATE.repeat(100)]) {
    await content(page, '<input class="result" type="text" readonly>');
    await page.locator(".result").evaluate((element, current) => { (element as HTMLInputElement).value = current; }, value);
    await refused(page);
  }
  await content(page, '<input class="result" type="text" readonly>');
  await page.locator(".result").evaluate((element) => { (element as HTMLInputElement).value = "x".repeat(4000); });
  assert.equal((await extractLearnedOutput(page, recipe)).rows[0]!.amount!.length, 4000);
  await page.locator(".result").evaluate((element) => { (element as HTMLInputElement).value += "x"; }); await refused(page);
});

test("value extraction reads without events, mutations or invoking an element-owned value getter", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const state = { events: 0, mutations: 0, getterReads: 0 };
    (window as unknown as { fixtureState: typeof state }).fixtureState = state;
    for (const event of ["input", "change", "click", "focus", "blur"]) document.addEventListener(event, () => { state.events++; }, true);
    new MutationObserver((records) => { state.mutations += records.length; }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const input = document.querySelector<HTMLInputElement>(".result")!;
    Object.defineProperty(input, "value", { configurable: true, get() { state.getterReads++; return "fixture-private-getter-value"; } });
  });
  const before = await page.locator("#results").innerHTML();
  assert.deepEqual((await extractLearnedOutput(page, recipe)).rows, [{ amount: "42" }]);
  assert.equal(await page.locator("#results").innerHTML(), before);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { fixtureState: unknown }).fixtureState), { events: 0, mutations: 0, getterReads: 0 });
});

test("value field additions preserve existing text line selection and safe href normalization", async (t) => {
  const page = await fixture(t);
  await content(page, '<input class="result" type="text" readonly value="0"><p> First line <br> Second line </p><a href="https://fixture.invalid/result?private=ignored#ignored"> Detail </a>');
  const mixed: OutputRecipe = { ...recipe, fields: [recipe.fields[0]!,
    { name: "summary", selector: "p", source: "text", line: 1 },
    { name: "url", selector: "a", source: "href", line: null },
  ] };
  assert.deepEqual((await extractLearnedOutput(page, mixed)).rows, [{ amount: "0", summary: "Second line", url: "https://fixture.invalid/result" }]);
});
