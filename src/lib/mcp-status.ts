/*
 * "Is the MCP up, and is anything using it?" — answered by asking the running
 * server, not by guessing.
 *
 * The tool list comes from a real JSON-RPC `tools/list` against
 * 127.0.0.1:KATIBE_MCP_PORT with the same token a Claude client uses. That is
 * one round trip and it proves the whole path at once: the process is
 * listening, the token in .env.local is the token it expects, and the tools
 * are registered. A second, hand-maintained copy of the tool list on this page
 * would only be a copy that goes stale.
 *
 * The transport answers with SSE (text/event-stream) by default, so the reply
 * is parsed out of `data:` lines rather than JSON.parse'd whole.
 */

export interface McpTool {
  name: string;
  title: string | null;
  description: string | null;
}

export interface McpUsage {
  startedAt: string;
  requests: number;
  unauthorized: number;
  lastRequestAt: string | null;
  tools: Record<string, number>;
  lastTool: { name: string; at: string } | null;
}

export interface McpStatus {
  /** Where a client outside this box connects. */
  publicUrl: string;
  port: number;
  tokenConfigured: boolean;
  /** The server answered a real MCP request. */
  ok: boolean;
  /** Why not, in Azerbaijani, when ok is false. */
  error: string | null;
  tools: McpTool[];
  usage: McpUsage | null;
}

const TIMEOUT_MS = 4000;

function base(): { url: string; port: number } {
  const port = Number(process.env.KATIBE_MCP_PORT ?? 3010);
  return { url: `http://127.0.0.1:${port}`, port };
}

/** The transport streams its reply; the JSON lives on the `data:` lines. */
function parseSse(body: string): unknown[] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim()) as unknown;
      } catch {
        return null;
      }
    })
    .filter((v) => v !== null);
}

function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort|timeout/i.test(msg)) return `Server ${TIMEOUT_MS} ms içində cavab vermədi.`;
  if (/ECONNREFUSED|fetch failed/i.test(msg))
    return "Qoşulmaq olmadı — katibe-mcp servisi işləmir (systemctl status katibe-mcp).";
  return msg;
}

export async function getMcpStatus(): Promise<McpStatus> {
  const { url, port } = base();
  const publicUrl = process.env.KATIBE_MCP_PUBLIC_URL ?? "https://katibe.online/mcp";
  const token = process.env.KATIBE_MCP_TOKEN?.trim();
  const out: McpStatus = {
    publicUrl,
    port,
    tokenConfigured: !!token,
    ok: false,
    error: null,
    tools: [],
    usage: null,
  };
  if (!token) {
    out.error = "KATIBE_MCP_TOKEN .env.local-da yoxdur — server bu açar olmadan başlamır.";
    return out;
  }
  const auth = { authorization: `Bearer ${token}` };

  try {
    const res = await fetch(`${url}/`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    const raw = await res.text();
    if (res.status === 401) {
      out.error = "401 — .env.local-dakı token serverin gözlədiyi token deyil. Servisi yenidən başlat.";
      return out;
    }
    if (!res.ok) {
      out.error = `Server ${res.status} qaytardı.`;
      return out;
    }
    const messages = res.headers.get("content-type")?.includes("event-stream")
      ? parseSse(raw)
      : [JSON.parse(raw) as unknown];
    const listed = messages
      .map((m) => (m as { result?: { tools?: McpTool[] } }).result?.tools)
      .find((t): t is McpTool[] => Array.isArray(t));
    if (!listed) {
      out.error = "Cavab gəldi, amma alət siyahısı yox idi.";
      return out;
    }
    out.ok = true;
    out.tools = listed.map((t) => ({
      name: t.name,
      title: t.title ?? null,
      description: t.description ?? null,
    }));
  } catch (e) {
    out.error = reason(e);
    return out;
  }

  // Counters are a nice-to-have: an older server without /stats must not make
  // the panel look broken.
  try {
    const res = await fetch(`${url}/stats`, {
      headers: auth,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.ok) out.usage = (await res.json()) as McpUsage;
  } catch {
    /* ignore — ok stays true */
  }
  return out;
}
