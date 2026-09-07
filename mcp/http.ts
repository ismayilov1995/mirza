/**
 * Ismayil MCP over HTTPS — for Claude clients that are not on this box
 * (claude.ai connector, phone, a scheduled task running elsewhere).
 *
 *   npm run mcp:http        # binds 127.0.0.1 only; nginx terminates TLS
 *
 * Two locks, and the second one is the real one:
 *  - nginx serves it at https://katibe.online/mcp
 *  - every request must carry the shared token, as `Authorization: Bearer …`,
 *    as `x-api-key`, or as the first path segment (/<token>/…) for clients
 *    whose connector UI cannot set a header. The token lives in .env.local as
 *    KATIBE_MCP_TOKEN; with no token set the server refuses to start rather
 *    than listening without auth.
 *
 * Stateless on purpose: a fresh server + transport per request. The tools hold
 * no per-session state, and a session map would only be something to leak
 * between clients.
 */
import http from "node:http";
import crypto from "node:crypto";
import { loadEnvLocal } from "./env";

const MAX_BODY_BYTES = 1_000_000;

/**
 * In-memory usage counters, served at GET /stats (token required).
 *
 * The dashboard's /settings/mcp screen shows them so "is anything actually
 * using this?" has an answer that is not journalctl. Deliberately not
 * persisted: they describe this process, and a restart is exactly the event
 * that makes older numbers misleading.
 */
const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  unauthorized: 0,
  lastRequestAt: null as string | null,
  /** Tool name → how many times it was called since start. */
  tools: {} as Record<string, number>,
  lastTool: null as { name: string; at: string } | null,
};

/** Records what a JSON-RPC body asked for. Never reads the arguments. */
function countCall(body: unknown): void {
  const method = (body as { method?: unknown } | undefined)?.method;
  if (method !== "tools/call") return;
  const name = (body as { params?: { name?: unknown } }).params?.name;
  if (typeof name !== "string") return;
  stats.tools[name] = (stats.tools[name] ?? 0) + 1;
  stats.lastTool = { name, at: new Date().toISOString() };
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself the answer.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function deny(res: http.ServerResponse, code: number, message: string) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
}

async function main() {
  loadEnvLocal();
  const token = process.env.KATIBE_MCP_TOKEN?.trim();
  if (!token || token.length < 24) {
    console.error("[ismayil-mcp] KATIBE_MCP_TOKEN is missing or too short (min 24 chars). Refusing to start.");
    process.exit(1);
  }
  const port = Number(process.env.KATIBE_MCP_PORT ?? 3010);

  const { pool } = await import("../src/lib/db");
  const { createServer } = await import("./server");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // nginx strips the /mcp prefix, which turns a request for "/mcp/" into "//".
    // new URL("//", base) is a protocol-relative URL with no host and THROWS —
    // and thrown from an async listener it took the whole process down. Collapse
    // the leading slashes before parsing, and treat a bad path as 404, not death.
    const rawPath = (req.url ?? "/").replace(/^\/+/, "/");
    let url: URL;
    try {
      url = new URL(rawPath, "http://localhost");
    } catch {
      deny(res, 404, "Not found");
      return;
    }
    // Liveness for systemd/nginx — deliberately says nothing about the account.
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }

    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const firstSegment = url.pathname.split("/").filter(Boolean)[0];
    const authorized =
      tokenMatches(bearer, token) ||
      tokenMatches(req.headers["x-api-key"] as string | undefined, token) ||
      tokenMatches(firstSegment, token);
    if (!authorized) {
      stats.unauthorized++;
      deny(res, 401, "Unauthorized");
      return;
    }

    // Same token as the tools, so the counters are as private as the chats
    // they describe. Placed after the auth check on purpose.
    if (url.pathname.endsWith("/stats") && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }

    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      stats.requests++;
      stats.lastRequestAt = new Date().toISOString();
      countCall(body);
      const server = await createServer(pool);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("[ismayil-mcp] request failed:", e);
      if (!res.headersSent) deny(res, 500, "Internal error");
      else res.end();
    }
  };

  // The listener is deliberately not `async`: an async listener that rejects is
  // an unhandled rejection, and node exits on those. One malformed request must
  // never be able to stop the server.
  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("[ismayil-mcp] handler crashed:", e);
      if (!res.headersSent) deny(res, 500, "Internal error");
      else res.end();
    });
  });

  httpServer.listen(port, "127.0.0.1", () => {
    console.error(`[ismayil-mcp] listening on 127.0.0.1:${port}`);
  });

  const shutdown = () => {
    httpServer.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[ismayil-mcp] start failed:", e);
  process.exit(1);
});
