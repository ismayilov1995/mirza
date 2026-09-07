import fs from "node:fs";
import path from "node:path";

/**
 * The repo root.
 *
 * Resolved from this file rather than from process.cwd() because an MCP client
 * starts the stdio server from wherever it happens to live, and a cwd-relative
 * .env.local would then silently not be found.
 *
 * The dashboard imports this module too (the /settings/mcp screen edits the
 * same priorities file), and there __dirname is whatever the bundler decided —
 * .next/server, not <repo>/mcp. So __dirname is trusted only when the repo is
 * actually next to it; otherwise cwd wins, which for katibe-dashboard.service
 * is the repo root (WorkingDirectory=). KATIBE_ROOT overrides both.
 */
function resolveRoot(): string {
  const override = process.env.KATIBE_ROOT?.trim();
  if (override) return override;
  const dir = typeof __dirname === "string" ? __dirname : "";
  if (dir && fs.existsSync(path.join(dir, "..", "package.json"))) return path.resolve(dir, "..");
  return process.cwd();
}

export const ROOT = resolveRoot();

/**
 * The MCP server runs outside the Next.js runtime (tsx/node), so Next's
 * automatic .env.local loading does not apply. Load it by hand, and always
 * BEFORE importing anything that opens a connection pool at module scope
 * (src/lib/db.ts does exactly that) — hence the dynamic imports in stdio.ts
 * and http.ts.
 *
 * Same parser as scripts/transcribe-voice.ts on purpose: one file, one format.
 */
export function loadEnvLocal(): void {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
