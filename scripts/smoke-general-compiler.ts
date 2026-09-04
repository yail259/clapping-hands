import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkflowRuntime } from "../src/workflow-runtime.js";

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (url.pathname === "/api/search") {
    const query = url.searchParams.get("q") ?? "";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ title: `Oak ${query} daybed`, price: 125 }] }));
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><html><body><main>
    <h1>Fixture catalogue</h1>
    <label for="query">Search products</label><input id="query">
    <button id="search">Search</button><section id="results">Ready</section>
    <script>document.querySelector('#search').onclick = async () => {
      const query = document.querySelector('#query').value;
      const value = await (await fetch('/api/search?q=' + encodeURIComponent(query))).json();
      document.querySelector('#results').textContent = value.items[0].title + ' — $' + value.items[0].price;
    }</script>
  </main></body></html>`);
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Smoke fixture did not bind.");
const origin = `http://127.0.0.1:${address.port}`;
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-general-smoke-"));
const runtime = new WorkflowRuntime(directory);

try {
  const workflow = await runtime.compileDom({
    action: "search_fixture",
    startUrl: origin,
    outputSelector: "#results",
    demonstrations: ["sofa", "chair"].map((query) => ({
      input: { query },
      instructions: [`Enter ${query} in the product search box and click Search`],
    })),
  });
  const executions = [];
  for (const query of ["lamp", "desk", "table"]) executions.push(await runtime.run("search_fixture", { query }));
  process.stdout.write(`${JSON.stringify({
    workflow: {
      baseline: workflow.baseline.engine,
      accelerator: workflow.accelerator?.engine ?? null,
    },
    executions: executions.map((execution) => ({
      engine: execution.engine,
      accelerated: execution.accelerated,
      shadow: execution.shadow,
      durationMs: typeof execution.result === "object" && execution.result && "durationMs" in execution.result
        ? Math.round(Number((execution.result as { durationMs: unknown }).durationMs))
        : null,
    })),
  }, null, 2)}\n`);
} finally {
  await runtime.close();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  await rm(directory, { recursive: true, force: true });
}
