import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env";

/**
 * Whose WhatsApp this MCP server speaks for.
 *
 * A katibe user name (katibe.users.name), not an instance name: people keep
 * their name when their number or Evolution instance is replaced, and
 * katibe.user_instances already records which instance is theirs *now*
 * (ended_at IS NULL). KATIBE_MCP_USER overrides it, KATIBE_MCP_INSTANCE_ID
 * bypasses the lookup entirely.
 */
export const MCP_USER = process.env.KATIBE_MCP_USER ?? "Ismayl";

export interface Owner {
  userId: number | null;
  userName: string;
  instanceId: string;
  instanceName: string;
  /** Our own WhatsApp address — used to spot mentions of us inside groups. */
  ownerJid: string | null;
  /** The bare number of ownerJid, which is how mentions usually spell it. */
  ownerNumber: string | null;
  /**
   * Every local part WhatsApp may use to address us: the bare number AND the
   * @lid aliases it hides that number behind. A group mention of this account
   * is written as the @lid (38315470376995@lid here), never as the number, so
   * matching on the number alone finds no mentions at all.
   */
  ownerKeys: string[];
}

/**
 * Resolves the one instance this server is allowed to read.
 *
 * Everything else in this server takes instanceId from here and nothing takes
 * it from the caller: a tool argument would turn "Ismayil's MCP" into
 * "everyone's MCP" the first time a model guessed a different id.
 */
let ownerCache: Promise<Owner> | null = null;

/**
 * Cached because the HTTP transport builds a fresh server per request (see
 * mcp/http.ts) and this lookup would otherwise run on every tool call. The
 * mapping changes only when someone is reassigned in the admin panel, which
 * is a restart-worthy event.
 */
export function resolveOwner(pool: import("pg").Pool): Promise<Owner> {
  ownerCache ??= resolveOwnerUncached(pool);
  return ownerCache;
}

async function resolveOwnerUncached(pool: import("pg").Pool): Promise<Owner> {
  const forced = process.env.KATIBE_MCP_INSTANCE_ID;
  const { rows } = await pool.query(
    forced
      ? `SELECT u.id AS user_id, u.name AS user_name, i.id AS instance_id, i.name AS instance_name, i."ownerJid"
           FROM evolution_api."Instance" i
           LEFT JOIN katibe.user_instances ui ON ui.instance_id = i.id AND ui.ended_at IS NULL
           LEFT JOIN katibe.users u ON u.id = ui.user_id
          WHERE i.id = $1`
      : `SELECT u.id AS user_id, u.name AS user_name, i.id AS instance_id, i.name AS instance_name, i."ownerJid"
           FROM katibe.users u
           JOIN katibe.user_instances ui ON ui.user_id = u.id AND ui.ended_at IS NULL
           JOIN evolution_api."Instance" i ON i.id = ui.instance_id
          WHERE lower(u.name) = lower($1)`,
    [forced ?? MCP_USER],
  );
  const r = rows[0];
  if (!r) {
    throw new Error(
      `MCP owner not found for ${forced ? `instance ${forced}` : `user "${MCP_USER}"`}. ` +
        `Set KATIBE_MCP_USER or KATIBE_MCP_INSTANCE_ID in .env.local.`,
    );
  }
  const ownerJid: string | null = r.ownerJid ?? null;
  const ownerNumber = ownerJid ? ownerJid.split("@")[0] : null;
  // katibe.lid_number is filled by scripts/harvest-lid-numbers.ts; without this
  // lookup groupsMentionOnly would silently match nothing.
  const lids = ownerNumber
    ? await pool.query(`SELECT lid_jid FROM katibe.lid_number WHERE phone_number = $1`, [ownerNumber])
    : { rows: [] as { lid_jid: string }[] };
  return {
    userId: r.user_id ?? null,
    userName: r.user_name ?? "(təyin edilməyib)",
    instanceId: r.instance_id,
    instanceName: r.instance_name,
    ownerJid,
    ownerNumber,
    ownerKeys: [ownerNumber, ...lids.rows.map((l) => l.lid_jid.split("@")[0])].filter(
      (v): v is string => !!v,
    ),
  };
}

/** One entry in a priority tier. Either field may be empty, but not both. */
export interface PriorityEntry {
  /** The stable address. Preferred: names change, JIDs do not. */
  jid?: string;
  /** Fallback match: case-insensitive substring of the resolved chat name. */
  name?: string;
  /** Free text for humans — why this is here. Never matched against. */
  note?: string;
}

export interface Priorities {
  /** How far back the brief looks, in hours. */
  lookbackHours: number;
  /** Monday reaches back over the weekend when this is set. */
  mondayLookbackHours: number | null;
  /** In group chats, only surface messages that mention or quote us. */
  groupsMentionOnly: boolean;
  /** Show chats in no tier at all when they are waiting on a reply. */
  includeUntiered: boolean;
  /** Spellings of the owner's name that count as being addressed in a group. */
  mentionAliases: string[];
  /** Always checked, shown first. */
  tier1: PriorityEntry[];
  /** Shown only when they are waiting on a reply. */
  tier2: PriorityEntry[];
  /** Never shown, whoever writes and whatever it says. */
  mute: PriorityEntry[];
  /** Any message containing one of these is surfaced, whoever sent it. */
  alwaysKeywords: string[];
  /** Messages containing one of these are treated as noise. */
  neverKeywords: string[];
  /** Carried here so the brief has one config, even though Gmail is a different MCP. */
  email: { alwaysFrom: string[]; neverFrom: string[] };
}

export const PRIORITIES_PATH =
  process.env.KATIBE_MCP_PRIORITIES ?? path.join(ROOT, "mcp", "priorities.json");

const EMPTY: Priorities = {
  lookbackHours: 48,
  mondayLookbackHours: 72,
  groupsMentionOnly: false,
  includeUntiered: true,
  mentionAliases: [],
  tier1: [],
  tier2: [],
  mute: [],
  alwaysKeywords: [],
  neverKeywords: [],
  email: { alwaysFrom: [], neverFrom: [] },
};

/**
 * Reads the priority file, filling in anything it does not define.
 *
 * A missing or half-written file must never break a tool call: an unfilled
 * config is the normal state on day one, and the brief still works from it
 * (everything lands in "untiered", which is why includeUntiered defaults on).
 */
export function loadPriorities(): Priorities {
  // The turbopackIgnore comments are for the dashboard build only (the
  // /settings/mcp screen imports this file). Without them Next sees a
  // computed path and traces the WHOLE repo into the server output. The path
  // is resolved at runtime by design — see ROOT in env.ts.
  if (!fs.existsSync(/*turbopackIgnore: true*/ PRIORITIES_PATH)) return { ...EMPTY };
  try {
    const raw = JSON.parse(
      fs.readFileSync(/*turbopackIgnore: true*/ PRIORITIES_PATH, "utf8"),
    ) as Partial<Priorities>;
    return {
      ...EMPTY,
      ...raw,
      email: { ...EMPTY.email, ...(raw.email ?? {}) },
    };
  } catch (e) {
    throw new Error(
      `${PRIORITIES_PATH} is not valid JSON (${(e as Error).message}). Fix it, or delete it to start over.`,
    );
  }
}

/**
 * Written through a temp file + rename so a reader never sees half a file.
 * Two writers exist now — the MCP's own update_priorities tool and the
 * dashboard's /settings/mcp screen — and every tool call re-reads this file,
 * so a torn write would surface as "not valid JSON" on the next brief.
 */
export function savePriorities(p: Priorities): void {
  const tmp = `${PRIORITIES_PATH}.${process.pid}.tmp`;
  // 0640 is set explicitly rather than inherited: rename() brings the temp
  // file's mode with it, so the umask of whichever process saved last would
  // otherwise decide who can read the chat list. Group-readable, not world.
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n", { encoding: "utf8", mode: 0o640 });
  fs.chmodSync(tmp, 0o640);
  fs.renameSync(tmp, PRIORITIES_PATH);
}

export type Tier = "tier1" | "tier2" | "mute" | "untiered";

/**
 * Which tier a chat falls in.
 *
 * An entry with a JID matches THAT chat and nothing else, even when it also
 * carries a name — the name there is a human label, not a second matcher.
 * Otherwise "Farid" in the note field would quietly also claim "Farid City Walk
 * Storage". Name matching is the fallback for entries written before the JID
 * was known, and stays a case-insensitive substring so a half-remembered name
 * still works.
 *
 * The same person often has several JIDs (a second phone, an @lid copy); each
 * one gets its own line rather than being caught by a shared name.
 *
 * mute wins over everything: the point of mute is that nothing drags the chat
 * back into the brief.
 */
export function tierOf(priorities: Priorities, jid: string, name: string | null): Tier {
  const hit = (entries: PriorityEntry[]) =>
    entries.some((e) =>
      e.jid?.trim()
        ? e.jid.trim() === jid
        : !!e.name && !!name && name.toLowerCase().includes(e.name.trim().toLowerCase()),
    );
  if (hit(priorities.mute)) return "mute";
  if (hit(priorities.tier1)) return "tier1";
  if (hit(priorities.tier2)) return "tier2";
  return "untiered";
}
