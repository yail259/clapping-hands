import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { extractLearnedOutput, type OutputRecipe } from "../src/learned-output.js";

test("learned extraction rejects absent or hidden rows instead of inventing an empty success", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const recipe: OutputRecipe = { region: "main", item: "article", fields: [
    { name: "count", selector: "span", source: "text", line: null },
  ] };
  try {
    const page = await browser.newPage();
    for (const content of [
      "<main><p>No results found</p></main>",
      "<main><div><span>Changed result layout</span></div></main>",
      '<main><input type="password"><button>Log in</button></main>',
      '<main><article hidden><span>Stale hidden result</span></article></main>',
    ]) {
      await page.setContent(`<style>main { min-height: 100px; }</style>${content}`);
      await assert.rejects(() => extractLearnedOutput(page, recipe), /empty result state has not been verified/);
    }
    await page.setContent("<main><article><span>0</span></article></main>");
    assert.deepEqual((await extractLearnedOutput(page, recipe)).rows, [{ count: "0" }]);
  } finally {
    await browser.close();
  }
});
