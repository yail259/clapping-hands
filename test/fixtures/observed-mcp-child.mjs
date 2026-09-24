// Controlled child for the TEST-ONLY installed-runtime preload. It imitates
// only the MCP framing boundary; no learner, provider model or real site.
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
const [origin, mode] = process.argv.slice(2);
let browser, context, page;
if (mode === "browser") {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  context = await browser.newContext(); page = await context.newPage(); await page.goto(origin);
}
const output = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  const operation = request.params?.arguments?.operation;
  if (operation === "exit") { await browser?.close(); output({ id: request.id, result: {} }); break; }
  if (operation === "ui") {
    await page.getByRole("textbox").fill("fixture-private-input");
    await page.getByRole("button").click();
    await page.goto(`${origin}/next`);
  }
  if (operation === "direct-http") { const response = await context.request.get(`${origin}/data`); await response.dispose(); }
  if (operation === "evaluate") await page.evaluate((value) => { document.body.dataset.value = value; }, "fixture-private-expression");
  if (operation === "provider") await fetch(`${origin}/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer fixture-private-credential" }, body: "fixture-private-provider-body" });
  if (operation === "unmatched") output({ id: 999_999, result: { private: "fixture-private-result" } });
  if (operation === "break-fetch") globalThis.fetch = async () => new Response("fixture-private-replacement");
  if (operation === "missing") continue;
  if (operation === "overlap") await new Promise((done) => setTimeout(done, 25));
  output({ id: request.id, result: { private: "fixture-private-result", modelCalls: 0, actions: 0 } });
}
await browser?.close();
