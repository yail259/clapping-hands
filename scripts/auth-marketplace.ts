import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AuthStatus } from "../src/profile.js";

const projectRoot = resolve(import.meta.dirname, "..");
const profileDir = resolve(projectRoot, ".data/browser-profile");

async function connect(): Promise<Client> {
  const client = new Client({ name: "clapping-hands-auth", version: "0.0.1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(projectRoot, "dist/src/server.js")],
    cwd: projectRoot,
    env: {
      ...process.env,
      CLAPPING_HANDS_PROFILE_DIR: profileDir,
      CLAPPING_HANDS_HEADLESS: "false",
    },
    stderr: "inherit",
  }));
  return client;
}

async function auth(client: Client, tool: "facebook_marketplace_auth_open" | "facebook_marketplace_auth_status") {
  const response = await client.callTool({ name: tool, arguments: {} });
  if (response.isError) throw new Error(JSON.stringify(response.content));
  return (response.structuredContent as { auth: AuthStatus }).auth;
}

function waitForEnter(): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolveWait) => {
    readline.question(
      "Complete Facebook login or its checkpoint in the Clapping Hands Chrome window, then press Enter here.\n",
      () => {
        readline.close();
        resolveWait();
      },
    );
  });
}

let first: Client | null = null;
let restarted: Client | null = null;
try {
  first = await connect();
  let status = await auth(first, "facebook_marketplace_auth_open");
  process.stderr.write(`AUTH_STATE=${status.state} AUTH_PERSISTENCE=${status.persistence}\n`);
  while (status.state !== "authenticated") {
    await waitForEnter();
    status = await auth(first, "facebook_marketplace_auth_status");
    process.stderr.write(`AUTH_STATE=${status.state} AUTH_PERSISTENCE=${status.persistence}\n`);
  }

  await first.close();
  first = null;
  await delay(1_000);

  restarted = await connect();
  const afterRestart = await auth(restarted, "facebook_marketplace_auth_status");
  process.stdout.write(`RESTART_AUTH_STATE=${afterRestart.state}\n`);
  process.stdout.write(`RESTART_AUTH_PERSISTENCE=${afterRestart.persistence}\n`);
  process.stdout.write(`RESTART_AUTH_VERIFIED=${afterRestart.state === "authenticated"}\n`);
  if (afterRestart.state !== "authenticated") process.exitCode = 3;
} finally {
  await first?.close().catch(() => {});
  await restarted?.close().catch(() => {});
}
