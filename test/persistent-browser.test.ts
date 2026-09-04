import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { PersistentWorkflowBrowser } from "../src/persistent-browser.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function fixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><main>Persistent profile fixture</main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Persistent browser fixture did not bind.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test("deterministic cached browser persists first-party auth state without an LLM", async () => {
  const { server, origin } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-persistent-"));
  try {
    const first = new PersistentWorkflowBrowser({
      allowedOrigins: [origin],
      profileDirectory: directory,
      executablePath: CHROME,
      headless: true,
    });
    const page = await first.goto(origin);
    await page.evaluate(() => {
      document.cookie = "fixture_session=present; SameSite=Lax";
      localStorage.setItem("fixture-auth", "present");
    });
    await first.close();

    const second = new PersistentWorkflowBrowser({
      allowedOrigins: [origin],
      profileDirectory: directory,
      executablePath: CHROME,
      headless: true,
    });
    const restored = await second.goto(origin);
    assert.match(await restored.evaluate(() => document.cookie), /fixture_session=present/);
    assert.equal(await restored.evaluate(() => localStorage.getItem("fixture-auth")), "present");
    await assert.rejects(() => second.goto("https://example.com"), /outside the allowed origins/);
    await second.close();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
