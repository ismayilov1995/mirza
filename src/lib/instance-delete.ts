import { pool } from "./db";

/*
 * Bir nömrənin (Evolution instansının) sistemdən çıxarılması.
 *
 * Silmək burada iki ayrı bazanın işidir və onları bir yerdə saxlamağın səbəbi
 * var: Evolution öz cədvəllərini `Instance`-a bağlı kaskadla özü aparır, amma
 * `katibe.*` sxeması ona FK ilə bağlı DEYİL (yeganə istisna
 * `user_instances`). Yəni Evolution-a "sil" deyib əlini yumaq nömrəni
 * siyahıdan çıxarır, arxada isə həmin instansın bayraqları, xülasələri, axtarış
 * parçaları və icazə sətirləri qalır — heç bir ekranda görünməyən, amma
 * nəzarətçi lentində «qopub» kimi geri çıxan zibil. Ona görə təmizləmə də bu
 * fayldadır.
 *
 * SİLMƏK GERİ ALINMIR. Evolution tərəfdə mesajlar və söhbətlər kaskadla gedir,
 * bu tərəfdə isə anbardakı nüsxələri. Təsdiq ekranı (`/admin/instance/<ad>/sil`)
 * məhz buna görə rəqəmləri əvvəlcədən göstərir və adın əl ilə yazılmasını
 * tələb edir.
 */

/** Media və səs endirmə bu instansın üzərindən gedir — silinsə, panel qırılır. */
export function protectedInstanceName(): string | null {
  return process.env.EVOLUTION_INSTANCE_NAME?.trim() || null;
}

export interface InstanceDeletionFacts {
  id: string;
  name: string;
  number: string | null;
  connectionStatus: string;
  createdAt: Date;
  /** Evolution-da duran mesajlar — silinmə ilə gedir. */
  messages: number;
  chats: number;
  /** Anbardakı (`katibe.message`) nüsxələr — arxiv, axtarış və statistika bunun üstündədir. */
  mirroredMessages: number;
  /** Nəzarətçi lentindəki sətirlər. */
  flags: number;
  /** Hazırkı sahibi, varsa. */
  ownerName: string | null;
  /** Təyinat tarixçəsindəki sətirlərin sayı (bağlanmışlar daxil). */
  assignments: number;
}

export async function getInstanceDeletionFacts(name: string): Promise<InstanceDeletionFacts | null> {
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i.number, i."connectionStatus" AS status, i."createdAt" AS created_at,
            (SELECT count(*) FROM evolution_api."Message" m WHERE m."instanceId" = i.id) AS messages,
            (SELECT count(*) FROM evolution_api."Chat" c WHERE c."instanceId" = i.id) AS chats,
            (SELECT count(*) FROM katibe.message_source ms WHERE ms.source_id = i.id) AS mirrored,
            (SELECT count(*) FROM katibe.agent_posts p WHERE p.instance_id = i.id) AS flags,
            (SELECT u.name FROM katibe.user_instances ui
               JOIN katibe.users u ON u.id = ui.user_id
              WHERE ui.instance_id = i.id AND ui.ended_at IS NULL
              LIMIT 1) AS owner_name,
            (SELECT count(*) FROM katibe.user_instances ui WHERE ui.instance_id = i.id) AS assignments
       FROM evolution_api."Instance" i
      WHERE i.name = $1`,
    [name],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    number: r.number,
    connectionStatus: r.status,
    createdAt: r.created_at,
    messages: Number(r.messages),
    chats: Number(r.chats),
    mirroredMessages: Number(r.mirrored),
    flags: Number(r.flags),
    ownerName: r.owner_name,
    assignments: Number(r.assignments),
  };
}

export interface PurgeResult {
  mirrorMessages: number;
  mirrorChats: number;
  katibeRows: number;
}

/**
 * `katibe.*` sxemasında bu instansdan qalan hər şeyi bir tranzaksiyada silir.
 *
 * İki hissədən ibarətdir, çünki iki fərqli açar var:
 *
 *  1. **Anbar.** `katibe.message` / `katibe.chat` instans ID-si daşımır —
 *     bağlantı `message_source` / `chat_source` üzərindəndir və bir söhbət bir
 *     neçə mənbədə ola bilər (eyni adam həm köhnə arxivdə, həm bu nömrədə
 *     yazıb). Ona görə yalnız BU mənbədən başqa mənbəyi olmayan sətirlər
 *     silinir; ortaq söhbət yerində qalır, sadəcə bir mənbəsi azalır.
 *     «Mənbəsi qalmayan hər şeyi sil» yazmaq olardı və səhv olardı: bazada
 *     onsuz da mənbəsiz 300-ə yaxın köhnə söhbət var, onların bu nömrə ilə
 *     əlaqəsi yoxdur.
 *
 *  2. **Qalan cədvəllər.** Onlar `instance_id` daşıyır və siyahı əl ilə
 *     yazılmır: katalogdan oxunur. Səbəb sadədir — bu sxemə vaxtaşırı yeni
 *     `instance_id`-li cədvəl əlavə olunur (indi 19-dur) və əl ilə yazılmış
 *     siyahı ilk unudulan cədvəldə səssizcə köhnəlir.
 *
 * Ad `information_schema`-dan gəlir, amma yenə də şablona salınmazdan əvvəl
 * yoxlanır: kataloqdan gələn dəyər üçün bu artıqlıqdır, artıqlıq olmayan gün
 * isə bu sətir SQL injection olur.
 */
export async function purgeInstanceFromKatibe(instanceId: string): Promise<PurgeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const messages = await client.query(
      `DELETE FROM katibe.message m
        USING katibe.message_source ms
        WHERE ms.message_id = m.id AND ms.source_id = $1
          AND NOT EXISTS (SELECT 1 FROM katibe.message_source o
                           WHERE o.message_id = m.id AND o.source_id <> $1)`,
      [instanceId],
    );

    // Söhbətin özü sonuncu mənbəsini itirəndə gedir; `chat_jid`, `chunk`,
    // `read_marker` və qalan mesajlar ona kaskadla bağlıdır.
    const chats = await client.query(
      `DELETE FROM katibe.chat c
        WHERE EXISTS (SELECT 1 FROM katibe.chat_source cs
                       WHERE cs.chat_id = c.id AND cs.source_id = $1)
          AND NOT EXISTS (SELECT 1 FROM katibe.chat_source o
                           WHERE o.chat_id = c.id AND o.source_id <> $1)`,
      [instanceId],
    );

    await client.query(`DELETE FROM katibe.source WHERE id = $1 AND kind = 'evolution'`, [instanceId]);

    const { rows: targets } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'katibe'
          AND column_name IN ('instance_id', 'source_instance_id')
        ORDER BY table_name`,
    );

    let katibeRows = 0;
    for (const t of targets) {
      if (!/^[a-z_][a-z0-9_]*$/.test(t.table_name) || !/^[a-z_][a-z0-9_]*$/.test(t.column_name)) {
        throw new Error(`Gözlənilməz cədvəl adı: katibe.${t.table_name}.${t.column_name}`);
      }
      const res = await client.query(
        `DELETE FROM katibe.${t.table_name} WHERE ${t.column_name} = $1`,
        [instanceId],
      );
      katibeRows += res.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return {
      mirrorMessages: messages.rowCount ?? 0,
      mirrorChats: chats.rowCount ?? 0,
      katibeRows,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Evolution sətri həqiqətən aparana qədər gözləyir.
 *
 * Evolution "SUCCESS" cavabını istəyi qəbul edən kimi verir, sətirləri isə
 * `remove.instance` dinləyicisində silir. Gözləməsək, silinən nömrə admin
 * siyahısına bir dəfə də olsa geri qayıdır və adam ikinci dəfə basır.
 *
 * Gözləmə bitsə də səhv sayılmır: silinmə onsuz da gedir, sadəcə səhifə bir
 * yeniləmə gec göstərəcək.
 */
export async function waitForInstanceRowGone(instanceId: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rowCount } = await pool.query(`SELECT 1 FROM evolution_api."Instance" WHERE id = $1`, [
      instanceId,
    ]);
    if (rowCount === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Evolution-un tanımadığı sətri özümüz silirik.
 *
 * Yalnız `deleteInstance` "missing" deyəndə çağırılır: instans nə yaddaşda, nə
 * də Evolution-un öz sorğusunda var, deməli sətir prosesdən sağ qalmış qalıqdır
 * və onu silməyi başqa heç kim etməyəcək. Evolution-un cədvəlləri `Instance`-a
 * kaskadla bağlıdır, ona görə bir DELETE bəs edir.
 */
export async function dropInstanceRow(instanceId: string): Promise<void> {
  await pool.query(`DELETE FROM evolution_api."Instance" WHERE id = $1`, [instanceId]);
}
