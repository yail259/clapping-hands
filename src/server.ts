#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AuthRequiredError, ProfileInUseError } from "./profile.js";
import { MarketplaceSearchService } from "./search.js";

// STDIO MCP reserves stdout for protocol frames. Route incidental dependency
// logging to stderr so browser startup cannot corrupt the transport.
console.log = (...values: unknown[]) => console.error(...values);

const searchService = new MarketplaceSearchService();
const server = new McpServer(
  { name: "clapping-hands", version: "0.0.1" },
  {
    instructions:
      "Clapping Hands compiles user-authorized browser workflows into typed tools. " +
      "Marketplace tools are read-only. Never message sellers, save listings, make offers, " +
      "or bypass login, CAPTCHA, access controls, or rate limits. Cached plans must retrieve fresh data.",
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
    await searchService.close().catch(() => {});
    process.exit(0);
  })();
  return shutdownPromise;
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());

await server.connect(new StdioServerTransport());
