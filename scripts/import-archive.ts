/**
 * Imports a WhatsApp archive export into Katibe's canonical store.
 *
 * The archive is a phone's own backup, extracted to SQLite: 1,559,453 messages
 * from 2017-11-13 to 2026-08-30, against Evolution's 199,000 from 2026. They
 * are not versions of each other — measured, they share 93,589 messages, and
 * each holds well over a hundred thousand the other has never seen. Neither is
 * authoritative, so both are sources and the store holds their union.
 *
 * IDEMPOTENT, which is the point rather than a nicety. Six months from now a
 * newer export must land on top of this one instead of beside it: the same
 * message arriving twice becomes one row with two source links, an interrupted
 * run resumes from where it stopped, and re-running a finished import writes
 * nothing. That is what the unique key on (remote_jid, stanza_id) buys.
 *
 * Media is never copied. The export's files are already in Spaces under
 * archive/<source>/ — 249,499 objects, 75.57 GB against 43 GB free on this
 * host — so only the object key is recorded, and the same presign resolver
 * serves them as serves Evolution's.
 *
 * Run:  npm run import:archive
 *   ARCHIVE_DB=path        SQLite export (default /var/lib/katibe/archive/business.sqlite)
 *   ARCHIVE_SOURCE=id      source id (default from the file's own meta.source)
 *   ARCHIVE_OWNER=<userId> katibe user who owns it — required the first time
 *   ARCHIVE_BATCH=2000     messages per statement (default 2000)
 *   ARCHIVE_MAX=0          ceiling per run, 0 = no ceiling (default 0)
 *   ARCHIVE_DRY_RUN=1      report what would be imported, write nothing
 */
import { DatabaseSync } from "node:sqlite";
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

const DEFAULT_DB = "/var/lib/katibe/archive/business.sqlite";

/** The export's chat kinds, in this store's vocabulary. */
const CHAT_KIND: Record<string, string> = {
  direct: "individual",
  group: "group",
  status: "broadcast",
  orphaned: "other",
};

/**
 * Status (story) axını söhbət deyil, ona görə idxal olunmur.
 *
 * İxracda hər status yayımçısı ayrıca "chat" kimi görünür — `<nömrə>@status`
 * və bir dənə `status@broadcast`. Onlar yazışma deyil: kimsə şəkil paylaşıb,
 * 24 saatdan sonra yox olub. Bu qərar onsuz da bütün panelin qərarıdır —
 * webhook `status@broadcast`-ı atır, nəzarətçi detektorları broadcast-a
 * baxmır, nəzarətçinin görmə qaydası onu həmişə gizlədir — sadəcə idxal
 * addımında unudulmuşdu və anbara 348 belə "söhbət" düşdü, onlardan 317-si
 * BİR DƏNƏ də mesajı olmayan boş qabıq idi (ixrac yayımçının adını saxlayır,
 * postlarını yox).
 *
 * Həqiqi yayım siyahısı (`<rəqəm>@broadcast`) buraya DÜŞMÜR: o, işin özüdür —
 * satıcının müştərilərə göndərdiyi mesajdır.
 */
const STATUS_KIND = "status";

/**
 * Timestamps arrive as ISO 8601 strings, not epochs — a detail worth catching
 * before the import rather than after, since every window filter in this
 * codebase compares raw epoch seconds.
 */
function toEpoch(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

interface ChatRow {
  id: number;
  jid: string;
  name: string | null;
  kind: string;
}

interface MsgRow {
  id: number;
  chat_id: number;
  ts: string;
  direction: string;
  sender_jid: string | null;
  sender_name: string | null;
  text: string | null;
  kind: string;
  stanza_id: string;
  reply_to: string | null;
}

async function main() {
  const { pool } = await import("../src/lib/db");

  const dbPath = process.env.ARCHIVE_DB ?? DEFAULT_DB;
  const batchSize = Number(process.env.ARCHIVE_BATCH ?? 2000);
  const maxRows = Number(process.env.ARCHIVE_MAX ?? 0);
  const dryRun = process.env.ARCHIVE_DRY_RUN === "1";

  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  const meta = Object.fromEntries(
    (sqlite.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[])
      .map((r) => [r.key, r.value]),
  );
  const sourceId = process.env.ARCHIVE_SOURCE ?? `archive:${meta.source ?? "unknown"}`;
  // Files sit under archive/<source>/ in Spaces and media.rel_path is relative
  // to that folder — the export says so itself in meta.media_path_rule.
  const mediaPrefix = `archive/${meta.source ?? "unknown"}/`;

  const total = Number(
    (sqlite.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n,
  );
  console.log(
    `${dbPath}\n  mənbə ${sourceId} · ${total.toLocaleString()} mesaj · ixrac ${meta.generated}`,
  );

  // The source must exist before anything points at it, and it must have an
  // owner: "archive rows are visible to their owner only" is enforced through
  // this column rather than through a rule anyone has to remember.
  const { rows: existing } = await pool.query(
    `SELECT owner_user_id FROM katibe.source WHERE id = $1`,
    [sourceId],
  );
  const ownerEnv = process.env.ARCHIVE_OWNER ? Number(process.env.ARCHIVE_OWNER) : null;
  if (existing.length === 0) {
    // A dry run reports the requirement rather than failing on it — its job is
    // to tell you what would happen, and "you would need an owner" is part of
    // that answer.
    if (!ownerEnv && dryRun) {
      console.log("  yeni mənbədir — həqiqi idxal üçün ARCHIVE_OWNER=<userId> lazımdır");
    } else if (!ownerEnv) {
      throw new Error(
        `${sourceId} ilk dəfə idxal olunur — ARCHIVE_OWNER=<userId> verilməlidir ` +
          `(katibe.users). Sahibsiz arxiv icazə modelindən kənarda qalardı.`,
      );
    }
    if (!dryRun) {
      await pool.query(
        `INSERT INTO katibe.source (id, kind, owner_user_id, label)
         VALUES ($1, 'archive', $2, $3)`,
        [sourceId, ownerEnv, `${meta.source} · ${meta.generated}`],
      );
      console.log(`  yeni mənbə yaradıldı, sahibi user ${ownerEnv}`);
    }
  }

  // Resume point. Archive ids ascend, so the highest already imported is a
  // complete answer to "what is left" — no checkpoint file, no guessing.
  const { rows: hw } = await pool.query(
    `SELECT COALESCE(max(external_id::bigint), 0) AS mark
       FROM katibe.message_source WHERE source_id = $1`,
    [sourceId],
  );
  let mark = Number(hw[0].mark);
  const remaining = Number(
    (
      sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id > ?").get(mark) as {
        n: number;
      }
    ).n,
  );
  console.log(`  ${remaining.toLocaleString()} qalıb${dryRun ? " · QURU İŞLƏMƏ" : ""}`);
  if (dryRun || remaining === 0) {
    sqlite.close();
    await pool.end();
    return;
  }

  // ---- chats first, so every message has somewhere to land ----
  const chats = sqlite
    .prepare("SELECT id, jid, name, kind FROM chats")
    .all() as unknown as ChatRow[];
  const { rows: lidRows } = await pool.query(
    `SELECT lid_jid, phone_number FROM katibe.lid_number`,
  );
  const lid = new Map(lidRows.map((r) => [r.lid_jid as string, r.phone_number as string]));

  /** Same rule as the Evolution mirror, so both sources land on one key. */
  const personKey = (jid: string): string => {
    if (jid.endsWith("@s.whatsapp.net")) return jid.split("@")[0];
    if (jid.endsWith("@lid")) return lid.get(jid) ?? jid;
    return jid;
  };

  const chatIdByArchiveId = new Map<number, number>();
  let skippedChats = 0;
  let skippedStatus = 0;
  for (const ch of chats) {
    // The export carries a placeholder row for messages it could not attribute
    // to a conversation — jid null, and in this file zero messages. Nothing to
    // place, so nothing to import; counted rather than silently dropped.
    if (!ch.jid) {
      skippedChats++;
      continue;
    }
    // Status axını (yuxarıdakı izah). Söhbət yaradılmadığına görə onun
    // mesajları da aşağıdakı `!chatId` yoxlamasına düşür və özləri atılır.
    if (ch.kind === STATUS_KIND) {
      skippedStatus++;
      continue;
    }
    const pk = personKey(ch.jid);
    const kind = CHAT_KIND[ch.kind] ?? "other";
    const { rows } = await pool.query(
      `WITH up AS (
         INSERT INTO katibe.chat (person_key, kind, title)
         VALUES ($1, $2, $3)
         ON CONFLICT (person_key) DO UPDATE
           SET updated_at = now(),
               -- A title already set by the live side is better than the
               -- export's, which is a snapshot of one phone's address book.
               title = COALESCE(katibe.chat.title, EXCLUDED.title)
         RETURNING id)
       SELECT id FROM up`,
      [pk, kind, ch.name],
    );
    const chatId = Number(rows[0].id);
    chatIdByArchiveId.set(ch.id, chatId);
    await pool.query(
      `INSERT INTO katibe.chat_jid (remote_jid, chat_id) VALUES ($1, $2)
       ON CONFLICT (remote_jid) DO NOTHING`,
      [ch.jid, chatId],
    );
  }
  const jidByArchiveId = new Map(
    chats.filter((c) => c.jid).map((c) => [c.id, c.jid]),
  );
  console.log(
    `  ${chats.length - skippedChats - skippedStatus} söhbət hazırlandı` +
      (skippedChats > 0 ? ` · ${skippedChats} jid-siz atıldı` : "") +
      (skippedStatus > 0 ? ` · ${skippedStatus} status axını atıldı` : ""),
  );

  // ---- messages ----
  const { rows: runRow } = await pool.query(
    `INSERT INTO katibe.import_run (source_id, input) VALUES ($1, $2) RETURNING id`,
    [sourceId, `${dbPath} (${remaining} qalıb)`],
  );
  const runId = runRow[0].id as string;

  const selectMsgs = sqlite.prepare(
    `SELECT m.id, m.chat_id, m.ts, m.direction, m.sender_jid, m.sender_name,
            m.text, m.kind, m.stanza_id, m.reply_to
       FROM messages m WHERE m.id > ? ORDER BY m.id LIMIT ?`,
  );
  const selectMedia = sqlite.prepare(
    `SELECT message_id, status, rel_path, mime, declared_size
       FROM media WHERE message_id > ? AND message_id <= ?`,
  );

  let done = 0;
  const t0 = Date.now();
  try {
    for (;;) {
      if (maxRows > 0 && done >= maxRows) break;
      const want = maxRows > 0 ? Math.min(batchSize, maxRows - done) : batchSize;
      const rows = selectMsgs.all(mark, want) as unknown as MsgRow[];
      if (rows.length === 0) break;
      const highest = rows[rows.length - 1].id;

      const values: unknown[] = [];
      const tuples: string[] = [];
      const keep: MsgRow[] = [];
      // Two rows sharing (remote_jid, stanza_id) inside ONE statement is not a
      // conflict Postgres will resolve — it rejects the whole batch with "ON
      // CONFLICT DO UPDATE command cannot affect row a second time". The
      // archive holds two such pairs of its own, so the batch is made unique
      // before it is sent and the duplicate is left for the next run to fold
      // in through the normal upsert path.
      const seenInBatch = new Set<string>();
      for (const m of rows) {
        const jid = jidByArchiveId.get(m.chat_id);
        const chatId = chatIdByArchiveId.get(m.chat_id);
        // A message whose chat is missing from the export cannot be placed;
        // counting it as skipped is honest, dropping it silently is not.
        if (!jid || !chatId || !m.stanza_id) continue;
        const dedupeKey = `${jid} ${m.stanza_id}`;
        if (seenInBatch.has(dedupeKey)) continue;
        seenInBatch.add(dedupeKey);
        const p = values.length;
        values.push(
          chatId, jid, m.stanza_id, toEpoch(m.ts), m.direction === "out" ? "out" : "in",
          m.sender_jid, m.sender_name === "me" ? null : m.sender_name,
          m.text, m.kind ?? "text", m.reply_to,
        );
        tuples.push(
          `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9},$${p + 10})`,
        );
        keep.push(m);
      }

      if (tuples.length > 0) {
        const { rows: ins } = await pool.query(
          `INSERT INTO katibe.message
             (chat_id, remote_jid, stanza_id, ts, direction, sender_jid,
              sender_name, body, kind, reply_to)
           VALUES ${tuples.join(",")}
           ON CONFLICT (remote_jid, stanza_id) DO UPDATE
             -- The archive is the phone's own record, so where the two sources
             -- disagree the earlier timestamp and the non-null field win. The
             -- live side keeps whatever it alone knows.
             SET ts = LEAST(katibe.message.ts, EXCLUDED.ts),
                 body = COALESCE(katibe.message.body, EXCLUDED.body),
                 sender_jid = COALESCE(katibe.message.sender_jid, EXCLUDED.sender_jid),
                 sender_name = COALESCE(katibe.message.sender_name, EXCLUDED.sender_name),
                 direction = CASE WHEN katibe.message.direction = 'out'
                                    OR EXCLUDED.direction = 'out'
                                  THEN 'out' ELSE 'in' END
           RETURNING id, remote_jid, stanza_id`,
          values,
        );
        const idByKey = new Map(
          ins.map((r) => [`${r.remote_jid} ${r.stanza_id}`, Number(r.id)]),
        );

        const lv: unknown[] = [];
        const lt: string[] = [];
        for (const m of keep) {
          const jid = jidByArchiveId.get(m.chat_id) as string;
          const id = idByKey.get(`${jid} ${m.stanza_id}`);
          if (!id) continue;
          const p = lv.length;
          lv.push(id, sourceId, String(m.id), m.direction === "out" ? "out" : "in");
          lt.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4})`);
        }
        if (lt.length > 0) {
          await pool.query(
            `INSERT INTO katibe.message_source
               (message_id, source_id, external_id, direction)
             VALUES ${lt.join(",")}
             ON CONFLICT (message_id, source_id) DO UPDATE
               SET external_id = EXCLUDED.external_id, direction = EXCLUDED.direction`,
            lv,
          );
        }

        // Media rows for this id range, joined back through the same map.
        const med = selectMedia.all(mark, highest) as unknown as {
          message_id: number; status: string; rel_path: string | null;
          mime: string | null; declared_size: number | null;
        }[];
        const mv: unknown[] = [];
        const mt: string[] = [];
        const msgById = new Map(keep.map((m) => [m.id, m]));
        for (const md of med) {
          const m = msgById.get(md.message_id);
          if (!m) continue;
          const jid = jidByArchiveId.get(m.chat_id) as string;
          const id = idByKey.get(`${jid} ${m.stanza_id}`);
          if (!id) continue;
          const present = md.status === "present" && md.rel_path;
          const p = mv.length;
          mv.push(
            id, present ? "archive" : "absent",
            present ? mediaPrefix + md.rel_path : null, md.mime, md.declared_size,
          );
          mt.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5})`);
        }
        if (mt.length > 0) {
          await pool.query(
            `INSERT INTO katibe.media (message_id, storage, object_key, mime, size_bytes)
             VALUES ${mt.join(",")}
             ON CONFLICT (message_id) DO UPDATE
               -- An archive file that exists beats a live row that lost its
               -- media to WhatsApp's retention.
               SET storage = CASE WHEN EXCLUDED.storage = 'archive'
                                  THEN 'archive' ELSE katibe.media.storage END,
                   object_key = COALESCE(EXCLUDED.object_key, katibe.media.object_key),
                   mime = COALESCE(katibe.media.mime, EXCLUDED.mime)`,
            mv,
          );
        }
      }

      done += rows.length;
      mark = highest;
      await pool.query(
        `UPDATE katibe.import_run
            SET read_count = read_count + $2, inserted = inserted + $3,
                skipped = skipped + $4
          WHERE id = $1`,
        [runId, rows.length, tuples.length, rows.length - tuples.length],
      );
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(
        `\r  ${done.toLocaleString()}/${remaining.toLocaleString()} · ${Math.round(rate)}/san   `,
      );
    }
    await pool.query(
      `UPDATE katibe.import_run SET status='ok', finished_at=now() WHERE id=$1`,
      [runId],
    );
  } catch (e) {
    await pool.query(
      `UPDATE katibe.import_run SET status='failed', finished_at=now(), error=$2 WHERE id=$1`,
      [runId, (e as Error).message.slice(0, 500)],
    );
    throw e;
  }

  const { rows: tot } = await pool.query(
    `SELECT (SELECT count(*) FROM katibe.message) AS msg,
            (SELECT count(*) FROM katibe.chat) AS chat,
            (SELECT count(*) FROM katibe.message_source WHERE source_id = $1) AS mine`,
    [sourceId],
  );
  console.log(
    `\nBitdi — bu mənbədən ${Number(tot[0].mine).toLocaleString()} əlaqə · ` +
      `anbarda ${Number(tot[0].msg).toLocaleString()} mesaj, ${tot[0].chat} söhbət.`,
  );
  sqlite.close();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
