#!/usr/bin/env node
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AuthRequiredError, ProfileInUseError } from "./profile.js";
import { MarketplaceSearchService } from "./search.js";
import type { FormControl } from "./form-workflow.js";
import { WorkflowRuntime } from "./workflow-runtime.js";
import type { StoredWorkflow } from "./workflow-store.js";

// STDIO MCP reserves stdout for protocol frames. Route incidental dependency
// logging to stderr so browser startup cannot corrupt the transport.
console.log = (...values: unknown[]) => console.error(...values);

const searchService = new MarketplaceSearchService();
const workflowRuntime = new WorkflowRuntime();
const server = new McpServer(
  { name: "clapping-hands", version: "0.0.1" },
  {
    instructions:
      "Clapping Hands compiles user-authorized browser workflows into typed tools. " +
      "Never bypass login, CAPTCHA, access controls, site policy, or rate limits. " +
      "Cached plans must retrieve fresh data. Read workflows may fall back to the browser; " +
      "write workflows must be prepared and then explicitly committed from a one-time receipt.",
  },
);

const scalarInput = z.union([z.string(), z.number(), z.boolean()]);
const formValueInput = z.union([z.string(), z.array(z.string())]);
const formAnswersInput = z.record(z.string(), z.record(z.string(), formValueInput));
const compiledTools = new Map<string, RegisteredTool>();

function compiledToolName(action: string): string {
  return `clapping_hands_do_${action}`;
}

function formControlSchema(control: FormControl): z.ZodType {
  let schema: z.ZodType;
  if (control.kind === "checkbox" || control.multiple) {
    schema = z.union([z.string(), z.array(z.string())]);
  } else {
    schema = z.string();
  }
  return control.required && control.kind !== "hidden" ? schema : schema.optional();
}

function compiledInputSchema(workflow: StoredWorkflow): z.ZodType<Record<string, unknown>> {
  if (workflow.baseline.engine === "stagehand-action-v1") {
    return z.object(Object.fromEntries(workflow.baseline.inputNames.map((name) => [name, scalarInput]))).strict();
  }
  const steps = Object.fromEntries(workflow.baseline.steps.map((step) => [
    step.questionKey,
    z.object(Object.fromEntries(step.controls
      .filter((control) => control.kind !== "hidden")
      .map((control) => [control.name, formControlSchema(control)]))).strict(),
  ]));
  return z.object(steps).strict();
}

function safeWorkflowSummary(workflow: StoredWorkflow) {
  return {
    action: workflow.action,
    tool: compiledToolName(workflow.action),
    version: workflow.version,
    origin: workflow.origin,
    baselineEngine: workflow.baseline.engine,
    effect: workflow.baseline.engine === "stagehand-action-v1" ? workflow.baseline.effect.level : workflow.baseline.effect,
    baselineStatus: workflow.baseline.status,
    acceleratorStatus: workflow.accelerator?.status ?? "none",
    updatedAt: workflow.updatedAt,
  };
}

function registerCompiledTool(workflow: StoredWorkflow): void {
  const name = compiledToolName(workflow.action);
  compiledTools.get(name)?.remove();
  const write = workflow.baseline.engine === "stagehand-action-v1" && workflow.baseline.effect.level === "write";
  const registered = server.registerTool(
    name,
    {
      title: workflow.action.replaceAll("_", " "),
      description: write
        ? `Prepare ${workflow.action}. This does not execute the final external effect; it returns a receipt for clapping_hands_commit.`
        : `Run the compiled ${workflow.action} workflow using its validated accelerator or deterministic browser fallback.`,
      inputSchema: compiledInputSchema(workflow),
      annotations: {
        readOnlyHint: !write,
        destructiveHint: false,
        idempotentHint: !write,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const execution = await workflowRuntime.run(workflow.action, input as never);
        return {
          content: [{ type: "text", text: JSON.stringify(execution, null, 2) }],
          structuredContent: execution,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
  compiledTools.set(name, registered);
}

server.registerTool(
  "clapping_hands_compile_dom",
  {
    title: "Compile a browser workflow",
    description:
      "Learn the same user-authorized UI workflow from two varied demonstrations, redact inputs, and create a typed deterministic tool. " +
      "A read workflow may also learn a same-origin JSON request accelerator when its response is evidenced in the rendered output.",
    inputSchema: {
      action: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
      startUrl: z.string().url(),
      outputSelector: z.string().min(1).max(500),
      demonstrations: z.array(z.object({
        input: z.record(z.string(), scalarInput),
        instructions: z.array(z.string().min(1).max(1_000)).min(1).max(20),
      })).min(2).max(5),
      effect: z.enum(["read", "write"]).default("read"),
      confirmation: z.string().min(1).max(240).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      const workflow = await workflowRuntime.compileDom(input);
      registerCompiledTool(workflow);
      server.sendToolListChanged();
      const summary = safeWorkflowSummary(workflow);
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], structuredContent: summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

server.registerTool(
  "clapping_hands_compile_form",
  {
    title: "Compile a form workflow",
    description:
      "Compile two user-authorized demonstrations of a same-origin HTML form journey into direct validated requests, with deterministic browser fallback for same-document apps.",
    inputSchema: {
      action: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
      startUrl: z.string().url(),
      demonstrations: z.array(formAnswersInput).min(2).max(5),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      const workflow = await workflowRuntime.compileForm(input);
      registerCompiledTool(workflow);
      server.sendToolListChanged();
      const summary = safeWorkflowSummary(workflow);
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], structuredContent: summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

server.registerTool(
  "clapping_hands_list",
  {
    title: "List compiled workflows",
    description: "List compiled workflow health and generated tool names without exposing inputs, cookies, or request templates.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const workflows = (await workflowRuntime.list()).map(safeWorkflowSummary);
      return { content: [{ type: "text", text: JSON.stringify(workflows, null, 2) }], structuredContent: { workflows } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

server.registerTool(
  "clapping_hands_run",
  {
    title: "Run a compiled workflow",
    description: "Run a compiled workflow by action name. Prefer its generated clapping_hands_do_* tool when available because that tool has a specific input schema.",
    inputSchema: { action: z.string(), input: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ action, input }) => {
    try {
      const execution = await workflowRuntime.run(action, input as never);
      return { content: [{ type: "text", text: JSON.stringify(execution, null, 2) }], structuredContent: execution };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

server.registerTool(
  "clapping_hands_commit",
  {
    title: "Commit a prepared site action",
    description: "Execute the final external effect for an unexpired one-time receipt. A committed or uncertain receipt is never retried.",
    inputSchema: {
      action: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
      receiptId: z.string().uuid(),
      input: z.record(z.string(), scalarInput),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ action, receiptId, input }) => {
    try {
      const execution = await workflowRuntime.commit(action, receiptId, input);
      return { content: [{ type: "text", text: JSON.stringify(execution, null, 2) }], structuredContent: execution };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

server.registerTool(
  "clapping_hands_auth_open",
  {
    title: "Open a workflow login page",
    description: "Open a dedicated persistent Chrome profile for a manual login, MFA, passkey, consent, or checkpoint handoff. Credentials are never accepted by this tool.",
    inputSchema: { url: z.string().url() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ url }) => {
    try {
      const status = await workflowRuntime.openAuthentication(url);
      return {
        content: [{ type: "text", text: `Opened ${status.origin} in its persistent profile; ${status.firstPartyCookieCount} first-party cookies are present (not proof of authentication).` }],
        structuredContent: { auth: status },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

server.registerTool(
  "facebook_marketplace_compilation_status",
  {
    title: "Check Marketplace compilation status",
    description:
      "Report safe promotion evidence and health for the Marketplace search plan without exposing request bodies or authentication material.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const compilation = await searchService.compilationStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(compilation, null, 2) }],
        structuredContent: { compilation },
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

server.registerTool(
  "facebook_marketplace_auth_status",
  {
    title: "Check Facebook Marketplace authentication",
    description:
      "Check the dedicated Clapping Hands browser profile without returning cookies, account identifiers, or credentials.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      const auth = await searchService.authStatus();
      return {
        content: [{ type: "text", text: auth.safeSummary }],
        structuredContent: { auth },
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

server.registerTool(
  "facebook_marketplace_auth_open",
  {
    title: "Open Facebook Marketplace authentication",
    description:
      "Open the dedicated headed Chrome profile for a manual Facebook login, checkpoint, passkey, or MFA handoff. " +
      "Clapping Hands never accepts the password or attempts to solve a challenge.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      const auth = await searchService.openAuthentication();
      return {
        content: [{ type: "text", text: auth.safeSummary }],
        structuredContent: { auth },
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

server.registerTool(
  "facebook_marketplace_search",
  {
    title: "Search Facebook Marketplace",
    description:
      "Search the user's authenticated local Facebook Marketplace session. A stable plan uses fresh browser-authenticated network pagination; " +
      "otherwise the tool records a DOM demonstration and safely falls back. The response reports auth, completeness, execution level, and validation evidence.",
    inputSchema: {
      query: z.string().min(1).max(200).describe("Marketplace search query"),
      locationSlug: z.string().regex(/^[a-z0-9-]+$/).default("sydney").describe("Facebook Marketplace location slug"),
      radiusKm: z.number().int().min(1).max(500).default(65),
      maxScrolls: z.number().int().min(1).max(100).default(40)
        .describe("DOM scroll limit or compiled-network page budget"),
      executionMode: z
        .enum(["auto", "dom", "network"])
        .default("auto")
        .describe("auto uses a stable compiled network plan, dom demonstrates the UI path, and network requires a plan"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => {
    try {
      const result = await searchService.search(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      };
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        const result = {
          error: {
            code: error.code,
            message: error.message,
            recoverable: true,
          },
          auth: error.auth,
        };
        return {
          content: [{ type: "text", text: `${error.message} Use facebook_marketplace_auth_open, complete the handoff, then retry.` }],
          structuredContent: result,
          isError: true,
        };
      }
      if (error instanceof ProfileInUseError) {
        return {
          content: [{ type: "text", text: error.message }],
          structuredContent: {
            error: { code: error.code, message: error.message, recoverable: true },
          },
          isError: true,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Marketplace search failed: ${message}` }],
        isError: true,
      };
    }
  },
);

let shutdownPromise: Promise<void> | null = null;
const shutdown = (): Promise<void> => {
  shutdownPromise ??= (async () => {
    await Promise.all([
      searchService.close().catch(() => {}),
      workflowRuntime.close().catch(() => {}),
    ]);
    process.exit(0);
  })();
  return shutdownPromise;
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());

for (const workflow of await workflowRuntime.list()) registerCompiledTool(workflow);
await server.connect(new StdioServerTransport());
