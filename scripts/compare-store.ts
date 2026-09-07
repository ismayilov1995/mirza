/**
 * Proves the canonical store reproduces Evolution before anything reads it.
 *
 * Stage two. The mirror writes; this asks whether what it wrote is the same
 * data, and refuses to be satisfied by "looks about right" — every check is a
 * count or a field diff with an exact expected answer.
 *
 * WHAT EQUALITY MEANS HERE, because the naive version is wrong. The canonical
 * store deliberately differs from Evolution in two ways: a message stored once
 * per instance that belongs to a group becomes one row with several source
 * links, and a person's @lid and @s.whatsapp.net chats become one
 * conversation. A test demanding identical totals would fail by design and
 * teach us nothing.
 *
 * So equality is asserted PER SOURCE: filtered through message_source to one
 * instance, the store must reproduce that instance exactly — same row count,
 * same per-chat counts, same timestamps, same text. Anything else is a bug.
 *
 * EQUALITY IS AS OF A MOMENT. Messages keep arriving while this runs, so a
 * naive comparison always trails by whatever landed mid-count and can never
 * pass on a live system. Everything below is bounded to messages older than
 * COMPARE_LAG seconds, which is the only way "equal" means anything here.
 *
 * Reads only. Run:  npm run compare:store
 *   COMPARE_SAMPLE=400   how many messages to diff field by field (default 400)
 *   COMPARE_LAG=600      ignore the last N seconds of traffic (default 600)
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function mark(c: Check): string {
  return `${c.ok ? "  ✓" : "  ✗"} ${c.name.padEnd(42)} ${c.detail}`;
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const sample = Number(process.env.COMPARE_SAMPLE ?? 400);
  const lag = Number(process.env.COMPARE_LAG ?? 600);
  const { rows: cut } = await pool.query(
    `SELECT (EXTRACT(epoch FROM now())::int - $1) AS ts`, [lag],
  );
  const cutoff = Number(cut[0].ts);
  console.log(`kəsilmə nöqtəsi: son ${lag} saniyə nəzərə alınmır`);

  const { rows: sources } = await pool.query(
    `SELECT id FROM katibe.source WHERE kind = 'evolution' ORDER BY id`,
  );
  if (sources.length === 0) {
    console.log("Evolution mənbəyi yoxdur — əvvəlcə npm run mirror:evolution.");
    await pool.end();
    return;
  }

  const checks: Check[] = [];

  for (const { id } of sources as { id: string }[]) {
    console.log(`\n### ${id}`);
    // Where this instance's checks start, so only they are printed below while
    // the whole run is still counted at the end.
    const from = checks.length;

    // 1. Row count. Evolution rows and source links are one-to-one: the
    //    collapse happens between links and messages, never here.
    const { rows: c1 } = await pool.query(
      `SELECT
         (SELECT count(*) FROM evolution_api."Message"
           WHERE "instanceId" = $1 AND key->>'id' IS NOT NULL
             AND "messageTimestamp" < $2) AS evo,
         (SELECT count(*) FROM katibe.message_source ms
            JOIN katibe.message m ON m.id = ms.message_id
           WHERE ms.source_id = $1 AND m.ts < $2) AS store`,
      [id, cutoff],
    );
    const evo = Number(c1[0].evo);
    const store = Number(c1[0].store);
    checks.push({
      name: "sətir sayı",
      ok: evo === store,
      detail: `evolution ${evo} · anbar ${store}${evo === store ? "" : ` · fərq ${evo - store}`}`,
    });

    // 2. Per-chat counts. Catches a message attached to the wrong conversation,
    //    which a total would hide by cancelling out.
    const { rows: c2 } = await pool.query(
      `WITH e AS (
         SELECT key->>'remoteJid' AS jid, count(*) AS n
           FROM evolution_api."Message"
          WHERE "instanceId" = $1 AND key->>'id' IS NOT NULL
            AND "messageTimestamp" < $2 GROUP BY 1),
       s AS (
         SELECT m.remote_jid AS jid, count(*) AS n
           FROM katibe.message_source ms JOIN katibe.message m ON m.id = ms.message_id
          WHERE ms.source_id = $1 AND m.ts < $2 GROUP BY 1)
       SELECT count(*) FILTER (WHERE COALESCE(e.n,0) <> COALESCE(s.n,0)) AS ferqli,
              count(*) AS sohbet
         FROM e FULL OUTER JOIN s ON s.jid = e.jid`,
      [id, cutoff],
    );
    checks.push({
      name: "söhbət üzrə say",
      ok: Number(c2[0].ferqli) === 0,
      detail: `${c2[0].sohbet} söhbət · ${c2[0].ferqli} fərqli`,
    });

    // 3. Field fidelity on a sample. Timestamp is compared with LEAST because
    //    the store deliberately keeps the earliest when instances disagree.
    const { rows: c3 } = await pool.query(
      `WITH collide AS (
         SELECT ms2.message_id
           FROM katibe.message_source ms2
           JOIN evolution_api."Message" e2 ON e2.id = ms2.external_id
          GROUP BY ms2.message_id
         HAVING count(DISTINCT COALESCE(e2.message->>'conversation',
                e2.message->'extendedTextMessage'->>'text', '~')) > 1
       ),
       pair AS (
         SELECT m.ts, m.body, ms.direction, e."messageTimestamp" AS e_ts,
                COALESCE(e.message->>'conversation',
                         e.message->'extendedTextMessage'->>'text',
                         e.message->'imageMessage'->>'caption',
                         e.message->'videoMessage'->>'caption',
                         e.message->'documentMessage'->>'fileName') AS e_body,
                CASE WHEN (e.key->>'fromMe')::boolean THEN 'out' ELSE 'in' END AS e_dir
           FROM katibe.message_source ms
           JOIN katibe.message m ON m.id = ms.message_id
           JOIN evolution_api."Message" e ON e.id = ms.external_id
          WHERE ms.source_id = $1
            -- Accepted collisions are excluded here and counted separately
            -- below; leaving them in would make a known, bounded cost look
            -- like a fidelity failure and hide a real one behind it.
            AND m.id NOT IN (SELECT message_id FROM collide)
          ORDER BY random() LIMIT $2)
       SELECT count(*) AS baxilan,
              count(*) FILTER (WHERE ts > e_ts) AS vaxt_pis,
              count(*) FILTER (WHERE e_body IS NOT NULL AND body IS DISTINCT FROM e_body) AS metn_pis,
              count(*) FILTER (WHERE direction <> e_dir) AS istiqamet_pis
         FROM pair`,
      [id, sample],
    );
    const bad =
      Number(c3[0].vaxt_pis) + Number(c3[0].metn_pis) + Number(c3[0].istiqamet_pis);
    checks.push({
      name: `sahə uyğunluğu (${c3[0].baxilan} nümunə)`,
      ok: bad === 0,
      detail:
        bad === 0
          ? "vaxt, mətn, istiqamət — hamısı uyğun"
          : `vaxt ${c3[0].vaxt_pis} · mətn ${c3[0].metn_pis} · istiqamət ${c3[0].istiqamet_pis}`,
    });

    // 4. Window boundaries. Every date filter in the app leans on these.
    const { rows: c4 } = await pool.query(
      `SELECT
         (SELECT min("messageTimestamp") FROM evolution_api."Message"
           WHERE "instanceId" = $1 AND key->>'id' IS NOT NULL
             AND "messageTimestamp" < $2) AS e_min,
         (SELECT max("messageTimestamp") FROM evolution_api."Message"
           WHERE "instanceId" = $1 AND key->>'id' IS NOT NULL
             AND "messageTimestamp" < $2) AS e_max,
         (SELECT min(m.ts) FROM katibe.message_source ms
            JOIN katibe.message m ON m.id = ms.message_id
           WHERE ms.source_id = $1 AND m.ts < $2) AS s_min,
         (SELECT max(m.ts) FROM katibe.message_source ms
            JOIN katibe.message m ON m.id = ms.message_id
           WHERE ms.source_id = $1 AND m.ts < $2) AS s_max`,
      [id, cutoff],
    );
    const r = c4[0];
    checks.push({
      name: "pəncərə sərhədləri",
      // min may legitimately be earlier in the store — LEAST across instances.
      ok: Number(r.s_min) <= Number(r.e_min) && Number(r.s_max) === Number(r.e_max),
      detail: `min ${r.e_min}→${r.s_min} · max ${r.e_max}→${r.s_max}`,
    });

    for (const c of checks.slice(from)) console.log(mark(c));
  }

  // 5. The accepted cost of the dedupe key, kept visible and bounded.
  //    (remote_jid, stanza_id) merges a small number of genuinely different
  //    messages — a documented trade, not a defect. It stops being acceptable
  //    if it grows, so it is measured rather than assumed.
  const COLLISION_LIMIT = 0.001; // 0.1% of the store
  const { rows: col } = await pool.query(
    `WITH c AS (
       SELECT ms.message_id
         FROM katibe.message_source ms
         JOIN evolution_api."Message" e ON e.id = ms.external_id
        GROUP BY ms.message_id
       HAVING count(DISTINCT COALESCE(e.message->>'conversation',
              e.message->'extendedTextMessage'->>'text', '~')) > 1)
     SELECT (SELECT count(*) FROM c) AS n,
            (SELECT count(*) FROM katibe.message) AS total`,
  );
  const collisions = Number(col[0].n);
  const totalMsg = Number(col[0].total);
  const ratio = totalMsg === 0 ? 0 : collisions / totalMsg;
  console.log("\n### açarın qəbul edilmiş xərci");
  const colCheck: Check = {
    name: "mətn toqquşması",
    ok: ratio <= COLLISION_LIMIT,
    detail: `${collisions} / ${totalMsg} (${(ratio * 100).toFixed(3)}%) · hədd ${(COLLISION_LIMIT * 100).toFixed(1)}%`,
  };
  console.log(mark(colCheck));

  // 6. Store-wide invariants. These are about the store's own consistency
  //    rather than about Evolution, and a violation means the schema is not
  //    holding what it promises.
  console.log("\n### anbarın öz bütövlüyü");
  const { rows: inv } = await pool.query(
    `SELECT
       (SELECT count(*) FROM katibe.message m
         WHERE NOT EXISTS (SELECT 1 FROM katibe.message_source ms WHERE ms.message_id = m.id)) AS mensebsiz,
       (SELECT count(*) FROM katibe.message m
         WHERE NOT EXISTS (SELECT 1 FROM katibe.chat_jid cj WHERE cj.remote_jid = m.remote_jid)) AS jidsiz,
       (SELECT count(*) FROM katibe.message m
          JOIN katibe.chat_jid cj ON cj.remote_jid = m.remote_jid
         WHERE cj.chat_id <> m.chat_id) AS sohbet_uygunsuz,
       (SELECT count(*) FROM katibe.media WHERE storage <> 'absent' AND object_key IS NULL) AS media_yolsuz`,
  );
  const i = inv[0];
  const invChecks: Check[] = [
    { name: "hər mesajın mənbəyi var", ok: Number(i.mensebsiz) === 0, detail: `${i.mensebsiz} mənbəsiz` },
    { name: "hər jid söhbətə bağlıdır", ok: Number(i.jidsiz) === 0, detail: `${i.jidsiz} bağsız` },
    { name: "mesaj–söhbət uyğunluğu", ok: Number(i.sohbet_uygunsuz) === 0, detail: `${i.sohbet_uygunsuz} uyğunsuz` },
    { name: "media yolu var", ok: Number(i.media_yolsuz) === 0, detail: `${i.media_yolsuz} yolsuz` },
  ];
  for (const c of invChecks) console.log(mark(c));

  // Every check counts, not only the invariants — an earlier version reported
  // "all passed" underneath four visible failures, which is worse than no
  // check at all.
  const failed = [...checks, colCheck, ...invChecks].filter((c) => !c.ok).length;
  console.log(
    failed === 0
      ? "\nHamısı keçdi — anbar Evolution-u mənbə üzrə tam təkrar edir."
      : `\n${failed} yoxlama uğursuz — kəsilmə etmə.`,
  );
  if (failed > 0) process.exitCode = 1;
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
