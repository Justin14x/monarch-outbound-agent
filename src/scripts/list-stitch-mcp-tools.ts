import { listAvailableStitchMcpTools } from "../lib/stitch/server.js";

try {
  const tools = await listAvailableStitchMcpTools();
  for (const tool of tools) console.log(tool.name);
} catch (error) {
  console.error(
    `STITCH MCP DISCOVERY FAILED\n\n${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
}
