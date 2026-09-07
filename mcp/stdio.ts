/**
 * Ismayil MCP over stdio — for a Claude Code session running on this server.
 *
 *   npm run mcp:stdio
 *
 * Nothing may be printed to stdout here: stdout IS the protocol channel, and a
 * stray console.log corrupts the JSON-RPC stream. Diagnostics go to stderr.
 */
import { loadEnvLocal } from "./env";

async function main() {
  loadEnvLocal();
  // Imported after the env is loaded — src/lib/db.ts opens its pool at module scope.
  const { pool } = await import("../src/lib/db");
  const { createServer } = await import("./server");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const server = await createServer(pool);
  await server.connect(new StdioServerTransport());

  const shutdown = async () => {
    await server.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[ismayil-mcp] start failed:", e);
  process.exit(1);
});
