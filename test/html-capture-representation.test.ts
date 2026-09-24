import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { NetworkRecorder } from "../src/network-recorder.js";
import { extractLearnedOutput, type OutputRecipe } from "../src/learned-output.js";
import { compileGenericJsonCandidatesFromTraces, replayGenericJsonPlan, type GenericNetworkTrace } from "../src/generic-network.js";
import { inferCapturedNetworkResponse } from "../src/network-response.js";
import { captureHtmlEvidence, type HtmlEvidence } from '../src/html-evidence.js';
import { compileJavaScriptTask, replayJavaScriptTask } from '../src/javascript-task.js';
import type { TaskDefinition } from '../src/task-store.js';

const executablePath = process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const recipe: OutputRecipe = { region: "#result", item: "span:has(#total)",
  fields: [{ name: "total", selector: "#total", source: "value", line: null }] };

// "Café € " in Windows-1252: 0x80 is the euro sign there and undefined in ISO-8859-1,
// so a document that is re-decoded with the wrong codec cannot silently agree.
const prefixBytes = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x20]);
const expected = (amount: number) => `Café € ${(amount * 1.5066).toFixed(2).replace(".", ",")}`;
function resultDocument(amount: number): Buffer {
  return Buffer.concat([
    // The transport charset and this meta declaration deliberately disagree, as
    // real calculator result pages do; the transport declaration wins.
    Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Result</title></head><body><main id="result"><span><input type="text" id="total" readonly value="'),
    prefixBytes, Buffer.from((amount * 1.5066).toFixed(2).replace(".", ",")),
    Buffer.from('"></span></main></body></html>'),
  ]);
}
const formDocument = '<!doctype html><html><head><meta charset="utf-8"><title>Form</title></head><body><form method="post" action="/calculate">'
  + '<input type="text" name="amount" id="amount"><button type="submit" id="run">Calculate</button></form></body></html>';

async function demonstrate(page: Page, recorder: NetworkRecorder, origin: string, amount: number): Promise<GenericNetworkTrace & { html: HtmlEvidence[] }> {
  const mark = recorder.mark();
  await recorder.withDocumentResponses(async () => {
    await page.goto(origin);
    await page.fill("#amount", String(amount));
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#run")]);
  });
  const browser = await extractLearnedOutput(page, recipe);
  assert.deepEqual(browser.rows, [{ total: expected(amount) }]);
  const exchanges = (await recorder.since(mark)).filter((exchange) => exchange.method === "POST");
  assert.equal(exchanges.length, 1);
  return { input: { amount }, exchanges, outputText: "Result", outputRows: browser.rows, html: await captureHtmlEvidence(page) };
}

test("browser-decoded capture text and fresh transport bytes yield the same learned rows for a legacy-charset document", async () => {
  const served: string[] = [];
  const server = createServer((request, response) => {
    served.push(`${request.method} ${request.url}`);
    if (request.url !== "/calculate") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(formDocument);
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const amount = Number(new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("amount"));
      response.writeHead(200, { "content-type": "text/html;charset=ISO-8859-1", "cache-control": "no-store" });
      response.end(resultDocument(amount));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const recorder = new NetworkRecorder();
    recorder.setAllowedOrigins([origin]);
    recorder.attach(page);
    const mark = recorder.mark();
    const traces = [await demonstrate(page, recorder, origin, 100), await demonstrate(page, recorder, origin, 250.5)];
    const capture = await recorder.diagnosticsSince(mark);
    assert.equal(capture.capturedResponses, 4);
    assert.deepEqual(capture.outcomes, { captured: 4 });

    const captured = traces[0]!.exchanges[0]!;
    const decoded = inferCapturedNetworkResponse(captured, recipe);
    // The transport charset survives Chromium's decoding; the re-encoded text does not carry it.
    assert.equal(decoded.htmlRecipe?.encoding, "windows-1252");
    assert.deepEqual(decoded.value, { rows: [{ total: expected(100) }] });
    assert.notEqual(new TextDecoder("windows-1252").decode(Buffer.from(captured.responseBody, "utf8")), captured.responseBody,
      "the fixture would visibly corrupt if captured text were decoded a second time");

    const [candidate] = compileGenericJsonCandidatesFromTraces("html_capture_representation", traces,
      { workflowOrigin: origin, htmlOutputRecipe: recipe });
    assert.ok(candidate);
    assert.equal(candidate.plan.response.htmlRecipe?.encoding, "windows-1252");

    // The actual alpha adapter discovers its own passive recipe after each
    // navigation. No prototype recipe or fabricated browser rows enter it.
    const definition:TaskDefinition={action:'restored_html',startUrl:origin+'/',goal:'Equivalent cost',effect:'read',
      inputSchema:{type:'object',properties:{amount:{type:'number'}},required:['amount'],additionalProperties:false},outputSchema:{type:'string'}};
    const id='1788788997083-23d225da-9fc8-4b47-8456-a9dbb4c0f1ef';
    const restored = await compileJavaScriptTask(definition,
      traces.map(({ input, exchanges }) => ({ input, exchanges })),[expected(100),expected(250.5)],[id,id],'unused-fixture',
      async()=>({proposal:{supported:true,source:`function*(input){const r=yield {op:'request',resource:'response_0',parameters:input};return JSON.parse(r.body).rows[0].total;}`,explanation:'Fixture compiler boundary'},
        durationMs:0,requestId:id,responseId:id}),traces.map(trace=>trace.html));
    assert.ok(restored);
    assert.equal(restored.resources[0]!.plan.response.htmlRecipe?.encoding,'windows-1252');
    const adapterReplay = await replayJavaScriptTask(context,definition,restored,{amount:37.5});
    assert.equal(adapterReplay.value,expected(37.5));

    const before = served.length;
    const replayed = await replayGenericJsonPlan(context as BrowserContext, candidate.plan, { amount: 37.5 });
    assert.equal(served.length, before + 1, "the compiled call is one fresh request, not a cached answer");
    assert.deepEqual(replayed.data, { rows: [{ total: expected(37.5) }] });
    // Independent browser observation of the same held-out input, for meaning, not shape.
    const holdout = await demonstrate(page, recorder, origin, 37.5);
    assert.deepEqual(replayed.data, { rows: holdout.outputRows });
  } finally {
    try { await browser.close(); }
    finally { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); }
  }
});
