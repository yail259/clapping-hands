import { z } from 'zod';
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const browserModelUsageSchema=z.object({
  requestAttempts:count,reportedInvocations:count.nullable(),promptTokens:count.nullable(),
  completionTokens:count.nullable(),cachedPromptTokens:count.nullable(),tokenCoverageComplete:z.boolean(),costUSD:z.null(),
}).strict().refine(v=>!v.tokenCoverageComplete || (v.reportedInvocations===v.requestAttempts && v.promptTokens!==null && v.completionTokens!==null));
export type BrowserModelUsage=z.infer<typeof browserModelUsageSchema>;
/** Missing, malformed or duplicate final summaries are unknown, never zero.
 * This describes the browser agent only, not later compiler inference. */
export function browserModelUsage(events:unknown[]):BrowserModelUsage|undefined{
  const candidates=events.filter(e=>e && typeof e==='object' && (e as {kind?:unknown}).kind==='browser-use-usage');
  if(candidates.length!==1)return undefined;
  const {kind,...value}=candidates[0] as Record<string,unknown>;
  const parsed=browserModelUsageSchema.safeParse(value);
  return parsed.success?parsed.data:undefined;
}
