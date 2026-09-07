/**
 * Pulls the current group subjects from the Evolution API and caches them in
 * katibe.group_subject, so the dashboard shows a group's real WhatsApp name.
 *
 * Why this exists: Evolution's own Chat.name is incomplete — it had 268 group
 * rows while the API reported 395 groups, and several groups the dashboard
 * listed as "unnamed" turned out to have perfectly good names.
 *
 * Safety: hits only GET /group/fetchAllGroups, which calls Baileys'
 * groupFetchAllParticipating() — a metadata read. It sends no messages and
 * marks nothing as read.
 *
 * Syncs every connected instance by default, since group subjects are stored
 * globally by JID — one employee's account may be the only one that can see a
 * given group's name. Pass an instance name to limit it to one.
 *
 * Run manually:  npm run sync:groups
 *                npm run sync:groups -- Rouz-2
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
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
loadEnvLocal();

interface LiveGroup {
  id?: string;
  subject?: string;
  size?: number;
}

/** Instance names to sync: the CLI argument, else every connected instance. */
async function resolveInstances(base: string, apiKey: string): Promise<string[]> {
  const named = process.argv[2]?.trim();
  if (named) return [named];

  const res = await fetch(`${base}/instance/fetchInstances`, {
    headers: { apikey: apiKey },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`fetchInstances ${res.status}: ${await res.text().catch(() => "")}`);
  const body: unknown = await res.json();
  const list = Array.isArray(body) ? body : [body];
  return list
    .map((entry) => {
      const i = (entry as { instance?: Record<string, unknown> }).instance ?? (entry as Record<string, unknown>);
      return { name: String(i.name ?? i.instanceName ?? ""), state: String(i.connectionStatus ?? "") };
    })
    // An unpaired instance has no groups to report and only wastes a call.
    .filter((i) => i.name && i.state === "open")
    .map((i) => i.name);
}

async function main() {
  const base = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  if (!base || !apiKey) {
    throw new Error("EVOLUTION_API_URL / EVOLUTION_API_KEY missing in .env.local");
  }

  const instances = await resolveInstances(base, apiKey);
  if (instances.length === 0) {
    console.log("Qoşulu instance tapılmadı.");
    return;
  }
  console.log(`${instances.length} instance sinxronlaşdırılacaq: ${instances.join(", ")}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  let stored = 0;
  let skipped = 0;

  for (const instance of instances) {
    const url = `${base}/group/fetchAllGroups/${instance}?getParticipants=false`;
    // Fetching every group's metadata is slow on a busy account.
    const res = await fetch(url, { headers: { apikey: apiKey }, signal: AbortSignal.timeout(180_000) });
    if (!res.ok) {
      // One bad instance shouldn't abandon the others.
      console.error(`  ${instance}: Evolution API ${res.status}, keçilir`);
      continue;
    }

    const body: unknown = await res.json();
    const groups: LiveGroup[] = Array.isArray(body)
      ? (body as LiveGroup[])
      : ((body as { groups?: LiveGroup[] })?.groups ?? []);
    console.log(`  ${instance}: ${groups.length} qrup`);

    for (const g of groups) {
      const jid = g.id?.trim();
      const subject = g.subject?.trim();
      // A group with no subject set carries no name to cache.
      if (!jid || !subject) {
        skipped++;
        continue;
      }
      await pool.query(
        `INSERT INTO katibe.group_subject (remote_jid, subject, size)
         VALUES ($1, $2, $3)
         ON CONFLICT (remote_jid) DO UPDATE SET
           subject = EXCLUDED.subject, size = EXCLUDED.size, synced_at = now()`,
        [jid, subject, g.size ?? null],
      );
      stored++;
    }
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*) AS c FROM katibe.group_subject gs
     WHERE NOT EXISTS (SELECT 1 FROM katibe.contact_labels cl WHERE cl.remote_jid = gs.remote_jid)`,
  );
  console.log(`Bitdi: ${stored} qrup adı saxlanıldı, ${skipped} adsız qrup keçildi.`);
  console.log(`Bunlardan ${rows[0].c} qrupun əl ilə verilmiş adı yoxdur — indi əsl adı görünəcək.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
