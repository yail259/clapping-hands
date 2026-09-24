import type { Page } from 'playwright-core';
import { extractLearnedOutput, type OutputRecipe } from './learned-output.js';

export type HtmlEvidence = { recipe: OutputRecipe; rows: Record<string, string>[] };

/** Passive live-value evidence, not a navigation controller or output compiler. */
export async function captureHtmlEvidence(page: Page): Promise<HtmlEvidence[]> {
  const ids = await page.locator('input[readonly],input[disabled]').evaluateAll(nodes =>
    nodes.slice(0, 24).map(node => node.id).filter(id => /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(id)));
  const result: HtmlEvidence[] = [];
  for (const id of [...new Set(ids)]) {
    const name = id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/-/g, '_');
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) continue;
    const recipe: OutputRecipe = { region: 'body', item: 'input#'+id,
      fields: [{ name, selector: '', source: 'value', line: null }] };
    try { const { rows } = await extractLearnedOutput(page, recipe); result.push({ recipe, rows }); }
    catch { /* Hidden, editable, private or ambiguous fields are not evidence. */ }
  }
  return result;
}
