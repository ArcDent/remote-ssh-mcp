// Local debug client: starts dist/index.js over stdio and lists or calls tools.
//   npm run call -- --list [--json]
//   npm run call -- <tool> '<json args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const [tool, json] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "call", version: "0.0.0" });
await client.connect(transport);

if (!tool || tool === "--list") {
  const { tools } = await client.listTools();
  if (process.argv.includes("--json")) console.log(JSON.stringify(tools, null, 2));
  else for (const t of tools) console.log(t.name);
  console.error(`[${tools.length} tools, definitions ${JSON.stringify(tools).length} chars]`);
} else {
  const t0 = performance.now();
  const res = await client.callTool({ name: tool, arguments: json ? JSON.parse(json) : {} });
  const ms = Math.round(performance.now() - t0);
  for (const c of res.content) console.log(c.type === "text" ? c.text : JSON.stringify(c));
  console.error(`[${res.isError ? "isError, " : ""}${ms}ms]`);
  process.exitCode = res.isError ? 1 : 0;
}
await client.close();
