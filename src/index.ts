#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOctsshServer } from "./mcp/server.js";
import { runInitCli } from "./init/initCli.js";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "init") {
    await runInitCli();
    return;
  }

  const server = createOctsshServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // MCP hosts typically surface stderr; keep it readable.
  process.stderr.write(`OctSSH failed to start: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
