import { z } from "zod";
import type { Page } from "playwright-core";
import { readReadOnlyInputValue } from "./read-only-input-value.js";

const selector = z.string().min(1).max(500).refine((value) => !/(?:token|cookie|password|secret|csrf|session)[\s=]/i.test(value));
export const outputRecipeSchema = z.object({
  region: selector.describe("Unique CSS selector of the results region"),
  item: selector.describe("CSS selector relative to the region for each result row/card"),
  fields: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    selector: z.string().max(500).describe("Relative CSS selector; empty string means the item itself"),
    source: z.enum(["text", "href", "value"]).describe("value reads a safe visible native readonly/disabled text or number input's live string; not arbitrary form data"),
    line: z.number().int().min(0).max(30).nullable().describe("Optional zero-based nonempty innerText line, otherwise null"),
  }).strict().refine((field) => field.source !== "value" || field.line === null, {
    message: "Input value extraction requires line: null.", path: ["line"],
  })).min(1).max(12),
}).strict();
export type OutputRecipe = z.infer<typeof outputRecipeSchema>;

export class ExtractionFailure extends Error {
  constructor(readonly issue: { code: "field-cardinality" | "field-value"; item: number; field: string; matches?: number }) {
    super(`Learned output field ${issue.field} failed (${issue.code}) at item ${issue.item}.`);
  }
}

export async function previewLearnedOutput(page: Page, recipe: OutputRecipe) {
  try {
    const result = await extractLearnedOutput(page, recipe);
    const indices = [...new Set([0, 1, 2, 3, result.rows.length - 2, result.rows.length - 1])].filter((index) => index >= 0 && index < result.rows.length);
    return { valid: result.rows.length > 0, count: result.rows.length, samples: indices.map((index) => ({ index,
      row: Object.fromEntries(Object.entries(result.rows[index]!).map(([key, value]) => [key, value.slice(0, 500)])),
    })), issue: result.rows.length ? null : { code: "empty-results" } };
  } catch (error) {
    return { valid: false, count: null, samples: [], issue: error instanceof ExtractionFailure ? error.issue : { code: "invalid-region-or-recipe" } };
  }
}

export async function extractLearnedOutput(page: Page, input: OutputRecipe) {
  const recipe = outputRecipeSchema.parse(input);
  if (new Set(recipe.fields.map((field) => field.name)).size !== recipe.fields.length) throw new Error("Duplicate output fields.");
  const region = page.locator(recipe.region);
  if (await region.count() !== 1 || !await region.isVisible()) throw new Error("Learned result region is unavailable or ambiguous.");
  const items = region.locator(recipe.item);
  const count = await items.count();
  if (count > 100) throw new Error("Learned extraction exceeds the 100-item page limit.");
  const rows: Record<string, string>[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    if (!await item.isVisible()) continue;
    const row: Record<string, string> = {};
    for (const field of recipe.fields) {
      const target = field.selector ? item.locator(field.selector) : item;
      const matches = await target.count();
      if (matches !== 1) throw new ExtractionFailure({ code: "field-cardinality", item: index, field: field.name, matches });
      let value: string;
      if (field.source === "href") {
        const href = await target.getAttribute("href");
        if (!href) throw new Error("Learned result link is absent.");
        const url = new URL(href, page.url());
        if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) throw new Error("Unsafe result URL.");
        url.search = ""; url.hash = "";
        value = url.href;
      } else if (field.source === "value") {
        // Page-side accessors or a destroyed context must not put arbitrary
        // page exception text (possibly containing a value) into diagnostics.
        const evidence = await target.evaluate(readReadOnlyInputValue).catch(() => null);
        if (!evidence) throw new ExtractionFailure({ code: "field-value", item: index, field: field.name });
        value = evidence.value;
      } else {
        const text = await target.innerText();
        value = field.line === null ? text.trim() : text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[field.line] ?? "";
      }
      if (!value || value.length > 4_000) throw new ExtractionFailure({ code: "field-value", item: index, field: field.name });
      row[field.name] = value;
    }
    rows.push(row);
  }
  // No empty-state contract has been learned: absence may mean selector drift or a login shell.
  // Do not turn that uncertainty into a plausible successful empty search.
  if (rows.length === 0) throw new Error("Learned output has no visible results; an empty result state has not been verified.");
  return { rows, completeness: "visible-results-only" as const, modelCalls: 0 };
}
