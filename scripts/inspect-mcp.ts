import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/src/server.js")],
  cwd: process.cwd(),
  stderr: "inherit",
});

const client = new Client({ name: "clapping-hands-inspector", version: "0.0.1" });
await client.connect(transport);
const tools = await client.listTools();
process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
await client.close();

