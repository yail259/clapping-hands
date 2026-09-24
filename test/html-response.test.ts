import assert from "node:assert/strict";
import test from "node:test";
import { assertHtmlValueResponseRecipe, decodeHtmlResponseBytes, extractHtmlResponseRows, HtmlResponseError,
  inferHtmlResponseEncoding, type HtmlResponseFailure, type HtmlValueResponseRecipe } from "../src/html-response.js";

const PRIVATE = "fixture-private-html-value-never-report";
const recipe: HtmlValueResponseRecipe = { kind: "server-html-input-values-v1", encoding: "utf-8",
  region: "#tab-1 form[name='frmCalcA']", item: "#calculatedAnnualDollarValue", fields: [{ name: "amount", selector: "" }] };
const html = (control = '<input id="calculatedAnnualDollarValue" type="text" readonly value="42">', extra = "") =>
  `<!doctype html><html><head><meta charset="utf-8">${extra}</head><body><section id="tab-1"><form name="frmCalcA">${control}</form></section></body></html>`;
function refused(operation: () => unknown, reason?: HtmlResponseFailure) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof HtmlResponseError);
    if (reason) assert.equal(error.reason, reason);
    assert.equal(error.code, "HTML_RESPONSE_REFUSED");
    assert.doesNotMatch(String(error) + JSON.stringify(error), /fixture-private|https?:|value=|frmCalcA|PRIVATE/);
    return true;
  });
}

test("recipe admits bounded simple descendant/child CSS and refuses unsupported syntax and unsafe shapes", () => {
  assertHtmlValueResponseRecipe(recipe);
  assertHtmlValueResponseRecipe({ ...recipe, region: 'section#tab-1 > form[name="frmCalcA"]' });
  for (const selector of ["input:visible", "input:nth-child(1)", "input,textarea", "input + input", "input ~ input", "*", "#x\\31", "[value='private']", "form >> input", "form ", "a ".repeat(9).trim()]) {
    refused(() => assertHtmlValueResponseRecipe({ ...recipe, item: selector }), "invalid-recipe");
  }
  for (const value of [
    { ...recipe, fields: [{ name: "constructor", selector: "" }] },
    { ...recipe, fields: [recipe.fields[0], recipe.fields[0]] },
    { ...recipe, encoding: "latin1" }, { ...recipe, surprise: PRIVATE },
    { ...recipe, fields: [{ ...recipe.fields[0], source: "value" }] },
    { ...recipe, item: "#" + "x".repeat(501) },
    { ...recipe, fields: [] }, { ...recipe, fields: Array(13).fill(recipe.fields[0]) },
    Object.create(recipe),
  ]) refused(() => assertHtmlValueResponseRecipe(value), "invalid-recipe");
  const getter = { ...recipe }; Object.defineProperty(getter, "region", { get() { throw new Error(PRIVATE); } });
  refused(() => assertHtmlValueResponseRecipe(getter), "invalid-recipe");
  refused(() => assertHtmlValueResponseRecipe(new Proxy({}, { ownKeys() { throw new Error(PRIVATE); } })), "invalid-recipe");
});

test("encoding is explicit, canonical and browser-compatible for ISO-8859-1", () => {
  for (const label of ["utf-8", "UTF8", '"utf-8"']) assert.equal(inferHtmlResponseEncoding(`Text/HTML; charset=${label}`), "utf-8");
  for (const label of ["iso-8859-1", "latin1", "windows-1252", "us-ascii"]) assert.equal(inferHtmlResponseEncoding(`text/html;charset=${label}`), "windows-1252");
  const bytes = Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><p>'), Buffer.from([0x80, 0x93, 0xe9]), Buffer.from("</p>")]);
  assert.equal(decodeHtmlResponseBytes(bytes, "text/html; charset=iso-8859-1").body, '<meta charset="iso-8859-1"><p>€“é</p>');
  assert.equal(decodeHtmlResponseBytes(Buffer.from(html()), "text/html; charset=utf-8").encoding, "utf-8");
});

test("one early real meta declaration can establish encoding without a header charset", () => {
  for (const declaration of ['<meta charset="utf-8">', '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">']) {
    assert.equal(inferHtmlResponseEncoding("text/html", Buffer.from(declaration)), "utf-8");
  }
  assert.equal(inferHtmlResponseEncoding("text/html", Buffer.from([0xef, 0xbb, 0xbf, 0x41])), "utf-8");
  for (const body of ["plain HTML", '<!-- <meta charset="utf-8"> -->', '<script>const fake=\'<meta charset="utf-8">\';</script>', " ".repeat(1024) + '<meta charset="utf-8">']) {
    refused(() => inferHtmlResponseEncoding("text/html", Buffer.from(body)), "encoding");
  }
});

test('Windows-1252 C1 mappings do not depend on the host Node/ICU decoder',()=>{
  const bytes=Buffer.concat([Buffer.from('<p>'),Buffer.from(Array.from({length:32},(_,i)=>0x80+i)),Buffer.from('</p>')]);
  const expected='€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
  assert.equal(decodeHtmlResponseBytes(bytes,'text/html;charset=windows-1252').body,'<p>'+expected+'</p>');
});

test("missing, malformed, unsupported winning encoding and changed expected encoding are refused", () => {
  for (const type of ["text/html", "text/html; charset=shift_jis", "text/html;charset=utf-8;charset=utf-8", "text/html; charset=", "text/html; x=y"]) {
    refused(() => inferHtmlResponseEncoding(type), "encoding");
  }
  for (const type of ["text/plain;charset=utf-8", "application/xhtml+xml;charset=utf-8", "text/htmlish;charset=utf-8", `text/html\r\n${PRIVATE}`]) refused(() => inferHtmlResponseEncoding(type), "content-type");
  refused(() => decodeHtmlResponseBytes(Buffer.from('<meta charset="utf-8"><meta charset="utf-8">'), "text/html"), "encoding-conflict");
  refused(() => decodeHtmlResponseBytes(Buffer.from('<meta charset="utf-8">'), "text/html;charset=utf-8", "windows-1252"), "encoding-conflict");
  refused(() => decodeHtmlResponseBytes(Buffer.from([0xff, 0xfe, 0x41, 0]), "text/html;charset=utf-8"), "encoding");
  refused(() => decodeHtmlResponseBytes(Buffer.from([0xc3, 0x28]), "text/html;charset=utf-8"), "encoding");
  refused(() => decodeHtmlResponseBytes(Buffer.from("A\0B"), "text/html;charset=utf-8"), "invalid-document");
});

test("encoding follows BOM then transport then early meta; a decoded string does not infer charset", () => {
  const conflicting = Buffer.from('<meta charset="windows-1252"><meta charset="unsupported-encoding"><p>é €</p>');
  assert.equal(decodeHtmlResponseBytes(conflicting, "text/html;charset=utf-8").encoding, "utf-8");
  assert.match(decodeHtmlResponseBytes(conflicting, "text/html;charset=utf-8").body, /é €/);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), conflicting]);
  for (const header of ["windows-1252", "utf-16le", "unsupported-encoding"]) {
    assert.equal(decodeHtmlResponseBytes(bom, `text/html;charset=${header}`).encoding, "utf-8");
  }
  const late = Buffer.from(' '.repeat(1100) + '<meta charset="iso-8859-1">');
  assert.equal(decodeHtmlResponseBytes(late, "text/html;charset=utf-8").encoding, "utf-8");
  assert.deepEqual(extractHtmlResponseRows(html().replace('charset="utf-8"', 'charset="unsupported-encoding"'), recipe).rows, [{ amount: "42" }]);
  refused(() => decodeHtmlResponseBytes(conflicting, "text/html;charset=utf-16le"), "encoding");
  refused(() => decodeHtmlResponseBytes(bom, "text/html;charset=windows-1252", "windows-1252"), "encoding-conflict");
});

test("one bounded :has(simple compound) supports learned wrappers without accepting general selector grammar", () => {
  const wrapped = { ...recipe, item: "span:has(#calculatedAnnualDollarValue)", fields: [{ name: "amount", selector: "#calculatedAnnualDollarValue" }] };
  assert.deepEqual(extractHtmlResponseRows(html('<span><input id="calculatedAnnualDollarValue" readonly value="42"></span>'), wrapped).rows, [{ amount: "42" }]);
  assertHtmlValueResponseRecipe({ ...wrapped, item: 'span.result:has(input#calculatedAnnualDollarValue[type="text"])' });
  for (const item of ["span:has()", "span:has(> input)", "span:has(+ input)", "span:has(input,textarea)", "span:has(input .child)",
    "span:has(input>span)", "span:has(input:visible)", "span:has(span:has(input))", "span:has(input):has(input)", "span:has(#x\\31)",
    ":has(input)", "span:has(*)", "span:has(input", "span:has(input))", "span:has(input):not(.private)"]) {
    refused(() => assertHtmlValueResponseRecipe({ ...wrapped, item }), "invalid-recipe");
  }
  refused(() => extractHtmlResponseRows(html('<span><span><input id="calculatedAnnualDollarValue" readonly value="42"></span></span>'),
    { ...wrapped, region: "#tab-1 span:has(#calculatedAnnualDollarValue)" }), "field-cardinality");
});

test("decoder bounds bytes before parsing and rejects refresh and duplicate attributes", () => {
  refused(() => decodeHtmlResponseBytes(new Uint8Array(), "text/html;charset=utf-8"), "invalid-document");
  assert.equal(decodeHtmlResponseBytes(Buffer.alloc(1024 * 1024, 32), "text/html;charset=utf-8").body.length, 1024 * 1024);
  refused(() => decodeHtmlResponseBytes(Buffer.alloc(1024 * 1024 + 1, 32), "text/html;charset=utf-8"), "response-too-large");
  refused(() => decodeHtmlResponseBytes(Buffer.from('<meta charset="utf-8" charset="iso-8859-1">'), "text/html;charset=utf-8"), "invalid-document");
  refused(() => decodeHtmlResponseBytes(Buffer.from('<meta http-equiv="refresh" content="0;url=https://fixture-private.invalid">'), "text/html;charset=utf-8"), "invalid-document");
});

test("passive extraction preserves exact selected value attributes and decodes HTML entities", () => {
  for (const [attribute, expected] of [["0", "0"], ["  12.50  ", "  12.50  "], ["   ", "   "], ["A&amp;B &#x20AC;", "A&B €"], ["A&#9;B", "A\tB"]]) {
    assert.deepEqual(extractHtmlResponseRows(html(`<input id="calculatedAnnualDollarValue" readonly value="${attribute}">`), recipe), { rows: [{ amount: expected }] });
  }
  assert.deepEqual(extractHtmlResponseRows(html('<input id="calculatedAnnualDollarValue" disabled value="42">'), recipe).rows, [{ amount: "42" }]);
  assert.deepEqual(extractHtmlResponseRows(html('<fieldset disabled><input id="calculatedAnnualDollarValue" value="42"></fieldset>'), recipe).rows, [{ amount: "42" }]);
  refused(() => extractHtmlResponseRows(html('<fieldset disabled><legend><input id="calculatedAnnualDollarValue" value="42"></legend></fieldset>'), recipe), "unsafe-control");
});

test("number attributes must already satisfy native input syntax; text newlines are not silently normalized", () => {
  for (const value of ["0", "-0", "-001.50", ".5", "1e3", "-1.2e-3"]) {
    assert.equal(extractHtmlResponseRows(html(`<input id="calculatedAnnualDollarValue" type="number" readonly value="${value}">`), recipe).rows[0]!.amount, value);
  }
  for (const value of ["1,000", "$42", "1.", "+1", " 1 ", "NaN", "Infinity", "1e999", "", "1&#10;2"]) {
    refused(() => extractHtmlResponseRows(html(`<input id="calculatedAnnualDollarValue" type="number" readonly value="${value}">`), recipe), "unsafe-control");
  }
  refused(() => extractHtmlResponseRows(html('<input id="calculatedAnnualDollarValue" readonly value="a&#10;b">'), recipe), "unsafe-control");
});

test("control type, readonly status, size and absence drift cannot return private values", () => {
  for (const attributes of ["", 'type="password" readonly', 'type="file" readonly', 'type="hidden" readonly', 'type="email" readonly', 'type="unknown" readonly', 'type="" readonly']) {
    refused(() => extractHtmlResponseRows(html(`<input id="calculatedAnnualDollarValue" ${attributes} value="${PRIVATE}">`), recipe), "unsafe-control");
  }
  for (const control of ['<textarea id="calculatedAnnualDollarValue" readonly>private</textarea>', '<input id="calculatedAnnualDollarValue" readonly>', '<input id="calculatedAnnualDollarValue" readonly value="">']) refused(() => extractHtmlResponseRows(html(control), recipe), "unsafe-control");
  assert.equal(extractHtmlResponseRows(html(`<input id="calculatedAnnualDollarValue" readonly value="${"x".repeat(4000)}">`), recipe).rows[0]!.amount!.length, 4000);
  refused(() => extractHtmlResponseRows(html(`<input id="calculatedAnnualDollarValue" readonly value="${"x".repeat(4001)}">`), recipe), "unsafe-control");
});

test("explicit hidden/inert/visibility styling and inert containers refuse selected values", () => {
  for (const attributes of ["hidden", "inert", 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0 !important"', 'style="content-visibility:hidden"', 'style="opacity:var(--x)"', 'style="display:n/**/one"']) {
    refused(() => extractHtmlResponseRows(html(`<div ${attributes}><input id="calculatedAnnualDollarValue" readonly value="${PRIVATE}"></div>`), recipe), "unsafe-control");
  }
  for (const tag of ["template", "noscript", "script", "style", "svg", "math", "iframe", "object", "details", "dialog"]) {
    refused(() => extractHtmlResponseRows(html(`<${tag}><input id="calculatedAnnualDollarValue" readonly value="${PRIVATE}"></${tag}>`), recipe));
  }
});

test("private metadata includes associated forms, labels and unique ARIA references", () => {
  for (const control of [
    `<input id="calculatedAnnualDollarValue" readonly name="firstName" value="${PRIVATE}">`,
    `<input id="calculatedAnnualDollarValue" readonly autocomplete="one-time-code" value="${PRIVATE}">`,
    `<input id="calculatedAnnualDollarValue" readonly autocomplete="on" value="${PRIVATE}">`,
    `<label for="calculatedAnnualDollarValue">Full name</label><input id="calculatedAnnualDollarValue" readonly value="${PRIVATE}">`,
    `<label>Account number<input id="calculatedAnnualDollarValue" readonly value="${PRIVATE}"></label>`,
    `<span id="meaning">Contact email</span><input id="calculatedAnnualDollarValue" readonly aria-describedby="meaning" value="${PRIVATE}">`,
    `<input id="calculatedAnnualDollarValue" readonly aria-describedby="missing" value="${PRIVATE}">`,
    `<span id="meaning">Amount</span><span id="meaning">Amount</span><input id="calculatedAnnualDollarValue" readonly aria-labelledby="meaning" value="${PRIVATE}">`,
    `<input id="calculatedAnnualDollarValue" readonly form="missing" value="${PRIVATE}">`,
  ]) refused(() => extractHtmlResponseRows(html(control), recipe), "unsafe-control");
  for (const autocomplete of ["on", "unknown", "section-checkout billing cc-number", ""]) {
    const body = html().replace('<form name="frmCalcA">', `<form name="frmCalcA" autocomplete="${autocomplete}">`);
    refused(() => extractHtmlResponseRows(body, recipe), "unsafe-control");
  }
  const external = html('<input id="calculatedAnnualDollarValue" readonly form="owner" value="42">').replace('</body>', '<form id="owner" autocomplete="email"></form></body>');
  refused(() => extractHtmlResponseRows(external, recipe), "unsafe-control");
});

test("login/checkpoint HTML is refused even when it retains matching output controls", () => {
  const body = html().replace('</body>', '<h1>Sign in</h1><form><input type="password"><button>Log in</button></form></body>');
  refused(() => extractHtmlResponseRows(body, recipe), "login-form");
  const checkpoint = html().replace('</body>', '<h1>Verify your identity</h1><form><input autocomplete="one-time-code"></form></body>');
  refused(() => extractHtmlResponseRows(checkpoint, recipe), "checkpoint");
  assert.deepEqual(extractHtmlResponseRows(html().replace('</body>', '<form hidden><h1>Log in</h1><input type="password"><button>Log in</button></form></body>'), recipe).rows, [{ amount: "42" }]);
});

test("duplicate, absent and excess rows fail instead of returning partial data", () => {
  refused(() => extractHtmlResponseRows(html('<input id="calculatedAnnualDollarValue" readonly value="1"><input id="calculatedAnnualDollarValue" readonly value="2">'), recipe), "unsafe-control");
  refused(() => extractHtmlResponseRows(html('<span>Layout changed</span>'), recipe), "field-cardinality");
  refused(() => extractHtmlResponseRows(html().replace('</body>', '<section id="tab-1"><form name="frmCalcA"></form></section></body>'), recipe), "field-cardinality");
  const rows = { ...recipe, item: ".row", fields: [{ name: "amount", selector: "input" }] };
  assert.deepEqual(extractHtmlResponseRows(html('<div class="row"><input readonly value="1"></div><div class="row"><input readonly value="2"></div>'), rows).rows, [{ amount: "1" }, { amount: "2" }]);
  refused(() => extractHtmlResponseRows(html('<div class="row"><input readonly value="1"><input readonly value="2"></div>'), rows), "field-cardinality");
  refused(() => extractHtmlResponseRows(html('<div class="row"><input readonly value="1"></div>'.repeat(101)), rows), "field-cardinality");
});

test("accepted AST and string bounds reject oversized/deep/lexically truncated documents", () => {
  refused(() => extractHtmlResponseRows(html() + " ".repeat(1024 * 1024), recipe), "response-too-large");
  refused(() => extractHtmlResponseRows(html('<div>'.repeat(101) + '<input id="calculatedAnnualDollarValue" readonly value="42">' + '</div>'.repeat(101)), recipe), "invalid-document");
  refused(() => extractHtmlResponseRows(html() + '<i></i>'.repeat(20_001), recipe), "invalid-document");
  refused(() => decodeHtmlResponseBytes(Buffer.from(html() + '<i></i>'.repeat(20_001)), "text/html;charset=utf-8"), "invalid-document");
  refused(() => extractHtmlResponseRows(html() + '<input value="' + PRIVATE, recipe), "invalid-document");
  refused(() => extractHtmlResponseRows(html().replace('value="42"', 'value="42" value="43"'), recipe), "invalid-document");
});

test("scripts and resources remain passive; static output is explicitly not live value or computed visibility", () => {
  const state = globalThis as unknown as { fixtureHtmlExecuted?: boolean };
  state.fixtureHtmlExecuted = false;
  const body = html(undefined, '<style>#calculatedAnnualDollarValue { display:none }</style><link rel="stylesheet" href="https://fixture-private.invalid/style.css">')
    .replace('</body>', '<script>globalThis.fixtureHtmlExecuted=true; document.querySelector("input").value="99"; fetch("https://fixture-private.invalid/beacon")</script><img src="https://fixture-private.invalid/image"></body>');
  assert.deepEqual(extractHtmlResponseRows(body, recipe), { rows: [{ amount: "42" }] });
  assert.equal(state.fixtureHtmlExecuted, false);
  delete state.fixtureHtmlExecuted;
  // The 42 attribute is server evidence only: browser differential validation must reject a live 99 result.
});
